// Regression: does the SHIPPED derivation still satisfy E008's oracles?
//
// E008 established that the raw-V8 ELF axis -- the exact NODE_MODULE_VERSION -- is
// derivable, using the reader directly. What ships is different: src/artifact/
// elf-addon.mjs -> node-module-struct.mjs, wired through the ELF branch of
// deriveConstraints and then through decide(). The experiment's result does not
// automatically transfer to that path, so this re-applies all three oracles to the
// constraints the product actually emits.
//
// Why this file has to exist. The struct reader is a SCAN over .data with a shape
// predicate. Predicates like that fail silently and asymmetrically: tighten one test
// and artifacts stop matching, so the axis quietly reverts to `unknown` and everything
// refuses; loosen one and a second record starts matching, so the value becomes a coin
// flip. Neither shows up as a thrown error. Only agreement with independent sources
// catches it, and only if that agreement is re-checked on every change.
//
// The oracles, restated -- none needs a Linux host:
//
//   O1  FILENAME-LABEL AGREEMENT. @datadog/pprof ships dd_pprof.node.abi137.node: the
//       packager states the ABI independently of the bytes. NOT ground truth on its own
//       (the knowledge model records node.abi115.node actually being an N-API addon, so
//       filenames do lie), but a second independent source.
//   O2  CROSS-BUILD AGREEMENT. One component at one ABI, built for x64 and arm64 and for
//       glibc and musl, is four files whose section layouts, struct offsets and pointer
//       values all differ. One value must come out of all four.
//   O3  CROSS-FORMAT AGREEMENT. Where the same component+ABI also ships PE or Mach-O,
//       the values must match. The PE path is E001-validated against 291 real loads, so
//       this transfers measured ground truth onto the ELF read.
//
// None of them proves the LOADING direction on Linux. That needs a Linux host and is
// what CROSSPLATFORMTEST.md is for.
//
//   node test/regress-e008.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveConstraints } from '../src/artifact/constraints.mjs';
import { resolveNapiMap } from '../src/artifact/napi-map.mjs';
import { decide } from '../src/compat/decide.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME;
const LOCAL = process.env.LOCALAPPDATA;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');

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

// Component identity: strip platform tokens, and keep the ABI label separate. A component
// legitimately ships many ABIs, so agreement is required per (component, label) -- grouping
// on the component alone would report a disagreement that is an artefact of the grouping.
const PLAT_TOKEN = /(?:^|[-._])(?:linuxmusl|linux|darwin|macos|win32|windows|freebsd|openbsd|musl|glibc|gnueabihf|gnueabi|gnu|msvc|android|x86_64|x64|amd64|arm64|aarch64|armv8|armhf|armv7l?|arm|ia32|i386|x86|loong64|loongarch64|riscv64d|riscv64|ppc64le|s390x|universal|uv1|d)(?=$|[-._])/g;
function componentKey(file) {
  let b = path.basename(file).replace(/\.(node|so|dylib|dll)$/i, '').toLowerCase();
  b = b.replace(/\.abi\d+/g, '').replace(/\.node$/, '');
  let prev;
  do { prev = b; b = b.replace(PLAT_TOKEN, ''); } while (b !== prev);
  return b.replace(/[-._]+/g, '') || '(single)';
}
const abiLabel = (f) => Number(path.basename(f).match(/abi(\d+)/)?.[1]) || null;

const { map: napiMap, defaultNapi } = resolveNapiMap();

const seen = new Set();
const rows = [];
for (const f of [
  ...discover(path.join(LOCAL ?? '', 'Programs/HackerRank/resources/app.asar.unpacked/node_modules'), 9),
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
  ...discover(path.join(ROOT, 'experiments/e004-vertical-slice/demo'), 6),
]) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (seen.has(sha)) continue;
  seen.add(sha);

  // The SHIPPED derivation, constraints and evidence exactly as the product emits them.
  const a = deriveConstraints(buf, napiMap, { name: path.basename(f), defaultNapi });
  if (a.class !== 'raw-v8' && a.class !== 'raw-v8-noreg') continue;
  const abi = a.constraints.find((c) => c.kind === 'abi-exact');
  rows.push({
    format: a.format, class: a.class,
    key: componentKey(f), label: abiLabel(f),
    rel: f.replace(/^.*node_modules[\\/]/, ''),
    arch: a.container?.arch ?? null, libc: a.container?.libc ?? null,
    value: abi?.abi ?? null,
    method: a.nmMethod ?? (a.slices?.map((s) => s.nmMethod).join('+') ?? '-'),
    unknown: a.constraints.some((c) => c.kind === 'unknown'),
    constraints: a.constraints,
  });
}

const elf = rows.filter((r) => r.format === 'elf');
const other = rows.filter((r) => r.format !== 'elf');
console.log(`corpus:   ${elf.length} raw-V8 ELF, ${other.length} raw-V8 PE/Mach-O ` +
            `(${elf.filter((r) => r.label != null).length} ELF with a filename ABI label)\n`);

