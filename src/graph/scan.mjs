// Scan an installed tree into a package graph, and decide which packages are
// runtime-sensitive at all.
//
// The sensitivity predicate is the whole point of Model D: 91-96% of installed
// packages ship no native object, so computing and storing constraints for them
// is pure overhead. But the predicate must be CONSERVATIVE -- a wrong
// "insensitive" verdict is a missed incompatibility, which is the expensive
// direction. So it is a union, and it defaults to sensitive when the package
// cannot be read:
//
//   ships a native object  OR  has an install/preinstall/postinstall script
//                          OR  has a binding.gyp
//
// The install-script and binding.gyp arms come directly from the red-team
// (Attack 1 vs Model D): those packages are runtime-sensitive without shipping a
// pre-built .node, because they compile against whichever runtime is present.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './serialize.mjs';

const NATIVE_EXT = new Set(['.node']);
const SHARED_EXT = new Set(['.dll', '.so', '.dylib']);

/** Directory entries that are package boundaries rather than package content. */
const isNodeModules = (name) => name === 'node_modules';

/**
 * @param {string} root a directory containing node_modules (or a node_modules itself)
 * @param {{hashes?: 'all'|'artifacts'}} [opts]
 *   `all` (default) hashes every file: required for graph identity and for the CAS,
 *   so `ingest` must use it. `artifacts` hashes only files that can carry a runtime
 *   requirement and leaves every other `sha` null, which is all `check` needs -- see
 *   the note on cost below.
 * @returns {{root:string, packages:object[], partial:boolean}}
 */
export function scanTree(root, { hashes = 'all' } = {}) {
  const abs = path.resolve(root);
  const nm = path.basename(abs) === 'node_modules' ? abs : path.join(abs, 'node_modules');
  if (!fs.existsSync(nm)) throw new Error(`no node_modules found at ${nm}`);
  const packages = [];
  collectPackages(nm, abs, packages, hashes === 'all');
  packages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: abs, nodeModules: nm, packages, partial: hashes !== 'all' };
}

function collectPackages(nmDir, base, out, hashAll) {
  let ents;
  try { ents = fs.readdirSync(nmDir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.')) continue;                       // .bin, .package-lock.json etc
    const p = path.join(nmDir, e.name);
    if (e.name.startsWith('@')) {                                // scope dir, one level down
      let scoped;
      try { scoped = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
      for (const s of scoped) {
        if (s.isDirectory() || s.isSymbolicLink()) readPackage(path.join(p, s.name), base, out, hashAll);
      }
      continue;
    }
    readPackage(p, base, out, hashAll);
  }
}

function readPackage(dir, base, out, hashAll) {
  const pkgJson = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJson)) return;
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(pkgJson, 'utf8')); } catch { /* unreadable */ }

  const files = [];
  const nested = [];
  walkFiles(dir, dir, files, hashAll, nested);

  const reasons = [];
  const natives = files.filter((f) => NATIVE_EXT.has(path.extname(f.path).toLowerCase()));
  const shared = files.filter((f) => SHARED_EXT.has(path.extname(f.path).toLowerCase()));
  if (natives.length) reasons.push(`ships ${natives.length} native object(s)`);
  if (shared.length) reasons.push(`ships ${shared.length} bundled shared library/libraries`);
  const scripts = manifest?.scripts ?? {};
  for (const k of ['preinstall', 'install', 'postinstall']) {
    if (scripts[k]) reasons.push(`has ${k} script`);
  }
  if (fs.existsSync(path.join(dir, 'binding.gyp'))) reasons.push('has binding.gyp');
  if (!manifest) reasons.push('package.json unreadable; assuming sensitive');

  out.push({
    name: manifest?.name ?? path.basename(dir),
    version: manifest?.version ?? null,
    path: path.relative(base, dir).split(path.sep).join('/'),
    files,
    native: natives.map((f) => f.path),
    shared: shared.map((f) => f.path),
    // The package's OWN claim about which platforms it is for. This is metadata, not
    // derived from bytes, so it is never allowed to say an artifact LOADS -- it is
    // recorded only so that a package which declares itself off-platform can be
    // reported as excluded rather than broken. See src/compat/resolve.mjs.
    declared: manifestPlatform(manifest),
    sensitive: reasons.length > 0,
    sensitivity: reasons,
    // Carried on every package, not just on the scan root, so that a partial file
    // list cannot be handed to graphId once it has been separated from the scan it
    // came from. In a partial scan `files` holds only artifacts, so the absence of a
    // hash is NOT a detectable signal -- a package with no artifacts has an empty
    // list that looks complete. The flag is the only honest marker.
    partial: !hashAll,
  });

  // Nested node_modules are separate packages, not content of this one -- and they do
  // not only live at `<pkg>/node_modules`. A bundled package keeps its whole tree
  // under `dist/node_modules/`, and walkFiles skips every node_modules it meets as
  // "someone else's territory". Recursing only into the root one left those trees
  // claimed by nobody: invisible to the package scan AND skipped by
  // unexaminedArtifacts, which also stops at any node_modules. Measured on a real
  // install, that hole swallowed 34 of 80 .node files -- silently, with `unexamined`
  // reporting 0. So collect every boundary walkFiles found, at whatever depth.
  for (const nm of nested) collectPackages(nm, base, out, hashAll);
}

