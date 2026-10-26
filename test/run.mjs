// Invariant tests. These do not measure accuracy -- E001 and test/regress-e001.mjs
// do that. These assert the STRUCTURAL properties that must hold regardless of
// corpus, because every one of them is a failure mode identified in the red-team.
//
//   node test/run.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveConstraints } from '../src/artifact/constraints.mjs';
import { readConstReturn, normalizeFuncAddr } from '../src/artifact/code-imm.mjs';
import { readMacho } from '../src/artifact/macho.mjs';
import { readContainer } from '../src/artifact/container.mjs';
import { check, decide } from '../src/compat/decide.mjs';
import { resolveTree } from '../src/compat/resolve.mjs';
import { canonical, graphId, artifactId, hashJson, sha256 } from '../src/graph/serialize.mjs';
import { Store } from '../src/store/cas.mjs';
import { scanTree, isNativeObject, isSharedLibrary, unexaminedArtifacts } from '../src/graph/scan.mjs';
import { currentRuntime, parseTarget, targetRuntime } from '../src/runtime/probe.mjs';
import { evaluate } from '../src/commands/check.mjs';
import { parseArgs } from '../src/cli.mjs';

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const RT = { os: 'linux', arch: 'x64', abi: 137, napi: 10, libc: 'glibc' };

// ---------------------------------------------------------------- conjunction
test('empty constraint set refuses (an empty conjunction is vacuously true)', () => {
  assert(decide([], RT).ok === false, 'empty set was accepted');
  assert(decide(null, RT).ok === false, 'null was accepted');
});

test('unknown constraint refuses', () => {
  assert(check({ kind: 'unknown', source: 'x' }, RT).ok === false);
});

test('unrecognised constraint kind refuses rather than being ignored', () => {
  assert(check({ kind: 'some-future-axis' }, RT).ok === false);
});

test('one failing member fails the whole conjunction', () => {
  const cs = [
    { kind: 'platform', os: 'linux', arch: 'x64', libc: 'glibc' },
    { kind: 'napi-min', napi: 99 },
  ];
  const d = decide(cs, RT);
  assert(d.ok === false, 'conjunction passed with a failing member');
  assert(d.satisfied.length === 1, 'satisfied members should still be reported');
  assert(d.failures.length === 1);
});

// ------------------------------------------------------------------- platform
test('undetermined architecture refuses (E001: 18 false-negative cells)', () => {
  assert(check({ kind: 'platform', os: 'win32', arch: null }, { os: 'win32', arch: 'x64' }).ok === false);
});

test('undetermined OS refuses', () => {
  assert(check({ kind: 'platform', os: null, arch: 'x64' }, { os: 'linux', arch: 'x64' }).ok === false);
});

test('wrong architecture on the host OS refuses', () => {
  assert(check({ kind: 'platform', os: 'win32', arch: 'arm64' }, { os: 'win32', arch: 'x64' }).ok === false);
});

test('libc mismatch refuses on linux (E003)', () => {
  const musl = { kind: 'platform', os: 'linux', arch: 'x64', libc: 'musl' };
  assert(check(musl, RT).ok === false, 'musl artifact accepted on glibc host');
  assert(check({ ...musl, libc: 'glibc' }, RT).ok === true, 'glibc artifact refused on glibc host');
});

test('undetermined libc refuses on linux, and is ignored elsewhere', () => {
  assert(check({ kind: 'platform', os: 'linux', arch: 'x64', libc: null }, RT).ok === false);
  assert(check({ kind: 'platform', os: 'win32', arch: 'x64' }, { os: 'win32', arch: 'x64' }).ok === true);
});

test('unknown host libc refuses a linux artifact', () => {
  assert(check({ kind: 'platform', os: 'linux', arch: 'x64', libc: 'glibc' },
    { ...RT, libc: null }).ok === false);
});

test('a universal binary is satisfied by any of its slices', () => {
  const fat = { kind: 'platform', os: 'darwin', arch: null, archs: ['arm64', 'x64'] };
  assert(check(fat, { os: 'darwin', arch: 'arm64' }).ok === true);
  assert(check(fat, { os: 'darwin', arch: 'x64' }).ok === true);
  assert(check(fat, { os: 'darwin', arch: 'ia32' }).ok === false);
});

// ---------------------------------------------------------------- requirements
test('N-API is a minimum, forward-portable across ABI bumps', () => {
  assert(check({ kind: 'napi-min', napi: 9 }, { ...RT, napi: 10 }).ok === true);
  assert(check({ kind: 'napi-min', napi: 10 }, { ...RT, napi: 9 }).ok === false);
});

test('raw-V8 ABI is exact in both directions', () => {
  assert(check({ kind: 'abi-exact', abi: 137 }, { ...RT, abi: 137 }).ok === true);
  assert(check({ kind: 'abi-exact', abi: 137 }, { ...RT, abi: 141 }).ok === false);
  assert(check({ kind: 'abi-exact', abi: 137 }, { ...RT, abi: 127 }).ok === false);
});

test('a runtime reporting no N-API level refuses an N-API addon', () => {
  assert(check({ kind: 'napi-min', napi: 1 }, { ...RT, napi: null }).ok === false);
});

test('no-requirement passes normally and refuses under --strict', () => {
  const c = { kind: 'no-requirement', source: 'shared library' };
  assert(check(c, RT).ok === true);
  assert(check(c, RT, { strict: true }).ok === false);
});

// ------------------------------------------------- derivation never yields []
test('garbage bytes yield an explicit unknown, never an empty constraint set', () => {
  for (const buf of [Buffer.alloc(0), Buffer.alloc(8), Buffer.from('not a binary at all'),
                     Buffer.alloc(4096, 0x41)]) {
    const a = deriveConstraints(buf, null, { name: 'x.node' });
    assert(a.constraints.length > 0, 'empty constraint set produced');
    assert(decide(a.constraints, RT).ok === false, 'garbage was declared compatible');
  }
});

test('a truncated PE header degrades to unrecognised-container, not to a guess', () => {
  const b = Buffer.alloc(0x40);
  b[0] = 0x4d; b[1] = 0x5a;                 // 'MZ' with no PE header behind it
  b.writeUInt32LE(0x1000, 0x3c);            // e_lfanew past the end
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(decide(a.constraints, RT).ok === false);
});

test('a .node with no Node linkage refuses; a .dll with none is a plain library', () => {
  // Same bytes, different filename: the extension only decides what ABSENCE of
  // Node linkage means. A .node that looks inert is a parser gap and must refuse.
  const pe = fs.readFileSync(process.execPath.replace(/node\.exe$/i, 'node.exe'));
  if (!pe || pe.length < 1024) return;
  const asNode = deriveConstraints(pe, null, { name: 'thing.node' });
  const asDll = deriveConstraints(pe, null, { name: 'thing.dll' });
  const rt = currentRuntime();
  if (asNode.class === 'unknown') {
    assert(decide(asNode.constraints, rt).ok === false, '.node with no linkage was accepted');
    assert(asDll.constraints.some((c) => c.kind === 'no-requirement'),
      '.dll with no linkage should carry no-requirement');
  }
});

// ------------------------------------------------------------------- mach-o
test('fat Mach-O arch slices are recovered', () => {
  const b = Buffer.alloc(8 + 20 * 2);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(2, 4);
  b.writeUInt32BE(0x01000007, 8);            // x86_64
  b.writeUInt32BE(0x0100000c, 28);           // arm64
  const m = readMacho(b);
  assert(m && m.format === 'macho-fat', 'fat header not recognised');
  assert(JSON.stringify(m.archs) === '["arm64","x64"]', 'archs=' + JSON.stringify(m.archs));
});

test('a bogus fat arch count does not throw or read out of bounds', () => {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(0xffffff, 4);
  const m = readMacho(b);
  assert(m && m.archs.length === 0);
});

