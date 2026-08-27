import fs from 'node:fs';
import { readSlices, readImage } from '../../src/artifact/macho-addon.mjs';
const buf = fs.readFileSync(process.argv[2]);
const sl = readSlices(buf)[0];
const img = readImage(buf, sl.base);
const found = new Map();
for (const s of img.sections) {
  if (s.zerofill || !s.size) continue;
  const txt = buf.subarray(s.offset, Math.min(s.offset + s.size, buf.length)).toString('latin1');
  for (const m of txt.matchAll(/(?:napi|node_api)_[a-z0-9_]{2,60}/g)) {
    const k = m[0];
    if (!found.has(k)) found.set(k, `${s.segname},${s.name}`);
  }
}
console.log(`distinct matches: ${found.size}`);
const bySec = new Map();
for (const [, sec] of found) bySec.set(sec, (bySec.get(sec) ?? 0) + 1);
console.log('by section:', [...bySec]);
console.log([...found.keys()].sort().slice(0, 200).join('\n'));
