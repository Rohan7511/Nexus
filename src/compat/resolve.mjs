// Package-level resolution: artifacts within a package are ALTERNATIVES across
// platforms and CONJUNCTS within one.
//
// The vertical slice surfaced this and it is not cosmetic. A prebuild set ships
// every platform on purpose: better-sqlite3 carries 8 objects, of which exactly
// one is meant to load here. Reporting the other 7 as "cannot load" is not a
// conservative answer, it is a wrong one -- it is the over-invalidation this
// project exists to eliminate, dressed up as safety.
//
// The rule, derived from artifact bytes and never from metadata:
//
//   applicable = artifacts whose PLATFORM constraint the runtime satisfies
//   inert      = the rest; they are unused alternatives, not failures
//
//   * a package with artifacts but NO applicable artifact is broken: nothing it
//     ships can run here.
//   * every APPLICABLE artifact must satisfy its full constraint set. Artifacts
//     that target the same platform are distinct components, not variants, so
//     "at least one loads" would be unsound at this level.
//
// This is exactly E001's stratification -- restrict to host-loadable objects, so
// that the ABI/N-API axes are what decides -- promoted from a scoring convenience
// into the product's decision procedure.
//
// One case sits above the artifact level. A package can declare in its OWN
// package.json that it is not for this platform (`os`, `cpu`, `libc`); npm's installer
// gates on exactly those fields. `@img/sharp-linux-x64` declares `os:["linux"]` and
// ships one Linux object -- so on Windows the artifact rule above calls it "ships 1
// artifact, none targeting win32/x64" and refuses. That refusal is a FALSE POSITIVE of
// the worst practical kind: this shape is how the entire prebuild ecosystem ships
// (sharp, esbuild, rollup, swc, ngrok), so a tool that refuses it refuses nearly every
// real install. Measured here: 6 of 6 refusals on an uncurated 128k-file tree were
// this, 4 of them declaring `os:["linux"]` outright and 5 of 6 being optional
// dependencies of a parent that selects among them.
//
// So a package excluded by its own declaration is reported as EXCLUDED: its artifacts
// go to `inert`, it does not fail the tree, and it is listed separately rather than
// folded into the OK. The residual risk is stated rather than hidden -- `os` is an
// install-time gate, not a runtime one, so a program that directly requires such a
// package anyway would fail where Nexus said nothing was wrong. That failure is a
// catchable `ERR_DLOPEN_FAILED` (wrong container format), never the silent segfault
// this project is built to prevent, and it is the trade the objective function asks
// for: minimize false positives, prioritize zero false NEGATIVES of the fatal kind.

import { decide } from './decide.mjs';

const platformOf = (constraints) => constraints?.find((c) => c.kind === 'platform') ?? null;

/**
 * npm's matching rule for `os`/`cpu`/`libc`: a list may hold negations (`"!win32"`).
 * Any negation that matches excludes; otherwise, if the list has positive entries, one
 * must match. An axis the package did not state cannot exclude anything.
 */
function axisExcludes(list, value) {
  if (!list?.length || value == null) return false;
  const neg = list.filter((e) => e.startsWith('!')).map((e) => e.slice(1));
  if (neg.includes(value)) return true;
  const pos = list.filter((e) => !e.startsWith('!'));
  return pos.length > 0 && !pos.includes(value);
}

/** @returns {string|null} the axis that excludes this runtime, or null if none does. */
export function declaredExclusion(declared, rt) {
  if (!declared) return null;
  if (axisExcludes(declared.os, rt.os)) return `os ${JSON.stringify(declared.os)}`;
  if (axisExcludes(declared.cpu, rt.arch)) return `cpu ${JSON.stringify(declared.cpu)}`;
  // libc is only meaningful where the runtime has one; on win32/darwin rt.libc is null
  // and the axis cannot exclude, which axisExcludes already handles.
  if (axisExcludes(declared.libc, rt.libc)) return `libc ${JSON.stringify(declared.libc)}`;
  return null;
}

/**
 * @param {object[]} sites   [{package, version, pkgPath, file, sha, addon, declared}]
 * @param {Record<string,object>} artifacts  sha -> analysis
 * @param {object} rt runtime descriptor
 * @returns {{ok:boolean, packages:object[], counts:object}}
 */
export function resolveTree(sites, artifacts, rt, opts = {}) {
  const groups = new Map();
  for (const s of sites) {
    const key = s.pkgPath ?? s.package;
    if (!groups.has(key)) {
      groups.set(key, { package: s.package, version: s.version, pkgPath: key,
                        declared: s.declared ?? null, artifacts: [] });
    }
    const a = artifacts[s.sha];
    const constraints = a?.constraints ?? null;
    const plat = platformOf(constraints);
    groups.get(key).artifacts.push({
      ...s,
      class: a?.class ?? '?',
      constraints,
      // Applicability is decided by axis 0 ALONE. That is the whole point: it
      // separates "this object is not for this machine" from "this object is for
      // this machine and is broken on it".
      applicable: constraints ? decide(plat ? [plat] : [], rt).ok : false,
      verdict: constraints
        ? decide(constraints, rt, opts)
        : { ok: false, satisfied: [], failures: [{ constraint: null, why: 'no analysis recorded' }],
            why: 'no analysis recorded' },
    });
  }

  const packages = [];
  for (const g of [...groups.values()].sort((a, b) => (a.pkgPath < b.pkgPath ? -1 : 1))) {
    // Checked before applicability is scored: a package npm would never have selected
    // here has no applicable artifact BY CONSTRUCTION, so letting the artifact rule
    // speak first would turn every one of them into a refusal.
    const excludedBy = declaredExclusion(g.declared, rt);
    if (excludedBy) {
      packages.push({
        ...g, applicable: [], inert: g.artifacts, broken: [],
        noneApplicable: false, excludedBy, ok: true,
        reason: `declares itself off-platform (${excludedBy}); not selected on ` +
                `${rt.os}/${rt.arch}${rt.libc ? '/' + rt.libc : ''}`,
      });
      continue;
    }
    const applicable = g.artifacts.filter((a) => a.applicable);
    const inert = g.artifacts.filter((a) => !a.applicable);
    const broken = applicable.filter((a) => !a.verdict.ok);
    const noneApplicable = g.artifacts.length > 0 && applicable.length === 0;
    packages.push({
      ...g, applicable, inert, broken, noneApplicable, excludedBy: null,
      ok: !noneApplicable && broken.length === 0,
      reason: noneApplicable
        ? `ships ${g.artifacts.length} native artifact(s), none targeting ` +
          `${rt.os}/${rt.arch}${rt.libc ? '/' + rt.libc : ''}`
        : broken.length ? `${broken.length} applicable artifact(s) cannot load` : null,
    });
  }

  const counts = {
    packages: packages.length,
    packagesOk: packages.filter((p) => p.ok).length,
    packagesBroken: packages.filter((p) => !p.ok).length,
    // Counted, never hidden: these are OK because of a metadata claim rather than
    // because anything about them was derived from bytes.
    packagesExcluded: packages.filter((p) => p.excludedBy).length,
    artifacts: sites.length,
    applicable: packages.reduce((n, p) => n + p.applicable.length, 0),
    inert: packages.reduce((n, p) => n + p.inert.length, 0),
    broken: packages.reduce((n, p) => n + p.broken.length, 0),
  };
  return { ok: counts.packagesBroken === 0, packages, counts };
}
