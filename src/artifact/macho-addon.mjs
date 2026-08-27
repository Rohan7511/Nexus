// Mach-O addon analysis: slices, symbols, and the requirement axis.
//
// The Mach-O analogue of elf-addon.mjs / pe-addon.mjs. Mach-O was the last container
// format whose requirement axis was underived, which made Nexus sound-but-unusable on
// macOS -- the explicit gate carried out of Phase 7.
//
// Two things make Mach-O different from ELF, and both are load-bearing:
//
//  * A universal ("fat") file carries a complete image per architecture. So the
//    requirement is derived PER SLICE and the slices must AGREE. That is E005's
//    cross-architecture oracle enforced at derivation time rather than in a
//    write-up: two slices of one file disagreeing means the read is wrong, and the
//    honest response is to refuse.
//  * Pointer slots in __DATA are not final on disk. Classic dyld rebase leaves the
//    unrelocated vmaddr; chained fixups (LC_DYLD_CHAINED_FIXUPS, the default on
//    modern macOS) leave a PACKED ENCODING whose low bits are the target and whose
//    high bits are fixup metadata. PE's "pointer is null or inside the image" test
//    therefore does not transfer, and assuming it did would silently reject every
//    real struct. See readRawNmVersion.

import { readConstReturn, normalizeFuncAddr } from './code-imm.mjs';
import { findNodeModule } from './node-module-struct.mjs';

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const LC_SEGMENT = 0x01;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;

const CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm' };

// n_type field of struct nlist. N_STAB entries are debug info, not linkage.
const N_STAB = 0xe0;
const N_TYPE = 0x0e;
const N_EXT = 0x01;
const N_UNDF = 0x00;
const N_SECT = 0x0e;

const GETVER = 'node_api_module_get_api_version_v1';
const ENTRY = 'napi_register_module_v1';
const NAPI_RE = /^(napi_|node_api_)/;

/**
 * Every Mach-O image in the file. A thin file has one at offset 0; a fat file has one
 * per architecture, and every one of them has to be analyzed -- picking a single slice
 * would mean answering about an architecture the caller did not ask about.
 * @returns {{arch:string|null, base:number, size:number}[]}
 */
export function readSlices(buf) {
  if (buf.length < 8) return [];
  const be = buf.readUInt32BE(0);
  if (be !== FAT_MAGIC && be !== FAT_MAGIC_64) {
    const le = buf.readUInt32LE(0);
    const thin = le === MH_MAGIC || le === MH_MAGIC_64 || be === MH_MAGIC || be === MH_MAGIC_64;
    return thin ? [{ arch: null, base: 0, size: buf.length }] : [];
  }
  const wide = be === FAT_MAGIC_64;
  const entry = wide ? 32 : 20;
  const n = buf.readUInt32BE(4);
  const out = [];
  for (let i = 0; i < n && 8 + (i + 1) * entry <= buf.length; i++) {
    const o = 8 + i * entry;
    const arch = CPU[buf.readUInt32BE(o)] ?? null;
    const base = wide ? Number(buf.readBigUInt64BE(o + 8)) : buf.readUInt32BE(o + 8);
    const size = wide ? Number(buf.readBigUInt64BE(o + 16)) : buf.readUInt32BE(o + 12);
    if (base < 0 || base >= buf.length) continue;
    out.push({ arch, base, size: Math.min(size, buf.length - base) });
  }
  return out;
}

/**
 * Parse one image's header, segments/sections and symtab pointers. All offsets
 * returned are absolute in `buf`, already rebased by the slice base, so callers never
 * have to remember which slice they are in.
 * @returns {object|null}
 */
