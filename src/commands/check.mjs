// nexus check -- can this install load on this runtime?
//
// The whole thesis in one command: no artifact is executed, no rebuild is
// attempted, and the answer is per-artifact rather than per-installation. A
// refusal always names the specific constraint that failed, because an
// unexplained refusal is indistinguishable from the over-invalidation this
// project exists to avoid.
//
// The verdict is reported at PACKAGE level over per-artifact decisions, because
// artifacts for other platforms are unused alternatives rather than failures --
// see src/compat/resolve.mjs.

import path from 'node:path';
import { scanTree, unexaminedArtifacts } from '../graph/scan.mjs';
import { graphId } from '../graph/serialize.mjs';
import { analyzeTree } from '../compat/analyze-tree.mjs';
import { resolveTree } from '../compat/resolve.mjs';
import { targetRuntime, runtimeLabel } from '../runtime/probe.mjs';
import { COMPAT, LOCK, openStore, napiMapFor, readJson, findLock, fmtConstraint, out } from './common.mjs';

export function evaluate(opts) {
  const dir = path.resolve(opts._[0] ?? '.');
  const rt = targetRuntime(opts);

  // Two separate questions, previously conflated under --strict:
  //
  //   verify -- do not trust the cached nexus-compat.json; re-derive from bytes.
  //   strict -- refuse artifacts whose requirement axis is ASSERTED from the absence
  //             of Node linkage rather than derived.
  //
  // They were one flag, which meant the only way to distrust the cache was also to
  // change what counts as loadable. `run` needs the first without the second: it is a
  // safety gate, and a gate that trusts an unauthenticated sidecar file is not a
  // gate. The compat file's graphId is cross-checked against the lock, but that
  // covers the TREE, not the constraint payload -- editing a napi-min down to 1 while
  // leaving graphId intact produced a wrong OK, which is a segfault under `run`.
  // Re-deriving is affordable because the analysis is cached in the store by
  // (sha, derivationKey), so verification is a scan plus cache hits.
  const verify = !!(opts.strict || opts.verify);

  let artifacts, sites, source;
  const compatPath = findLock(dir, COMPAT);
  if (compatPath && !verify) {
    const compat = readJson(compatPath);
    const lockPath = findLock(dir, LOCK);
    if (lockPath && readJson(lockPath).graphId !== compat.graphId) {
      throw new Error(`${LOCK} and ${COMPAT} disagree on graph identity; re-run ingest`);
    }
    ({ artifacts, sites } = compat);
    source = COMPAT;
  } else {
    // Hash only the artifacts unless a graph identity is actually needed. The verdict
    // never depends on the hash of a .js file -- only the artifact hashes, which key
    // the analysis cache. Hashing the whole tree to answer a two-artifact question
    // made this command cost 26s on a 3,667-file install, which is disqualifying for
    // `run`, whose entire job is to be a gate you leave switched on. The staleness
    // comparison below does need a real identity, so that path pays for a full scan.
    const store = openStore(opts);
    const napi = napiMapFor(store);
    const needsIdentity = !!compatPath;
    const scan = scanTree(dir, { hashes: needsIdentity ? 'all' : 'artifacts' });
    ({ artifacts, sites } = analyzeTree(scan, {
      napiMap: napi.map, defaultNapi: napi.defaultNapi, derivKey: napi.key, store,
    }));
    source = compatPath ? 'live scan (verified, compat file not trusted)' : 'live scan';
    if (needsIdentity) {
      const live = graphId(scan.packages);
      const recorded = readJson(compatPath).graphId;
      if (recorded !== live) {
        source = `live scan (WARNING: ${COMPAT} is stale -- records ` +
                 `${String(recorded).slice(0, 12)}, tree is ${live.slice(0, 12)})`;
      }
    }
  }

  const res = resolveTree(sites, artifacts, rt, { strict: !!opts.strict });
  // Reported alongside the verdict, never folded into it. These artifacts were not
  // examined, so claiming they fail would be as dishonest as claiming they pass; the
  // caller has to be told the verdict's scope rather than left to assume it.
  const unexamined = unexaminedArtifacts(dir);
  return { dir, rt, source, unexamined, ...res };
}

