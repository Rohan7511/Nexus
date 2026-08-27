// E007 probe: is the node_module struct readable in an ELF .data section?
// Same method as the Mach-O probe -- the filename states the expected NODE_MODULE_VERSION,
// so search for that u32 and dump the record around every hit. The question that decides
// the design is what the POINTER slots hold: a plain link-time vaddr (usable) or something
// relocation-dependent (not).
import fs from 'node:fs';
import path from 'node:path';
import { readElf } from '../../src/artifact/elf.mjs';

const file = process.argv[2];
const expect = Number(process.argv[3] ?? path.basename(file).match(/abi(\d+)/)?.[1]);
const buf = fs.readFileSync(file);
const elf = readElf(buf);
const SHT_NOBITS = 8;
let lo = Infinity, hi = 0;
for (const s of elf.sections) {
  if (!s.addr || !s.size) continue;
  lo = Math.min(lo, s.addr); hi = Math.max(hi, s.addr + s.size);
}
console.log(`${path.basename(file)}  arch=${elf.arch} expecting nm_version=${expect}  ` +
            `vm=[0x${lo.toString(16)},0x${hi.toString(16)})`);

for (const s of elf.sections) {
  if (s.type === SHT_NOBITS || !s.size || !s.addr) continue;
  if (!/^\.(data|data\.rel\.ro|bss|rodata)/.test(s.name ?? '')) continue;
  const end = Math.min(s.offset + s.size, buf.length);
  for (let o = s.offset; o + 64 <= end; o += 4) {
    if (buf.readUInt32LE(o) !== expect) continue;
    const q = (k) => buf.readBigUInt64LE(o + k).toString(16).padStart(16, '0');
    console.log(`  hit ${s.name} off=0x${o.toString(16)} vaddr=0x${(s.addr + (o - s.offset)).toString(16)}`);
    console.log(`     +0  version=${buf.readUInt32LE(o)} flags=0x${buf.readUInt32LE(o + 4).toString(16)}`);
    for (const [k, n] of [[8, 'dso_handle'], [16, 'filename'], [24, 'regFn'],
                          [32, 'ctxRegFn'], [40, 'modname'], [48, 'priv'], [56, 'link']]) {
      console.log(`     +${String(k).padEnd(2)} ${n.padEnd(10)} = ${q(k)}`);
    }
  }
}
