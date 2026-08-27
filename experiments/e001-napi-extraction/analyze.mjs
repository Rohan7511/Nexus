// E001: derive native-addon compatibility requirements statically.
//
// Candidate methods, all evaluated against ground truth in groundtruth.mjs:
//   M1 classify      - raw-V8 vs N-API, from imports/exports
//   M2 declared napi - read the constant returned by node_api_module_get_api_version_v1
//   M3 import floor  - lower bound from which napi_* symbols are imported (header-derived map)
//   M4 raw nm_version- read NODE_MODULE_VERSION out of the embedded node_module struct
//
// M2 and M4 are authoritative; M3 is a lower bound only and is retained to
// measure how much weaker it is.

import fs from 'node:fs';
import path from 'node:path';
import { readPE } from './pe.mjs';

// ---------------------------------------------------------------- header map
// Build symbol -> minimum NAPI_VERSION from the local node_api headers, so the
// mapping is local evidence rather than recall.
export function buildHeaderMap(includeDir) {
  const map = new Map();
  for (const f of ['js_native_api.h', 'node_api.h']) {
    const p = path.join(includeDir, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const stack = [];
    for (const line of src.split(/\r?\n/)) {
      const open = line.match(/^\s*#if(?:def)?\s+.*NAPI_VERSION\s*>=\s*(\d+)/);
      const openExp = /^\s*#ifdef\s+NAPI_EXPERIMENTAL/.test(line);
      if (open) stack.push(parseInt(open[1], 10));
      else if (openExp) stack.push(Infinity);
      else if (/^\s*#if/.test(line)) stack.push(null);
      else if (/^\s*#endif/.test(line)) stack.pop();
      else {
        const m = line.match(/\b(napi_[a-z0-9_]+|node_api_[a-z0-9_]+)\s*\(/);
        if (m && /NAPI_EXTERN|^\s*NAPI/.test(line)) {
          const active = stack.filter((x) => typeof x === 'number' && isFinite(x));
          const req = active.length ? Math.max(...active) : 1;
          const prev = map.get(m[1]);
          if (prev === undefined || req < prev) map.set(m[1], req);
        }
      }
    }
  }
  return map;
}

// ----------------------------------------------------------------- container
// Axis 0: is this even a loadable object for this host? Cheapest and most
// reliable of the three axes. keytar.node in the local corpus is an ELF x86-64
// binary sitting at a Windows build/Release path.
const ELF_MACHINE = { 62: 'x64', 183: 'arm64', 3: 'ia32', 40: 'arm' };
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32', 0x1c0: 'arm' };
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm' };

export function readContainer(buf) {
  if (buf.length < 64) return { format: 'unknown', os: null, arch: null };
  if (buf[0] === 0x7f && buf.subarray(1, 4).toString('latin1') === 'ELF') {
    return { format: 'elf', os: 'linux', arch: ELF_MACHINE[buf.readUInt16LE(18)] ?? null };
  }
  const be = buf.readUInt32BE(0), le = buf.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) {
    return { format: 'macho', os: 'darwin', arch: MACHO_CPU[buf.readUInt32LE(4)] ?? null };
  }
  if (be === 0xfeedfacf || be === 0xfeedface) {
    return { format: 'macho', os: 'darwin', arch: MACHO_CPU[buf.readUInt32BE(4)] ?? null };
  }
  if (be === 0xcafebabe || be === 0xcafebabf) return { format: 'macho-fat', os: 'darwin', arch: null };
  if (buf.readUInt16LE(0) === 0x5a4d) {
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 6 < buf.length && buf.readUInt32LE(peOff) === 0x00004550) {
      return { format: 'pe', os: 'win32', arch: PE_MACHINE[buf.readUInt16LE(peOff + 4)] ?? null };
    }
    return { format: 'mz-not-pe', os: 'win32', arch: null };
  }
  return { format: 'unknown', os: null, arch: null };
}
const NODE_IMPORT_RE = /^node(\.exe)?$/i;

// Both directories matter: node-gyp's delay-load hook puts the node/napi
// symbols in the delay-import table, so directory 1 alone is not enough.
function nodeImports(pe) {
  const out = [];
  for (const table of [pe.imports, pe.delayImports]) {
    for (const [dll, syms] of Object.entries(table || {})) {
      if (NODE_IMPORT_RE.test(dll.replace(/\.dll$/i, ''))) out.push(...syms);
    }
  }
  return out;
}

// M2: node_api_module_get_api_version_v1 is compiled to `mov eax, imm32; ret`.
// Match that shape explicitly and refuse to guess if it does not match.
function readDeclaredNapi(pe) {
  const ex = pe.exports.find((e) => e.name === 'node_api_module_get_api_version_v1');
  if (!ex) return { value: null, method: 'absent' };
  const off = pe.rvaToOffset(ex.rva);
  if (off == null) return { value: null, method: 'unmapped-rva' };
  const b = pe.buf;
  // b8 <imm32> c3   =>  mov eax, imm32 ; ret
  if (b[off] === 0xb8 && b[off + 5] === 0xc3) {
    return { value: b.readUInt32LE(off + 1), method: 'mov-eax-imm32-ret' };
  }
  // 31 c0 c3 / 33 c0 c3 => xor eax,eax ; ret  (version 0)
  if ((b[off] === 0x31 || b[off] === 0x33) && b[off + 1] === 0xc0 && b[off + 2] === 0xc3) {
    return { value: 0, method: 'xor-eax-ret' };
  }
  return { value: null, method: 'unrecognised-prologue:' + b.subarray(off, off + 8).toString('hex') };
}

// M4: NODE_MODULE writes
//   static node_module _module = { NODE_MODULE_VERSION, flags, dso, filename,
//                                  reg_func, ctx_reg_func, modname, priv, link }
// into a data section. Rather than guessing from the version range, validate the
// whole struct shape: the pointer slots must hold either NULL or an address
// inside this image. That is what disambiguates the real struct from noise.
function readRawNmVersion(pe) {
  const lo = pe.imageBase;
  const hi = pe.imageBase + BigInt(pe.sizeOfImage);
  const inImage = (v) => v >= lo && v < hi;
  const ptrOrNull = (v) => v === 0n || inImage(v);

  const cands = [];
  for (const s of pe.sections) {
    if (!/^\.(data|rdata)/.test(s.name)) continue;
    const start = s.pointerToRawData;
    const end = Math.min(start + s.sizeOfRawData, pe.buf.length) - 64;
    for (let o = start; o < end; o += 4) {
      const version = pe.buf.readUInt32LE(o);
      if (version < 1 || version > 250) continue;
      if (pe.buf.readUInt32LE(o + 4) > 0x0f) continue;        // nm_flags: small bitfield
      if (pe.buf.readBigUInt64LE(o + 8) !== 0n) continue;      // nm_dso_handle: NULL in image
      const filename = pe.buf.readBigUInt64LE(o + 16);
      const regFn = pe.buf.readBigUInt64LE(o + 24);
      const ctxRegFn = pe.buf.readBigUInt64LE(o + 32);
      const modname = pe.buf.readBigUInt64LE(o + 40);
      const priv = pe.buf.readBigUInt64LE(o + 48);
      const link = pe.buf.readBigUInt64LE(o + 56);
      if (!ptrOrNull(filename) || !ptrOrNull(regFn) || !ptrOrNull(ctxRegFn)) continue;
      if (!ptrOrNull(modname) || priv !== 0n || link !== 0n) continue;
      // Exactly one of the two register hooks is set by the NODE_MODULE macros.
      if ((regFn === 0n) === (ctxRegFn === 0n)) continue;
      if (!inImage(modname)) continue;                         // module name is always present
      cands.push({ version, off: o });
    }
  }
  if (cands.length === 0) return { value: null, method: 'no-struct-found' };
  const distinct = [...new Set(cands.map((c) => c.version))];
  return {
    value: cands[0].version,
    method: 'data-struct-scan(validated)',
    ambiguous: distinct.length > 1 ? distinct.join(',') : null,
  };
}

export function analyze(file, headerMap) {
  const buf = fs.readFileSync(file);
  const container = readContainer(buf);
  const rec = { file: path.basename(file), container, constraints: [] };

  // Axis 0 applies to EVERY artifact, not only foreign containers. A PE built
  // for arm64 is exactly as unloadable on an x64 host as an ELF is. The first
  // corpus sweep scored 27/27 precisely because it contained no wrong-arch PE;
  // widening the corpus surfaced 6 of them (18 cells) as false negatives.
  rec.constraints.push({
    kind: 'platform',
    os: container.os,
    arch: container.arch,
    source: `container=${container.format}`,
  });

  if (container.format !== 'pe') {
    rec.class = 'foreign-' + container.format;
    return rec;
  }

  const pe = readPE(buf);
  const imps = nodeImports(pe);
  const expNames = pe.exports.map((e) => e.name);

  const usesNapi = imps.some((s) => /^(napi_|node_api_)/.test(s)) ||
                   expNames.includes('napi_register_module_v1');
  const usesRaw = imps.includes('node_module_register');
  const usesV8 = imps.some((s) => /@v8@@|@node@@/.test(s));

  const cls = usesRaw ? 'raw-v8' : usesNapi ? 'n-api' : usesV8 ? 'raw-v8-noreg' : 'unknown';

  rec.class = cls;
  rec.arch = container.arch;

  if (cls === 'n-api') {
    const d = readDeclaredNapi(pe);
    const napiSyms = imps.filter((s) => /^(napi_|node_api_)/.test(s));
    const floors = napiSyms.map((s) => headerMap.get(s) ?? 1);
    rec.declaredNapi = d.value;
    rec.declaredMethod = d.method;
    rec.importFloor = floors.length ? Math.max(...floors) : 1;
    rec.napiSymbolCount = napiSyms.length;
    rec.constraints.push(d.value != null && d.value > 0
      ? { kind: 'napi-min', napi: d.value, source: 'declared' }
      : { kind: 'napi-min', napi: rec.importFloor, source: 'import-floor(WEAK)' });
  } else if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
    const r = readRawNmVersion(pe);
    rec.nmVersion = r.value;
    rec.nmMethod = r.method;
    rec.nmAmbiguous = r.ambiguous;
    rec.constraints.push(r.value != null
      ? { kind: 'abi-exact', abi: r.value, source: 'nm_version' }
      : { kind: 'unknown', source: 'raw addon, nm_version not recovered' });
  } else {
    rec.constraints.push({ kind: 'unknown', source: 'unclassified binary' });
  }
  return rec;
}

// ------------------------------------------------------------------ decision
// A compatibility requirement is a CONJUNCTION: every constraint must hold.
// Conservative: an unknown constraint refuses.
function check(c, runtime) {
  switch (c.kind) {
    case 'platform':
      if (c.os !== runtime.os) {
        return { ok: false, why: `object targets ${c.os ?? 'an unrecognised OS'}, host is ${runtime.os}` };
      }
      if (c.arch == null) {
        return { ok: false, why: `object architecture could not be determined; refusing (conservative)` };
      }
      if (c.arch !== runtime.arch) {
        return { ok: false, why: `object is ${c.os}/${c.arch}, host is ${runtime.os}/${runtime.arch}` };
      }
      return { ok: true, why: `platform ${c.os}/${c.arch} matches host` };
    case 'napi-min':
      return c.napi <= runtime.napi
        ? { ok: true, why: `addon needs N-API >= ${c.napi}, runtime provides ${runtime.napi}` }
        : { ok: false, why: `addon needs N-API >= ${c.napi}, runtime provides only ${runtime.napi}` };
    case 'abi-exact':
      return c.abi === runtime.abi
        ? { ok: true, why: `addon built for ABI ${c.abi}, runtime is ABI ${runtime.abi}` }
        : { ok: false, why: `addon built for ABI ${c.abi}, runtime is ABI ${runtime.abi}` };
    default:
      return { ok: false, why: 'compatibility could not be determined; refusing (conservative)' };
  }
}

export function decide(constraints, runtime) {
  for (const c of constraints) {
    const r = check(c, runtime);
    if (!r.ok) return r;
  }
  return { ok: true, why: 'all constraints satisfied' };
}
