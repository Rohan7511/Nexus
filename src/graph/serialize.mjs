// Deterministic serialization and hashing.
//
// Every identity in Nexus is a hash over one of these strings, so byte-identical
// output for identical input is not a nicety -- it is what makes graph identity
// reproducible across machines. Hence: keys sorted recursively, `undefined`
// dropped rather than emitted as null, LF endings, one trailing newline.

import crypto from 'node:crypto';

/** Canonical JSON: recursively key-sorted, no incidental whitespace variation. */
export function canonical(value) {
  return JSON.stringify(sortDeep(value));
}

/** Canonical JSON formatted for a file on disk: 2-space indent, LF, final newline. */
export function canonicalFile(value) {
  return JSON.stringify(sortDeep(value), null, 2).replace(/\r\n/g, '\n') + '\n';
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v instanceof Map) return sortDeep(Object.fromEntries(v));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;      // absent, not null
      out[k] = sortDeep(v[k]);
    }
    return out;
  }
  return v;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const hashJson = (value) => sha256(canonical(value));

/**
 * Graph identity: a content hash over the resolved dependency graph alone.
 *
 * Runtime-independent BY CONSTRUCTION -- no runtime field is in scope here. This
 * is identity #1 of the three the architecture keeps separate, and the reason a
 * Node upgrade cannot invalidate a lockfile.
 *
 * Refuses a partial scan. `scanTree({hashes:'artifacts'})` records only the files
 * that can carry a runtime requirement, because `check` needs nothing else. Hashing
 * that subset would yield a stable, plausible-looking identity that is blind to most
 * of the tree, so two genuinely different installs could share it. Note the absence
 * of hashes is not itself detectable -- a package with no artifacts has an empty file
 * list that looks complete -- so the check is on the explicit `partial` marker.
 * Throwing is the only safe response: an identity that quietly means less than it
 * appears to is worse than no identity.
 */
export function graphId(packages) {
  for (const p of packages) {
    if (p.partial) {
      throw new Error(`graphId requires a fully hashed scan; package '${p.path}' came from a ` +
                      `partial scan (scanTree with hashes:'artifacts')`);
    }
    for (const f of p.files ?? []) {
      if (f.sha == null) throw new Error(`graphId: '${p.path}/${f.path}' has no hash`);
    }
  }
  const norm = packages
    .map((p) => ({ name: p.name, version: p.version, path: p.path, files: p.files }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return hashJson({ v: 1, packages: norm });
}
