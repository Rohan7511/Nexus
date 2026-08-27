// ELF addon analysis: classification and the requirement axis.
//
// The ELF analogue of pe-addon.mjs. Validated by E005 against two oracles that do
// not need a Linux host: cross-architecture agreement (koffi declares 8 across 13
// builds and 6 architectures) and cross-flavour agreement with the PE value, whose
// correctness E001 established against 291 real load outcomes.
//
// E005 left one deliberate gap: the local corpus then held ZERO raw-V8 ELF addons, so the
// `node_module` struct read that pe-addon.mjs performs had no validation evidence, and
// shipping an unvalidated parser that returns a plausible ABI number is precisely the
// false-negative source this project cannot afford. E008 closed it -- 44 raw-V8 ELF
// artifacts turned up in a bundled Electron tree, all labelled, and the reader now agrees
// with three independent sources. See readRawNmVersion.

import { readConstReturn, normalizeFuncAddr } from './code-imm.mjs';
import { findNodeModule } from './node-module-struct.mjs';

const GETVER = 'node_api_module_get_api_version_v1';
const ENTRY = 'napi_register_module_v1';
const NAPI_RE = /^(napi_|node_api_)/;

/**
 * .dynsym is the loader-visible symbol table. It survives stripping -- which every
 * shipped prebuild has been through -- because the dynamic linker needs it, whereas
 * .symtab does not.
 * @returns {{name:string, shndx:number, value:number, defined:boolean}[]}
 */
export function readDynsym(buf, elf) {
  const sym = elf.sections?.find((s) => s.name === '.dynsym');
  const str = elf.sections?.find((s) => s.name === '.dynstr');
  if (!sym || !str || !sym.size) return [];
  if (sym.offset + sym.size > buf.length) return [];

  const is64 = elf.is64;
  const le = buf[5] !== 2;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const uptr = (o) => (is64
    ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))
    : u32(o));
  const entsize = is64 ? 24 : 16;

  const cstr = (off) => {
    if (off < 0 || off >= buf.length) return '';
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.subarray(off, e).toString('latin1');
  };

  const out = [];
  const n = Math.floor(sym.size / entsize);
  for (let i = 0; i < n; i++) {
    const o = sym.offset + i * entsize;
    const nameOff = u32(o);
    if (!nameOff) continue;
    const name = cstr(str.offset + nameOff);
    if (!name) continue;
    // 64-bit: name,info,other,shndx,value,size. 32-bit: name,value,size,info,other,shndx.
    const shndx = is64 ? u16(o + 6) : u16(o + 14);
    const value = is64 ? uptr(o + 8) : u32(o + 4);
    out.push({ name, shndx, value, defined: shndx !== 0 });
  }
  return out;
}

/** Virtual address -> file offset via section headers. SHT_NOBITS holds no bytes. */
export function vaddrToOffset(elf, va) {
  for (const s of elf.sections ?? []) {
    if (s.type === 8 || s.addr == null || !s.size) continue;
    if (va >= s.addr && va < s.addr + s.size) return s.offset + (va - s.addr);
  }
  return null;
}

/** Which requirement axis applies. */
export function classify(syms) {
  const undef = syms.filter((s) => !s.defined);
  const defined = syms.filter((s) => s.defined);
  if (undef.some((s) => s.name === 'node_module_register')) return 'raw-v8';
  if (defined.some((s) => s.name === GETVER || s.name === ENTRY)) return 'n-api';
  if (undef.some((s) => NAPI_RE.test(s.name))) return 'n-api';
  // A shared object that links V8 or Node internals but registers neither way.
  if (undef.some((s) => /^_ZN2v8|^_ZN4node/.test(s.name))) return 'raw-v8-noreg';
  return 'unknown';
}

/** Every N-API symbol the addon imports; the import floor is computed from these. */
export const napiImports = (syms) =>
  syms.filter((s) => !s.defined && NAPI_RE.test(s.name)).map((s) => s.name);

/**
 * The declared N-API minimum. Authoritative when present: E001 measured the
 * declared value at 291/291 against an import floor's 288/291.
 */
export function readDeclaredNapi(buf, elf, syms) {
  const ex = syms.find((s) => s.defined && s.name === GETVER);
  if (!ex) return { value: null, method: 'absent' };
  const off = vaddrToOffset(elf, normalizeFuncAddr(ex.value, elf.arch));
  if (off == null) return { value: null, method: 'unmapped-vaddr' };
  const v = readConstReturn(buf, off, elf.arch);
  if (v == null) {
    return { value: null,
             method: 'unrecognised-prologue:' + buf.subarray(off, off + 12).toString('hex') };
  }
  return { value: v, method: 'const-return:' + elf.arch };
}

/** True when the artifact registers as an N-API module at all. */
export const definesNapiEntry = (syms) =>
  syms.some((s) => s.defined && (s.name === ENTRY || s.name === GETVER));

/**
 * E008. The exact NODE_MODULE_VERSION a raw-V8 ELF addon is pinned to.
 *
 * E005 refused this by construction and said why: the local corpus held no raw-V8 ELF
 * artifact, so a struct reader would have shipped unvalidated, and an untested parser
 * returning a plausible ABI number is worse than a refusal. That premise no longer holds --
 * a bundled Electron tree turned out to carry 44 raw-V8 ELF artifacts (@datadog/pprof and
 * @newrelic across glibc and musl, x64 and arm64, nine ABI levels), every one with the
 * NODE_MODULE_VERSION stated independently in the filename. So the reader could be validated
 * rather than asserted, and refusing would have left a derivable fact underived.
 *
 * Measured: 44/44 agree with the filename label, 13/13 multi-build groups agree internally,
 * 44/44 agree with the E001-validated PE and Mach-O reads, and each matches exactly one
 * record. What this is NOT validated against is a real Linux load; that direction needs a
 * Linux host and is CROSSPLATFORMTEST.md's job.
 *
 * ELF's pointer slots do NOT behave like PE's, which is why this was measured rather than
 * ported: BOTH register-hook slots read zero on disk, because the function pointer lives in
 * a .rela.dyn addend while the linker resolved the string pointers in place. PE's "exactly
 * one hook is set" test therefore finds nothing in an ELF file. See node-module-struct.mjs
 * for the discriminator that replaced it.
 */
export function readRawNmVersion(buf, elf) {
  const secs = (elf.sections ?? []).filter(
    (s) => s.type !== 8 && s.size && s.addr && /^\.(data|data\.rel\.ro)/.test(s.name ?? ''));
  if (!secs.length) return { value: null, method: 'no-writable-data-section' };

  let lo = Infinity, hi = 0;
  for (const s of elf.sections ?? []) {
    if (!s.addr || !s.size) continue;
    lo = Math.min(lo, s.addr);
    hi = Math.max(hi, s.addr + s.size);
  }
  if (!(lo < hi)) return { value: null, method: 'no-mapped-address-range' };

  return findNodeModule({
    buf, sections: secs,
    inImage: (v) => v >= lo && v < hi,
    cstrAt: (va) => {
      const off = vaddrToOffset(elf, va);
      if (off == null || off < 0 || off >= buf.length) return null;
      let e = off;
      while (e < buf.length && buf[e] !== 0 && e - off < 256) e++;
      return buf.subarray(off, e).toString('latin1');
    },
    is64: elf.is64,
  });
}
