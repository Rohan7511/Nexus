// E005: can the REQUIREMENT axis be derived from ELF artifacts?
//
// Nexus derives the platform axis for ELF (E003) but emits an explicit `unknown`
// requirement axis, so every Linux and macOS artifact is refused. That is sound and
// useless: "safe because it never says yes" is not a product. This experiment asks
// whether the N-API minimum and raw ABI are statically derivable from ELF the way
// E001 showed they are from PE.
//
// THE ORACLE PROBLEM. E001 could validate against ground truth by actually loading
// each artifact on each runtime. This host is win32, so no ELF artifact can be
// loaded here and that oracle is unavailable. Two substitutes, neither requiring a
// Linux host:
//
//   O1  CROSS-ARCHITECTURE AGREEMENT. One package version declares one N-API
//       minimum. koffi ships the same version for x64, ia32, arm64, arm, loong64
//       and riscv64, so six independently written instruction decoders agreeing on
//       one value is strong evidence that all six are correct. A decoder bug shows
//       up as disagreement.
//
//   O2  CROSS-FLAVOUR AGREEMENT. Where a package ships both PE and ELF artifacts of
//       the same version, the declared minimum must match. The PE side is not a
//       guess -- E001 validated it against 291 real load outcomes. This transfers
//       that validated ground truth onto the ELF path.
//
// Neither oracle proves the LOADING direction on Linux; that still needs a Linux
// host and remains an explicitly carried risk.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readElf } from '../../src/artifact/elf.mjs';
import { readPE } from '../../src/artifact/pe.mjs';
import { nodeImports, classify as classifyPe, readDeclaredNapi } from '../../src/artifact/pe-addon.mjs';
import { resolveNapiMap } from '../../src/artifact/napi-map.mjs';
import { readConstReturn, normalizeFuncAddr } from '../../src/artifact/code-imm.mjs';
import { readDynsym, vaddrToOffset } from './elf-sym.mjs';

const HOME = process.env.USERPROFILE;
const GETVER = 'node_api_module_get_api_version_v1';

