// ELF .dynsym reader, shared by the E005 probe and deriver.
//
// .dynsym is the loader-visible symbol table. It survives stripping (which every
// shipped prebuild has been through) because the dynamic linker needs it, whereas
// .symtab does not. Both the declared-version symbol and the undefined napi_*
// imports are visible here.

/**
 * @param {Buffer} buf
 * @param {{sections:object[], is64:boolean}} elf  from readElf()
 * @returns {{name:string, shndx:number, value:number, defined:boolean}[]}
 */
export function readDynsym(buf, elf) {
  const sym = elf.sections.find((s) => s.name === '.dynsym');
  const str = elf.sections.find((s) => s.name === '.dynstr');
  if (!sym || !str) return [];
  if (sym.offset + sym.size > buf.length || sym.size === 0) return [];

  const is64 = elf.is64;
  const le = buf[5] !== 2;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const uptr = (o) => (is64
    ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))
    : u32(o));
  const entsize = is64 ? 24 : 16;

  const cstr = (off) => {
    if (off < 0 || off >= buf.length) return '';
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.subarray(off, e).toString('latin1');
  };

  const out = [];
  const n = Math.floor(sym.size / entsize);
  for (let i = 0; i < n; i++) {
    const o = sym.offset + i * entsize;
    const nameOff = u32(o);
    if (!nameOff) continue;
    const name = cstr(str.offset + nameOff);
    if (!name) continue;
    // 64-bit: name,info,other,shndx,value,size.
    // 32-bit: name,value,size,info,other,shndx.
    const shndx = is64 ? u16(o + 6) : u16(o + 14);
    const value = is64 ? uptr(o + 8) : u32(o + 4);
    out.push({ name, shndx, value, defined: shndx !== 0 });
  }
  return out;
}

/** Virtual address -> file offset, via section headers. */
export function vaddrToOffset(elf, va) {
  for (const s of elf.sections) {
    if (s.type === 8) continue; // SHT_NOBITS occupies no file space
    if (s.addr == null) continue;
    if (va >= s.addr && va < s.addr + s.size) return s.offset + (va - s.addr);
  }
  return null;
}
