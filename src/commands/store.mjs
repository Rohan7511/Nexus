// nexus store -- where the store is and what is in it. Read-only by design:
// nothing here deletes, and GC is deliberately not implemented in this POC.

import fs from 'node:fs';
import { openStore, fmtBytes, out } from './common.mjs';

export function cmdStore(opts) {
  const store = openStore(opts);
  const { objects, bytes } = store.stats();
  let analyses = 0;
  try { analyses = fs.readdirSync(store.analysisDir).length; } catch { /* empty */ }
  const napi = store.readMeta('napi-map.json');

  if (opts.json) {
    out(JSON.stringify({ root: store.root, objects, bytes, analyses,
                         napiMap: napi ? { source: napi.source, defaultNapi: napi.defaultNapi ?? null,
                                           symbols: Object.keys(napi.symbols).length } : null }));
    return 0;
  }
  out(`root      ${store.root}`);
  out(`objects   ${objects} (${fmtBytes(bytes)})`);
  out(`analyses  ${analyses} cached constraint set(s)`);
  out(`napi map  ${napi ? `${Object.keys(napi.symbols).length} symbols from ${napi.source}` : 'not cached'}`);
  if (napi) out(`          default module API version ${napi.defaultNapi ?? 'unknown'}`);
  out('');
  out('the store is append-only. nexus never deletes from it.');
  return 0;
}
