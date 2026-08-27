// E008 oracle: is the raw-V8 ELF nm_version read correct?
//
// E005 refused this axis and stated its reason precisely: "the local corpus contains ZERO
// raw-V8 ELF addons", so any struct reader would ship unvalidated, and an untested parser
// returning a plausible ABI number is exactly the false-negative source this project cannot
// afford. That was a statement about the CORPUS, not about the problem -- and the corpus
// changed. A bundled Electron tree (HackerRank) carries @datadog/pprof and @newrelic builds
// across glibc/musl and x64/arm64, most of them stating NODE_MODULE_VERSION in the filename.
//
// So the refusal is now re-examinable on evidence. Three oracles, none needing a Linux host,
// because the question here is whether the BYTES were read correctly -- not whether Linux
// loads the result, which is CROSSPLATFORMTEST.md's job:
//
//   O1  FILENAME-LABEL AGREEMENT. dd_pprof.node.abi127.node states the ABI independently of
//       the bytes. NOT ground truth on its own -- the knowledge model records
//       node.abi115.node actually being an N-API addon, so filenames do lie -- but a second
//       independent source, and disagreement on any artifact is a hard failure.
//
//   O2  CROSS-BUILD AGREEMENT. One component at one abi label, built for x64 and arm64 and
//       for glibc and musl, is four independent files whose struct offsets, section layouts
//       and pointer values all differ. They must still derive one value. This is E005's
//       cross-architecture oracle applied to the struct reader instead of the instruction
//       decoders.
//
//   O3  CROSS-FORMAT AGREEMENT. Where the same component+label also ships a Mach-O or PE
//       build, the ELF value must match it. The PE path is E001-validated against 291 real
//       load outcomes, so this transfers measured ground truth onto the ELF read.
//
// Reported alongside: the LABEL-FREE reads. An artifact the reader resolves but no label
// covers is not validated by O1, and saying so is the difference between "24 agree" and
// "the reader is right".

import fs from 'node:fs';
import path from 'node:path';
import { readElf } from '../../src/artifact/elf.mjs';
import * as elfAddon from '../../src/artifact/elf-addon.mjs';
import { readPE } from '../../src/artifact/pe.mjs';
import { classify as classifyPe, nodeImports,
         readRawNmVersion as peRawNm } from '../../src/artifact/pe-addon.mjs';
import * as machoAddon from '../../src/artifact/macho-addon.mjs';

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
      else if (e.isFile() && /\.(node|so|dylib|dll)$/i.test(e.name)) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

// Component identity, as in E005/E007: strip platform tokens and the abi label so that one
// component's builds collapse to one key. The abi label is kept separately -- a component
// legitimately ships many ABIs, so agreement is required per (component, label), not per
// component.
const PLAT_TOKEN = /(?:^|[-._])(?:linuxmusl|linux|darwin|macos|win32|windows|freebsd|openbsd|musl|glibc|gnueabihf|gnueabi|gnu|msvc|android|x86_64|x64|amd64|arm64|aarch64|armv8|armhf|armv7l?|arm|ia32|i386|x86|loong64|loongarch64|riscv64d|riscv64|ppc64le|s390x|universal|uv1|d)(?=$|[-._])/g;
function componentKey(file) {
  let b = path.basename(file).replace(/\.(node|so|dylib|dll)$/i, '').toLowerCase();
  b = b.replace(/\.abi\d+/g, '').replace(/\.node$/, '');
  let prev;
  do { prev = b; b = b.replace(PLAT_TOKEN, ''); } while (b !== prev);
  return b.replace(/[-._]+/g, '') || '(single)';
}
const abiLabel = (f) => Number(path.basename(f).match(/abi(\d+)/)?.[1]) || null;

const files = [
  ...discover(path.join(LOCAL ?? '', 'Programs/HackerRank/resources/app.asar.unpacked/node_modules'), 9),
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
  ...discover('experiments/e004-vertical-slice/demo', 6),
];

const elfRows = [];        // every ELF, with its class
const otherRaw = [];       // raw-V8 values from PE and Mach-O, for O3

for (const p of files) {
  let buf;
  try { buf = fs.readFileSync(p); } catch { continue; }
  if (buf.length < 8) continue;

  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const elf = readElf(buf);
    if (!elf) { elfRows.push({ file: p, cls: 'PARSE-FAIL' }); continue; }
    const syms = elfAddon.readDynsym(buf, elf);
    const cls = syms.length ? elfAddon.classify(syms) : 'no-dynsym';
    const row = { file: p, key: componentKey(p), label: abiLabel(p), cls,
                  arch: elf.arch, libc: elf.libc ?? null };
    if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
      const r = elfAddon.readRawNmVersion(buf, elf);
      row.value = r.value;
      row.method = r.method;
      row.candidates = r.candidates ?? 0;
    }
    elfRows.push(row);
    continue;
  }

  if (buf.readUInt16LE(0) === 0x5a4d) {
    const pe = readPE(buf);
    if (!pe) continue;
    const cls = classifyPe(pe, nodeImports(pe));
    if (cls !== 'raw-v8' && cls !== 'raw-v8-noreg') continue;
    const r = peRawNm(pe);
    if (r.value != null) otherRaw.push({ key: componentKey(p), label: abiLabel(p),
                                         value: r.value, flavour: 'pe', file: p });
    continue;
  }

  for (const sl of machoAddon.readSlices(buf)) {
    const img = machoAddon.readImage(buf, sl.base);
    if (!img) continue;
    const syms = machoAddon.readSymbols(buf, img);
    if (!syms.length) continue;
    const cls = machoAddon.classify(syms);
    if (cls !== 'raw-v8' && cls !== 'raw-v8-noreg') continue;
    const r = machoAddon.readRawNmVersion(buf, img);
    if (r.value != null) otherRaw.push({ key: componentKey(p), label: abiLabel(p),
                                         value: r.value, flavour: 'macho', file: p });
  }
}