test('container dispatch tags unrecognised bytes as unknown', () => {
  const c = readContainer(Buffer.from('hello world, not an object file'));
  assert(c.format === 'unknown' && c.os === null && c.arch === null);
});

// -------------------------------------------------------------- serialization
test('canonical JSON is key-order independent', () => {
  assert(canonical({ b: 1, a: { d: 2, c: 3 } }) === canonical({ a: { c: 3, d: 2 }, b: 1 }));
});

test('canonical JSON drops undefined rather than emitting null', () => {
  assert(canonical({ a: 1, b: undefined }) === '{"a":1}');
});

test('graph identity ignores package order and is runtime-free', () => {
  const p1 = [{ name: 'a', version: '1', path: 'node_modules/a', files: [{ path: 'i.js', sha: 'x' }] },
              { name: 'b', version: '2', path: 'node_modules/b', files: [] }];
  const p2 = [p1[1], p1[0]];
  assert(graphId(p1) === graphId(p2), 'graph id depends on ordering');
  // Any runtime field is out of scope by construction: adding one must not change it.
  const p3 = p1.map((p) => ({ ...p, abi: 141, napi: 10 }));
  assert(graphId(p1) === graphId(p3), 'graph id absorbed a runtime field');
});

test('graph identity changes when file content changes', () => {
  const a = [{ name: 'a', version: '1', path: 'node_modules/a', files: [{ path: 'i.js', sha: 'x' }] }];
  const b = [{ name: 'a', version: '1', path: 'node_modules/a', files: [{ path: 'i.js', sha: 'y' }] }];
  assert(graphId(a) !== graphId(b));
});

// ------------------------------------------------------- partial scans
// `check` hashes only the artifacts, because hashing a whole tree to answer a
// two-artifact question cost 26s on a 3,667-file install. Two properties make that
// safe, and both are pinned here.
function fixtureTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-scan-'));
  const mk = (rel, data) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  mk('node_modules/plain/package.json', JSON.stringify({ name: 'plain', version: '1.0.0' }));
  mk('node_modules/plain/index.js', 'module.exports = 1;\n');
  mk('node_modules/plain/lib/deep/util.js', 'x'.repeat(4096));
  mk('node_modules/withaddon/package.json', JSON.stringify({ name: 'withaddon', version: '2.0.0' }));
  mk('node_modules/withaddon/index.js', 'require("./b.node");\n');
  mk('node_modules/withaddon/b.node', Buffer.from('MZ not really a PE'));
  mk('node_modules/withaddon/vendor/extra.dll', Buffer.from('MZ nor this'));
  return root;
}

test('a partial scan finds exactly the same artifacts as a full scan', () => {
  // The verdict must not depend on which mode produced the scan -- only on the
  // artifacts, which both modes hash identically.
  const root = fixtureTree();
  const key = (s) => s.packages.flatMap((p) => p.files
    .filter((f) => isNativeObject(f.path) || isSharedLibrary(f.path))
    .map((f) => `${p.path}/${f.path}@${f.sha}`)).sort().join('\n');
  const full = scanTree(root);
  const part = scanTree(root, { hashes: 'artifacts' });
  assert(key(full) === key(part), `artifact sets differ:\n${key(full)}\n---\n${key(part)}`);
  assert(key(part).split('\n').length === 2, 'fixture should expose one .node and one .dll');
  // And the partial scan really did skip the rest, or it saved nothing.
  const count = (s) => s.packages.reduce((n, p) => n + p.files.length, 0);
  assert(count(part) < count(full), 'partial scan recorded just as many files as a full one');
  assert(part.packages.length === full.packages.length, 'partial scan lost a package');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a partial scan cannot produce a graph identity', () => {
  // The dangerous case is a package with NO artifacts: in a partial scan its file
  // list is empty, which is indistinguishable from a complete one. So the guard
  // cannot be "are any hashes missing" -- it has to be an explicit marker.
  const root = fixtureTree();
  const part = scanTree(root, { hashes: 'artifacts' });
  const plain = part.packages.find((p) => p.name === 'plain');
  assert(plain.files.length === 0, 'fixture assumption: no-artifact package has an empty file list');
  let threw = false;
  try { graphId(part.packages); } catch { threw = true; }
  assert(threw, 'a partial scan produced a graph identity that would look whole-tree');
  // Handing graphId a single partial package, detached from its scan, must also fail.
  let threw2 = false;
  try { graphId([plain]); } catch { threw2 = true; }
  assert(threw2, 'the partial marker did not travel with the package');
  assert(typeof graphId(scanTree(root).packages) === 'string', 'a full scan must still work');
  fs.rmSync(root, { recursive: true, force: true });
});

test('sensitivity survives a partial scan', () => {
  // The predicate's native/shared arms read the files a partial scan keeps; its
  // script and binding.gyp arms never read files at all. A wrong "insensitive"
  // verdict is a missed incompatibility, so this must not degrade.
  const root = fixtureTree();
  const pick = (s) => Object.fromEntries(s.packages.map((p) => [p.name, p.sensitive]));
  assert(JSON.stringify(pick(scanTree(root))) === JSON.stringify(pick(scanTree(root, { hashes: 'artifacts' }))),
         'partial scan changed which packages are runtime-sensitive');
  assert(pick(scanTree(root, { hashes: 'artifacts' })).withaddon === true, 'addon package not sensitive');
  fs.rmSync(root, { recursive: true, force: true });
});

// -------------------------------------------- artifacts outside node_modules
// The package scan is node_modules-shaped by definition, but real trees keep addons
// elsewhere: in one measured extension corpus 19 of 21 `.node` files were outside any
// node_modules. Reporting "0 packages with native artifacts -- OK" for such a tree is
// a vacuous OK, which is the false-negative shape this project refuses to ship.
test('a nested node_modules below the package root is still scanned', () => {
  // The hole this closes: walkFiles skipped every node_modules as "someone else's
  // territory" while readPackage only recursed into `<pkg>/node_modules`, so a bundled
  // `<pkg>/dist/node_modules/` belonged to nobody -- invisible to the package scan AND
  // skipped by unexaminedArtifacts. Measured on a real install: 34 of 80 .node files.
  const root = fixtureTree();
  const mk = (rel, data) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  mk('node_modules/bundler/package.json', JSON.stringify({ name: 'bundler', version: '1.0.0' }));
  mk('node_modules/bundler/dist/node_modules/buried/package.json',
     JSON.stringify({ name: 'buried', version: '3.0.0' }));
  mk('node_modules/bundler/dist/node_modules/buried/deep.node', Buffer.from('MZ buried'));
  const s = scanTree(root, { hashes: 'artifacts' });
  const buried = s.packages.find((p) => p.name === 'buried');
  assert(buried, `nested package not found; scanned: ${s.packages.map((p) => p.name).join(', ')}`);
  assert(buried.files.some((f) => f.path === 'deep.node'), 'nested artifact not recorded');
  assert(buried.version === '3.0.0', 'nested package manifest not read');
  // And it must not have been double-counted as content of its host package.
  const host = s.packages.find((p) => p.name === 'bundler');
  assert(!host.files.some((f) => f.path.includes('deep.node')),
    'nested artifact was also recorded as the host package\'s content');
  // unexaminedArtifacts must stay complementary: it skips node_modules at any depth,
  // which is only correct because the scan now reaches them.
  assert(!unexaminedArtifacts(root).some((f) => f.includes('deep.node')),
    'a scanned artifact was also reported as unexamined');
  fs.rmSync(root, { recursive: true, force: true });
});

