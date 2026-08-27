// PE addon introspection: classify a Windows .node and recover its requirement.
//
// Promoted verbatim in substance from E001's analyzer, where each function below
// was scored against `process.dlopen()` ground truth over 97 artifacts x 3
// runtimes. Two findings are load-bearing and encoded here:
//
//  * napi_* imports live in the DELAY-import table (PE data directory 13), because
//    node-gyp links addons with a delay-load hook for node.exe. Reading only
//    directory 1 made keytar and onnxruntime_binding look like non-addons and
//    caused 6 false positives.
//  * the node_module struct must be validated by SHAPE, not by plausible version
//    range. A naive [version][flags] scan read 1 instead of 141.

import { findNodeModule } from './node-module-struct.mjs';

const NODE_IMPORT_RE = /^node(\.exe)?$/i;

/** Every symbol the addon imports from node.exe, across both import tables. */
export function nodeImports(pe) {
  const out = [];
  for (const table of [pe.imports, pe.delayImports]) {
    for (const [dll, syms] of Object.entries(table || {})) {
      if (NODE_IMPORT_RE.test(dll.replace(/\.dll$/i, ''))) out.push(...syms);
    }
  }
  return out;
}

/** M1: raw-V8 vs N-API. Determines WHICH requirement axis applies. */
export function classify(pe, imps) {
  const expNames = pe.exports.map((e) => e.name);
  const usesRaw = imps.includes('node_module_register');
  const usesNapi = imps.some((s) => /^(napi_|node_api_)/.test(s)) ||
                   expNames.includes('napi_register_module_v1');
  const usesV8 = imps.some((s) => /@v8@@|@node@@/.test(s));
  if (usesRaw) return 'raw-v8';
  if (usesNapi) return 'n-api';
  if (usesV8) return 'raw-v8-noreg';
  return 'unknown';
}

/**
 * M2: the declared N-API minimum, authoritative when present.
 * `node_api_module_get_api_version_v1` is a function returning a constant, so it
 * compiles to `mov eax, imm32; ret`. The shape is matched explicitly; an
 * unrecognised prologue degrades to null (-> refuse) rather than to a guess.
 */
export function readDeclaredNapi(pe) {
  const ex = pe.exports.find((e) => e.name === 'node_api_module_get_api_version_v1');
  if (!ex) return { value: null, method: 'absent' };
  const off = pe.rvaToOffset(ex.rva);
  if (off == null) return { value: null, method: 'unmapped-rva' };
  const b = pe.buf;
  if (b[off] === 0xb8 && b[off + 5] === 0xc3) {            // mov eax, imm32 ; ret
    return { value: b.readUInt32LE(off + 1), method: 'mov-eax-imm32-ret' };
  }
  if ((b[off] === 0x31 || b[off] === 0x33) && b[off + 1] === 0xc0 && b[off + 2] === 0xc3) {
    return { value: 0, method: 'xor-eax-ret' };            // returns 0
  }
  return { value: null, method: 'unrecognised-prologue:' + b.subarray(off, off + 8).toString('hex') };
}

/**
 * M4: the exact NODE_MODULE_VERSION a raw-V8 addon is pinned to.
 *
 * The predicate now lives in node-module-struct.mjs, shared with ELF and Mach-O; this
 * supplies the PE addressing (VAs relative to imageBase, `.data`/`.rdata`). Unifying it was
 * only defensible because E001's 291-cell replay can prove PE behaviour did not move: it
 * still scores 291/291, so one predicate serving three formats is strictly better than three
 * copies of a soundness-critical test drifting apart.
 */
export function readRawNmVersion(pe) {
  const lo = Number(pe.imageBase);
  const hi = lo + pe.sizeOfImage;
  return findNodeModule({
    buf: pe.buf,
    sections: pe.sections
      .filter((s) => /^\.(data|rdata)/.test(s.name))
      .map((s) => ({ name: s.name, offset: s.pointerToRawData, size: s.sizeOfRawData })),
    inImage: (v) => v >= lo && v < hi,
    // A PE pointer slot holds a VA; subtract imageBase to get the RVA the section table
    // is keyed on. pe.rvaToOffset already does that walk.
    cstrAt: (va) => {
      const off = pe.rvaToOffset(va - lo);
      if (off == null || off < 0 || off >= pe.buf.length) return null;
      let e = off;
      while (e < pe.buf.length && pe.buf[e] !== 0 && e - off < 256) e++;
      return pe.buf.subarray(off, e).toString('latin1');
    },
    is64: true,
  });
}
