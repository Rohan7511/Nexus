// Content-addressed store: append-only, never mutated, never auto-deleted.
//
// Layout
//   <root>/cas/<hh>/<sha256>             artifact bytes, mode 0o444
//   <root>/analysis/<sha256>.<key>.json  derived constraint set for that content,
//                                        under the derivation inputs that produced it
//   <root>/meta/napi-map.json            header-derived symbol map + the default
//                                        module API version, cached for reproducibility
//
// Two invariants have teeth here:
//
//  * CAS entries are written via temp-file + rename and then chmod 0o444. Since
//    materialization uses hardlinks, an installed file SHARES the store's inode --
//    so a package that writes into its own directory would otherwise silently
//    corrupt the store for every other project. Read-only makes that attempt fail
//    loudly instead. Callers needing a writable tree ask for copy mode.
//  * Nothing in this module deletes from cas/ or analysis/. GC is a separate,
//    dry-run-by-default concern and is not implemented here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sha256, canonicalFile } from '../graph/serialize.mjs';

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.cas = path.join(this.root, 'cas');
    this.analysisDir = path.join(this.root, 'analysis');
    this.metaDir = path.join(this.root, 'meta');
    this.tmp = path.join(this.root, 'tmp');
  }

  static default() {
    return new Store(process.env.NEXUS_STORE || path.join(os.homedir(), '.nexus', 'store'));
  }

  init() {
    for (const d of [this.cas, this.analysisDir, this.metaDir, this.tmp]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return this;
  }

  pathFor(sha) {
    return path.join(this.cas, sha.slice(0, 2), sha);
  }

  has(sha) {
    return fs.existsSync(this.pathFor(sha));
  }

  /**
   * Add bytes to the store. Idempotent: identical content is already at the same
   * address, so an existing entry is left exactly as it is.
   * @returns {{sha:string, added:boolean, size:number}}
   */
  putBuffer(buf) {
    const sha = sha256(buf);
    const dest = this.pathFor(sha);
    if (fs.existsSync(dest)) return { sha, added: false, size: buf.length };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const t = path.join(this.tmp, `${sha}.${process.pid}`);
    fs.writeFileSync(t, buf);
    try {
      fs.renameSync(t, dest);
    } catch (e) {
      // Lost a race with a concurrent writer: content-addressed, so the winner
      // wrote identical bytes. Drop ours rather than overwrite theirs.
      try { fs.unlinkSync(t); } catch { /* already gone */ }
      if (!fs.existsSync(dest)) throw e;
      return { sha, added: false, size: buf.length };
    }
    try { fs.chmodSync(dest, 0o444); } catch { /* best effort; not all filesystems */ }
    return { sha, added: true, size: buf.length };
  }

  putFile(file) {
    return this.putBuffer(fs.readFileSync(file));
  }

  read(sha) {
    return fs.readFileSync(this.pathFor(sha));
  }

  /**
   * Project a store entry into a working tree.
   * @param {'hardlink'|'copy'} mode
   * @returns {'hardlink'|'copy'} the method actually used
   */
  materialize(sha, dest, mode = 'hardlink') {
    const src = this.pathFor(sha);
    if (!fs.existsSync(src)) throw new Error(`store miss: ${sha}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) removeReadOnly(dest);
    if (mode === 'hardlink') {
      try {
        fs.linkSync(src, dest);
        return 'hardlink';
      } catch {
        // EXDEV (different volume), EMLINK (link count exhausted), or a
        // filesystem without hardlinks. Copying is always available.
      }
    }
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o644); } catch { /* best effort */ }
    return 'copy';
  }

  // ------------------------------------------------------------ derived data
  //
  // Keyed on (content sha, derivation key) rather than content alone. A derived
  // constraint set depends on the node_api symbol map and the header default as
  // well as the bytes, so a key covering only the bytes would serve a stale answer
  // after the headers change -- the same class of bug as keying a lockfile by the
  // runtime. Entries for a superseded derivation key are left in place, never
  // rewritten and never deleted.
  analysisPath(sha, deriv) {
    return path.join(this.analysisDir, deriv ? `${sha}.${deriv}.json` : `${sha}.json`);
  }

  readAnalysis(sha, deriv) {
    try {
      return JSON.parse(fs.readFileSync(this.analysisPath(sha, deriv), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Append-only: an existing entry for this (sha, deriv) is authoritative. */
  writeAnalysis(sha, deriv, obj) {
    const p = this.analysisPath(sha, deriv);
    if (fs.existsSync(p)) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const t = path.join(this.tmp, `a.${sha}.${process.pid}`);
    fs.writeFileSync(t, canonicalFile(obj));
    try { fs.renameSync(t, p); } catch { try { fs.unlinkSync(t); } catch { /* gone */ } }
    return true;
  }

  readMeta(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.metaDir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  writeMeta(name, obj) {
    fs.mkdirSync(this.metaDir, { recursive: true });
    fs.writeFileSync(path.join(this.metaDir, name), canonicalFile(obj));
  }

  stats() {
    let objects = 0, bytes = 0;
    let shards;
    try { shards = fs.readdirSync(this.cas); } catch { return { objects: 0, bytes: 0 }; }
    for (const s of shards) {
      let ents;
      try { ents = fs.readdirSync(path.join(this.cas, s)); } catch { continue; }
      for (const e of ents) {
        objects++;
        try { bytes += fs.statSync(path.join(this.cas, s, e)).size; } catch { /* raced */ }
      }
    }
    return { objects, bytes };
  }
}

// A hardlink to a 0o444 store entry is itself read-only, and Windows refuses to
// unlink a read-only file. Clear the bit before replacing.
function removeReadOnly(p) {
  try { fs.chmodSync(p, 0o666); } catch { /* may not be needed */ }
  fs.unlinkSync(p);
}
