// Read the immediate returned by a constant-returning function.
//
// `node_api_module_get_api_version_v1` compiles to "load constant into the return
// register, return". That is the only reliable place the DECLARED N-API minimum
// exists in a stripped artifact, and E001 showed the declared value is what decides
// loadability (M-static 291/291 vs import-floor 288/291).
//
// On PE this was a single pattern (`b8 imm32 c3`) because the corpus was x64/arm64
// Windows. ELF prebuilds are shipped for six architectures, so the decode is
// per-architecture. Each decoder is deliberately tiny and refuses rather than
// guesses: an unrecognised code shape returns null, which becomes an `unknown`
// constraint, which refuses. Being unable to read an artifact must never look like
// permission to load it.
//
// Validated by cross-architecture agreement -- the same package version declares
// one value, so six independent decoders agreeing is strong evidence that all six
// are right. See docs/experiments/e005-elf-requirement.md.

const RET_A64 = 0xd65f03c0; // ret
const RET_LA64 = 0x4c000020; // jirl $zero, $ra, 0
const RET_RV_C = 0x8082;     // c.jr ra
const RET_RV = 0x00008067;   // jalr x0, 0(x1)

/**
 * @param {Buffer} buf   whole artifact
 * @param {number} off   file offset of the function
 * @param {string} arch  'x64'|'ia32'|'arm64'|'arm'|'riscv64'|'loong64'
 * @param {number} win   bytes to scan
 * @returns {number|null} the immediate, or null if not unambiguously readable
 */
export function readConstReturn(buf, off, arch, win = 48) {
  if (off == null || off < 0 || off >= buf.length) return null;
  const end = Math.min(buf.length, off + win);
  const found = new Set();

  const u16 = (o) => buf.readUInt16LE(o);
  const u32 = (o) => buf.readUInt32LE(o);

  if (arch === 'x64' || arch === 'ia32') {
    // Tier 1: mov eax, imm32 (b8 imm32) followed by ret, allowing a short
    // epilogue (pop rbp / leave / pop rbx) in between. This is the common shape.
    const tight = new Set();
    for (let o = off; o + 5 < end; o++) {
      if (buf[o] !== 0xb8) continue;
      let p = o + 5;
      let hops = 0;
      while (p < end && hops < 4 && (buf[p] === 0x5d || buf[p] === 0xc9 || buf[p] === 0x5b)) { p++; hops++; }
      if (p < end && buf[p] === 0xc3) tight.add(u32(o + 1));
    }
    // Tier 2: OpenBSD's retguard puts ~26 bytes of cookie check and int3 padding
    // between the immediate and the ret, so proximity cannot be required. Accept a
    // lone `b8 imm32` provided the function does contain a ret. Ambiguity between
    // two differing immediates still refuses, so a stray b8 costs a false
    // positive, never a false negative.
    if (tight.size === 1) {
      found.add([...tight][0]);
    } else if (tight.size === 0) {
      let hasRet = false;
      for (let p = off; p < end; p++) if (buf[p] === 0xc3) { hasRet = true; break; }
      if (hasRet) {
        for (let o = off; o + 5 <= end; o++) {
          if (buf[o] === 0xb8) found.add(u32(o + 1));
        }
      }
    } else {
      for (const v of tight) found.add(v);
    }
    // xor eax,eax; ret  -> 0
    for (let o = off; o + 2 < end; o++) {
      if ((buf[o] === 0x31 || buf[o] === 0x33) && buf[o + 1] === 0xc0 && buf[o + 2] === 0xc3) found.add(0);
    }
  } else if (arch === 'arm64') {
    // movz w0, #imm16   ->  0x52800000 | (imm << 5)
    for (let o = off; o + 4 <= end; o += 4) {
      const w = u32(o);
      if ((w & 0xffe0001f) === 0x52800000) {
        // require a ret within the next few instructions
        for (let p = o + 4; p + 4 <= Math.min(end, o + 20); p += 4) {
          if (u32(p) === RET_A64) { found.add((w >>> 5) & 0xffff); break; }
        }
      }
    }
  } else if (arch === 'arm') {
    // Thumb-2: movs r0, #imm8 (0x20xx) then bx lr (0x4770).
    for (let o = off; o + 2 <= end; o += 2) {
      const h = u16(o);
      if ((h & 0xff00) === 0x2000) {
        for (let p = o + 2; p + 2 <= Math.min(end, o + 12); p += 2) {
          if (u16(p) === 0x4770) { found.add(h & 0xff); break; }
        }
      }
    }
  } else if (arch === 'riscv64') {
    for (let o = off; o + 2 <= end; o += 2) {
      const h = u16(o);
      // c.li a0, imm6  (funct3=010, op=01, rd=a0)
      if ((h & 0xef83) === 0x4501) {
        let imm = ((h >>> 2) & 0x1f) | (((h >>> 12) & 1) << 5);
        if (imm & 0x20) imm -= 0x40; // sign-extend 6 bits
        if (hasRvRet(buf, o + 2, Math.min(end, o + 16), u16, u32)) found.add(imm);
      }
      // addi a0, zero, imm12  (0x00000513 | imm<<20)
      if (o + 4 <= end) {
        const w = u32(o);
        if ((w & 0x000fffff) === 0x00000513) {
          let imm = (w >>> 20) & 0xfff;
          if (imm & 0x800) imm -= 0x1000;
          if (hasRvRet(buf, o + 4, Math.min(end, o + 16), u16, u32)) found.add(imm);
        }
      }
    }
  } else if (arch === 'loong64') {
    // addi.w/addi.d $a0, $zero, imm12 ; also ori $a0, $zero, imm12
    for (let o = off; o + 4 <= end; o += 4) {
      const w = u32(o);
      const isAddiW = (w & 0xffc003ff) === 0x02800004;
      const isAddiD = (w & 0xffc003ff) === 0x02c00004;
      const isOri = (w & 0xffc003ff) === 0x03800004;
      if (!isAddiW && !isAddiD && !isOri) continue;
      for (let p = o + 4; p + 4 <= Math.min(end, o + 20); p += 4) {
        if (u32(p) === RET_LA64) { found.add((w >>> 10) & 0xfff); break; }
      }
    }
  } else {
    return null;
  }

  // Ambiguity is not resolved by preferring one match -- it is refused. A wrong
  // immediate is a false negative, and false negatives are the failure mode this
  // project treats as unacceptable.
  if (found.size !== 1) return null;
  const v = [...found][0];
  return v >= 0 && v <= 0x7fffffff ? v : null;
}

function hasRvRet(buf, from, to, u16, u32) {
  for (let p = from; p + 2 <= to; p += 2) {
    if (u16(p) === RET_RV_C) return true;
    if (p + 4 <= to && u32(p) === RET_RV) return true;
  }
  return false;
}

/**
 * ARM thumb function addresses carry bit 0 set. Masking it on other
 * architectures reads one byte early -- which is exactly how sharp's
 * `b8 09 00 00 00 c3` first appeared as `ff b8 09 ...`.
 */
export function normalizeFuncAddr(va, arch) {
  return arch === 'arm' ? va & ~1 : va;
}
