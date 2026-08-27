// ELF reader: enough to derive platform constraints for a .node shared object.
//
// The libc flavour matters as much as the machine type -- publishers ship
// separate linux-x64-gnu and linux-x64-musl artifacts precisely because they are
// not interchangeable -- so this reader recovers it from the dynamic string
// table. Note .node files are shared objects (ET_DYN) and therefore have no
// PT_INTERP, so the interpreter path is NOT available as a signal; DT_NEEDED
// entries in .dynstr are.

const ELF_MACHINE = {
  3: 'ia32', 40: 'arm', 62: 'x64', 183: 'arm64',
  243: 'riscv64', 258: 'loong64',
};

export function readElf(buf) {
  if (buf.length < 64 || buf[0] !== 0x7f || buf.subarray(1, 4).toString('latin1') !== 'ELF') {
    return null;
  }
  const is64 = buf[4] === 2;
  const le = buf[5] !== 2;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const uptr = (o) => (is64
    ? Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))
    : u32(o));

  const machine = u16(18);
  const arch = ELF_MACHINE[machine] ?? null;

  // Section headers: needed to locate .dynstr.
  const shoff = is64 ? uptr(40) : u32(32);
  const shentsize = u16(is64 ? 58 : 46);
  const shnum = u16(is64 ? 60 : 48);
  const shstrndx = u16(is64 ? 62 : 50);

  const cstr = (off) => {
    if (off < 0 || off >= buf.length) return '';
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.subarray(off, e).toString('latin1');
  };

  const sections = [];
  if (shoff > 0 && shnum > 0 && shoff + shnum * shentsize <= buf.length) {
    for (let i = 0; i < shnum; i++) {
      const o = shoff + i * shentsize;
      sections.push({
        nameOff: u32(o),
        type: u32(o + 4),
        // sh_addr is needed to map a symbol's virtual address back to a file
        // offset, which is how the declared-N-API immediate is reached.
        addr: is64 ? uptr(o + 16) : u32(o + 12),
        offset: is64 ? uptr(o + 24) : u32(o + 16),
        size: is64 ? uptr(o + 32) : u32(o + 20),
      });
    }
    const shstr = sections[shstrndx];
    if (shstr) for (const s of sections) s.name = cstr(shstr.offset + s.nameOff);
  }

  // Collect every NUL-separated string in .dynstr. DT_NEEDED values live here,
  // as do the GLIBC_x.y version tags referenced by .gnu.version_r.
  const strings = [];
  for (const s of sections) {
    if (s.name !== '.dynstr') continue;
    if (s.offset + s.size > buf.length) continue;
    const blob = buf.subarray(s.offset, s.offset + s.size).toString('latin1');
    for (const part of blob.split('\0')) if (part) strings.push(part);
  }

  const needed = strings.filter((x) => /^lib.*\.so($|\.)/.test(x));
  const osabi = buf[7];
  return { format: 'elf', os: classifyOs(osabi, needed), osabi, arch, is64, machine,
           sections, strings, needed, libc: classifyLibc(strings, needed) };
}

// ELF is not a Linux-only format, and treating it as one is unsafe. koffi ships
// freebsd_* and openbsd_* .node artifacts that are ELF/x64 and would otherwise be
// handed linux/x64 constraints -- accepted on a Linux host, then failing. This
// host (win32) refuses them for other reasons, which is exactly why the E001
// corpus could not surface the bug.
//
// EI_OSABI is authoritative when set, but Linux toolchains usually leave it
// ELFOSABI_SYSV (0), so fall back to the shape of the DT_NEEDED list.
function classifyOs(osabi, needed) {
  if (osabi === 9) return 'freebsd';
  if (osabi === 12) return 'openbsd';
  if (osabi === 3) return 'linux';
  if (needed.includes('libc.so.7')) return 'freebsd';
  // OpenBSD uses two-component shared-object versions (libpthread.so.26.1).
  if (needed.some((n) => /\.so\.\d+\.\d+$/.test(n))) return 'openbsd';
  if (needed.some((n) => /^libc\.(so\.6|musl-)/.test(n) || n === 'libc.so')) return 'linux';
  if (needed.some((n) => /^lib(stdc\+\+|gcc_s|m|dl|pthread|rt)\.so\.\d+$/.test(n))) return 'linux';
  return null; // undetermined -> callers must refuse, not assume
}

// musl and glibc leave distinct fingerprints in .dynstr. Checked in order of
// specificity; an artifact linking neither yields null, which callers must treat
// as unknown rather than as "either".
function classifyLibc(strings, needed) {
  const joined = strings.join('\n');
  if (/libc\.musl-|ld-musl-/.test(joined)) return 'musl';
  if (needed.includes('libc.so.6') || /\bGLIBC_\d/.test(joined)) return 'glibc';
  // glibc always needs a versioned libc.so.6; an unversioned libc.so is musl's
  // other form, emitted by some Rust musl targets (wreq-js.linux-x64-musl).
  if (needed.includes('libc.so')) return 'musl';
  return null;
}
