// E005 probe: what is actually READABLE from ELF .node artifacts?
//
// Nexus currently derives the platform axis for ELF (E003) but emits an explicit
// `unknown` requirement axis, so every Linux artifact is refused. That is sound and
// useless. Before committing to a derivation method, measure the symbol landscape
// of the local ELF corpus -- the method must follow the evidence.
//
// Candidate signals, in decreasing strength:
//   S1  node_api_module_get_api_version_v1 DEFINED  -> declared N-API minimum,
//       exact, but requires reading machine code at its address (per-arch).
//   S2  undefined napi_*/node_api_* symbols         -> import floor, arch-independent,
//       provably weaker (E001: 72/75 vs 75/75 on PE).
//   S3  undefined node_module_register              -> raw-V8, needs nm_version
//       from the node_module struct in .data.
//   S4  defined napi_register_module_v1             -> N-API entry point present.
//
// This probe only counts. It does not decide.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readElf } from '../../src/artifact/elf.mjs';

const HOME = process.env.USERPROFILE;

function discover(root, depth) {
  const out = [];
  const walk = (d, left) => {
    if (left < 0) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith('.node')) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

// ELF symbol table. .dynsym is the loader-visible table and is present even when
// .symtab has been stripped, which it always has been in shipped prebuilds.
export function readDynsym(buf, elf) {
  const sym = elf.sections.find((s) => s.name === '.dynsym');
  const str = elf.sections.find((s) => s.name === '.dynstr');
  if (!sym || !str) return [];
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
  if (sym.offset + sym.size > buf.length) return [];
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

const NAPI_RE = /^(napi_|node_api_)/;
const seen = new Set();
const rows = [];

for (const f of [
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
  ...discover('experiments/e004-vertical-slice/demo', 6),
]) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  if (seen.has(h)) continue;
  const elf = readElf(buf);
  if (!elf) continue;
  seen.add(h);

  const syms = readDynsym(buf, elf);
  const undef = syms.filter((s) => !s.defined);
  const def = syms.filter((s) => s.defined);
  const getVer = def.find((s) => s.name === 'node_api_module_get_api_version_v1');

  rows.push({
    sha: h.slice(0, 8),
    rel: f.split(/[\\/]/).slice(-2).join('/'),
    arch: elf.arch, os: elf.os, libc: elf.libc,
    symbols: syms.length,
    napiUndef: undef.filter((s) => NAPI_RE.test(s.name)).length,
    getVerAddr: getVer ? getVer.value : null,
    regV1: def.some((s) => s.name === 'napi_register_module_v1'),
    modReg: undef.some((s) => s.name === 'node_module_register'),
    nodeUndef: undef.filter((s) => /^(node|v8|uv_|_ZN2v8)/.test(s.name)).length,
  });
}

rows.sort((a, b) => (a.rel < b.rel ? -1 : 1));

const pad = (s, n) => String(s ?? '-').padEnd(n);
console.log(`E005 probe -- ${rows.length} distinct ELF .node artifact(s)\n`);
console.log(pad('artifact', 42), pad('arch', 8), pad('libc', 6), pad('syms', 5),
            pad('napiU', 6), pad('getVer', 10), pad('regV1', 6), pad('modReg', 7), 'nodeU');
console.log('-'.repeat(110));
for (const r of rows) {
  console.log(pad(r.rel.slice(0, 41), 42), pad(r.arch, 8), pad(r.libc, 6), pad(r.symbols, 5),
              pad(r.napiUndef, 6), pad(r.getVerAddr === null ? '-' : '0x' + r.getVerAddr.toString(16), 10),
              pad(r.regV1 ? 'yes' : '-', 6), pad(r.modReg ? 'yes' : '-', 7), r.nodeUndef);
}

// Classification landscape: which signal would decide each artifact?
const napiDeclared = rows.filter((r) => r.getVerAddr !== null);
const napiFloor = rows.filter((r) => r.getVerAddr === null && r.napiUndef > 0);
const rawV8 = rows.filter((r) => r.getVerAddr === null && r.napiUndef === 0 && r.modReg);
const neither = rows.filter((r) => r.getVerAddr === null && r.napiUndef === 0 && !r.modReg);

console.log(`\nlandscape (${rows.length} artifacts):`);
console.log(`  S1 declared N-API version present : ${napiDeclared.length}`);
console.log(`  S2 N-API, floor from imports only : ${napiFloor.length}`);
console.log(`  S3 raw-V8 (node_module_register)  : ${rawV8.length}`);
console.log(`  S4 neither -- not a Node addon?   : ${neither.length}`);
if (neither.length) {
  console.log('     ' + neither.map((r) => `${r.rel} (nodeU=${r.nodeUndef})`).join('\n     '));
}
const archs = {};
for (const r of rows) archs[r.arch] = (archs[r.arch] ?? 0) + 1;
console.log(`  architectures: ${Object.entries(archs).map(([k, v]) => k + '=' + v).join(' ')}`);
