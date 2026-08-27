// Regression: does the promoted src/ code still satisfy E005's oracles?
//
// E005 established that the ELF requirement axis is derivable, using its own
// implementation in experiments/e005-elf-requirement/. src/ is a rewrite of that
// logic (src/artifact/elf-addon.mjs + the ELF branch of constraints.mjs) wired into
// the full derivation, so the experiment's result does not automatically transfer.
// This re-applies BOTH oracles to what actually ships.
//
// The oracles, restated -- neither needs a Linux host:
//
//   O1  CROSS-ARCHITECTURE AGREEMENT. One package version declares one N-API
//       minimum, so N independently written instruction decoders agreeing on one
//       value is evidence all N are right. A decoder bug shows up as disagreement.
//   O2  CROSS-FLAVOUR AGREEMENT. Where a package ships both PE and ELF builds of
//       one version, the declared minimum must match. The PE side is not a guess:
//       E001 validated it against 291 real load outcomes.
//
// Neither proves the LOADING direction on Linux. That still needs a Linux host and
// remains an explicitly carried risk.
//
//   node test/regress-e005.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveConstraints } from '../src/artifact/constraints.mjs';
import { resolveNapiMap } from '../src/artifact/napi-map.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME;
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
      else if (e.isFile() && e.name.endsWith('.node')) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

