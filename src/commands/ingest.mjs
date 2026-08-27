// nexus ingest -- content-address a tree and derive its compatibility metadata.
//
// Writes two files, deliberately separate, because they answer different
// questions and change under different events:
//
//   nexus-lock.json    graph identity + every file's content hash. Runtime-free
//                      by construction, so a Node upgrade cannot invalidate it.
//   nexus-compat.json  per-artifact constraint sets. Runtime-free as well: it
//                      records what artifacts REQUIRE, never what a runtime
//                      provides, so it is evaluated against a runtime rather
//                      than keyed by one.

import fs from 'node:fs';
import path from 'node:path';
import { scanTree } from '../graph/scan.mjs';
import { graphId, canonicalFile } from '../graph/serialize.mjs';
import { analyzeTree } from '../compat/analyze-tree.mjs';
import { LOCK, COMPAT, openStore, napiMapFor, fmtBytes, out } from './common.mjs';

export function cmdIngest(opts) {
  const dir = path.resolve(opts._[0] ?? '.');
  const store = openStore(opts);
  const napi = napiMapFor(store);

  const scan = scanTree(dir);
  const root = scan.root;

  let added = 0, addedBytes = 0, total = 0, totalBytes = 0;
  for (const pkg of scan.packages) {
    for (const f of pkg.files) {
      const r = store.putFile(path.join(root, pkg.path, f.path));
      total++; totalBytes += r.size;
      if (r.added) { added++; addedBytes += r.size; }
    }
  }

  const { artifacts, sites } = analyzeTree(scan, {
    napiMap: napi.map, defaultNapi: napi.defaultNapi, derivKey: napi.key, store,
  });
  const gid = graphId(scan.packages);

  const lock = {
    lockfileVersion: 1,
    graphId: gid,
    packages: scan.packages.map((p) => ({
      name: p.name, version: p.version, path: p.path,
      sensitive: p.sensitive, sensitivity: p.sensitivity,
      files: p.files,
    })),
  };

  const compat = {
    compatVersion: 1,
    graphId: gid,
    // Provenance, not identity: recorded so a later disagreement is diagnosable.
    derivedWith: { napiMapSource: napi.source, napiMapSymbols: napi.count,
                   defaultNapi: napi.defaultNapi, key: napi.key },
    artifacts,
    sites,
  };

  fs.writeFileSync(path.join(dir, LOCK), canonicalFile(lock));
  fs.writeFileSync(path.join(dir, COMPAT), canonicalFile(compat));

  if (opts.json) {
    out(JSON.stringify({ graphId: gid, packages: scan.packages.length, files: total,
                         objectsAdded: added, artifacts: Object.keys(artifacts).length }));
    return 0;
  }

  const sensitive = scan.packages.filter((p) => p.sensitive);
  const nSites = sites.length;
  out(`graph identity  ${gid}`);
  out(`store           ${store.root}`);
  out(`packages        ${scan.packages.length}  (${sensitive.length} runtime-sensitive, ` +
      `${pct(sensitive.length, scan.packages.length)})`);
  out(`files           ${total} (${fmtBytes(totalBytes)}); ${added} new objects (${fmtBytes(addedBytes)})`);
  out(`artifacts       ${nSites} native/shared file(s), ${Object.keys(artifacts).length} distinct by content`);
  out(`napi map        ${napi.count} symbols${napi.source ? ' from ' + napi.source : ' (UNAVAILABLE)'}`);
  out(`default N-API   ${napi.defaultNapi ?? 'UNKNOWN'}  (NODE_API_DEFAULT_MODULE_API_VERSION)`);
  if (!napi.map) {
    out('');
    out('  warning: no node_api headers found, so addons without a declared N-API');
    out('  version cannot get an import floor and will be refused conservatively.');
    out('  set NEXUS_NODE_INCLUDE to a directory containing js_native_api.h.');
  }
  out('');
  out(`wrote ${LOCK} and ${COMPAT}`);
  return 0;
}

const pct = (a, b) => (b === 0 ? '0%' : `${((a / b) * 100).toFixed(1)}%`);
