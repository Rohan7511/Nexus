// Locate `struct node_module` and read nm_version -- the exact NODE_MODULE_VERSION a
// raw-V8 addon is pinned to.
//
// This is a C struct, so its LAYOUT is identical in PE, ELF and Mach-O. Only three things
// differ per format: which sections can hold it, how a pointer slot relates to a link-time
// address, and how to dereference one. Callers supply those; the predicate lives here once,
// because it is the delicate part and three drifting copies of a soundness-critical test is
// how a false negative gets in.
//
// WHY VALIDATION-BY-SHAPE. A bare `[version][flags]` scan matches noise constantly -- on PE
// it read 1 where the answer was 141. So the whole record has to be self-consistent before
// its first field is believed, and an unresolvable record refuses instead of guessing.
//
// WHAT THE POINTER SLOTS ACTUALLY HOLD, measured rather than assumed -- [LE] and the reason
// this module is parameterised instead of copied:
//
//   PE      nm_register_func / nm_context_register_func hold real VAs; exactly one is set.
//   Mach-O  47 of 49 local images use LC_DYLD_INFO_ONLY, so slots hold plain unrelocated
//           vmaddrs and one register hook is set, as on PE.
//   ELF     BOTH register slots are ZERO on disk. The function pointer lives in a .rela.dyn
//           addend, while the string pointers were resolved in place by the linker. So PE's
//           "exactly one hook is set" test finds NOTHING in an ELF file.
//
// That last line is why the discriminator here is `modname must dereference to a C
// identifier` rather than register-hook parity: it is strictly stronger, it is semantic
// rather than structural, and it holds in all three formats. Register hooks are still
// checked, but only as far as every format agrees: at most one, each null-or-in-image.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * @param {object} o
 * @param {Buffer} o.buf
 * @param {{name?:string, offset:number, size:number}[]} o.sections candidate sections,
 *        already filtered by the caller -- each format decides which names can hold the struct
 * @param {(v:number)=>boolean} o.inImage is this link-time address inside the image?
 * @param {(v:number)=>string|null} o.cstrAt dereference a link-time address to a C string
 * @param {boolean} [o.is64]
 * @returns {{value:number|null, method:string, candidates?:number}}
 */
export function findNodeModule({ buf, sections, inImage, cstrAt, is64 = true }) {
  const P = is64 ? 8 : 4;
  const size = 8 + 7 * P;                       // version+flags then seven pointers
  const ptr = is64
    ? (o) => Number(buf.readBigUInt64LE(o))
    : (o) => buf.readUInt32LE(o);
  const F = {                                   // slot -> byte offset
    dso: 8, filename: 8 + P, reg: 8 + 2 * P, ctx: 8 + 3 * P,
    modname: 8 + 4 * P, priv: 8 + 5 * P, link: 8 + 6 * P,
  };
  const ptrOrNull = (v) => v === 0 || inImage(v);
  const printable = (s) => s != null && s.length > 0 && /^[\x20-\x7e]+$/.test(s);

  const hits = [];
  for (const s of sections) {
    const end = Math.min(s.offset + s.size, buf.length) - size;
    for (let o = Math.max(s.offset, 0); o <= end; o += 4) {
      const version = buf.readUInt32LE(o);
      if (version < 1 || version > 250) continue;
      if (buf.readUInt32LE(o + 4) > 0x0f) continue;          // nm_flags is a small bitfield
      // nm_dso_handle is NULL in a built addon; nm_priv and nm_link are populated only
      // once the module is actually loaded, so all three are zero on disk in every format.
      if (ptr(o + F.dso) !== 0 || ptr(o + F.priv) !== 0 || ptr(o + F.link) !== 0) continue;

      const reg = ptr(o + F.reg), ctx = ptr(o + F.ctx);
      if (!ptrOrNull(reg) || !ptrOrNull(ctx)) continue;
      if (reg !== 0 && ctx !== 0) continue;                  // at most one register hook
      if (!ptrOrNull(ptr(o + F.filename))) continue;

      // The discriminator. nm_modname is NODE_STRINGIFY(modname), so it is never NULL and
      // always a C identifier. Requiring it to dereference to one rejects the arbitrary
      // in-range integers that survive the structural tests.
      const mn = ptr(o + F.modname);
      if (mn === 0 || !inImage(mn)) continue;
      const modname = cstrAt(mn);
      if (modname == null || !IDENT.test(modname)) continue;

      // __FILE__, when the slot is set: any printable string, no extension requirement --
      // build systems produce odd paths and demanding `.cc` would refuse real addons.
      const fn = ptr(o + F.filename);
      if (fn !== 0 && !printable(cstrAt(fn))) continue;

      hits.push({ version, off: o, modname });
    }
  }

  if (!hits.length) return { value: null, method: 'no-node-module-struct' };
  const distinct = [...new Set(hits.map((h) => h.version))];
  if (distinct.length > 1) {
    // Two records claiming different ABIs means the predicate is not discriminating on
    // this artifact. Picking one would put an unjustified number into a verdict.
    return { value: null, candidates: hits.length,
             method: 'ambiguous-node-module-struct:' + distinct.sort((a, b) => a - b).join(',') };
  }
  return { value: distinct[0], candidates: hits.length,
           method: `node-module-struct@0x${hits[0].off.toString(16)}(${hits[0].modname})` };
}