// Identity comes from the nearest enclosing package.json, not the filename.
const pkgCache = new Map();
function owningPackage(file) {
  let d = path.dirname(file);
  for (let i = 0; i < 12; i++) {
    if (pkgCache.has(d)) { const c = pkgCache.get(d); if (c) return c; }
    const pj = path.join(d, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (j.name) { const r = { name: j.name, version: j.version ?? '?' }; pkgCache.set(d, r); return r; }
      } catch { /* keep walking */ }
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { name: '?', version: '?' };
}

// One package.json can cover several unrelated bundled addons -- the VS Code Copilot
// extension ships kerberos, node_sqlite3 and vscode-policy-watcher under one
// manifest -- so grouping by package alone compares different components and reports
// a disagreement that is an artefact of the grouping. The comparable unit is one
// COMPONENT across platforms: strip the platform/arch/libc tokens and key on the rest.
const PLAT_TOKEN = /(?:^|[-._])(?:linuxmusl|linux|darwin|macos|win32|windows|freebsd|openbsd|musl|glibc|gnueabihf|gnueabi|gnu|msvc|android|x86_64|x64|amd64|arm64|aarch64|armhf|armv7l?|arm|ia32|i386|x86|loong64|loongarch64|riscv64d|riscv64|ppc64le|s390x|universal|d)(?=$|[-._])/g;

function componentKey(file) {
  let b = path.basename(file).replace(/\.node$/i, '').toLowerCase();
  let prev;
  do { prev = b; b = b.replace(PLAT_TOKEN, ''); } while (b !== prev);
  return b.replace(/[-._]+/g, '') || '(single)';
}

const { map: napiMap, source, defaultNapi } = resolveNapiMap();

const seen = new Set();
const rows = [];
for (const f of [
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

  // The SHIPPED derivation, evidence and all.
  const a = deriveConstraints(buf, napiMap, { name: path.basename(f), defaultNapi });
  if (a.format !== 'elf' && a.format !== 'pe') continue;
  const pkg = owningPackage(f);
  const napi = a.constraints.find((c) => c.kind === 'napi-min');
  rows.push({
    sha, format: a.format, class: a.class,
    key: `${pkg.name}@${pkg.version}:${componentKey(f)}`,
    rel: f.split(/[\\/]/).slice(-2).join('/'),
    arch: a.container?.arch ?? null,
    declared: a.declaredNapi ?? null,
    method: a.declaredMethod ?? '-',
    napi: napi?.napi ?? null,
    napiSource: napi?.source ?? null,
    unknown: a.constraints.some((c) => c.kind === 'unknown'),
  });
}

const elf = rows.filter((r) => r.format === 'elf');
const pe = rows.filter((r) => r.format === 'pe');
const group = (rs) => {
  const m = new Map();
  for (const r of rs) { if (!m.has(r.key)) m.set(r.key, []); m.get(r.key).push(r); }
  return m;
};
const byKeyElf = group(elf), byKeyPe = group(pe);

console.log(`napi map: ${napiMap ? napiMap.size + ' symbols from ' + source : 'UNAVAILABLE'}`);
console.log(`default:  NODE_API_DEFAULT_MODULE_API_VERSION = ${defaultNapi ?? 'UNKNOWN'}`);
console.log(`corpus:   ${elf.length} ELF, ${pe.length} PE\n`);

// ------------------------------------------------------------------------- O1
let o1ok = 0, o1bad = 0, o1skip = 0, multiArch = 0;
console.log('O1  cross-architecture agreement within one component+version');
for (const [k, rs] of [...byKeyElf.entries()].sort()) {
  const withDecl = rs.filter((r) => r.declared !== null);
  const shas = new Set(rs.map((r) => r.sha));
  const arches = [...new Set(rs.map((r) => r.arch))];
  if (withDecl.length < 2 || shas.size < 2) { o1skip++; continue; }
  const vals = [...new Set(withDecl.map((r) => r.declared))];
  // An n-api artifact whose declared symbol is present but unreadable is a decoder
  // gap, and counts against the oracle even if the readable ones agree.
  const unread = rs.filter((r) => r.class === 'n-api' && r.declared === null &&
                                  /^unrecognised/.test(r.method));
  const ok = vals.length === 1 && unread.length === 0;
  ok ? o1ok++ : o1bad++;
  if (arches.length >= 2) multiArch++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${k.padEnd(42)} declared=${vals.join('/')} ` +
              `over ${shas.size} build(s), ${arches.length} arch(es): ${arches.join(',')}` +
              (unread.length ? `  UNREAD:${unread.length}` : ''));
}
console.log(`  => ${o1ok} agree, ${o1bad} disagree, ${o1skip} single-build (not comparable)`);
console.log(`     of the comparable groups, ${multiArch} span 2+ architectures\n`);

// ------------------------------------------------------------------------- O2
let o2ok = 0, o2bad = 0, o2none = 0;
console.log('O2  cross-flavour agreement (ELF vs PE; PE side validated by E001 loads)');
for (const [k, rs] of [...byKeyElf.entries()].sort()) {
  const p = byKeyPe.get(k);
  if (!p) { o2none++; continue; }
  const ev = [...new Set(rs.filter((r) => r.declared !== null).map((r) => r.declared))];
  const pv = [...new Set(p.filter((r) => r.declared !== null).map((r) => r.declared))];
  if (!ev.length || !pv.length) { o2none++; continue; }
  const ok = ev.length === 1 && pv.length === 1 && ev[0] === pv[0];
  ok ? o2ok++ : o2bad++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${k.padEnd(42)} elf=${ev.join('/')} pe=${pv.join('/')}`);
}
console.log(`  => ${o2ok} agree, ${o2bad} disagree, ${o2none} without a comparable pair\n`);

// -------------------------------------------------------------------- coverage
const declaredRead = elf.filter((r) => r.declared !== null).length;
const bySource = {};
for (const r of elf) bySource[r.napiSource ?? 'none'] = (bySource[r.napiSource ?? 'none'] ?? 0) + 1;
const refused = elf.filter((r) => r.unknown);
console.log('coverage of the SHIPPED derivation');
console.log(`  declared value read : ${declaredRead}/${elf.length}`);
console.log(`  requirement source  : ${Object.entries(bySource).sort()
  .map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  still unknown       : ${refused.length}`);
for (const r of refused) console.log(`     ${r.rel} ${r.arch} ${r.class} ${r.method}`);

// A floor of 0 or 1 on a real N-API addon is the napi-rs false-negative shape: it
// would accept the artifact on any runtime. The header default exists to close it.
const tooLow = elf.filter((r) => r.class === 'n-api' && r.napi != null && r.napi < 2);
if (tooLow.length) {
  console.log(`\n${tooLow.length} N-API artifact(s) floored below 2 -- false-negative shape:`);
  for (const r of tooLow) console.log(`     ${r.rel} napi=${r.napi} (${r.napiSource})`);
}

const bad = o1bad + o2bad + tooLow.length;
console.log(`\n${bad ? 'REGRESSION' : 'OK'}: src/ ${bad ? 'does not satisfy' : 'satisfies'} the E005 oracles.`);
process.exit(bad ? 1 : 0);