test('artifacts outside node_modules are found, and those inside are left alone', () => {
  const root = fixtureTree();
  const mk = (rel, data) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  mk('dist/compiled/darwin/arm64/kerberos.node', Buffer.from('not really Mach-O'));
  mk('dist/compiled/win32/x64/vendor.dll', Buffer.from('MZ nope'));
  mk('dist/index.js', 'x');
  const found = unexaminedArtifacts(root);
  assert(found.length === 2, `expected 2 outside artifacts, got ${found.length}: ${found.join(', ')}`);
  assert(found[0] === 'dist/compiled/darwin/arm64/kerberos.node', `unexpected first: ${found[0]}`);
  // The two artifacts inside node_modules belong to the package scan; counting them
  // here would double-report them as unexamined when they were in fact examined.
  assert(!found.some((f) => f.includes('node_modules')),
    `node_modules artifacts leaked into the unexamined list: ${found.join(', ')}`);
  assert(!found.some((f) => f.endsWith('.js')), 'a .js file was reported as a native artifact');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unexamined artifact narrows the verdict without changing it', () => {
  // Scope and verdict are separate facts. Folding these into `ok` would claim they
  // fail, which is as dishonest as claiming they pass -- neither was examined.
  const root = fixtureTree();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-unex-store-'));
  const before = evaluate({ _: [root], target: 'linux/x64/glibc:137:10', store });
  const p = path.join(root, 'dist', 'compiled', 'linux', 'x64', 'late.node');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from('\x7fELF but truncated'));
  const after = evaluate({ _: [root], target: 'linux/x64/glibc:137:10', store });
  assert(before.unexamined.length === 0, `fixture should start clean, got ${before.unexamined.join(', ')}`);
  assert(after.unexamined.length === 1, `expected 1 unexamined, got ${after.unexamined.length}`);
  assert(after.ok === before.ok, 'an unexamined artifact silently changed the verdict');
  assert(after.counts.artifacts === before.counts.artifacts,
    'an unexamined artifact was counted as if it had been examined');
  fs.rmSync(root, { recursive: true, force: true });
  rmrf(store);
});

// --------------------------------------------------------------------- store
test('store is content-addressed, idempotent, read-only and hardlink-shared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-store-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tree-'));
  try {
    const store = new Store(root).init();
    const buf = Buffer.from('some artifact bytes');
    const r1 = store.putBuffer(buf);
    const r2 = store.putBuffer(buf);
    assert(r1.sha === sha256(buf), 'address is not the content hash');
    assert(r1.added === true && r2.added === false, 'put is not idempotent');
    assert(store.has(r1.sha) && store.read(r1.sha).equals(buf), 'round trip failed');

    // Read-only: hardlinks share the inode, so a writable store entry means a
    // package writing to its own file would corrupt every other project's copy.
    let threw = false;
    try { fs.writeFileSync(store.pathFor(r1.sha), 'mutated'); } catch { threw = true; }
    assert(threw, 'store entry was writable');

    const target = path.join(dest, 'pkg', 'x.node');
    const method = store.materialize(r1.sha, target);
    assert(fs.readFileSync(target).equals(buf), 'materialized content differs');
    if (method === 'hardlink') {
      assert(fs.statSync(target).ino === fs.statSync(store.pathFor(r1.sha)).ino,
        'hardlink does not share the inode');
    }
    // Re-materializing over a read-only hardlink must succeed, not EPERM.
    store.materialize(r1.sha, target);

    assert(store.writeAnalysis(r1.sha, 'k1', { class: 'n-api' }) === true);
    assert(store.writeAnalysis(r1.sha, 'k1', { class: 'DIFFERENT' }) === false, 'analysis was overwritten');
    assert(store.readAnalysis(r1.sha, 'k1').class === 'n-api', 'analysis mutated');

    // The derivation key is part of the address. An analysis derived from a
    // different symbol map / header default must be a cache MISS, not a stale hit --
    // otherwise the store repeats the exact mistake Nexus exists to diagnose: a key
    // that omits one of its inputs.
    assert(store.readAnalysis(r1.sha, 'k2') === null,
      'analysis cached under one derivation key was served for another');
    assert(store.writeAnalysis(r1.sha, 'k2', { class: 'other' }) === true);
    assert(store.readAnalysis(r1.sha, 'k1').class === 'n-api',
      'writing a new derivation displaced the old one');
  } finally {
    rmrf(root); rmrf(dest);
  }
});

function rmrf(p) {
  // Store entries are 0o444; Windows refuses to unlink read-only files.
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else { try { fs.chmodSync(q, 0o666); } catch { /* ignore */ } }
    }
  };
  try { walk(p); } catch { /* ignore */ }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ------------------------------------------------------------------- runtime
test('the runtime descriptor carries ABI and N-API separately', () => {
  const rt = currentRuntime();
  assert(typeof rt.abi === 'number' && typeof rt.napi === 'number',
    'descriptor is missing an independent axis');
  assert(rt.os === process.platform && rt.arch === process.arch);
  assert(process.platform === 'linux' ? rt.libc !== null : rt.libc === null,
    'libc should be derived on linux and null elsewhere');
});

// ------------------------------------------------- package-level resolution
// The E004 amendment: artifacts within a package are ALTERNATIVES across
// platforms and CONJUNCTS within one. Every case below is a way to get this
// wrong that would either resurrect over-invalidation or be unsound.
const HOST = { os: 'win32', arch: 'x64', abi: 141, napi: 10, libc: null };
const site = (pkg, file, sha) => ({ package: pkg, version: '1.0.0', pkgPath: 'node_modules/' + pkg, file, sha });
const platC = (os, arch) => ({ kind: 'platform', os, arch, source: 't' });
const art = (constraints) => ({ class: 't', format: 'pe', constraints });

test('inert artifacts for other platforms are not failures (E004 amendment)', () => {
  const sites = [site('p', 'a.node', 'h1'), site('p', 'b.node', 'h2'), site('p', 'c.node', 'h3')];
  const arts = {
    h1: art([platC('win32', 'x64'), { kind: 'napi-min', napi: 9 }]),
    h2: art([platC('linux', 'x64'), { kind: 'napi-min', napi: 99 }]),
    h3: art([platC('darwin', 'arm64'), { kind: 'unknown', source: 't' }]),
  };
  const r = resolveTree(sites, arts, HOST);
  assert(r.ok, 'a package whose only host artifact loads was reported broken');
  assert(r.counts.applicable === 1 && r.counts.inert === 2,
    `expected 1 applicable / 2 inert, got ${r.counts.applicable}/${r.counts.inert}`);
  assert(r.packages[0].broken.length === 0, 'inert artifacts leaked into broken');
});

test('a package with artifacts but none applicable is broken, not vacuously ok', () => {
  const sites = [site('p', 'a.node', 'h1')];
  const r = resolveTree(sites, { h1: art([platC('linux', 'x64')]) }, HOST);
  assert(!r.ok, 'package shipping nothing for this host was accepted');
  assert(r.packages[0].noneApplicable, 'noneApplicable not set');
  assert(/none targeting/.test(r.packages[0].reason), `reason unhelpful: ${r.packages[0].reason}`);
});

test('two artifacts on the SAME platform are conjuncts, not alternatives', () => {
  // Both target the host. One cannot load. "at least one loads" would be unsound.
  const sites = [site('p', 'good.node', 'h1'), site('p', 'bad.node', 'h2')];
  const arts = {
    h1: art([platC('win32', 'x64'), { kind: 'napi-min', napi: 9 }]),
    h2: art([platC('win32', 'x64'), { kind: 'abi-exact', abi: 127 }]),
  };
  const r = resolveTree(sites, arts, HOST);
  assert(!r.ok, 'a broken host artifact was excused by a working sibling');
  assert(r.packages[0].broken.length === 1);
});

