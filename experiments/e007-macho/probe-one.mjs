// E007 probe 2: why does an addon report zero N-API imports?
// Dump the symbol-type histogram and a sample of names for one image.
import fs from 'node:fs';
import { readSlices, readImage, readSymbols } from '../../src/artifact/macho-addon.mjs';

const file = process.argv[2];
const want = process.argv[3] ?? '';
const buf = fs.readFileSync(file);
for (const sl of readSlices(buf)) {
  const img = readImage(buf, sl.base);
  const syms = readSymbols(buf, img);
  console.log(`\n=== ${img.arch}  base=${sl.base}  syms=${syms.length}  symtab=`, img.symtab);
  const h = new Map();
  for (const s of syms) {
    const k = `${s.defined ? 'SECT' : s.undef ? 'UNDF' : 'other'}${s.external ? '/ext' : ''}`;
    h.set(k, (h.get(k) ?? 0) + 1);
  }
  console.log('type histogram:', [...h]);
  const hits = syms.filter((s) => s.name.includes(want));
  console.log(`names containing ${JSON.stringify(want)}: ${hits.length}`);
  for (const s of hits.slice(0, 12)) {
    console.log(`   ${s.defined ? 'SECT' : s.undef ? 'UNDF' : '????'}${s.external ? ' ext' : '    '} ` +
                `sect=${s.sect} value=0x${s.value.toString(16)}  ${s.name}`);
  }
  console.log('first 8 UNDF:', syms.filter((s) => s.undef).slice(0, 8).map((s) => s.name));
  console.log('sections:', img.sections.map((s) => `${s.segname},${s.name}@0x${s.addr.toString(16)}+${s.size}${s.zerofill ? ' ZF' : ''}`).join(' '));
}