// Node's own default when a module declares nothing. Read from the local headers
// rather than remembered: node_version.h defines it.
function defaultModuleApiVersion() {
  for (const d of [path.join(process.env.LOCALAPPDATA ?? '', 'node-gyp/Cache')]) {
    let vers;
    try { vers = fs.readdirSync(d); } catch { continue; }
    for (const v of vers) {
      const h = path.join(d, v, 'include/node/node_version.h');
      try {
        const m = fs.readFileSync(h, 'utf8')
          .match(/#define\s+NODE_API_DEFAULT_MODULE_API_VERSION\s+(\d+)/);
        if (m) return { value: Number(m[1]), source: h };
      } catch { /* next */ }
    }
  }
  return { value: null, source: null };
}

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

// Identity comes from the nearest enclosing package.json, not from the filename.
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

// A single package.json can cover several unrelated bundled addons -- the VS Code
// Copilot extension ships kerberos, node_sqlite3 and vscode-policy-watcher under
// one manifest. Grouping by package alone therefore compares different components
// and reports a disagreement that is an artefact of the grouping, not of the
// deriver. The comparable unit is one COMPONENT across platforms, so strip the
// platform/arch/libc tokens out of the filename and key on what is left.
const PLAT_TOKEN = /(?:^|[-._])(?:linuxmusl|linux|darwin|macos|win32|windows|freebsd|openbsd|musl|glibc|gnueabihf|gnueabi|gnu|msvc|android|x86_64|x64|amd64|arm64|aarch64|armhf|armv7l?|arm|ia32|i386|x86|loong64|loongarch64|riscv64d|riscv64|ppc64le|s390x|universal|d)(?=$|[-._])/g;

function componentKey(file) {
  let b = path.basename(file).replace(/\.node$/i, '').toLowerCase();
  let prev;
  do { prev = b; b = b.replace(PLAT_TOKEN, ''); } while (b !== prev);
  return b.replace(/[-._]+/g, '') || '(single)';
}

const { map: napiMap, symbols: mapSize, source: mapSource } = resolveNapiMap();
const DEFAULT_API = defaultModuleApiVersion();

/** Import floor: highest N-API level any referenced symbol requires. */
function importFloor(names) {
  if (!napiMap) return { floor: null, top: null, count: 0 };
  let floor = 0, top = null, count = 0;
  for (const n of names) {
    const lvl = napiMap.get(n);
    if (lvl == null) continue;
    count++;
    if (lvl > floor) { floor = lvl; top = n; }
  }
  return { floor, top, count };
}

function analyzeElf(buf, elf) {
  const syms = readDynsym(buf, elf);
  if (!syms.length) return { class: 'no-dynsym', declared: null, method: 'no-dynsym' };
  const defined = syms.filter((s) => s.defined);
  const undef = syms.filter((s) => !s.defined);
  const napiUndef = undef.filter((s) => /^(napi_|node_api_)/.test(s.name)).map((s) => s.name);
  const usesRaw = undef.some((s) => s.name === 'node_module_register');
  const definesEntry = defined.some((s) => s.name === 'napi_register_module_v1');
  const getVer = defined.find((s) => s.name === GETVER);

  let cls = 'unknown';
  if (usesRaw) cls = 'raw-v8';
  else if (getVer || definesEntry || napiUndef.length) cls = 'n-api';

  let declared = null, method = 'absent';
  if (getVer) {
    const off = vaddrToOffset(elf, normalizeFuncAddr(getVer.value, elf.arch));
    if (off == null) method = 'unmapped-vaddr';
    else {
      declared = readConstReturn(buf, off, elf.arch);
      method = declared == null
        ? 'unrecognised:' + buf.subarray(off, off + 12).toString('hex')
        : 'const-return:' + elf.arch;
    }
  }
  const fl = importFloor(napiUndef);
  return { class: cls, declared, method, floor: fl.floor, floorTop: fl.top,
           floorCount: fl.count, napiUndef: napiUndef.length, definesEntry, usesRaw };
}

function analyzePe(buf) {
  let pe;
  try { pe = readPE(buf); } catch { return null; }
  if (!pe) return null;
  const imps = nodeImports(pe);
  const d = readDeclaredNapi(pe);
  return { class: classifyPe(pe, imps), declared: d.value, method: d.method,
           ...importFloor(imps.filter((s) => /^(napi_|node_api_)/.test(s))) };
}

// ------------------------------------------------------------------ collect
const seen = new Set();
const elfRows = [], peRows = [];
for (const f of [
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
  ...discover('experiments/e004-vertical-slice/demo', 6),
]) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (seen.has(sha)) continue;
  seen.add(sha);
  const pkg = owningPackage(f);
  const rel = f.split(/[\\/]/).slice(-2).join('/');

  const elf = readElf(buf);
  if (elf) {
    elfRows.push({ sha, rel, pkg: pkg.name, version: pkg.version, comp: componentKey(f),
                   arch: elf.arch, os: elf.os, libc: elf.libc, ...analyzeElf(buf, elf) });
    continue;
  }
  const pe = analyzePe(buf);
  if (pe) peRows.push({ sha, rel, pkg: pkg.name, version: pkg.version, comp: componentKey(f), ...pe });
}

// ------------------------------------------------------------------- report
const pad = (s, n) => String(s ?? '-').padEnd(n);
console.log('E005 -- ELF requirement-axis derivation');
console.log(`napi map     ${mapSize} symbols  ${mapSource ? '(' + mapSource + ')' : '(NONE)'}`);
console.log(`default api  ${DEFAULT_API.value ?? 'UNKNOWN'}` +
            (DEFAULT_API.source ? `  (${DEFAULT_API.source.split(/[\\/]/).slice(-3).join('/')})` : ''));
console.log(`corpus       ${elfRows.length} ELF, ${peRows.length} PE\n`);

console.log(pad('artifact', 40), pad('pkg', 22), pad('arch', 8), pad('class', 8),
            pad('decl', 5), pad('floor', 6), 'method');
console.log('-'.repeat(125));
for (const r of [...elfRows].sort((a, b) => (a.pkg + a.arch < b.pkg + b.arch ? -1 : 1))) {
  console.log(pad(r.rel.slice(0, 39), 40), pad(r.pkg.slice(0, 21), 22), pad(r.arch, 8),
              pad(r.class, 8), pad(r.declared, 5), pad(r.floor, 6), r.method.slice(0, 40));
}