test('applicability is decided by the platform axis ALONE', () => {
  // A host-targeting artifact that fails axis 1 must be applicable-and-broken,
  // never reclassified as inert -- otherwise a real incompatibility disappears.
  const sites = [site('p', 'a.node', 'h1')];
  const arts = { h1: art([platC('win32', 'x64'), { kind: 'napi-min', napi: 99 }]) };
  const r = resolveTree(sites, arts, HOST);
  assert(r.counts.applicable === 1, 'host artifact was not applicable');
  assert(r.counts.inert === 0, 'a broken host artifact was hidden as inert');
  assert(!r.ok && r.packages[0].broken.length === 1);
});

test('a missing analysis refuses rather than being skipped', () => {
  const r = resolveTree([site('p', 'a.node', 'nosuch')], {}, HOST);
  assert(!r.ok, 'artifact with no recorded analysis was accepted');
});

// A package that declares itself off-platform in its OWN package.json is one npm
// would never select here. Calling it broken refuses `sharp`, `esbuild`, `rollup`,
// `swc`, `ngrok` -- i.e. nearly every real install. Measured: 6 of 6 refusals on an
// uncurated 128k-file tree were this shape, 4 of them declaring `os:["linux"]`.
const decl = (pkg, file, sha, declared) => ({ ...site(pkg, file, sha), declared });

test('a package declaring itself off-platform is excluded, not broken', () => {
  const sites = [decl('sharp-linux-x64', 'a.node', 'h1', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] })];
  const r = resolveTree(sites, { h1: art([platC('linux', 'x64')]) }, HOST);
  assert(r.ok, 'an off-platform optional prebuild package was reported broken');
  assert(r.packages[0].excludedBy === 'os ["linux"]', `wrong reason: ${r.packages[0].excludedBy}`);
  assert(r.counts.packagesExcluded === 1, 'exclusion was not counted');
  // Counted and reported, never silently absorbed: its artifacts are inert, not checked.
  assert(r.packages[0].inert.length === 1 && r.packages[0].applicable.length === 0,
    'excluded package artifacts were not moved to inert');
  assert(r.packages[0].broken.length === 0, 'excluded package still reported broken artifacts');
});

test('exclusion is decided per axis, and an unstated axis cannot exclude', () => {
  const cases = [
    // [declared, excluded?, note]
    [{ os: ['win32'], cpu: null, libc: null }, false, 'host os listed'],
    [{ os: ['linux', 'win32'], cpu: null, libc: null }, false, 'host os among several'],
    [{ os: ['!win32'], cpu: null, libc: null }, true, 'host os negated'],
    [{ os: ['!linux'], cpu: null, libc: null }, false, 'a different os negated'],
    [{ os: null, cpu: ['arm64'], libc: null }, true, 'cpu excludes'],
    [{ os: null, cpu: ['x64'], libc: null }, false, 'cpu matches'],
    // The host is win32, where rt.libc is null; a libc list must not exclude, or every
    // musl/glibc-tagged package would vanish from a Windows verdict.
    [{ os: null, cpu: null, libc: ['glibc'] }, false, 'libc irrelevant on win32'],
    [null, false, 'declared nothing'],
  ];
  for (const [declared, want, note] of cases) {
    const r = resolveTree([decl('p', 'a.node', 'h1', declared)],
                          { h1: art([platC('win32', 'x64'), { kind: 'napi-min', napi: 9 }]) }, HOST);
    const got = !!r.packages[0].excludedBy;
    assert(got === want, `${note}: expected excluded=${want}, got ${got} (${r.packages[0].excludedBy})`);
  }
  // On a libc-bearing runtime the axis does bite.
  const musl = { os: 'linux', arch: 'x64', abi: 141, napi: 10, libc: 'musl' };
  const r = resolveTree([decl('p', 'a.node', 'h1', { os: null, cpu: null, libc: ['glibc'] })],
                        { h1: art([platC('linux', 'x64')]) }, musl);
  assert(r.packages[0].excludedBy === 'libc ["glibc"]', `libc axis did not bite: ${r.packages[0].excludedBy}`);
});

test('exclusion never rescues a package that targets this platform', () => {
  // The dangerous direction. A package claiming to support this host must still be
  // judged on its bytes -- otherwise the metadata claim could bury a real failure.
  const sites = [decl('p', 'a.node', 'h1', { os: ['win32', 'linux'], cpu: null, libc: null })];
  const arts = { h1: art([platC('win32', 'x64'), { kind: 'napi-min', napi: 99 }]) };
  const r = resolveTree(sites, arts, HOST);
  assert(!r.ok, 'a self-declared-compatible package with an unloadable artifact was excused');
  assert(r.packages[0].excludedBy === null, 'a host-supporting package was excluded');
  assert(r.counts.packagesExcluded === 0);
});

test('packages are grouped by path, so two copies of a name stay distinct', () => {
  const sites = [
    { package: 'p', version: '1', pkgPath: 'node_modules/p', file: 'a', sha: 'h1' },
    { package: 'p', version: '2', pkgPath: 'node_modules/x/node_modules/p', file: 'b', sha: 'h2' },
  ];
  const arts = {
    h1: art([platC('win32', 'x64'), { kind: 'napi-min', napi: 9 }]),
    h2: art([platC('win32', 'x64'), { kind: 'abi-exact', abi: 127 }]),
  };
  const r = resolveTree(sites, arts, HOST);
  assert(r.counts.packages === 2, `nested duplicate collapsed: ${r.counts.packages}`);
  assert(r.counts.packagesOk === 1 && r.counts.packagesBroken === 1);
});

// ------------------------------------------------------------- ELF (E005)
// Two layers need coverage and they need it for different reasons.
//
//  * the per-architecture const-return DECODERS. E005 validated these against
//    real prebuilds by cross-architecture agreement, but that evidence lives in
//    a corpus this machine happens to have. These assert the encodings directly,
//    including the cases where the decoder must REFUSE.
//  * the ELF requirement axis end to end, on a synthetic shared object, so the
//    dynsym walk / vaddr mapping / classification path is exercised without a
//    Linux host and without depending on any installed package.

test('const-return decoders read the immediate on all six architectures', () => {
  const cases = [
    ['x64',     [0xb8, 0x0a, 0, 0, 0, 0xc3], 10],
    // gcc -O0 keeps a frame pointer, so the epilogue sits between mov and ret.
    ['x64',     [0x55, 0x89, 0xe5, 0xb8, 0x09, 0, 0, 0, 0x5d, 0xc3], 9],
    ['ia32',    [0xb8, 0x06, 0, 0, 0, 0xc3], 6],
    ['x64',     [0x31, 0xc0, 0xc3], 0],                       // xor eax,eax; ret
    ['arm64',   [0x00, 0x01, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6], 8],  // movz w0,#8; ret
    ['arm',     [0x08, 0x20, 0x70, 0x47], 8],                 // movs r0,#8; bx lr
    ['riscv64', [0x21, 0x45, 0x82, 0x80], 8],                 // c.li a0,8; c.jr ra
    ['loong64', [0x04, 0x20, 0x80, 0x02, 0x20, 0x00, 0x00, 0x4c], 8], // addi.w a0,zero,8; ret
  ];
  for (const [arch, bytes, want] of cases) {
    const got = readConstReturn(Buffer.from(bytes), 0, arch);
    assert(got === want, `${arch} ${Buffer.from(bytes).toString('hex')} -> ${got}, want ${want}`);
  }
});

test('a far-separated immediate is still read (OpenBSD retguard)', () => {
  // retguard puts a cookie check and int3 padding between the immediate and the
  // ret, so a proximity requirement would drop the value and refuse a loadable
  // artifact. Recovering it is a false-POSITIVE saving, never a soundness relaxation:
  // ambiguity below still refuses.
  const b = Buffer.alloc(48, 0xcc);
  b[0] = 0xb8; b.writeUInt32LE(8, 1);
  b[40] = 0xc3;
  assert(readConstReturn(b, 0, 'x64') === 8, 'retguard shape not decoded');
});