export function readImage(buf, base = 0) {
  if (base + 28 > buf.length) return null;
  const raw = buf.readUInt32LE(base);
  const rawBE = buf.readUInt32BE(base);
  let is64, le;
  if (raw === MH_MAGIC_64) { is64 = true; le = true; }
  else if (raw === MH_MAGIC) { is64 = false; le = true; }
  else if (rawBE === MH_MAGIC_64) { is64 = true; le = false; }
  else if (rawBE === MH_MAGIC) { is64 = false; le = false; }
  else return null;

  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const arch = CPU[u32(base + 4)] ?? null;
  const ncmds = u32(base + 16);
  const hdr = is64 ? 32 : 28;

  const sections = [];
  let symtab = null;
  let chained = false;
  let vmLow = null, vmHigh = null;
  let o = base + hdr;
  for (let i = 0; i < ncmds; i++) {
    if (o + 8 > buf.length) break;
    const cmd = u32(o);
    const cmdsize = u32(o + 4);
    if (cmdsize < 8 || o + cmdsize > buf.length) break;

    if (cmd === LC_DYLD_CHAINED_FIXUPS) {
      chained = true;
    } else if (cmd === LC_SYMTAB && o + 24 <= buf.length) {
      symtab = { symoff: base + u32(o + 8), nsyms: u32(o + 12),
                 stroff: base + u32(o + 16), strsize: u32(o + 20) };
    } else if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) {
      const wide = cmd === LC_SEGMENT_64;
      const segname = buf.subarray(o + 8, o + 24).toString('latin1').replace(/\0.*$/, '');
      const vmaddr = wide ? u64(o + 24) : u32(o + 24);
      const vmsize = wide ? u64(o + 32) : u32(o + 28);
      if (vmsize > 0) {
        vmLow = vmLow == null ? vmaddr : Math.min(vmLow, vmaddr);
        vmHigh = vmHigh == null ? vmaddr + vmsize : Math.max(vmHigh, vmaddr + vmsize);
      }
      const nsects = wide ? u32(o + 64) : u32(o + 48);
      const secSize = wide ? 80 : 68;
      let so = o + (wide ? 72 : 56);
      for (let s = 0; s < nsects && so + secSize <= o + cmdsize; s++, so += secSize) {
        const name = buf.subarray(so, so + 16).toString('latin1').replace(/\0.*$/, '');
        sections.push({
          name, segname,
          addr: wide ? u64(so + 32) : u32(so + 32),
          size: wide ? u64(so + 40) : u32(so + 36),
          offset: base + (wide ? u32(so + 48) : u32(so + 40)),
          // S_ZEROFILL sections occupy vm but no file bytes; reading them would
          // return whatever follows in the file.
          zerofill: ((wide ? u32(so + 64) : u32(so + 56)) & 0xff) === 1,
        });
      }
    }
    o += cmdsize;
  }
  return { is64, le, arch, base, sections, symtab, chained,
           vmLow: vmLow ?? 0, vmHigh: vmHigh ?? 0 };
}

/**
 * The symbol table. Mach-O keeps external and undefined symbols here after `strip`,
 * because the dynamic linker needs them -- the same reason ELF's .dynsym survives.
 * Names carry the C leading underscore, which is stripped so that callers compare
 * against the same identifiers on every platform.
 * @returns {{name:string, defined:boolean, external:boolean, value:number, sect:number}[]}
 */
export function readSymbols(buf, img) {
  const st = img.symtab;
  if (!st || !st.nsyms) return [];
  const entsize = img.is64 ? 16 : 12;
  if (st.symoff + st.nsyms * entsize > buf.length) return [];
  const u32 = (o) => (img.le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(img.le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));

  const cstr = (off) => {
    if (off < 0 || off >= buf.length) return '';
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.subarray(off, e).toString('latin1');
  };

  const out = [];
  for (let i = 0; i < st.nsyms; i++) {
    const o = st.symoff + i * entsize;
    const strx = u32(o);
    const nType = buf[o + 4];
    if (nType & N_STAB) continue;                       // debug entry, not linkage
    if (!strx) continue;
    const name = cstr(st.stroff + strx);
    if (!name) continue;
    const type = nType & N_TYPE;
    out.push({
      name: name.startsWith('_') ? name.slice(1) : name,
      defined: type === N_SECT,
      undef: type === N_UNDF,
      external: !!(nType & N_EXT),
      sect: buf[o + 5],
      value: img.is64 ? u64(o + 8) : u32(o + 8),
    });
  }
  return out;
}