export function cmdCheck(opts) {
  const { rt, source, ok, packages, counts, unexamined } = evaluate(opts);
  const excluded = packages.filter((p) => p.excludedBy);

  if (opts.json) {
    out(JSON.stringify({
      runtime: rt, compatible: ok, counts,
      unexamined,
      excluded: excluded.map((p) => ({
        package: p.package, version: p.version, path: p.pkgPath,
        excludedBy: p.excludedBy, artifacts: p.inert.length,
      })),
      broken: packages.filter((p) => !p.ok).map((p) => ({
        package: p.package, version: p.version, path: p.pkgPath, reason: p.reason,
        artifacts: p.broken.map((a) => ({ file: a.file, why: a.verdict.why })),
      })),
    }, null, 2));
    return ok ? 0 : 1;
  }

  out(`runtime   ${runtimeLabel(rt)}`);
  out(`source    ${source}`);
  out(`packages  ${counts.packages} with native artifacts`);
  out(`artifacts ${counts.artifacts} total: ${counts.applicable} apply to this runtime, ` +
      `${counts.inert} target other platforms`);
  if (excluded.length) {
    // Reported, not folded into the OK: these packages pass on the strength of their
    // own metadata claim, which is the one place the verdict does not rest on bytes.
    out(`EXCLUDED  ${excluded.length} package(s) declare themselves off-platform ` +
        `(npm would not select them here); their artifacts are not checked`);
    for (const p of excluded.slice(0, 5)) {
      out(`             ${p.package}${p.version ? '@' + p.version : ''} -- ${p.excludedBy}`);
    }
    if (excluded.length > 5) out(`             ... and ${excluded.length - 5} more`);
  }
  if (unexamined.length) {

    // The package scan is node_modules-shaped. Bundled trees keep addons elsewhere,
    // and staying quiet about them would turn "nothing was checked" into "OK".
    out(`UNEXAMINED ${unexamined.length} native artifact(s) outside node_modules -- ` +
        `NOT covered by the verdict below`);
    for (const f of unexamined.slice(0, 5)) out(`             ${short(f)}`);
    if (unexamined.length > 5) out(`             ... and ${unexamined.length - 5} more`);
    out(`             analyze them directly: nexus analyze <file>`);
  }
  out('');

  const bad = packages.filter((p) => !p.ok);
  if (bad.length) {
    out(`INCOMPATIBLE -- ${bad.length} package(s):`);
    out('');
    for (const p of bad) {
      out(`  x ${p.package}${p.version ? '@' + p.version : ''} -- ${p.reason}`);
      for (const a of (p.broken.length ? p.broken : p.artifacts)) {
        out(`      ${short(a.file)}`);
        out(`        class ${a.class}`);
        for (const c of a.constraints ?? []) out(`        needs ${fmtConstraint(c)}`);
        for (const f of a.verdict.failures) out(`        FAIL  ${f.why}`);
      }
      if (p.inert.length && p.broken.length) {
        out(`      (${p.inert.length} further artifact(s) target other platforms)`);
      }
      out('');
    }
  }

  if (opts.all) {
    const good = packages.filter((p) => p.ok);
    if (good.length) {
      out(`compatible -- ${good.length} package(s):`);
      out('');
      for (const p of good) {
        out(`  v ${p.package}${p.version ? '@' + p.version : ''}`);
        for (const a of p.applicable) {
          out(`      ${short(a.file)}  [${a.class}]`);
          for (const c of a.constraints ?? []) out(`        needs ${fmtConstraint(c)}`);
        }
        if (p.inert.length) {
          out(`      ${p.inert.length} inert artifact(s) for other platforms: ` +
              p.inert.map((a) => platLabel(a)).join(', '));
        }
        out('');
      }
    }
  }

  if (ok) {
    out(`OK -- every package with native artifacts can load on this runtime.` +
        (unexamined.length ? ` (${unexamined.length} artifact(s) outside node_modules were not examined)` : ''));
    if (!opts.all) out('(re-run with --all for the full listing)');
    return 0;
  }
  out(`${counts.packagesOk} of ${counts.packages} package(s) are fine and need no rebuild.`);
  out('run `nexus rebuild` to see what would be rebuilt (dry run).');
  return 1;
}

function platLabel(a) {
  const p = a.constraints?.find((c) => c.kind === 'platform');
  if (!p) return '?';
  return `${p.os ?? '?'}/${p.archs?.join('+') ?? p.arch ?? '?'}${p.libc ? '/' + p.libc : ''}`;
}

const short = (p) => (p.length > 90 ? '...' + p.slice(-87) : p);
