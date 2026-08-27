// E007 probe: what does a node_module struct actually look like in Mach-O __DATA?
//
// The filename states a hypothesis (dd_pprof.node.abi127.node -> nm_version 127).
// So instead of guessing a validation predicate and hoping, search __DATA for that
// u32 and dump the 64 bytes around every hit. Whatever the real struct looks like on
// Mach-O, it is in this output -- including what the pointer slots hold, which is the
// one thing that does NOT carry over from PE.
import fs from 'node:fs';
import path from 'node:path';
import { readSlices, readImage } from '../../src/artifact/macho-addon.mjs';

const file = process.argv[2];
const expect = Number(process.argv[3] ?? path.basename(file).match(/abi(\d+)/)?.[1]);
const buf = fs.readFileSync(file);
console.log(`${path.basename(file)}  expecting nm_version=${expect}`);

for (const sl of readSlices(buf)) {
  const img = readImage(buf, sl.base);
  if (!img) continue;
  console.log(`\n--- ${img.arch}  vm=[0x${img.vmLow.toString(16)},0x${img.vmHigh.toString(16)})`);
  for (const s of img.sections) {
    if (s.zerofill || !s.size) continue;
    if (!/^__DATA/.test(s.segname)) continue;
    const end = Math.min(s.offset + s.size, buf.length);
    for (let o = s.offset; o + 64 <= end; o += 4) {
      if (buf.readUInt32LE(o) !== expect) continue;
      const q = (k) => buf.readBigUInt64LE(o + k).toString(16).padStart(16, '0');
      console.log(`  hit ${s.segname},${s.name} off=0x${o.toString(16)} ` +
                  `vaddr=0x${(s.addr + (o - s.offset)).toString(16)}`);
      console.log(`     +0  version=${buf.readUInt32LE(o)} flags=0x${buf.readUInt32LE(o + 4).toString(16)}`);
      console.log(`     +8  dso_handle = ${q(8)}`);
      console.log(`     +16 filename   = ${q(16)}`);
      console.log(`     +24 regFn      = ${q(24)}`);
      console.log(`     +32 ctxRegFn   = ${q(32)}`);
      console.log(`     +40 modname    = ${q(40)}`);
      console.log(`     +48 priv       = ${q(48)}`);
      console.log(`     +56 link       = ${q(56)}`);
    }
  }
}
