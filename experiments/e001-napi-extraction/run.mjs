// E001 runner: score static analysis against measured ground truth.
//
// Ground truth = does process.dlopen() actually succeed, measured in a child
// process (so a segfaulting addon cannot take this process down).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { analyze, buildHeaderMap, decide } from './analyze.mjs';

const LOCAL = process.env.LOCALAPPDATA;
const HOME = process.env.USERPROFILE;

const RUNTIMES = [
  { name: 'node22', exe: path.join(LOCAL, 'ms-playwright-go/1.50.1/node.exe') },
  { name: 'node24', exe: path.join(LOCAL, 'ms-playwright-go/1.57.0/node.exe') },
  { name: 'node25', exe: process.execPath },
];

for (const r of RUNTIMES) {
  const out = execFileSync(r.exe, ['-p',
    'process.versions.modules+" "+process.versions.napi+" "+process.version+" "+process.platform+" "+process.arch'],
    { encoding: 'utf8' }).trim().split(' ');
  r.abi = +out[0]; r.napi = +out[1]; r.version = out[2]; r.os = out[3]; r.arch = out[4];
}

// ---- corpus: my fixtures (known ground truth) + every real addon on this box ----
// Discovery is deliberately broad: the analyzer was written against six
// hand-inspected artifacts, so everything else here is held-out data. Dedupe is
// by content hash, not path, so an addon that happens to be installed in three
// places does not get three votes in the score.
const FIX = 'experiments/fixtures/native';

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

const seenHash = new Set();
const corpus = [];
for (const f of [
  ...fs.readdirSync(FIX).filter((f) => f.endsWith('.node')).map((f) => path.join(FIX, f)),
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
]) {
  if (!fs.existsSync(f)) continue;
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (seenHash.has(h)) continue;
  seenHash.add(h);
  corpus.push(f);
}

function probe(exe, file) {
  const r = spawnSync(exe, ['-e', `process.dlopen({exports:{}},${JSON.stringify(path.resolve(file))})`],
    { encoding: 'utf8', timeout: 20000 });
  if (r.status === 0) return { load: true, detail: 'ok' };
  const err = (r.stderr || '') + (r.error ? r.error.message : '');
  const code = (err.match(/ERR_[A-Z_]+/) || [])[0];
  const nmv = (err.match(/NODE_MODULE_VERSION (\d+)/g) || []).join(' ');
  return {
    load: false,
    detail: r.status === null || r.status === 3221225477 || r.signal ? `CRASH(${r.signal || r.status})`
      : code ? code + (nmv ? ' [' + nmv + ']' : '') : `exit ${r.status}`,
  };
}

const headerMap = buildHeaderMap(path.join(LOCAL, 'node-gyp/Cache/25.1.0/include/node'));

console.log(`header-derived napi symbol map: ${headerMap.size} symbols`);
console.log('runtimes: ' + RUNTIMES.map((r) => `${r.name}=${r.version}(ABI${r.abi},napi${r.napi})`).join('  '));
console.log(`corpus: ${corpus.length} distinct artifacts (content-hash deduped)`);
console.log();

const label = (f) => f.split(/[\\/]/).slice(-2).join('/');

const rows = [];
for (const f of corpus) {
  let rec;
  try { rec = analyze(f, headerMap); }
  catch (e) {
    rec = { file: path.basename(f), class: 'PARSE-FAIL',
            constraints: [{ kind: 'unknown', source: e.message }] };
  }
  rec.label = label(f);
  // Content hash, so a later regression test can key ground truth unambiguously.
  // The last-two-path-segments label is NOT unique: darwin/x64/kerberos.node and
  // win32/x64/kerberos.node both render as x64/kerberos.node.
  rec.sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  rec.truth = {};
  for (const r of RUNTIMES) rec.truth[r.name] = probe(r.exe, f);
  rows.push({ f, rec });
}

// -------------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
const renderReq = (rec) => rec.constraints.map((c) =>
  c.kind === 'platform' ? `${c.os ?? '?'}/${c.arch ?? '?'}`
  : c.kind === 'napi-min' ? `napi>=${c.napi}`
  : c.kind === 'abi-exact' ? `abi==${c.abi}` : 'UNKNOWN').join(' ');

