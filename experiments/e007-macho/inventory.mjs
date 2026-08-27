// Inventory the local Mach-O corpus. No derivation yet -- just: what do we have,
// how many slices, which architectures, and is the requirement symbol present?
import fs from 'node:fs';
import path from 'node:path';
import { readContainer } from '../../src/artifact/container.mjs';

const roots = process.argv.slice(2);
const found = [];
const walk = (d, depth) => {
  if (depth > 12) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!e.isFile()) continue;
    if (!/\.(node|dylib)$/i.test(e.name)) continue;
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    const c = readContainer(buf);
    if (!/^macho/.test(c.format)) continue;
    // Presence of the requirement symbol name anywhere in the bytes is a cheap
    // pre-check: the string table is not compressed.
    const hasGetver = buf.includes('node_api_module_get_api_version_v1');
    const hasEntry = buf.includes('napi_register_module_v1');
    const hasNodeReg = buf.includes('node_module_register');
    found.push({ p, format: c.format, arch: c.arch, archs: c.archs, slices: c.slices ?? 1,
                 size: buf.length, hasGetver, hasEntry, hasNodeReg });
  }
};
for (const r of roots) walk(r, 0);

console.log(`mach-o artifacts found: ${found.length}\n`);
const by = (k) => {
  const m = new Map();
  for (const f of found) { const v = String(f[k]); m.set(v, (m.get(v) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}=${n}`).join('  ');
};
console.log('format :', by('format'));
console.log('arch   :', by('arch'));
console.log('slices :', by('slices'));
console.log('getver :', by('hasGetver'), '   entry:', by('hasEntry'), '   node_module_register:', by('hasNodeReg'));
console.log('\nper artifact:');
for (const f of found.sort((a, b) => (a.p < b.p ? -1 : 1))) {
  const tag = [f.hasGetver ? 'GETVER' : '', f.hasEntry ? 'entry' : '', f.hasNodeReg ? 'RAWV8' : '']
    .filter(Boolean).join(',') || 'none';
  console.log(`  ${f.format.padEnd(10)} ${(f.archs.join('+') || f.arch || '?').padEnd(12)} ` +
              `${String((f.size / 1048576).toFixed(1) + 'M').padEnd(7)} ${tag.padEnd(20)} ${f.p}`);
}