// E008 measured these. A drop is a coverage regression even with zero disagreements,
// because a predicate that stops matching refuses everything -- sound, but unusable, and
// silent. Asserting the floor is what makes that visible.
const EXPECT_MIN_ELF = 44;
let bad = 0;

// ------------------------------------------------------------------------- O1
let o1ok = 0, o1bad = 0, o1unread = 0, o1nolabel = 0;
console.log('O1  filename ABI label agreement');
for (const r of elf) {
  if (r.value == null) {
    o1unread++;
    console.log(`  UNREAD   ${r.rel}  ${r.method}`);
    continue;
  }
  if (r.label == null) { o1nolabel++; continue; }
  if (r.value === r.label) o1ok++;
  else {
    o1bad++;
    console.log(`  DISAGREE ${r.rel}  derived ${r.value} vs label ${r.label}`);
  }
}
console.log(`  => ${o1ok} agree, ${o1bad} disagree, ${o1unread} unread, ${o1nolabel} unlabelled\n`);

// ------------------------------------------------------------------------- O2
const groups = new Map();
for (const r of elf) {
  if (r.value == null) continue;
  const g = `${r.key}@${r.label ?? 'nolabel'}`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}
let o2ok = 0, o2bad = 0, o2single = 0;
console.log('O2  cross-build agreement (architecture x libc, one component at one ABI)');
for (const [g, rs] of [...groups].sort()) {
  if (rs.length < 2) { o2single++; continue; }
  const vals = [...new Set(rs.map((r) => r.value))];
  const ok = vals.length === 1;
  ok ? o2ok++ : o2bad++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${g.padEnd(24)} ${vals.join('/')} over ` +
              `${rs.length} build(s): ${rs.map((r) => `${r.arch}/${r.libc ?? '?'}`).join(' ')}`);
}
console.log(`  => ${o2ok} agree, ${o2bad} disagree, ${o2single} single-build (not comparable)\n`);

// ------------------------------------------------------------------------- O3
const otherByKey = new Map();
for (const o of other) {
  if (o.value == null) continue;
  const k = `${o.key}@${o.label ?? 'nolabel'}`;
  if (!otherByKey.has(k)) otherByKey.set(k, o);
}
let o3ok = 0, o3bad = 0, o3none = 0;
console.log('O3  cross-format agreement (ELF vs PE/Mach-O; PE side validated by E001 loads)');
for (const [g, rs] of [...groups].sort()) {
  const o = otherByKey.get(g);
  if (!o) { o3none++; continue; }
  const ok = rs.every((r) => r.value === o.value);
  ok ? o3ok++ : o3bad++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${g.padEnd(24)} elf=${[...new Set(rs.map((r) => r.value))].join('/')} ` +
              `${o.format}=${o.value}`);
}
console.log(`  => ${o3ok} agree, ${o3bad} disagree, ${o3none} without a comparable pair\n`);

// -------------------------------------------------------------------- soundness
// The direction that matters most: a derived exact ABI must refuse a mismatched runtime.
// A constraint that parses but does not bite is the false negative this project exists to
// prevent, so it is checked on the shipped decide() rather than assumed from the shape.
let bites = 0, inert = 0;
for (const r of elf) {
  if (r.value == null) continue;
  const rt = { os: 'linux', arch: r.arch, libc: r.libc ?? 'glibc', napi: 10 };
  const okSame = decide(r.constraints, { ...rt, abi: r.value }).ok;
  const okOther = decide(r.constraints, { ...rt, abi: r.value === 137 ? 141 : 137 }).ok;
  if (okSame && !okOther) bites++;
  else { inert++; console.log(`  INERT ${r.rel} abi=${r.value} same=${okSame} other=${okOther}`); }
}
console.log(`soundness: ${bites} constraint(s) accept their own ABI and refuse another, ${inert} inert`);

const refused = elf.filter((r) => r.unknown);
console.log(`coverage:  ${elf.length - refused.length}/${elf.length} raw-V8 ELF resolved to an exact ABI`);
for (const r of refused) console.log(`     UNRESOLVED ${r.rel} ${r.method}`);

if (elf.length < EXPECT_MIN_ELF) {
  console.log(`\nCORPUS SHRANK: found ${elf.length} raw-V8 ELF artifacts, E008 measured ` +
              `${EXPECT_MIN_ELF}. The oracles below are weaker than when they were recorded.`);
  bad++;
}
bad += o1bad + o1unread + o2bad + o3bad + inert;

console.log(`\n${bad ? 'REGRESSION' : 'OK'}: src/ ${bad ? 'does not satisfy' : 'satisfies'} the E008 oracles.`);
process.exit(bad ? 1 : 0);
