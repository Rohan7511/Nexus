// Minimal PE/COFF reader. No dependencies.
// Only what E001 needs: export names+RVAs, import names per DLL, RVA->file offset.

export function readPE(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not MZ');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('not PE');

  const coff = peOff + 4;
  const machine = buf.readUInt16LE(coff);
  const numSections = buf.readUInt16LE(coff + 2);
  const sizeOptional = buf.readUInt16LE(coff + 16);
  const optOff = coff + 20;
  const magic = buf.readUInt16LE(optOff);
  const isPE32Plus = magic === 0x20b;
  const imageBase = isPE32Plus ? buf.readBigUInt64LE(optOff + 24) : BigInt(buf.readUInt32LE(optOff + 28));
  const sizeOfImage = buf.readUInt32LE(optOff + 56);

  // NumberOfRvaAndSizes then the data directory array.
  const ddOff = optOff + (isPE32Plus ? 112 : 96);
  const numDD = buf.readUInt32LE(optOff + (isPE32Plus ? 108 : 92));
  const dd = [];
  for (let i = 0; i < numDD; i++) {
    dd.push({ rva: buf.readUInt32LE(ddOff + i * 8), size: buf.readUInt32LE(ddOff + i * 8 + 4) });
  }

  const secOff = optOff + sizeOptional;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    sections.push({
      name: buf.subarray(o, o + 8).toString('latin1').replace(/\0+$/, ''),
      virtualSize: buf.readUInt32LE(o + 8),
      virtualAddress: buf.readUInt32LE(o + 12),
      sizeOfRawData: buf.readUInt32LE(o + 16),
      pointerToRawData: buf.readUInt32LE(o + 20),
    });
  }

  const rvaToOffset = (rva) => {
    for (const s of sections) {
      // Use raw size as the upper bound so we never point past file data.
      const span = Math.max(s.virtualSize, s.sizeOfRawData);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        const off = rva - s.virtualAddress + s.pointerToRawData;
        return off < buf.length ? off : null;
      }
    }
    return null;
  };

  const cstr = (off) => {
    if (off == null || off < 0 || off >= buf.length) return null;
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.subarray(off, e).toString('latin1');
  };

  // ---- exports (data directory 0) ----
  const exports_ = [];
  let dllName = null;
  if (dd[0] && dd[0].rva) {
    const eo = rvaToOffset(dd[0].rva);
    if (eo != null) {
      dllName = cstr(rvaToOffset(buf.readUInt32LE(eo + 12)));
      const numNames = buf.readUInt32LE(eo + 24);
      const addrFuncs = buf.readUInt32LE(eo + 28);
      const addrNames = buf.readUInt32LE(eo + 32);
      const addrOrd = buf.readUInt32LE(eo + 36);
      const fo = rvaToOffset(addrFuncs), no = rvaToOffset(addrNames), oo = rvaToOffset(addrOrd);
      if (no != null && fo != null && oo != null) {
        for (let i = 0; i < numNames; i++) {
          const nameRva = buf.readUInt32LE(no + i * 4);
          const ord = buf.readUInt16LE(oo + i * 2);
          const funcRva = buf.readUInt32LE(fo + ord * 4);
          exports_.push({ name: cstr(rvaToOffset(nameRva)), rva: funcRva });
        }
      }
    }
  }

  // ---- thunk list reader (shared by normal and delay-load imports) ----
  const readThunks = (thunkRva, out) => {
    let to = rvaToOffset(thunkRva);
    if (to == null) return;
    const step = isPE32Plus ? 8 : 4;
    for (; to + step <= buf.length; to += step) {
      const lo = buf.readUInt32LE(to);
      const hi = isPE32Plus ? buf.readUInt32LE(to + 4) : 0;
      if (lo === 0 && hi === 0) break;
      const isOrdinal = isPE32Plus ? (hi & 0x80000000) !== 0 : (lo & 0x80000000) !== 0;
      if (isOrdinal) { out.push('#ordinal' + (lo & 0xffff)); continue; }
      const no = rvaToOffset(lo);
      if (no == null) continue;
      const name = cstr(no + 2); // skip the 2-byte hint
      if (name) out.push(name);
    }
  };

  // ---- imports (data directory 1) ----
  const imports = {};
  if (dd[1] && dd[1].rva) {
    let io = rvaToOffset(dd[1].rva);
    if (io != null) {
      for (; io + 20 <= buf.length; io += 20) {
        const origThunk = buf.readUInt32LE(io);
        const nameRva = buf.readUInt32LE(io + 12);
        const firstThunk = buf.readUInt32LE(io + 16);
        if (origThunk === 0 && nameRva === 0 && firstThunk === 0) break;
        const dll = cstr(rvaToOffset(nameRva)) || '?';
        readThunks(origThunk || firstThunk, (imports[dll] ||= []));
      }
    }
  }

  // ---- delay-load imports (data directory 13) ----
  // node-gyp links Windows addons with a delay-load hook for node.exe, so the
  // node/napi symbols the addon needs sit HERE, not in directory 1. Skipping
  // this directory makes an ordinary addon look like it imports nothing from
  // node at all -- which is how keytar and onnxruntime_binding got classified
  // 'unknown' and then conservatively refused despite loading fine.
  const delayImports = {};
  if (dd[13] && dd[13].rva) {
    let dio = rvaToOffset(dd[13].rva);
    if (dio != null) {
      for (; dio + 32 <= buf.length; dio += 32) {
        const grAttrs = buf.readUInt32LE(dio);
        const rvaDLLName = buf.readUInt32LE(dio + 4);
        const rvaIAT = buf.readUInt32LE(dio + 12);
        const rvaINT = buf.readUInt32LE(dio + 16);
        if (grAttrs === 0 && rvaDLLName === 0 && rvaINT === 0) break;
        // grAttrs bit0 (dlattrRva) => these fields are RVAs. Older linkers
        // emitted absolute VAs, which need imageBase subtracted.
        const toRva = (v) => (v === 0 ? 0 : (grAttrs & 1) ? v : v - Number(imageBase));
        const dll = cstr(rvaToOffset(toRva(rvaDLLName))) || '?';
        readThunks(toRva(rvaINT || rvaIAT), (delayImports[dll] ||= []));
      }
    }
  }

  return { machine, isPE32Plus, imageBase, sizeOfImage, dllName, sections,
           exports: exports_, imports, delayImports, rvaToOffset, buf };
}