/** Virtual address -> file offset via section table. Zerofill holds no bytes. */
export function vaddrToOffset(img, va) {
  for (const s of img.sections) {
    if (s.zerofill || !s.size) continue;
    if (va >= s.addr && va < s.addr + s.size) return s.offset + (va - s.addr);
  }
  return null;
}

/** Which requirement axis applies. Mirrors elf-addon.classify on Mach-O linkage. */
export function classify(syms) {
  const undef = syms.filter((s) => s.undef);
  const defined = syms.filter((s) => s.defined);
  if (undef.some((s) => s.name === 'node_module_register')) return 'raw-v8';
  if (defined.some((s) => s.name === GETVER || s.name === ENTRY)) return 'n-api';
  if (undef.some((s) => NAPI_RE.test(s.name))) return 'n-api';
  if (undef.some((s) => /^_?_ZN2v8|^_?_ZN4node/.test(s.name))) return 'raw-v8-noreg';
  return 'unknown';
}

/** Every N-API symbol the addon imports; the import floor is computed from these. */
export const napiImports = (syms) =>
  syms.filter((s) => s.undef && NAPI_RE.test(s.name)).map((s) => s.name);

/**
 * The declared N-API minimum, from the constant-returning accessor. Same decoders as
 * ELF -- the encoding is a property of the ARCHITECTURE, not of the container -- which
 * is why extending to Mach-O needed no new instruction patterns for x64 or arm64.
 */
export function readDeclaredNapi(buf, img, syms) {
  const ex = syms.find((s) => s.defined && s.name === GETVER);
  if (!ex) return { value: null, method: 'absent' };
  const off = vaddrToOffset(img, normalizeFuncAddr(ex.value, img.arch));
  if (off == null) return { value: null, method: 'unmapped-vaddr' };
  const v = readConstReturn(buf, off, img.arch);
  if (v == null) {
    return { value: null,
             method: 'unrecognised-prologue:' + buf.subarray(off, off + 12).toString('hex') };
  }
  return { value: v, method: 'const-return:' + img.arch };
}

/**
 * The exact NODE_MODULE_VERSION a raw-V8 addon was built against, read out of the
 * `struct node_module` that NODE_MODULE plants in __DATA. The predicate lives in
 * node-module-struct.mjs, shared with PE and ELF; this supplies the Mach-O addressing.
 *
 * WHY THE POINTER TEST IS AN IN-IMAGE TEST. [LE] Measured across the 49-image local
 * Mach-O corpus: 47 images carry LC_DYLD_INFO_ONLY, so __DATA pointer slots hold plain
 * *unrelocated* vmaddrs and "null or inside the image vm range" is exactly right. The only
 * two LC_DYLD_CHAINED_FIXUPS images are libonnxruntime.dylib, a plain shared library with
 * no node_module struct at all. Under chained fixups a slot holds a PACKED ENCODING whose
 * high bits are metadata, so the test would fail, no candidate would be found, and the
 * artifact would refuse. That is the safe direction -- but it is reported as its own reason,
 * because "this needs a decoder nobody has validated" and "this is not a raw-V8 addon" are
 * different facts and only one of them is a coverage gap. Speculatively decoding a format no
 * local artifact exercises would put an unvalidated number into a verdict.
 *
 * @returns {{value:number|null, method:string}}
 */
export function readRawNmVersion(buf, img) {
  if (!img.is64) return { value: null, method: 'raw-v8-32bit-macho-unvalidated' };
  if (img.chained) return { value: null, method: 'raw-v8-chained-fixups-undecoded' };

  return findNodeModule({
    buf,
    sections: img.sections.filter((s) => !s.zerofill && s.size && /^__DATA/.test(s.segname)),
    inImage: (v) => v >= img.vmLow && v < img.vmHigh,
    cstrAt: (va) => cstrAtOffset(buf, vaddrToOffset(img, va)),
    is64: img.is64,
  });
}

/** Read a NUL-terminated string at a file offset, bounded so a bad pointer cannot run away. */
function cstrAtOffset(buf, off, max = 256) {
  if (off == null || off < 0 || off >= buf.length) return null;
  let e = off;
  while (e < buf.length && buf[e] !== 0 && e - off < max) e++;
  return buf.subarray(off, e).toString('latin1');
}