/**
 * Hashing every file costs one full read per file, and a real tree is overwhelmingly
 * files that cannot carry a runtime requirement: a 3,667-file install here took 26s
 * to scan in order to analyze 2 artifacts. `check` and `run` only need the artifact
 * hashes, so `hashAll: false` records artifacts alone and drops the rest.
 *
 * Dropping them is safe for the sensitivity predicate, whose other two arms
 * (install scripts, binding.gyp) do not consult the file list at all, and whose
 * native/shared arms consult exactly the files still recorded. It is NOT safe for
 * graph identity, which is why `graphId` throws on a scan whose files are absent or
 * unhashed rather than hashing a subset that would look like a whole-tree identity.
 *
 * `nested` collects the `node_modules` directories met on the way down instead of
 * discarding them: they are package boundaries rather than this package's content, but
 * they still have to be walked by somebody.
 */
function walkFiles(dir, pkgRoot, out, hashAll, nested) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isNodeModules(e.name)) { nested.push(p); continue; }     // separate package boundary
      walkFiles(p, pkgRoot, out, hashAll, nested);
      continue;
    }
    if (!e.isFile()) continue;                                   // skip symlinks, sockets, fifos
    const rel = path.relative(pkgRoot, p).split(path.sep).join('/');
    if (!hashAll && !isNativeObject(rel) && !isSharedLibrary(rel)) continue;
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    out.push({ path: rel, sha: sha256(buf), size: buf.length });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const isNativeObject = (p) => NATIVE_EXT.has(path.extname(p).toLowerCase());
export const isSharedLibrary = (p) => SHARED_EXT.has(path.extname(p).toLowerCase());

/**
 * npm's own install-time platform gate: `os`, `cpu` and `libc` in a package.json.
 * Returns null unless at least one is present, so "declared nothing" and "declared
 * something" stay distinguishable.
 *
 * Entries may be negated (`"!win32"`), which is why this keeps the raw arrays rather
 * than normalising to a single triple -- the matching rule belongs with the decision,
 * not with the scan.
 */
function manifestPlatform(manifest) {
  if (!manifest) return null;
  const pick = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string')
                       : typeof v === 'string' ? [v] : null);
  const os = pick(manifest.os), cpu = pick(manifest.cpu), libc = pick(manifest.libc);
  if (!os && !cpu && !libc) return null;
  return { os, cpu, libc };
}

/**
 * Artifacts the package scan structurally cannot see.
 *
 * `scanTree` walks `node_modules` because its job is to build a package graph, and a
 * package graph is defined by that layout. But plenty of real trees ship native
 * objects outside it -- a bundled VS Code extension keeps them under
 * `dist/compiled/<os>/<arch>/`, and in one measured extension corpus **19 of 21**
 * `.node` files were outside any `node_modules` directory.
 *
 * Left unreported, `check` prints "0 packages with native artifacts -- OK" for a tree
 * containing seventeen addons. That verdict is vacuous rather than true, and a
 * vacuous OK is the false-negative shape this project treats as unacceptable. So the
 * count is surfaced instead of being silently dropped: an unexamined artifact must
 * never look like permission to load.
 *
 * Cheap on purpose -- readdir only, no reads, and it skips the node_modules subtree
 * that the package scan already covered.
 */
export function unexaminedArtifacts(root) {
  const abs = path.resolve(root);
  const found = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isNodeModules(e.name)) continue;                   // the package scan's territory
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (isNativeObject(e.name) || isSharedLibrary(e.name)) {
        found.push(path.relative(abs, p).split(path.sep).join('/'));
      }
    }
  };
  walk(abs);
  found.sort();
  return found;
}
