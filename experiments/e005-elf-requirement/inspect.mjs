// E005: inspect one artifact's symbol landscape in detail.
//   node experiments/e005-elf-requirement/inspect.mjs <substring>

import fs from 'node:fs';
import path from 'node:path';
import { readElf } from '../../src/artifact/elf.mjs';
import { readDynsym, vaddrToOffset } from './elf-sym.mjs';

const HOME = process.env.USERPROFILE;

export function discover(root, depth) {
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

export function corpus() {
  return [
    ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
    ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
    ...discover(path.join(HOME, '.vscode/extensions'), 6),
    ...discover('experiments/e004-vertical-slice/demo', 6),
  ];
}

if (process.argv[2]) {
  const want = process.argv[2].toLowerCase();
  const hits = corpus().filter((f) => f.toLowerCase().includes(want));
  if (!hits.length) { console.log('no match for ' + want); process.exit(1); }
  for (const f of hits.slice(0, 2)) {
    const buf = fs.readFileSync(f);
    const elf = readElf(buf);
    if (!elf) { console.log('not ELF: ' + f); continue; }
    const syms = readDynsym(buf, elf);
    console.log('\n=== ' + f);
    console.log(`arch=${elf.arch} os=${elf.os} libc=${elf.libc} is64=${elf.is64} symbols=${syms.length}`);
    const napi = syms.filter((s) => /napi|node_api/i.test(s.name));
    console.log(`napi-ish symbols: ${napi.length}`);
    for (const s of napi.slice(0, 20)) {
      const off = s.defined ? vaddrToOffset(elf, s.value) : null;
      console.log(`   ${s.defined ? 'DEF  ' : 'UNDEF'} ${s.name}` +
        (off !== null ? `  va=0x${s.value.toString(16)} off=0x${off.toString(16)} bytes=${buf.subarray(off, off + 12).toString('hex')}` : ''));
    }
    const undef = syms.filter((s) => !s.defined);
    console.log(`undefined symbols: ${undef.length} (first 25)`);
    for (const s of undef.slice(0, 25)) console.log('   ' + s.name);
    console.log('sections: ' + elf.sections.map((s) => s.name).filter(Boolean).join(' '));
  }
}
