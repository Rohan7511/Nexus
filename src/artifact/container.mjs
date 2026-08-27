// Container dispatch: normalise PE / ELF / Mach-O into one platform shape.
//
// Axis 0 of the compatibility model. E001's key negative result was that platform
// must be checked for EVERY artifact, not only for foreign-looking ones: six
// wrong-architecture PE files (win32-arm64, win32_ia32) were called loadable and
// all six fail. So this returns a platform descriptor unconditionally, and
// `arch: null` is a refusal signal rather than a wildcard.

import { readElf } from './elf.mjs';
import { readMacho } from './macho.mjs';

const PE_MACHINE = {
  0x014c: 'ia32', 0x8664: 'x64', 0xaa64: 'arm64', 0x01c4: 'arm', 0x0200: 'ia64',
};

function readPeHeader(buf) {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // 'MZ'
  const e = buf.readUInt32LE(0x3c);
  if (e + 6 > buf.length) return null;
  if (buf.readUInt32LE(e) !== 0x00004550) return null; // 'PE\0\0'
  const machine = buf.readUInt16LE(e + 4);
  const arch = PE_MACHINE[machine] ?? null;
  return { format: 'pe', os: 'win32', arch, archs: arch ? [arch] : [], machine };
}

/**
 * Identify an artifact's container and target platform from its bytes.
 * @returns {{format:string, os:string|null, arch:string|null, archs:string[],
 *            libc:string|null, detail:object|null}}
 *   `format: 'unknown'` for anything unrecognised. Callers must refuse it.
 */
export function readContainer(buf) {
  const pe = readPeHeader(buf);
  if (pe) return { ...pe, libc: null, detail: null };

  const elf = readElf(buf);
  if (elf) {
    return {
      format: 'elf', os: elf.os, arch: elf.arch,
      archs: elf.arch ? [elf.arch] : [],
      libc: elf.libc,
      detail: { osabi: elf.osabi, needed: elf.needed },
    };
  }

  const mo = readMacho(buf);
  if (mo) {
    return {
      format: mo.format, os: 'darwin', arch: mo.arch, archs: mo.archs,
      libc: null, detail: mo.slices ? { slices: mo.slices } : null,
    };
  }

  return { format: 'unknown', os: null, arch: null, archs: [], libc: null, detail: null };
}
