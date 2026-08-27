// E007 probe 1: does the Mach-O parser see what it needs to?
//
// Three questions, in order of how badly a "no" would hurt:
//   1. Is there an LC_SYMTAB at all, or are .node bundles stripped of it?
//   2. Is `_node_api_module_get_api_version_v1` a DEFINED symbol we can locate?
//   3. Does the vaddr map to a file offset, and does readConstReturn decode it?
import fs from 'node:fs';
import path from 'node:path';
import { readSlices, readImage, readSymbols, classify, readDeclaredNapi, napiImports }
  from '../../src/artifact/macho-addon.mjs';

const roots = process.argv.slice(2);
const files = [];
const walk = (d, depth) => {
  if (depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (e.isFile() && /\.(node|dylib)$/i.test(e.name)) files.push(p);
  }
};
for (const r of roots) walk(r, 0);

let machos = 0, withSymtab = 0, decoded = 0;
const rows = [];
for (const p of files.sort()) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { continue; }
  const slices = readSlices(buf);
  if (!slices.length) continue;
  machos++;
  for (const sl of slices) {
    const img = readImage(buf, sl.base);
    if (!img) { rows.push([p, sl.arch ?? '?', 'NO-IMAGE', '', '', '']); continue; }
    const syms = readSymbols(buf, img);
    if (img.symtab) withSymtab++;
    const cls = classify(syms);
    const dn = readDeclaredNapi(buf, img, syms);
    if (dn.value != null) decoded++;
    rows.push([p, img.arch ?? sl.arch ?? '?',
               img.symtab ? `symtab:${img.symtab.nsyms}` : 'NO-SYMTAB',
               `syms:${syms.length}`, cls,
               dn.value == null ? dn.method : `napi=${dn.value} (${dn.method})`,
               `imports:${napiImports(syms).length}`]);
  }
}

console.log(`files scanned: ${files.length}   mach-o: ${machos}   images with symtab: ${withSymtab}   declared decoded: ${decoded}\n`);
for (const r of rows) {
  const [p, arch, st, ns, cls, dn, imp] = r;
  console.log(`${arch.padEnd(6)} ${st.padEnd(14)} ${(ns ?? '').padEnd(11)} ${(cls ?? '').padEnd(12)} ${(imp ?? '').padEnd(13)} ${(dn ?? '')}`);
  console.log(`       ${p}`);
}
