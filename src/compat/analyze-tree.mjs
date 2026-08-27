// Turn a scanned tree into per-artifact constraint sets.
//
// This is Model D in one function: only the artifacts that can carry a runtime
// requirement are analyzed, everything else is skipped entirely. Analysis is a
// pure function of content, so results are keyed by sha256 and cached in the
// store -- the same artifact installed in twelve places is analyzed once.

import fs from 'node:fs';
import path from 'node:path';
import { deriveConstraints } from '../artifact/constraints.mjs';
import { isNativeObject, isSharedLibrary } from '../graph/scan.mjs';

/**
 * @param {{root:string, packages:object[]}} scan
 * @param {{napiMap:Map|null, defaultNapi:number|null, derivKey:string|null,
 *          store:object|null}} ctx
 * @returns {{artifacts:Record<string,object>, sites:object[], skipped:number}}
 */
export function analyzeTree(scan, { napiMap = null, defaultNapi = null, derivKey = null, store = null } = {}) {
  const artifacts = {};
  const sites = [];
  let skipped = 0;

  for (const pkg of scan.packages) {
    for (const f of pkg.files) {
      const addon = isNativeObject(f.path);
      if (!addon && !isSharedLibrary(f.path)) { skipped++; continue; }

      if (!artifacts[f.sha]) {
        // The cache lookup carries the derivation key, so an answer produced from a
        // different symbol map or header default is a cache MISS rather than a
        // silently reused stale result.
        const cached = store?.readAnalysis(f.sha, derivKey);
        if (cached) {
          artifacts[f.sha] = cached;
        } else {
          const abs = path.join(scan.root, pkg.path, f.path);
          artifacts[f.sha] = analyzeOne(abs, f.path, napiMap, defaultNapi);
          store?.writeAnalysis(f.sha, derivKey, artifacts[f.sha]);
        }
      }
      sites.push({
        package: pkg.name, version: pkg.version, pkgPath: pkg.path,
        file: `${pkg.path}/${f.path}`, sha: f.sha, size: f.size, addon,
        // Recorded per site so that a compat file round-trips it. Absent in files
        // written before this field existed, which reads as "declared nothing" -- the
        // conservative direction, since that is what produces a refusal.
        declared: pkg.declared ?? null,
      });
    }
  }

  sites.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { artifacts, sites, skipped };
}

function analyzeOne(abs, name, napiMap, defaultNapi) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    // Unreadable is not "compatible": emit the explicit unknown constraint.
    return {
      class: 'READ-FAIL', format: 'unknown',
      constraints: [{ kind: 'unknown', source: 'could not read artifact: ' + e.code }],
    };
  }
  try {
    return deriveConstraints(buf, napiMap, { name, defaultNapi });
  } catch (e) {
    return {
      class: 'DERIVE-FAIL', format: 'unknown',
      constraints: [{ kind: 'unknown', source: 'derivation threw: ' + e.message }],
    };
  }
}
