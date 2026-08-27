// Mach-O reader: platform constraints only.
//
// Universal ("fat") binaries are the reason this is not a two-line function. A
// single .node can carry both x64 and arm64 slices, so architecture is a SET, not
// a scalar -- E001 recorded `arm64/kerberos.node` as `darwin/?` for exactly this
// reason and refused it. A refusal on the host's own OS is safe but wrong, so the
// arch set is derived here and `decide()` treats membership as satisfaction.

const MACHO_CPU = {
  0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm',
};

const MH_MAGIC = 0xfeedface;      // 32-bit, host-endian
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;     // always big-endian on disk
const FAT_MAGIC_64 = 0xcafebabf;  // 64-bit offsets/sizes

export function readMacho(buf) {
  if (buf.length < 8) return null;
  const be = buf.readUInt32BE(0);

  if (be === FAT_MAGIC || be === FAT_MAGIC_64) {
    const wide = be === FAT_MAGIC_64;
    const n = buf.readUInt32BE(4);
    const entry = wide ? 32 : 20;
    const archs = [];
    // A malformed count must not throw; cap the walk at the buffer.
    for (let i = 0; i < n && 8 + (i + 1) * entry <= buf.length; i++) {
      const o = 8 + i * entry;
      const a = MACHO_CPU[buf.readUInt32BE(o)];
      if (a && !archs.includes(a)) archs.push(a);
    }
    return { format: 'macho-fat', os: 'darwin', arch: null, archs: archs.sort(), slices: n };
  }

  const le = buf.readUInt32LE(0);
  let cpu = null;
  if (le === MH_MAGIC || le === MH_MAGIC_64) cpu = buf.readUInt32LE(4);
  else if (be === MH_MAGIC || be === MH_MAGIC_64) cpu = buf.readUInt32BE(4);
  else return null;

  const arch = MACHO_CPU[cpu] ?? null;
  return { format: 'macho', os: 'darwin', arch, archs: arch ? [arch] : [], cpu };
}
