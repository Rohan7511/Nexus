// Regression: does the SHIPPED derivation still satisfy E007's oracles?
//
// E007 established that the Mach-O requirement axis is derivable, testing the readers
// directly. What ships is src/artifact/macho-addon.mjs wired through deriveMacho and then
// through decide(), including the per-slice agreement invariant that the experiment does
// not exercise. So the experiment's result does not transfer on its own.
//
// Why this file has to exist. Both Mach-O requirement reads are pattern matches -- a
// constant-return instruction decoder and a struct scan over __DATA. Pattern matches fail
// silently in both directions: tighten one and artifacts stop matching, so everything
// reverts to `unknown` and refuses (sound, unusable, invisible); loosen one and a second
// candidate matches, so the value becomes arbitrary. Only agreement with independent
// sources catches either, and only if it is re-checked on every change.
//
// The oracles, restated -- none needs a macOS host:
//
//   O1  CROSS-SLICE AGREEMENT. A universal binary carries a complete image per
//       architecture, built from one source at one time, so the slices must derive the
//       same requirement. Two independent decoders agreeing is evidence both are right.
//   O2  CROSS-FLAVOUR AGREEMENT. Where a component ships darwin and win32 builds of one
//       version, the declared N-API minimum must match. The PE side is not a guess --
//       E001 validated it against 291 real load outcomes -- so this transfers measured
//       ground truth onto the Mach-O path.
//   O3  FILENAME-LABEL AGREEMENT (raw-V8 only). @datadog/pprof states the
//       NODE_MODULE_VERSION in the filename, independently of the bytes. NOT ground truth
//       on its own -- the knowledge model records node.abi115.node actually being an N-API
//       addon, so filenames do lie -- but a second independent source.
//
// None of them proves the LOADING direction on macOS. That needs a Mac and is what
// CROSSPLATFORMTEST.md is for.
//
//   node test/regress-e007.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveConstraints } from '../src/artifact/constraints.mjs';
import { resolveNapiMap } from '../src/artifact/napi-map.mjs';

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
      else if (e.isFile() && /\.(node|dylib|dll)$/i.test(e.name)) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

const PLAT_TOKEN = /(?:^|[-._])(?:linuxmusl|linux|darwin|macos|win32|windows|freebsd|openbsd|musl|glibc|gnueabihf|gnueabi|gnu|msvc|android|x86_64|x64|amd64|arm64|aarch64|armv8|armhf|armv7l?|arm|ia32|i386|x86|loong64|loongarch64|riscv64d|riscv64|ppc64le|s390x|universal|uv1|d)(?=$|[-._])/g;
function componentKey(file) {
  let b = path.basename(file).replace(/\.(node|dylib|dll)$/i, '').toLowerCase();
  b = b.replace(/\.abi\d+/g, '').replace(/\.node$/, '');
  let prev;
  do { prev = b; b = b.replace(PLAT_TOKEN, ''); } while (b !== prev);
  return b.replace(/[-._]+/g, '') || '(single)';
}
const abiLabel = (f) => Number(path.basename(f).match(/abi(\d+)/)?.[1]) || null;

const { map: napiMap, defaultNapi } = resolveNapiMap();

const seen = new Set();
const macho = [], pe = [];
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

  const a = deriveConstraints(buf, napiMap, { name: path.basename(f), defaultNapi });
  const napi = a.constraints.find((c) => c.kind === 'napi-min');
  const abi = a.constraints.find((c) => c.kind === 'abi-exact');
  const row = {
    format: a.format, class: a.class, key: componentKey(f), label: abiLabel(f),
    rel: f.replace(/^.*node_modules[\\/]/, ''),
    declared: a.declaredNapi ?? null, method: a.declaredMethod ?? '-',
    napi: napi?.napi ?? null, napiSource: napi?.source ?? null,
    abi: abi?.abi ?? null,
    // A fat file's answer rests on its slices agreeing, so the per-slice reads are the
    // unit O1 examines -- the merged constraint has already hidden any disagreement.
    slices: a.slices ?? null,
    unknown: a.constraints.some((c) => c.kind === 'unknown'),
  };
  if (a.format === 'macho' || a.format === 'macho-fat') macho.push(row);
  else if (a.format === 'pe') pe.push(row);
}

// E007 measured these (deduped by SHA, as this regression does -- E007's own run.mjs does
// not dedup and so reports 49; four are byte-identical copies). A drop is a coverage
// regression even with zero disagreements, because a pattern that stops matching refuses
// everything: sound, but unusable, and silent.
const EXPECT_MIN_IMAGES = 45;
const EXPECT_MIN_FAT = 4;

const images = macho.flatMap((r) => r.slices ?? [r]);
console.log(`corpus:   ${macho.length} Mach-O files, ${images.length} images, ` +
            `${macho.filter((r) => (r.slices?.length ?? 1) > 1).length} universal, ` +
            `${pe.filter((r) => r.declared != null).length} PE declared values for O2\n`);