test('the immediate is anchored at the ret, so a dead store does not confuse it', () => {
  // mov eax,8; mov eax,10; ret really does return 10 -- the last write wins. Tier 1
  // requires the immediate to sit immediately before the ret precisely so that this
  // reads as 10 rather than as an ambiguity.
  const b = Buffer.from([0xb8, 0x08, 0, 0, 0, 0xb8, 0x0a, 0, 0, 0, 0xc3]);
  assert(readConstReturn(b, 0, 'x64') === 10, 'dead store won over the live one');
});

test('an ambiguous or ret-less function refuses instead of guessing', () => {
  // Two DISTINCT constant returns (a conditional return): either answer could be
  // the one Node observes, and a wrong pick is a false negative. Refuse.
  const twoTight = Buffer.from([0xb8, 0x08, 0, 0, 0, 0xc3, 0xb8, 0x0a, 0, 0, 0, 0xc3]);
  assert(readConstReturn(twoTight, 0, 'x64') === null, 'ambiguity resolved by guessing');
  // Same ambiguity reached through the retguard fallback, where no immediate is
  // adjacent to a ret. The relaxed tier must not become a guessing tier.
  const twoLoose = Buffer.from([0xb8, 0x08, 0, 0, 0, 0x90, 0xb8, 0x0a, 0, 0, 0, 0x90, 0xc3]);
  assert(readConstReturn(twoLoose, 0, 'x64') === null, 'loose tier guessed between two values');
  // A `b8` with no ret anywhere is not a constant-returning function at all.
  assert(readConstReturn(Buffer.from([0xb8, 0x08, 0, 0, 0, 0x90]), 0, 'x64') === null,
    'accepted a b8 with no ret');
  // An architecture with no decoder must refuse, not fall through to another's.
  assert(readConstReturn(Buffer.from([0xb8, 0x08, 0, 0, 0, 0xc3]), 0, 's390x') === null,
    'unknown architecture was decoded anyway');
  assert(readConstReturn(Buffer.alloc(4), 99, 'x64') === null, 'out-of-range offset accepted');
});

test('only ARM masks bit 0 out of a function address', () => {
  // Masking unconditionally reads one byte early, which is how sharp's
  // `b8 09 00 00 00 c3` first appeared as `ff b8 09 ...`.
  assert(normalizeFuncAddr(0x1111, 'arm') === 0x1110);
  for (const a of ['x64', 'ia32', 'arm64', 'riscv64', 'loong64']) {
    assert(normalizeFuncAddr(0x1111, a) === 0x1111, `${a} address was masked`);
  }
});

// A synthetic ELF64/x86-64 shared object: 5 sections, a .dynsym/.dynstr pair and a
// .text holding one function. Enough for the whole requirement path to run.
const TEXT_VADDR = 0x2000;
const DATA_VADDR = 0x4000;
function synthElf(symbols, text, data = null) {
  const shstr = Buffer.from('\0.shstrtab\0.dynstr\0.dynsym\0.text\0.data\0', 'latin1');
  const NM = { shstrtab: 1, dynstr: 11, dynsym: 19, text: 27, data: 33 };

  let dynstr = Buffer.from('\0', 'latin1');
  const strOff = new Map();
  for (const n of [...symbols.map((s) => s.name), 'libc.so.6']) {
    strOff.set(n, dynstr.length);
    dynstr = Buffer.concat([dynstr, Buffer.from(n + '\0', 'latin1')]);
  }

  const dynsym = Buffer.alloc((symbols.length + 1) * 24);   // index 0 is the null entry
  symbols.forEach((s, i) => {
    const o = (i + 1) * 24;
    dynsym.writeUInt32LE(strOff.get(s.name), o);
    dynsym.writeUInt16LE(s.defined ? 4 : 0, o + 6);         // st_shndx; 4 is .text
    dynsym.writeBigUInt64LE(BigInt(s.defined ? TEXT_VADDR : 0), o + 8);
  });

  const up = (n) => (n + 15) & ~15;
  const oShstr = 0x40;
  const oDynstr = up(oShstr + shstr.length);
  const oDynsym = up(oDynstr + dynstr.length);
  const oText = up(oDynsym + dynsym.length);
  const oData = up(oText + text.length);
  const nsec = data ? 6 : 5;
  const oShdr = up(oData + (data ? data.length : 0));
  const buf = Buffer.alloc(oShdr + nsec * 64);

  buf.write('\x7fELF', 0, 'latin1');
  buf[4] = 2; buf[5] = 1; buf[6] = 1; buf[7] = 3;           // ELF64, LE, v1, Linux
  buf.writeUInt16LE(3, 16);                                 // ET_DYN
  buf.writeUInt16LE(62, 18);                                // EM_X86_64
  buf.writeBigUInt64LE(BigInt(oShdr), 40);
  buf.writeUInt16LE(64, 58); buf.writeUInt16LE(nsec, 60); buf.writeUInt16LE(1, 62);

  shstr.copy(buf, oShstr); dynstr.copy(buf, oDynstr);
  dynsym.copy(buf, oDynsym); text.copy(buf, oText);
  if (data) data.copy(buf, oData);

  const sh = (i, nameOff, type, addr, off, size, entsize = 0) => {
    const o = oShdr + i * 64;
    buf.writeUInt32LE(nameOff, o); buf.writeUInt32LE(type, o + 4);
    buf.writeBigUInt64LE(BigInt(addr), o + 16);
    buf.writeBigUInt64LE(BigInt(off), o + 24);
    buf.writeBigUInt64LE(BigInt(size), o + 32);
    buf.writeBigUInt64LE(BigInt(entsize), o + 56);
  };
  sh(0, 0, 0, 0, 0, 0);
  sh(1, NM.shstrtab, 3, 0, oShstr, shstr.length);
  sh(2, NM.dynstr, 3, 0, oDynstr, dynstr.length);
  sh(3, NM.dynsym, 11, 0, oDynsym, dynsym.length, 24);
  sh(4, NM.text, 1, TEXT_VADDR, oText, Math.max(text.length, 16));
  if (data) sh(5, NM.data, 1, DATA_VADDR, oData, data.length);
  return buf;
}

/**
 * A `struct node_module` as the linker leaves it in an ELF `.data` section, with the
 * modname string placed just past the record so it is inside the mapped range. Both
 * register-hook slots are ZERO because that is what real ELF artifacts hold -- the
 * function pointer lives in a .rela.dyn addend, not in the slot (E008).
 */
function synthNodeModule(version, modname = 'testmod', filename = '../src/binding.cc') {
  const rec = Buffer.alloc(64);
  rec.writeUInt32LE(version, 0);                            // nm_version
  rec.writeUInt32LE(0, 4);                                  // nm_flags
  const strs = Buffer.from(modname + '\0' + filename + '\0', 'latin1');
  rec.writeBigUInt64LE(BigInt(DATA_VADDR + 64 + modname.length + 1), 16);   // nm_filename
  rec.writeBigUInt64LE(BigInt(DATA_VADDR + 64), 40);                        // nm_modname
  return Buffer.concat([rec, strs]);
}

const ELF_RT = { os: 'linux', arch: 'x64', abi: 137, napi: 10, libc: 'glibc' };
const GETVER = 'node_api_module_get_api_version_v1';

test('the ELF requirement axis reads a declared N-API minimum end to end', () => {
  const b = synthElf(
    [{ name: GETVER, defined: true }, { name: 'napi_create_string_utf8', defined: false }],
    Buffer.from([0xb8, 0x0a, 0, 0, 0, 0xc3]),                // mov eax,10; ret
  );
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(a.format === 'elf' && a.class === 'n-api', `class=${a.class} format=${a.format}`);
  const p = a.constraints.find((c) => c.kind === 'platform');
  assert(p.os === 'linux' && p.arch === 'x64' && p.libc === 'glibc', JSON.stringify(p));
  const n = a.constraints.find((c) => c.kind === 'napi-min');
  assert(n && n.napi === 10 && n.source === 'declared', JSON.stringify(n));
  assert(decide(a.constraints, ELF_RT).ok, 'a napi-10 artifact was refused on a napi-10 runtime');
  assert(!decide(a.constraints, { ...ELF_RT, napi: 9 }).ok, 'napi 10 accepted on a napi-9 runtime');
});

