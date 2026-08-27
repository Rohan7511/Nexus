// Regression: does the promoted src/ code still reproduce E001's measured score?
//
// E001 established M-static at 291/291 (75/75 on the discriminating subset) using
// experiments/e001-napi-extraction/analyze.mjs. src/ is a rewrite of that logic
// with a wider platform axis ({os,arch,libc}), Mach-O arch sets, and an explicit
// no-requirement constraint for bundled shared libraries. Any of those changes
// could have broken the result, so this re-scores src/ against the SAME corpus and
// the SAME cached ground truth (process.dlopen outcomes, no re-probing needed).
//
//   node test/regress-e001.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveConstraints } from '../src/artifact/constraints.mjs';
import { decide } from '../src/compat/decide.mjs';
import { resolveNapiMap } from '../src/artifact/napi-map.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const RESULTS = path.join(ROOT, 'experiments/e001-napi-extraction/results.json');

if (!fs.existsSync(RESULTS)) {
  console.error('no E001 results.json; run `npm run e001` first');
  process.exit(2);
}
const prior = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
// Keyed by CONTENT HASH, not by label: the last-two-segments label is not unique
// (darwin/x64/kerberos.node and win32/x64/kerberos.node collide), and matching on
// it silently scores one artifact against another's ground truth.
const truthBySha = new Map(prior.rows.map((r) => [r.sha, r]));
if ([...truthBySha.keys()].some((k) => !k)) {
  console.error('results.json predates content hashing; re-run `npm run e001`');
  process.exit(2);
}

// Same discovery as E001, so the corpus is the same set.
function discover(root, depth) {
  const out = [];
  const walk = (d, left) => {
    if (left < 0) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith('.node')) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

const FIX = path.join(ROOT, 'experiments/fixtures/native');
const seen = new Set();
const corpus = [];
for (const f of [
  ...fs.readdirSync(FIX).filter((x) => x.endsWith('.node')).map((x) => path.join(FIX, x)),
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
]) {
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  if (seen.has(h)) continue;
  seen.add(h);
  corpus.push({ file: f, sha: h, buf });
}

const { map: napiMap, source, defaultNapi } = resolveNapiMap();
const RUNTIMES = prior.runtimes;

let cells = 0, ok = 0;
const fn = [], fp = [], missing = [], discCells = { n: 0, ok: 0, fn: 0, fp: 0 };

for (const item of corpus) {
  const label = item.file.split(/[\\/]/).slice(-2).join('/');
  const truth = truthBySha.get(item.sha);
  if (!truth) { missing.push(label); continue; }

  // Exercise the PRODUCTION derivation, defaultNapi included. E005 added the
  // header-derived default as a floor for non-declaring addons, which raises some
  // artifacts from an import floor of 0-1 to 8. That is a real behaviour change on
  // the PE path too, so it has to be re-scored against the measured loads rather
  // than assumed harmless.
  const a = deriveConstraints(item.buf, napiMap, { name: path.basename(item.file), defaultNapi });

  for (const rt of RUNTIMES) {
    const runtime = { os: rt.os, arch: rt.arch, abi: rt.abi, napi: rt.napi, libc: null };
    const predicted = decide(a.constraints, runtime).ok;
    const actual = truth.truth[rt.name].load;
    cells++;
    if (predicted === actual) ok++;
    else if (predicted && !actual) fn.push(`${label}@${rt.name} (${truth.truth[rt.name].detail})`);
    else fp.push(`${label}@${rt.name}`);

    // Discriminating subset: cells where axis 0 passes, so the ABI/N-API
    // reasoning is what actually decides the outcome.
    const platformOk = decide(a.constraints.filter((c) => c.kind === 'platform'), runtime).ok;
    if (platformOk) {
      discCells.n++;
      if (predicted === actual) discCells.ok++;
      else if (predicted) discCells.fn++;
      else discCells.fp++;
    }
  }
}

console.log(`napi map: ${napiMap ? napiMap.size + ' symbols from ' + source : 'UNAVAILABLE'}`);
console.log(`default:  NODE_API_DEFAULT_MODULE_API_VERSION = ${defaultNapi ?? 'UNKNOWN'}`);
console.log(`corpus:   ${corpus.length} artifacts, ${cells} cells`);
console.log();
console.log(`src/ M-static      all cells: ${ok}/${cells}   FN ${fn.length}   FP ${fp.length}`);
console.log(`src/ M-static  discriminating: ${discCells.ok}/${discCells.n}   FN ${discCells.fn}   FP ${discCells.fp}`);
console.log();

const priorTotals = prior.totals['M-static (three-axis, derived)'];
const priorDisc = prior.stratified?.['M-static (three-axis, derived)'];
console.log(`E001 recorded      all cells: ${priorTotals.ok}/${priorTotals.n}   FN ${priorTotals.fn_}   FP ${priorTotals.fp}`);
if (priorDisc) {
  console.log(`E001 recorded  discriminating: ${priorDisc.ok}/${priorDisc.n}   FN ${priorDisc.fn_}   FP ${priorDisc.fp}`);
}

if (missing.length) {
  console.log(`\n${missing.length} artifact(s) had no cached truth (corpus drifted since E001):`);
  for (const m of missing.slice(0, 10)) console.log('  ' + m);
}
if (fn.length) { console.log('\nFALSE NEGATIVES (unsafe):'); for (const x of fn) console.log('  ' + x); }
if (fp.length) { console.log('\nFALSE POSITIVES (over-invalidation):'); for (const x of fp) console.log('  ' + x); }

const regressed = fn.length > 0 || fp.length > priorTotals.fp || ok < priorTotals.ok;
console.log(`\n${regressed ? 'REGRESSION' : 'OK'}: src/ ${regressed ? 'does not reproduce' : 'reproduces'} the E001 result.`);
process.exit(regressed ? 1 : 0);
