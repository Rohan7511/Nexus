// E007 probe: would a dictionary string-scan floor exceed the header default of 8?
// If not, the dlsym hole has no consequence on this corpus and needs no new code.
import fs from 'node:fs';
import { readSlices, readImage } from '../../src/artifact/macho-addon.mjs';
import { resolveNapiMap } from '../../src/artifact/napi-map.mjs';

const { map } = resolveNapiMap();
const buf = fs.readFileSync(process.argv[2]);
const sl = readSlices(buf)[0];
const img = readImage(buf, sl.base);

let hay = '';
for (const s of img.sections) {
  if (s.zerofill || !s.size) continue;
  if (!/^__(const|cstring|data)$/.test(s.name)) continue;
  hay += buf.subarray(s.offset, Math.min(s.offset + s.size, buf.length)).toString('latin1');
}

const hits = [];
for (const [sym, min] of map) if (hay.includes(sym)) hits.push([sym, min]);
hits.sort((a, b) => b[1] - a[1]);
console.log(`map size ${map.size}; string hits ${hits.length}`);
console.log('floor =', hits.length ? Math.max(...hits.map((h) => h[1])) : 0);
console.log('highest hits:', hits.slice(0, 14).map((h) => `${h[0]}=${h[1]}`).join(' '));