test('a non-declaring ELF addon floors at the header default, not at zero', () => {
  // napi-rs artifacts resolve no napi_ symbol dynamically, so the import floor is 0.
  // Treating 0 as "loads anywhere" is a false negative; the floor Node itself
  // assigns (NODE_API_DEFAULT_MODULE_API_VERSION) closes it.
  const b = synthElf([{ name: 'napi_register_module_v1', defined: true }], Buffer.from([0xc3]));
  const a = deriveConstraints(b, new Map(), { name: 'x.node', defaultNapi: 8 });
  const n = a.constraints.find((c) => c.kind === 'napi-min');
  assert(n && n.napi === 8, `expected the header default 8, got ${JSON.stringify(n)}`);
  assert(!decide(a.constraints, { ...ELF_RT, napi: 6 }).ok, 'napi-rs addon accepted below its floor');

  // Without a header map there is no floor to fall back to, so refuse rather than
  // invent one.
  const bare = deriveConstraints(b, null, { name: 'x.node' });
  assert(bare.constraints.some((c) => c.kind === 'unknown'), 'derived a floor with no evidence');
});

test('a raw-V8 ELF addon pins to the exact NODE_MODULE_VERSION in its node_module struct', () => {
  // E008. This axis used to refuse for want of corpus evidence; 44 labelled raw-V8 ELF
  // artifacts now validate the reader, so the fact is derived.
  const b = synthElf([{ name: 'node_module_register', defined: false }], Buffer.from([0xc3]),
                     synthNodeModule(137, 'dd_pprof'));
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(a.class === 'raw-v8', `class=${a.class}`);
  const r = a.constraints.find((c) => c.kind === 'abi-exact');
  assert(r && r.abi === 137, `expected abi-exact 137, got ${JSON.stringify(a.constraints)}`);
  assert(/dd_pprof/.test(a.nmMethod), `method should name the module: ${a.nmMethod}`);

  // Exact, not minimum: an ABI in either direction must refuse. This is the asymmetry
  // that makes raw-V8 different from N-API.
  assert(decide(a.constraints, ELF_RT).ok, 'abi 137 refused on a 137 runtime');
  assert(!decide(a.constraints, { ...ELF_RT, abi: 141 }).ok, 'abi 137 accepted on 141');
  assert(!decide(a.constraints, { ...ELF_RT, abi: 127 }).ok, 'abi 137 accepted on 127');
});

test('a raw-V8 ELF addon with no readable struct refuses rather than guessing', () => {
  // The soundness direction: no .data section at all means no record to find. The
  // reader must produce an explicit unknown, never an empty conjunction.
  const b = synthElf([{ name: 'node_module_register', defined: false }], Buffer.from([0xc3]));
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(a.class === 'raw-v8', `class=${a.class}`);
  assert(!decide(a.constraints, ELF_RT).ok, 'an unrecovered raw-V8 ELF value produced an accept');
  assert(a.constraints.some((c) => c.kind === 'unknown' && /nm_version not recovered/.test(c.source)),
    `refusal does not say why: ${JSON.stringify(a.constraints)}`);
});

test('two node_module records claiming different ABIs refuse instead of picking one', () => {
  // Ambiguity means the predicate is not discriminating on this artifact, so no number
  // it returns is justified. Shared by PE, ELF and Mach-O via node-module-struct.mjs.
  const first = synthNodeModule(137, 'aaa');
  const pad = Buffer.alloc((8 - (first.length % 8)) % 8);   // the scan steps by 4; stay on it
  // A second, differently-versioned record whose modname points back at the first record's
  // string, so it survives the shape test on its own merits.
  const second = Buffer.alloc(64);
  second.writeUInt32LE(141, 0);
  second.writeBigUInt64LE(BigInt(DATA_VADDR + 64), 40);
  const b = synthElf([{ name: 'node_module_register', defined: false }], Buffer.from([0xc3]),
                     Buffer.concat([first, pad, second]));
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(!decide(a.constraints, ELF_RT).ok, 'an ambiguous struct scan produced an accept');
  assert(/ambiguous-node-module-struct:137,141/.test(a.nmMethod ?? ''),
    `expected an ambiguity refusal, got ${a.nmMethod}`);
});

test('an ELF with no dynamic symbols refuses as .node, is inert as .so', () => {
  const b = synthElf([], Buffer.from([0xc3]));
  const asNode = deriveConstraints(b, null, { name: 'x.node' });
  assert(!decide(asNode.constraints, ELF_RT).ok, 'a .node with no .dynsym was accepted');
  const asLib = deriveConstraints(b, null, { name: 'libfoo.so.1' });
  assert(asLib.constraints.some((c) => c.kind === 'no-requirement'),
    'a bundled shared library should carry no-requirement');
});

// ------------------------------------------- mach-o requirement axis (E007)
//
// The corpus validated this path by AGREEMENT, which by construction only exercises
// slices that agree. The refusal branch -- two slices deriving different requirements --
// is the invariant that makes a fat verdict trustworthy, and no real artifact can reach
// it, because a disagreement means a build is malformed. So it is synthesized here.

const MTEXT_VADDR = 0x1000;   // __TEXT,__text
// __DATA,__data deliberately shares ELF's DATA_VADDR so synthNodeModule serves both.

/**
 * One complete Mach-O image, with all offsets SLICE-RELATIVE the way a real fat member
 * has them -- readImage rebases by the slice base, so an image that hard-coded absolute
 * offsets would pass thin and fail fat, hiding exactly the bug this exercises.
 */