const raw = elfRows.filter((r) => r.cls === 'raw-v8' || r.cls === 'raw-v8-noreg');
const byCls = new Map();
for (const r of elfRows) byCls.set(r.cls, (byCls.get(r.cls) ?? 0) + 1);

console.log(`corpus       ${elfRows.length} ELF files  (` +
            [...byCls].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ') + ')');
console.log(`             ${raw.length} raw-V8 ELF, ${raw.filter((r) => r.label != null).length} ` +
            `with a filename ABI label, ${otherRaw.length} raw-V8 PE/Mach-O values for O3\n`);

let fail = 0;

// ---- O1: filename label agreement -------------------------------------------
let a1 = 0, d1 = 0, unread = 0, nolabel = 0;
const bad1 = [];
for (const r of raw) {
  if (r.value == null) { unread++; bad1.push([`UNREAD ${r.method}`, r.file]); continue; }
  if (r.label == null) { nolabel++; continue; }
  if (r.value === r.label) a1++;
  else { d1++; bad1.push([`DISAGREE derived ${r.value} vs label ${r.label}`, r.file]); }
}
console.log(`O1 filename label     ${a1} agree / ${d1} disagree / ${unread} unread / ${nolabel} unlabelled`);
for (const [d, f] of bad1) console.log(`   ${d}  ${f.replace(/^.*node_modules[\\/]/, '')}`);
if (d1 || unread) fail++;

// ---- O2: cross-build agreement (arch x libc) --------------------------------
const groups = new Map();
for (const r of raw) {
  if (r.value == null) continue;
  const g = `${r.key}@${r.label ?? 'nolabel'}`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}
let a2 = 0, d2 = 0, n2 = 0;
for (const [g, rs] of groups) {
  if (rs.length < 2) continue;
  n2++;
  const vals = [...new Set(rs.map((r) => r.value))];
  if (vals.length === 1) a2++;
  else {
    d2++; fail++;
    console.log(`   DISAGREE ${g}: ` +
      rs.map((r) => `${r.arch}/${r.libc ?? '?'}=${r.value}`).join(' '));
  }
}
console.log(`O2 cross-build        ${a2} agree / ${d2} disagree  (of ${n2} multi-build groups)`);

// ---- O3: cross-format agreement against PE / Mach-O -------------------------
const otherByKey = new Map();
for (const o of otherRaw) {
  const k = `${o.key}@${o.label ?? 'nolabel'}`;
  if (!otherByKey.has(k)) otherByKey.set(k, o);
}
let a3 = 0, d3 = 0;
for (const r of raw) {
  if (r.value == null) continue;
  const o = otherByKey.get(`${r.key}@${r.label ?? 'nolabel'}`);
  if (!o) continue;
  if (o.value === r.value) a3++;
  else {
    d3++; fail++;
    console.log(`   DISAGREE ${r.key}@${r.label}: elf ${r.value} vs ${o.flavour} ${o.value}`);
  }
}
console.log(`O3 cross-format       ${a3} agree / ${d3} disagree  ` +
            `(raw-V8 components shipping ELF and PE/Mach-O at one label)`);

// ---- coverage ---------------------------------------------------------------
const tally = new Map();
for (const r of raw) {
  const k = r.value != null ? 'read' : 'refuse:' + r.method.split(':')[0];
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log('\ncoverage of raw-V8 ELF:');
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(3)}  ${k}`);

console.log('\nper artifact:');
for (const r of raw.sort((a, b) => (a.file < b.file ? -1 : 1))) {
  console.log(`  ${(r.label ? 'abi' + r.label : '-').padEnd(7)} ${String(r.value ?? 'NULL').padEnd(5)} ` +
              `${(r.arch ?? '?').padEnd(6)} ${(r.libc ?? '?').padEnd(5)} c=${r.candidates} ${r.method}`);
  console.log(`          ${r.file.replace(/^.*node_modules[\\/]/, '')}`);
}

console.log(fail ? `\nFAIL: ${fail} oracle failure(s)` : '\nOK: all E008 oracles agree');
process.exit(fail ? 1 : 0);
