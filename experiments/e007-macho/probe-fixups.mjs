// E007 probe: which fixup mechanism does each image use?
// LC_DYLD_CHAINED_FIXUPS leaves packed encodings in __DATA pointer slots; classic
// LC_DYLD_INFO(_ONLY) rebase leaves plain unrelocated vmaddrs. The answer decides how
// tolerant the raw-V8 pointer test has to be -- and writing speculative chained-fixup
// decoding with no artifact that needs it would be unvalidated code.
import fs from 'node:fs';
import path from 'node:path';
import { readSlices } from '../../src/artifact/macho-addon.mjs';

const NAMES = {
  0x22: 'LC_DYLD_INFO', 0x80000022: 'LC_DYLD_INFO_ONLY',
  0x80000034: 'LC_DYLD_CHAINED_FIXUPS', 0x80000035: 'LC_DYLD_EXPORTS_TRIE',
};

const files = [];
const walk = (d, depth) => {
  if (depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.isFile() && /\.(node|dylib)$/i.test(e.name)) files.push(p);
  }
};
for (const r of process.argv.slice(2)) walk(r, 0);

const tally = new Map();
for (const p of files.sort()) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { continue; }
  for (const sl of readSlices(buf)) {
    const b = sl.base;
    if (b + 32 > buf.length) continue;
    const magic = buf.readUInt32LE(b);
    const is64 = magic === 0xfeedfacf;
    if (magic !== 0xfeedfacf && magic !== 0xfeedface) continue;
    const ncmds = buf.readUInt32LE(b + 16);
    let o = b + (is64 ? 32 : 28);
    const kinds = [];
    for (let i = 0; i < ncmds && o + 8 <= buf.length; i++) {
      const cmd = buf.readUInt32LE(o);
      const cs = buf.readUInt32LE(o + 4);
      if (cs < 8) break;
      if (NAMES[cmd]) kinds.push(NAMES[cmd]);
      o += cs;
    }
    const key = kinds.sort().join('+') || '(none)';
    if (!tally.has(key)) tally.set(key, []);
    tally.get(key).push(`${path.basename(p)}:${sl.arch ?? '?'}`);
  }
}
for (const [k, v] of tally) {
  console.log(`${k}  ->  ${v.length} image(s)`);
  console.log(`    e.g. ${v.slice(0, 4).join(', ')}`);
}