function synthMachoImage({ arch = 'x64', symbols = [], text = Buffer.alloc(0),
                           data = null, chained = false } = {}) {
  const cputype = { x64: 0x01000007, arm64: 0x0100000c }[arch];

  let strtab = Buffer.from('\0', 'latin1');
  const strOff = new Map();
  for (const s of symbols) {
    strOff.set(s.name, strtab.length);
    // Mach-O carries the C leading underscore; readSymbols is expected to strip it.
    strtab = Buffer.concat([strtab, Buffer.from('_' + s.name + '\0', 'latin1')]);
  }
  const nlist = Buffer.alloc(symbols.length * 16);
  symbols.forEach((s, i) => {
    const o = i * 16;
    nlist.writeUInt32LE(strOff.get(s.name), o);
    nlist[o + 4] = s.defined ? 0x0f : 0x01;          // N_SECT|N_EXT : N_UNDF|N_EXT
    nlist[o + 5] = s.defined ? 1 : 0;
    nlist.writeBigUInt64LE(BigInt(s.defined ? (s.value ?? MTEXT_VADDR) : 0), o + 8);
  });

  const SEG = 72 + 80;                               // LC_SEGMENT_64 + one section_64
  const ncmds = 3 + (chained ? 1 : 0);
  const sizeofcmds = SEG * 2 + 24 + (chained ? 16 : 0);
  const up = (n) => (n + 15) & ~15;
  const oText = up(32 + sizeofcmds);
  const oData = up(oText + Math.max(text.length, 16));
  const oSym = up(oData + (data ? data.length : 16));
  const oStr = up(oSym + nlist.length);
  const buf = Buffer.alloc(up(oStr + strtab.length));

  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cputype, 4);
  buf.writeUInt32LE(6, 12);                          // MH_DYLIB
  buf.writeUInt32LE(ncmds, 16);
  buf.writeUInt32LE(sizeofcmds, 20);

  let o = 32;
  const seg = (segname, secname, vmaddr, off, size) => {
    buf.writeUInt32LE(0x19, o);                      // LC_SEGMENT_64
    buf.writeUInt32LE(SEG, o + 4);
    buf.write(segname, o + 8, 16, 'latin1');
    buf.writeBigUInt64LE(BigInt(vmaddr), o + 24);
    buf.writeBigUInt64LE(BigInt(0x1000), o + 32);    // vmsize; sets vmLow/vmHigh
    buf.writeUInt32LE(1, o + 64);                    // nsects
    const so = o + 72;
    buf.write(secname, so, 16, 'latin1');
    buf.write(segname, so + 16, 16, 'latin1');
    buf.writeBigUInt64LE(BigInt(vmaddr), so + 32);
    buf.writeBigUInt64LE(BigInt(size), so + 40);
    buf.writeUInt32LE(off, so + 48);
    o += SEG;
  };
  seg('__TEXT', '__text', MTEXT_VADDR, oText, Math.max(text.length, 16));
  seg('__DATA', '__data', DATA_VADDR, oData, data ? data.length : 0);

  buf.writeUInt32LE(0x02, o);                        // LC_SYMTAB
  buf.writeUInt32LE(24, o + 4);
  buf.writeUInt32LE(oSym, o + 8);
  buf.writeUInt32LE(symbols.length, o + 12);
  buf.writeUInt32LE(oStr, o + 16);
  buf.writeUInt32LE(strtab.length, o + 20);
  o += 24;

  if (chained) {
    buf.writeUInt32LE(0x80000034, o);                // LC_DYLD_CHAINED_FIXUPS
    buf.writeUInt32LE(16, o + 4);
  }

  text.copy(buf, oText);
  if (data) data.copy(buf, oData);
  nlist.copy(buf, oSym);
  strtab.copy(buf, oStr);
  return buf;
}

/** A universal binary from complete per-architecture images. */
function synthMachoFat(images) {
  const hdr = 8 + images.length * 20;
  const up = (n) => (n + 0xfff) & ~0xfff;
  const bases = [];
  let at = up(hdr);
  for (const im of images) { bases.push(at); at = up(at + im.length); }
  const buf = Buffer.alloc(at);
  buf.writeUInt32BE(0xcafebabe, 0);                  // FAT_MAGIC, big-endian
  buf.writeUInt32BE(images.length, 4);
  images.forEach((im, i) => {
    const o = 8 + i * 20;
    buf.writeUInt32BE(im.readUInt32LE(4), o);        // cputype, from the image itself
    buf.writeUInt32BE(bases[i], o + 8);
    buf.writeUInt32BE(im.length, o + 12);
    im.copy(buf, bases[i]);
  });
  return buf;
}

const MAC_RT = { os: 'darwin', arch: 'arm64', abi: 137, napi: 10 };

test('the Mach-O requirement axis reads a declared N-API minimum end to end', () => {
  const b = synthMachoImage({
    arch: 'arm64',
    symbols: [{ name: GETVER, defined: true }, { name: 'napi_create_string_utf8', defined: false }],
    text: Buffer.from([0x40, 0x01, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6]),  // mov w0,#10; ret
  });
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(a.format === 'macho' && a.class === 'n-api', `class=${a.class} format=${a.format}`);
  const p = a.constraints.find((c) => c.kind === 'platform');
  assert(p.os === 'darwin' && p.arch === 'arm64', JSON.stringify(p));
  const n = a.constraints.find((c) => c.kind === 'napi-min');
  assert(n && n.napi === 10 && n.source === 'declared', JSON.stringify(n));
  assert(decide(a.constraints, MAC_RT).ok, 'a napi-10 Mach-O was refused on a napi-10 runtime');
  assert(!decide(a.constraints, { ...MAC_RT, napi: 9 }).ok, 'napi 10 accepted on napi 9');
});

test('a raw-V8 Mach-O addon pins to the exact NODE_MODULE_VERSION', () => {
  const b = synthMachoImage({
    arch: 'arm64',
    symbols: [{ name: 'node_module_register', defined: false }],
    data: synthNodeModule(137, 'dd_pprof'),
  });
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(a.class === 'raw-v8', `class=${a.class}`);
  const r = a.constraints.find((c) => c.kind === 'abi-exact');
  assert(r && r.abi === 137, `expected abi-exact 137, got ${JSON.stringify(a.constraints)}`);
  assert(decide(a.constraints, MAC_RT).ok, 'abi 137 refused on a 137 runtime');
  assert(!decide(a.constraints, { ...MAC_RT, abi: 141 }).ok, 'abi 137 accepted on 141');
});

test('a fat Mach-O whose slices agree derives the requirement once', () => {
  const mk = (arch, text) => synthMachoImage({
    arch, symbols: [{ name: GETVER, defined: true }], text,
  });
  const b = synthMachoFat([
    mk('x64', Buffer.from([0xb8, 0x0a, 0, 0, 0, 0xc3])),                  // mov eax,10; ret
    mk('arm64', Buffer.from([0x40, 0x01, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6])),
  ]);
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(a.format === 'macho-fat', `format=${a.format}`);
  assert(a.slices?.length === 2, `expected 2 slices, got ${a.slices?.length}`);
  const n = a.constraints.filter((c) => c.kind === 'napi-min');
  assert(n.length === 1 && n[0].napi === 10,
    `one merged requirement expected, got ${JSON.stringify(n)}`);
  // A fat binary satisfies either architecture, so both must decide loadable.
  assert(decide(a.constraints, MAC_RT).ok, 'agreeing fat binary refused on arm64');
  assert(decide(a.constraints, { ...MAC_RT, arch: 'x64' }).ok, 'agreeing fat binary refused on x64');
});

test('a fat Mach-O whose slices disagree refuses instead of picking a slice', () => {
  // Two slices of one file, built from one source at one time, cannot honestly require
  // different things -- so a disagreement means one of the reads is wrong. Voting or
  // taking the first slice would put an unjustified number into a verdict.
  const b = synthMachoFat([
    synthMachoImage({ arch: 'x64', symbols: [{ name: GETVER, defined: true }],
                      text: Buffer.from([0xb8, 0x09, 0, 0, 0, 0xc3]) }),     // declares 9
    synthMachoImage({ arch: 'arm64', symbols: [{ name: GETVER, defined: true }],
                      text: Buffer.from([0x40, 0x01, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6]) }), // 10
  ]);
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(!decide(a.constraints, MAC_RT).ok, 'disagreeing slices produced an accept');
  const u = a.constraints.find((c) => c.kind === 'unknown');
  assert(u && /slices disagree/.test(u.source), `refusal does not say why: ${JSON.stringify(u)}`);
  // The evidence has to name both readings, or the refusal is unactionable.
  assert(/napi-min:9/.test(u.source) && /napi-min:10/.test(u.source),
    `both slice values should appear: ${u.source}`);
});

test('a raw-V8 Mach-O under chained fixups refuses with its own distinct reason', () => {
  // Under LC_DYLD_CHAINED_FIXUPS a __DATA pointer slot holds a packed encoding, not an
  // address, so the in-image test cannot apply and no candidate is found. Refusing is
  // right, but "needs a decoder nobody has validated" and "is not a raw-V8 addon" are
  // different facts and only one is a coverage gap.
  const b = synthMachoImage({
    arch: 'arm64', chained: true,
    symbols: [{ name: 'node_module_register', defined: false }],
    data: synthNodeModule(137, 'dd_pprof'),
  });
  const a = deriveConstraints(b, null, { name: 'x.node' });
  assert(!decide(a.constraints, MAC_RT).ok, 'a chained-fixups raw-V8 addon was accepted');
  const u = a.constraints.find((c) => c.kind === 'unknown');
  assert(u && /chained-fixups-undecoded/.test(u.source),
    `expected the chained-fixups reason, got ${JSON.stringify(u)}`);
});

