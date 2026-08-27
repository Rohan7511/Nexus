// Shared plumbing for the commands.

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../store/cas.mjs';
import {
  resolveNapiMap, serializeNapiMap, deserializeNapiMap,
  readDefaultApiVersion, derivationKey,
} from '../artifact/napi-map.mjs';

export const LOCK = 'nexus-lock.json';
export const COMPAT = 'nexus-compat.json';

export function openStore(opts) {
  const s = opts.store ? new Store(opts.store) : Store.default();
  return s.init();
}

/**
 * The header-derived derivation context: the N-API symbol map, the default module
 * API version, and a fingerprint of both. Cached in the store.
 *
 * Order matters for reproducibility: prefer the cached copy so that a `check` run
 * months later cannot silently change its answer because node-gyp headers were
 * added or removed. Fresh derivation is used only to populate an empty cache.
 */
export function napiMapFor(store) {
  const cached = store.readMeta('napi-map.json');
  if (cached?.symbols) {
    const map = deserializeNapiMap(cached.symbols);
    // A v1 cache predates the default-module-API-version input. Recover it from the
    // same include directory the map came from, so an old store gets the stronger
    // answer without its symbol map being re-derived from different headers.
    const defaultNapi = cached.defaultNapi ?? (cached.source ? readDefaultApiVersion(cached.source) : null);
    if (cached.defaultNapi === undefined && defaultNapi != null) {
      store.writeMeta('napi-map.json', { v: 2, source: cached.source, defaultNapi, symbols: cached.symbols });
    }
    return { map, source: cached.source, cached: true, defaultNapi,
             count: Object.keys(cached.symbols).length,
             key: derivationKey(map, defaultNapi) };
  }
  const { map, source, symbols, defaultNapi } = resolveNapiMap();
  if (!map) {
    return { map: null, source: null, cached: false, count: 0, defaultNapi: null,
             key: derivationKey(null, null) };
  }
  store.writeMeta('napi-map.json', { v: 2, source, defaultNapi, symbols: serializeNapiMap(map) });
  return { map, source, cached: false, count: symbols, defaultNapi,
           key: derivationKey(map, defaultNapi) };
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function findLock(dir, name) {
  const p = path.join(path.resolve(dir), name);
  return fs.existsSync(p) ? p : null;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

/** One-line human form of a constraint, for explanations. */
export function fmtConstraint(c) {
  switch (c.kind) {
    case 'platform': {
      const arch = c.archs?.length ? c.archs.join('+') : (c.arch ?? '?');
      return `platform ${c.os ?? '?'}/${arch}${c.libc ? '/' + c.libc : ''}`;
    }
    case 'napi-min': return `N-API >= ${c.napi} (${c.source})`;
    case 'abi-exact': return `NODE_MODULE_VERSION == ${c.abi}`;
    case 'no-requirement': return 'no Node ABI requirement';
    case 'unknown': return `UNKNOWN (${c.source})`;
    default: return c.kind;
  }
}

export const out = (s = '') => process.stdout.write(s + '\n');
