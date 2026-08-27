import fs from 'node:fs';
import { readSlices, readImage } from '../../src/artifact/macho-addon.mjs';
const buf = fs.readFileSync(process.argv[2]);
const sl = readSlices(buf)[0];
const img = readImage(buf, sl.base);
// Scan every non-zerofill section for NUL-terminated napi_/node_api_ identifiers.
const found = new Map();
for (const s of img.sections) {
  if (s.zerofill || !s.size) continue;
  const seg = buf.subarray(s.offset, Math.min(s.offset + s.size, buf.length));
  const re = /(?:^|\0)((?:napi|node_api)_[a-z0-9_]{2,60})\0/g;
  const txt = seg.toString('latin1');
  let m;
  while ((m = re.exec(txt))) {
    const k = m[1];
    if (!found.has(k)) found.set(k, `${s.segname},${s.name}`);
    re.lastIndex--;                       // allow adjacent strings sharing a NUL
  }
}
console.log(`distinct napi_/node_api_ strings: ${found.size}`);
const bySec = new Map();
for (const [, sec] of found) bySec.set(sec, (bySec.get(sec) ?? 0) + 1);
console.log('by section:', [...bySec]);
console.log([...found.keys()].sort().join(' '));
