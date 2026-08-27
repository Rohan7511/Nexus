// nexus materialize -- reconstruct an installed tree from the store.
//
// Hardlink by default (R1 in ADR 0001): measured locally as needing no elevation,
// unlike symlinks, which imply Developer Mode on Windows. Copy is the fallback and
// is also available explicitly, because hardlinked files inherit the store's
// read-only mode and a package that writes into its own directory needs copies.

import fs from 'node:fs';
import path from 'node:path';
import { LOCK, openStore, readJson, findLock, fmtBytes, out } from './common.mjs';

export function cmdMaterialize(opts) {
  const [src, dest] = opts._;
  if (!src || !dest) throw new Error('usage: nexus materialize <dir-with-nexus-lock.json> <dest>');
  const lockPath = findLock(src, LOCK);
  if (!lockPath) throw new Error(`no ${LOCK} in ${path.resolve(src)}; run \`nexus ingest\` first`);
  const lock = readJson(lockPath);
  const store = openStore(opts);
  const destRoot = path.resolve(dest);

  // Fail before writing anything if the store cannot satisfy the whole tree.
  const missing = [];
  for (const p of lock.packages) {
    for (const f of p.files) if (!store.has(f.sha)) missing.push(`${p.path}/${f.path}`);
  }
  if (missing.length) {
    throw new Error(`store is missing ${missing.length} object(s), e.g. ${missing[0]}`);
  }

  const mode = opts.copy ? 'copy' : 'hardlink';
  const used = { hardlink: 0, copy: 0 };
  let bytes = 0;
  for (const p of lock.packages) {
    for (const f of p.files) {
      const target = path.join(destRoot, p.path.split('/').join(path.sep), f.path.split('/').join(path.sep));
      used[store.materialize(f.sha, target, mode)]++;
      bytes += f.size;
    }
  }

  if (opts.json) { out(JSON.stringify({ dest: destRoot, ...used, bytes })); return 0; }
  out(`materialized ${used.hardlink + used.copy} file(s) into ${destRoot}`);
  out(`  hardlink ${used.hardlink}   copy ${used.copy}   logical size ${fmtBytes(bytes)}`);
  if (used.hardlink) {
    out('  note: hardlinked files share the store inode and are read-only.');
    out('        use --copy for a writable tree.');
  }
  // Carry the compatibility metadata across so `check` works in the new tree.
  const compatSrc = findLock(src, 'nexus-compat.json');
  if (compatSrc) {
    fs.mkdirSync(destRoot, { recursive: true });
    fs.copyFileSync(compatSrc, path.join(destRoot, 'nexus-compat.json'));
    fs.copyFileSync(lockPath, path.join(destRoot, LOCK));
    out(`  copied ${LOCK} and nexus-compat.json`);
  }
  return 0;
}
