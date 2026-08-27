// E007 oracle: does the derived Mach-O requirement agree with independent evidence?
//
// No macOS host here, so no artifact in this corpus can be loaded and E001's ground-truth
// oracle is unavailable. Three substitutes, none needing a Mac:
//
//   O1  CROSS-SLICE AGREEMENT. A universal binary carries a complete image per
//       architecture built from one source at one time, so both slices must derive the
//       same requirement. Two independent instruction/struct decoders agreeing is
//       evidence both are right; disagreement is a decoder bug and is reported.
//
//   O2  CROSS-FLAVOUR AGREEMENT. Where a component ships darwin and win32/linux builds
//       of the same version, the declared N-API minimum must match. The PE side is not a
//       guess -- E001 validated it against 291 real load outcomes -- so this transfers
//       measured ground truth onto the Mach-O path.
//
//   O3  FILENAME-LABEL AGREEMENT (raw-V8 only). @datadog/pprof ships
//       dd_pprof.node.abi127.node etc: the packager states the NODE_MODULE_VERSION in the
//       filename, independently of the bytes. This is NOT ground truth -- the knowledge
//       model records node.abi115.node being an N-API addon, so filenames do lie -- it is
//       a second independent source, and agreement between two independent sources on 20+
//       artifacts is what makes the struct read credible.
//
// None of these validates the LOADING direction on macOS. That needs a Mac and is what
// CROSSPLATFORMTEST.md is for.

import fs from 'node:fs';
import path from 'node:path';
import { readSlices, readImage, readSymbols, classify, readDeclaredNapi, readRawNmVersion,
         napiImports } from '../../src/artifact/macho-addon.mjs';
import { readPE } from '../../src/artifact/pe.mjs';
import { classify as classifyPe, readDeclaredNapi as peDeclared,
         nodeImports } from '../../src/artifact/pe-addon.mjs';
import { readElf } from '../../src/artifact/elf.mjs';

const HOME = process.env.USERPROFILE;
const LOCAL = process.env.LOCALAPPDATA;

function discover(root, depth) {
  const out = [];
  const walk = (d, left) => {
    if (left < 0) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, left - 1);
      else if (e.isFile() && /\.(node|dylib)$/i.test(e.name)) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

// Same component-key normalisation as E005: one package.json can cover several unrelated
// bundled addons, so the comparable unit is one COMPONENT across platforms.
const PLAT_TOKEN = /(?:^|[-._])(?:linuxmusl|linux|darwin|macos|win32|windows|freebsd|openbsd|musl|glibc|gnueabihf|gnueabi|gnu|msvc|android|x86_64|x64|amd64|arm64|aarch64|armv8|armhf|armv7l?|arm|ia32|i386|x86|loong64|loongarch64|riscv64d|riscv64|ppc64le|s390x|universal|uv1|d)(?=$|[-._])/g;
function componentKey(file) {
  let b = path.basename(file).replace(/\.(node|dylib)$/i, '').toLowerCase();
  b = b.replace(/\.abi\d+/g, '').replace(/\.node$/, '');
  let prev;
  do { prev = b; b = b.replace(PLAT_TOKEN, ''); } while (b !== prev);
  return b.replace(/[-._]+/g, '') || '(single)';
}

const files = [
  ...discover(path.join(LOCAL ?? '', 'Programs/HackerRank/resources/app.asar.unpacked/node_modules'), 9),
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
  ...discover('experiments/e004-vertical-slice/demo', 6),
];

const rows = [];
const peRows = [];
for (const p of files) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { continue; }

  // Collect the PE/ELF side of the same component for O2.
  if (buf.length > 4 && buf.readUInt16LE(0) === 0x5a4d) {
    const pe = readPE(buf);
    if (pe && classifyPe(pe, nodeImports(pe)) === 'n-api') {
      const d = peDeclared(pe);
      if (d.value != null) peRows.push({ key: componentKey(p), value: d.value, file: p, flavour: 'pe' });
    }
    continue;
  }
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x7f454c46) {
    const elf = readElf(buf);
    if (elf) rows.push({ elfOnly: true, file: p, key: componentKey(p), arch: elf.arch });
    continue;
  }

  const slices = readSlices(buf);
  if (!slices.length) continue;
  const perSlice = [];
  for (const sl of slices) {
    const img = readImage(buf, sl.base);
    if (!img) { perSlice.push({ arch: sl.arch, cls: 'no-image', req: null, method: 'no-image' }); continue; }
    const syms = readSymbols(buf, img);
    const cls = classify(syms);
    if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
      const r = readRawNmVersion(buf, img);
      perSlice.push({ arch: img.arch, cls, kind: 'abi', req: r.value, method: r.method });
    } else if (cls === 'n-api') {
      const d = readDeclaredNapi(buf, img, syms);
      perSlice.push({ arch: img.arch, cls, kind: 'napi', req: d.value, method: d.method,
                      imports: napiImports(syms).length });
    } else {
      perSlice.push({ arch: img.arch, cls, kind: null, req: null, method: 'n/a' });
    }
  }
  rows.push({ file: p, key: componentKey(p), slices: perSlice,
              label: Number(path.basename(p).match(/abi(\d+)/)?.[1]) || null });
}