console.log(pad('artifact', 42) + pad('class', 17) + pad('requires', 26) + 'load 22/24/25');
console.log('-'.repeat(110));
for (const { rec } of rows) {
  const t = RUNTIMES.map((r) => (rec.truth[r.name].load ? 'OK' : ' X')).join('/');
  console.log(pad(rec.label.slice(0, 41), 42) + pad(rec.class, 17) + pad(renderReq(rec), 26) + t +
    '  ' + RUNTIMES.filter((r) => !rec.truth[r.name].load)
      .map((r) => `${r.name}:${rec.truth[r.name].detail}`).join(' ').slice(0, 60));
}

// ---- score the models ----
// Each model isolates exactly one variable against M-static.
const models = {
  'M-static (three-axis, derived)': (rec, rt) => decide(rec.constraints, rt).ok,
  'M-no-platform (ABI/napi only, no axis 0)': (rec, rt) =>
    decide(rec.constraints.filter((c) => c.kind !== 'platform'), rt).ok,
  'M-import-floor (weak static napi)': (rec, rt) =>
    decide(rec.constraints.map((c) =>
      c.kind === 'napi-min' ? { ...c, napi: rec.importFloor ?? 1 } : c), rt).ok,
  'M-abi-only (single hash / MVP-SPEC built/<abiKey>)': (rec, rt) => rt.abi === RUNTIMES[2].abi,
  'M-optimistic (npm/pnpm/yarn: assume portable)': () => true,
};

console.log();
console.log(pad('model', 52) + pad('correct', 10) + pad('FALSE-NEG', 12) + 'FALSE-POS');
console.log('-'.repeat(110));
const totals = {};
for (const [name, fn] of Object.entries(models)) {
  let ok = 0, fn_ = 0, fp = 0, n = 0;
  const fnList = [], fpList = [];
  for (const { rec } of rows) {
    for (const rt of RUNTIMES) {
      const predicted = fn(rec, rt);
      const actual = rec.truth[rt.name].load;
      n++;
      if (predicted === actual) ok++;
      else if (predicted && !actual) { fn_++; fnList.push(`${rec.label}@${rt.name}`); }
      else { fp++; fpList.push(`${rec.label}@${rt.name}`); }
    }
  }
  totals[name] = { ok, fn_, fp, n, fnList, fpList };
  console.log(pad(name, 52) + pad(`${ok}/${n}`, 10) + pad(fn_, 12) + fp);
}
console.log();
for (const [name, t] of Object.entries(totals)) {
  if (t.fn_) console.log(`  ${name}\n    FALSE NEG (unsafe, ${t.fn_}): ${t.fnList.slice(0, 6).join(', ')}${t.fnList.length > 6 ? ' …' : ''}`);
  if (t.fp) console.log(`  ${name}\n    FALSE POS (over-invalidation, ${t.fp}): ${t.fpList.slice(0, 6).join(', ')}${t.fpList.length > 6 ? ' …' : ''}`);
}

// ---- stratified score: only the cells the platform axis does NOT decide ----
// Most of the corpus is prebuild directories shipping every platform, and those
// are trivially refused by axis 0. Reporting only the headline number would let
// the easy cells carry the result. The honest question is: on artifacts that
// ARE loadable objects for this host, do the ABI/N-API axes get it right?
const platformOk = (rec, rt) => decide(rec.constraints.filter((c) => c.kind === 'platform'), rt).ok;
const strat = {};
for (const [name, fn] of Object.entries(models)) {
  let ok = 0, fn_ = 0, fp = 0, n = 0;
  for (const { rec } of rows) {
    for (const rt of RUNTIMES) {
      if (!platformOk(rec, rt)) continue;
      const predicted = fn(rec, rt), actual = rec.truth[rt.name].load;
      n++;
      if (predicted === actual) ok++;
      else if (predicted && !actual) fn_++;
      else fp++;
    }
  }
  strat[name] = { ok, fn_, fp, n };
}
console.log();
console.log('STRATIFIED: host-loadable artifacts only (platform axis satisfied)');
console.log(pad('model', 52) + pad('correct', 10) + pad('FALSE-NEG', 12) + 'FALSE-POS');
console.log('-'.repeat(110));
for (const [name, t] of Object.entries(strat)) {
  console.log(pad(name, 52) + pad(`${t.ok}/${t.n}`, 10) + pad(t.fn_, 12) + t.fp);
}

fs.writeFileSync('experiments/e001-napi-extraction/results.json',
  JSON.stringify({ runtimes: RUNTIMES, rows: rows.map((r) => r.rec), totals, stratified: strat }, null, 2));
console.log('\nwrote experiments/e001-napi-extraction/results.json');