// -------------------------------------------------- O1 cross-arch agreement
console.log('\nO1  agreement within one component+version (independent builds of one source)');
const byPkg = new Map();
for (const r of elfRows) {
  const k = `${r.pkg}@${r.version}:${r.comp}`;
  if (!byPkg.has(k)) byPkg.set(k, []);
  byPkg.get(k).push(r);
}
let o1ok = 0, o1bad = 0, o1skip = 0, multiArch = 0;
for (const [k, rs] of [...byPkg.entries()].sort()) {
  const withDecl = rs.filter((r) => r.declared !== null);
  const arches = [...new Set(rs.map((r) => r.arch))];
  // Distinct builds, not duplicate installs of one file: dedupe by sha first.
  const shas = new Set(rs.map((r) => r.sha));
  if (withDecl.length < 2 || shas.size < 2) { o1skip++; continue; }
  const vals = [...new Set(withDecl.map((r) => r.declared))];
  const unread = rs.filter((r) => r.class === 'n-api' && r.declared === null && r.method.startsWith('unrecognised'));
  const ok = vals.length === 1 && unread.length === 0;
  ok ? o1ok++ : o1bad++;
  if (arches.length >= 2) multiArch++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${pad(k, 42)} declared=${vals.join('/')} ` +
              `over ${shas.size} distinct build(s), ${arches.length} arch(es): ${arches.join(',')}` +
              (unread.length ? `  UNREAD:${unread.length}` : ''));
}
console.log(`  => ${o1ok} agree, ${o1bad} disagree, ${o1skip} single-build (not comparable)`);
console.log(`     of the comparable groups, ${multiArch} span 2+ architectures`);

// ------------------------------------------------ O2 cross-flavour agreement
console.log('\nO2  cross-flavour agreement (ELF vs PE, PE side validated by E001 loads)');
const peByPkg = new Map();
for (const r of peRows) {
  const k = `${r.pkg}@${r.version}:${r.comp}`;
  if (!peByPkg.has(k)) peByPkg.set(k, []);
  peByPkg.get(k).push(r);
}
let o2ok = 0, o2bad = 0, o2none = 0;
for (const [k, rs] of [...byPkg.entries()].sort()) {
  const pe = peByPkg.get(k);
  if (!pe) { o2none++; continue; }
  const elfVals = [...new Set(rs.filter((r) => r.declared !== null).map((r) => r.declared))];
  const peVals = [...new Set(pe.filter((r) => r.declared !== null).map((r) => r.declared))];
  if (!elfVals.length || !peVals.length) { o2none++; continue; }
  const ok = elfVals.length === 1 && peVals.length === 1 && elfVals[0] === peVals[0];
  ok ? o2ok++ : o2bad++;
  console.log(`  ${ok ? 'AGREE  ' : 'DISAGREE'} ${pad(k, 34)} elf=${elfVals.join('/')} pe=${peVals.join('/')}`);
}
console.log(`  => ${o2ok} agree, ${o2bad} disagree, ${o2none} without a comparable pair`);

// ------------------------------------------------------------- coverage view
const cls = {};
for (const r of elfRows) cls[r.class] = (cls[r.class] ?? 0) + 1;
const decided = elfRows.filter((r) => r.declared !== null).length;
const floorOnly = elfRows.filter((r) => r.declared === null && r.class === 'n-api' && r.napiUndef > 0).length;
const defaultOnly = elfRows.filter((r) => r.declared === null && r.class === 'n-api' && r.napiUndef === 0).length;
const refused = elfRows.filter((r) => r.class !== 'n-api' && r.class !== 'raw-v8').length;
console.log('\ncoverage');
console.log(`  classes: ${Object.entries(cls).map(([k, v]) => k + '=' + v).join(' ')}`);
console.log(`  declared value read        : ${decided}/${elfRows.length}`);
console.log(`  import floor only          : ${floorOnly}`);
console.log(`  header default only        : ${defaultOnly}  (no declared symbol, no napi imports)`);
console.log(`  would still refuse         : ${refused}`);
const unread = elfRows.filter((r) => r.method.startsWith('unrecognised') || r.method === 'unmapped-vaddr');
console.log(`  declared present but unread: ${unread.length}`);
for (const r of unread) console.log(`     ${r.rel} ${r.arch} ${r.method}`);

process.exit(o1bad + o2bad === 0 ? 0 : 1);