const machoRows = rows.filter((r) => !r.elfOnly);
console.log(`corpus       ${machoRows.length} Mach-O files, ` +
            `${machoRows.reduce((n, r) => n + r.slices.length, 0)} images, ` +
            `${peRows.length} PE N-API declared, ${rows.filter((r) => r.elfOnly).length} ELF\n`);

// ---- O1: cross-slice agreement inside one universal binary -------------------
let o1agree = 0, o1disagree = 0, o1n = 0;
const o1bad = [];
for (const r of machoRows) {
  if (r.slices.length < 2) continue;
  o1n++;
  const vals = [...new Set(r.slices.map((s) => `${s.kind}:${s.req}`))];
  if (vals.length === 1) o1agree++;
  else { o1disagree++; o1bad.push([r.file, r.slices.map((s) => `${s.arch}=${s.kind}:${s.req}`).join(' ')]); }
}
console.log(`O1 cross-slice        ${o1agree} agree / ${o1disagree} disagree  (of ${o1n} universal binaries)`);
for (const [f, d] of o1bad) console.log(`   DISAGREE ${path.basename(f)}  ${d}`);

// ---- O3: filename label agreement for raw-V8 --------------------------------
let o3agree = 0, o3disagree = 0, o3nolabel = 0, o3unread = 0;
const o3bad = [];
for (const r of machoRows) {
  const raw = r.slices.filter((s) => s.kind === 'abi');
  if (!raw.length) continue;
  for (const s of raw) {
    if (s.req == null) { o3unread++; o3bad.push([r.file, s.arch, `UNREAD ${s.method}`]); continue; }
    if (r.label == null) { o3nolabel++; continue; }
    if (s.req === r.label) o3agree++;
    else { o3disagree++; o3bad.push([r.file, s.arch, `derived ${s.req} vs label ${r.label}`]); }
  }
}
console.log(`O3 filename label     ${o3agree} agree / ${o3disagree} disagree / ` +
            `${o3unread} unread / ${o3nolabel} unlabelled`);
for (const [f, a, d] of o3bad) console.log(`   ${d}  ${a}  ${path.basename(f)}`);

// ---- O2: cross-flavour agreement against E001-validated PE values -----------
const peByKey = new Map();
for (const r of peRows) if (!peByKey.has(r.key)) peByKey.set(r.key, r.value);
let o2agree = 0, o2disagree = 0;
const o2bad = [], o2seen = new Set();
for (const r of machoRows) {
  for (const s of r.slices) {
    if (s.kind !== 'napi' || s.req == null) continue;
    const pv = peByKey.get(r.key);
    if (pv == null) continue;
    const tag = `${r.key}:${s.arch}:${s.req}`;
    if (o2seen.has(tag)) continue;
    o2seen.add(tag);
    if (pv === s.req) o2agree++;
    else { o2disagree++; o2bad.push([r.key, s.req, pv, r.file]); }
  }
}
console.log(`O2 cross-flavour      ${o2agree} agree / ${o2disagree} disagree  ` +
            `(components with both a Mach-O and a PE declared value)`);
for (const [k, mv, pv, f] of o2bad) console.log(`   DISAGREE ${k}: macho ${mv} vs pe ${pv}  ${path.basename(f)}`);

// ---- coverage ---------------------------------------------------------------
const images = machoRows.flatMap((r) => r.slices);
const tally = new Map();
for (const s of images) {
  const k = s.req != null ? `read:${s.kind}` : `unread:${s.cls}:${s.method.split(':')[0]}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log('\ncoverage by image:');
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);

console.log('\nper artifact:');
for (const r of machoRows.sort((a, b) => (a.file < b.file ? -1 : 1))) {
  const d = r.slices.map((s) => `${s.arch ?? '?'}:${s.cls}:${s.kind ?? '-'}=${s.req ?? 'NULL(' + s.method + ')'}`).join('  ');
  console.log(`  ${(r.label ? 'abi' + r.label : '').padEnd(7)} ${d}`);
  console.log(`          ${r.file.replace(/^.*node_modules[\\/]/, '')}`);
}
