// symbol -> minimum N-API version, derived from the node_api headers on disk.
//
// This is the fallback for the ~1/3 of N-API addons that do NOT export
// node_api_module_get_api_version_v1 and therefore declare no minimum. It is a
// LOWER BOUND and provably weaker than the declared value: E001 measured it at
// 72/75 vs 75/75, missing 3 addons that use only old symbols while declaring a
// newer minimum. It is used only where nothing authoritative exists.
//
// The map is derived from local headers rather than hardcoded, so it is evidence
// rather than recall -- and it is cached into the store on first use so that a
// later `check` on a machine without node-gyp headers reproduces the same answer
// instead of silently degrading.

import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from '../graph/serialize.mjs';

/**
 * Parse `#if NAPI_VERSION >= N` regions out of the headers and record, for each
 * exported symbol, the lowest N under which it is available.
 */
export function buildNapiMap(includeDir) {
  const map = new Map();
  let files = 0;
  for (const f of ['js_native_api.h', 'node_api.h']) {
    const p = path.join(includeDir, f);
    if (!fs.existsSync(p)) continue;
    files++;
    const stack = [];
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const open = line.match(/^\s*#if(?:def)?\s+.*NAPI_VERSION\s*>=\s*(\d+)/);
      if (open) { stack.push(parseInt(open[1], 10)); continue; }
      // Experimental symbols are gated on a define, not a version: treat as
      // unreachable so they never lower a floor.
      if (/^\s*#ifdef\s+NAPI_EXPERIMENTAL/.test(line)) { stack.push(Infinity); continue; }
      if (/^\s*#if/.test(line)) { stack.push(null); continue; }
      if (/^\s*#endif/.test(line)) { stack.pop(); continue; }
      const m = line.match(/\b(napi_[a-z0-9_]+|node_api_[a-z0-9_]+)\s*\(/);
      if (!m || !/NAPI_EXTERN|^\s*NAPI/.test(line)) continue;
      const active = stack.filter((x) => typeof x === 'number' && isFinite(x));
      const req = active.length ? Math.max(...active) : 1;
      const prev = map.get(m[1]);
      if (prev === undefined || req < prev) map.set(m[1], req);
    }
  }
  return files ? map : null;
}

/**
 * Candidate header directories, newest node-gyp cache version first. Newer
 * headers are preferred because they define a superset of symbols; a symbol's
 * introduction version does not change once shipped.
 */
export function napiIncludeDirs() {
  const dirs = [];
  if (process.env.NEXUS_NODE_INCLUDE) dirs.push(process.env.NEXUS_NODE_INCLUDE);

  const caches = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'node-gyp/Cache'),
    process.env.HOME && path.join(process.env.HOME, '.cache/node-gyp'),
    process.env.HOME && path.join(process.env.HOME, '.node-gyp'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.node-gyp'),
  ].filter(Boolean);

  for (const c of caches) {
    let ents;
    try { ents = fs.readdirSync(c, { withFileTypes: true }); } catch { continue; }
    const vers = ents.filter((e) => e.isDirectory() && /^\d+\./.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => cmpVer(b, a));
    for (const v of vers) dirs.push(path.join(c, v, 'include/node'));
  }

  // A source/installed tree keeps headers next to the binary.
  dirs.push(path.join(path.dirname(process.execPath), 'include/node'));
  dirs.push(path.join(path.dirname(process.execPath), '../include/node'));
  return dirs;
}

function cmpVer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/**
 * What Node assumes when a module declares no API version. Read from the headers
 * rather than remembered, because a wrong value here becomes a wrong floor for
 * every non-declaring addon. node_version.h:
 *   #define NODE_API_DEFAULT_MODULE_API_VERSION 8
 */
export function readDefaultApiVersion(includeDir) {
  try {
    const src = fs.readFileSync(path.join(includeDir, 'node_version.h'), 'utf8');
    const m = src.match(/#define\s+NODE_API_DEFAULT_MODULE_API_VERSION\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** First usable header dir, or null. Returns the map plus its provenance. */
export function resolveNapiMap() {
  for (const d of napiIncludeDirs()) {
    const map = buildNapiMap(d);
    if (map && map.size > 0) {
      return { map, source: d, symbols: map.size, defaultNapi: readDefaultApiVersion(d) };
    }
  }
  return { map: null, source: null, symbols: 0, defaultNapi: null };
}

export const serializeNapiMap = (map) =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

export const deserializeNapiMap = (obj) => new Map(Object.entries(obj));

/**
 * Fingerprint of everything OTHER than the artifact bytes that a derivation
 * depends on.
 *
 * The store caches derived constraint sets, and the original cache key was the
 * content sha alone -- which is exactly the mistake this project exists to
 * diagnose: a key that omits an input. Analysis is a pure function of (bytes,
 * symbol map, header default), so the cache is keyed on all three. Different
 * headers therefore produce a different cache entry rather than silently reusing
 * an answer derived from inputs that no longer hold.
 */
export function derivationKey(map, defaultNapi) {
  return sha256(canonical({
    v: 1,
    defaultNapi: defaultNapi ?? null,
    symbols: map ? serializeNapiMap(map) : null,
  })).slice(0, 12);
}