let bad = 0;

// ------------------------------------------------------------------------- O1
// Checked on the per-slice EVIDENCE, not on the merged constraint. deriveMacho refuses on
// disagreement, so by the time a disagreement reaches the constraint set it has already
// collapsed to a single `unknown` -- and an oracle that only saw that could not tell a
// disagreement from any other refusal.
let o1ok = 0, o1bad = 0, o1n = 0;
console.log('O1  cross-slice agreement within one universal binary');
for (const r of macho) {
  if ((r.slices?.length ?? 1) < 2) continue;
  o1n++;
  const key = (s) => `${s.cls}:${s.nmVersion ?? s.declaredNapi ?? s.napi ?? 'null'}`;
  const vals = [...new Set(r.slices.map(key))];
  const ok = vals.length === 1;
  ok ? o1ok++ : o1bad++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${r.rel.slice(-58).padEnd(58)} ` +
              `${vals.join(' | ')}`);
}
console.log(`  => ${o1ok} agree, ${o1bad} disagree (of ${o1n} universal binaries)\n`);

// ------------------------------------------------------------------------- O2
const peByKey = new Map();
for (const r of pe) if (r.declared != null && !peByKey.has(r.key)) peByKey.set(r.key, r.declared);
let o2ok = 0, o2bad = 0, o2none = 0;
console.log('O2  cross-flavour agreement (Mach-O vs PE; PE side validated by E001 loads)');
const o2seen = new Set();
for (const r of macho) {
  const mine = [...new Set((r.slices ?? [r]).map((s) => s.declaredNapi ?? r.declared)
                                            .filter((v) => v != null))];
  if (!mine.length) continue;
  const pv = peByKey.get(r.key);
  if (pv == null) { o2none++; continue; }
  if (o2seen.has(r.key + ':' + mine.join('/'))) continue;
  o2seen.add(r.key + ':' + mine.join('/'));
  const ok = mine.length === 1 && mine[0] === pv;
  ok ? o2ok++ : o2bad++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${r.key.padEnd(30)} macho=${mine.join('/')} pe=${pv}`);
}
console.log(`  => ${o2ok} agree, ${o2bad} disagree, ${o2none} without a comparable pair\n`);

// ------------------------------------------------------------------------- O3
let o3ok = 0, o3bad = 0, o3unread = 0, o3nolabel = 0;
console.log('O3  filename ABI label agreement (raw-V8 only)');
for (const r of macho) {
  const raws = (r.slices ?? [r]).filter((s) => /raw-v8/.test(s.cls ?? r.class));
  if (!raws.length) continue;
  for (const s of raws) {
    const v = s.nmVersion ?? r.abi;
    if (v == null) {
      o3unread++;
      console.log(`  UNREAD   ${r.rel.slice(-58)}  ${s.nmMethod ?? '-'}`);
      continue;
    }
    if (r.label == null) { o3nolabel++; continue; }
    if (v === r.label) o3ok++;
    else {
      o3bad++;
      console.log(`  DISAGREE ${r.rel.slice(-58)}  derived ${v} vs label ${r.label}`);
    }
  }
}
console.log(`  => ${o3ok} agree, ${o3bad} disagree, ${o3unread} unread, ${o3nolabel} unlabelled\n`);

// -------------------------------------------------------------------- coverage
const tally = new Map();
for (const s of images) {
  const cls = s.cls ?? '-';
  const v = s.nmVersion ?? s.declaredNapi ?? s.napi ?? null;
  const k = v != null ? `read:${cls}` : `unread:${cls}:${(s.nmMethod ?? s.declaredMethod ?? '-').split(':')[0]}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log('coverage of the SHIPPED derivation, by image');
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
}
const refused = macho.filter((r) => r.unknown);
console.log(`  ${refused.length} file(s) still resolve to unknown`);
for (const r of refused) console.log(`     ${r.rel.slice(-70)} ${r.class}`);

if (images.length < EXPECT_MIN_IMAGES) {
  console.log(`\nCORPUS SHRANK: ${images.length} images, E007 measured ${EXPECT_MIN_IMAGES}. ` +
              `The oracles above are weaker than when they were recorded.`);
  bad++;
}
if (o1n < EXPECT_MIN_FAT) {
  console.log(`\nCORPUS SHRANK: ${o1n} universal binaries, E007 measured ${EXPECT_MIN_FAT}. ` +
              `O1 is weaker than when it was recorded.`);
  bad++;
}
bad += o1bad + o2bad + o3bad + o3unread;

console.log(`\n${bad ? 'REGRESSION' : 'OK'}: src/ ${bad ? 'does not satisfy' : 'satisfies'} the E007 oracles.`);
process.exit(bad ? 1 : 0);