test('a Mach-O with no symbol table refuses as .node, is inert as .dylib', () => {
  const b = synthMachoImage({ arch: 'arm64' });
  const asNode = deriveConstraints(b, null, { name: 'x.node' });
  assert(!decide(asNode.constraints, MAC_RT).ok, 'a .node with no LC_SYMTAB was accepted');
  const asLib = deriveConstraints(b, null, { name: 'libfoo.dylib' });
  assert(asLib.constraints.some((c) => c.kind === 'no-requirement'),
    'a bundled dylib should carry no-requirement');
});

// -------------------------------------------------- hypothetical runtimes
// The constraint model is runtime-free, so a stated descriptor is as decidable as a
// probed one. That is what lets a Windows host answer a Linux question -- and it is
// the only way the ELF requirement axis can be exercised end to end here.
test('a stated target parses every axis and defaults none of them', () => {
  const t = parseTarget('linux/x64/glibc:127:9');
  assert(t.os === 'linux' && t.arch === 'x64' && t.libc === 'glibc', JSON.stringify(t));
  assert(t.abi === 127 && t.napi === 9, 'abi/napi not carried as numbers');
  assert(t.hypothetical === true, 'a stated target must be marked as not probed');
  const w = parseTarget('win32/arm64:141:10');
  assert(w.libc === null, 'non-linux target invented a libc');
});

test('an underspecified target is refused, never filled in from this host', () => {
  // Defaulting any axis would answer a question about a different runtime than the
  // one asked about. E003: on Linux the libc flavour is compatibility, not detail.
  for (const bad of ['linux/x64:127:9', 'linux/x64/glibc:127', 'x64:127:9',
                     'linux/x64/glibc', 'win32/x64/glibc:141:10', '', 'linux/x64/glibc:127:9:1']) {
    let threw = false;
    try { parseTarget(bad); } catch { threw = true; }
    assert(threw, `accepted underspecified target '${bad}'`);
  }
});

test('a probed runtime and a stated target cannot both be given', () => {
  let threw = false;
  try { targetRuntime({ target: 'linux/x64/glibc:127:9', runtime: process.execPath }); } catch { threw = true; }
  assert(threw, 'one runtime was silently preferred over the other');
  assert(targetRuntime({}).os === process.platform, 'no target/runtime should mean this host');
});

// ------------------------------------------------- trusting the compat file
// A cached nexus-compat.json is valid only when its canonical bytes and the exact
// native/shared artifact byte set both match the separately written lock. That is
// integrity binding, not a signature: changing both files remains outside its trust
// boundary, which is why `run` still re-derives from artifact bytes.
function trustFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-trust-'));
  const dir = path.join(root, 'node_modules', 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
  const art = synthElf(
    [{ name: GETVER, defined: true }, { name: 'napi_create_string_utf8', defined: false }],
    Buffer.from([0xb8, 0x0a, 0, 0, 0, 0xc3]),                // declares N-API 10
  );
  fs.writeFileSync(path.join(dir, 'x.node'), art);
  const sha = sha256(art);
  const scan = scanTree(root);
  const gid = graphId(scan.packages);
  const compat = {
    compatVersion: 2,
    graphId: gid,
    artifacts: { [sha]: { class: 'n-api', format: 'elf', constraints: [
      { kind: 'platform', os: 'linux', arch: 'x64', libc: 'glibc' },
      { kind: 'napi-min', napi: 10, source: 'declared' },
    ] } },
    sites: [{ package: 'pkg', version: '1.0.0', pkgPath: 'node_modules/pkg',
              file: 'node_modules/pkg/x.node', sha, size: art.length, addon: true }],
  };
  const lock = { lockfileVersion: 2, graphId: gid, artifactId: artifactId(scan.packages),
                 compatId: hashJson(compat) };
  fs.writeFileSync(path.join(root, 'nexus-lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(root, 'nexus-compat.json'), JSON.stringify(compat));
  return { root, store: fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-trust-store-')), art };
}

function forgeCompat(root) {
  const p = path.join(root, 'nexus-compat.json');
  const compat = JSON.parse(fs.readFileSync(p, 'utf8'));
  Object.values(compat.artifacts)[0].constraints.find((c) => c.kind === 'napi-min').napi = 1;
  fs.writeFileSync(p, JSON.stringify(compat));
}

test('a bound compat file is usable without re-deriving', () => {
  const { root, store } = trustFixture();
  const r = evaluate({ _: [root], target: 'linux/x64/glibc:137:10', store });
  assert(r.source === 'nexus-compat.json', `expected the cache to be used, got ${r.source}`);
  assert(r.ok === true, 'the bound cache should preserve the derived answer');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

test('a forged compat payload is rejected before it can produce an OK', () => {
  const { root, store } = trustFixture();
  forgeCompat(root);
  let threw = false;
  try { evaluate({ _: [root], target: 'linux/x64/glibc:137:9', store }); } catch (e) {
    threw = /content does not match/.test(e.message);
  }
  assert(threw, 'a sidecar-only edit was not detected');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

test('a covered artifact byte change is rejected before cached constraints are used', () => {
  const { root, store } = trustFixture();
  const p = path.join(root, 'node_modules', 'pkg', 'x.node');
  fs.writeFileSync(p, synthElf(
    [{ name: GETVER, defined: true }, { name: 'napi_create_string_utf8', defined: false }],
    Buffer.from([0xb8, 0x01, 0, 0, 0, 0xc3]),
  ));
  let threw = false;
  try { evaluate({ _: [root], target: 'linux/x64/glibc:137:10', store }); } catch (e) {
    threw = /covered artifact bytes/.test(e.message);
  }
  assert(threw, 'a changed artifact was accepted using its old cached constraints');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

test('--verify re-derives from bytes and catches a forged sidecar', () => {
  const { root, store } = trustFixture();
  forgeCompat(root);
  const r = evaluate({ _: [root], target: 'linux/x64/glibc:137:9', store, verify: true });
  assert(r.source.startsWith('live scan'), `expected a live scan, got ${r.source}`);
  assert(r.ok === false, 'a forged napi-min survived --verify');
  const why = r.packages.flatMap((p) => p.broken).map((a) => a.verdict.why).join(' ');
  assert(/N-API >= 10/.test(why), `refusal did not cite the real requirement: ${why}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
});

test('--strict implies --verify, but verify does not imply strict', () => {
  // They were one flag. Conflating them meant the only way to distrust the cache was
  // also to change what counts as loadable, which `run` must not do on its own.
  const a = trustFixture();
  assert(evaluate({ _: [a.root], target: 'linux/x64/glibc:137:9', store: a.store, strict: true })
    .source.startsWith('live scan'), '--strict trusted the compat file');
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(a.store, { recursive: true, force: true });

  // On a runtime that satisfies the REAL requirement, verify alone must accept. If
  // verify silently implied strict, this artifact's derived-from-bytes requirement
  // would still pass -- so assert the flags are separately observable instead.
  const b = trustFixture();
  const ok = evaluate({ _: [b.root], target: 'linux/x64/glibc:137:10', store: b.store, verify: true });
  assert(ok.ok === true, 'verify refused an artifact that genuinely loads');
  assert(parseArgs(['check', '--verify']).strict === undefined, '--verify set strict');
  assert(parseArgs(['check', '--strict']).verify === undefined, '--strict set verify at parse time');
  fs.rmSync(b.root, { recursive: true, force: true });
  fs.rmSync(b.store, { recursive: true, force: true });
});

// ----------------------------------------------------------------------- run
for (const t of tests) {
  try {
    t.fn();
    pass++;
    console.log(`  ok   ${t.name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${t.name}\n         ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
