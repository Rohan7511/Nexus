// E007 probe: confirm the ELF candidate really is a node_module struct by reading the
// strings its pointers name, and find a replacement discriminator for the regFn/ctxRegFn
// test that ELF does not satisfy.
import fs from 'node:fs';
import path from 'node:path';
import { readElf } from '../../src/artifact/elf.mjs';
import { vaddrToOffset } from '../../src/artifact/elf-addon.mjs';

const file = process.argv[2];
const expect = Number(process.argv[3] ?? path.basename(file).match(/abi(\d+)/)?.[1]);
const buf = fs.readFileSync(file);
const elf = readElf(buf);
const cstr = (va) => {
  const o = vaddrToOffset(elf, va);
  if (o == null) return `<unmapped 0x${va.toString(16)}>`;
  let e = o;
  while (e < buf.length && buf[e] !== 0 && e - o < 200) e++;
  return JSON.stringify(buf.subarray(o, e).toString('latin1'));
};

for (const s of elf.sections) {
  if (s.type === 8 || !s.size || !s.addr) continue;
  if (!/^\.(data|data\.rel\.ro)/.test(s.name ?? '')) continue;
  const end = Math.min(s.offset + s.size, buf.length);
  for (let o = s.offset; o + 64 <= end; o += 4) {
    if (buf.readUInt32LE(o) !== expect) continue;
    const q = (k) => Number(buf.readBigUInt64LE(o + k));
    console.log(`${path.basename(file)} ${s.name}@0x${o.toString(16)}`);
    console.log(`   filename -> ${cstr(q(16))}`);
    console.log(`   modname  -> ${cstr(q(40))}`);
  }
}
