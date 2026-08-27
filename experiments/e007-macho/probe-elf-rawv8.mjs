// E007 probe: is there a raw-V8 ELF corpus after all?
// E005 refused raw-V8 ELF because the local corpus held none. The HackerRank tree ships
// linux prebuilds of the same raw-V8 packages that supplied the Mach-O corpus, so the
// premise of that refusal needs rechecking before it is restated.
import fs from 'node:fs';
import path from 'node:path';
import { readElf } from '../../src/artifact/elf.mjs';
import * as elfAddon from '../../src/artifact/elf-addon.mjs';

const files = [];
const walk = (d, depth) => {
  if (depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.isFile() && /\.(node|so)(\.\d+)*$/i.test(e.name)) files.push(p);
  }
};
for (const r of process.argv.slice(2)) walk(r, 0);

const tally = new Map();
const raw = [];
for (const p of files.sort()) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { continue; }
  if (buf.length < 4 || buf.readUInt32BE(0) !== 0x7f454c46) continue;
  const elf = readElf(buf);
  if (!elf) continue;
  const syms = elfAddon.readDynsym(buf, elf);
  const cls = syms.length ? elfAddon.classify(syms) : 'no-dynsym';
  tally.set(cls, (tally.get(cls) ?? 0) + 1);
  if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
    raw.push({ p, arch: elf.arch, label: Number(path.basename(p).match(/abi(\d+)/)?.[1]) || null, cls });
  }
}
console.log(`ELF files: ${files.length} scanned`);
console.log('classes:', [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join('  '));
console.log(`\nraw-V8 ELF artifacts: ${raw.length}`);
for (const r of raw) {
  console.log(`  ${r.cls.padEnd(13)} ${(r.arch ?? '?').padEnd(8)} ${(r.label ? 'abi' + r.label : 'unlabelled').padEnd(11)} ` +
              r.p.replace(/^.*node_modules[\\/]/, ''));
}
