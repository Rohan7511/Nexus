// E003: is libc flavour (glibc vs musl) derivable from an ELF .node artifact?
//
// This closes the top carried risk from the Phase 2 red-team: the container
// reader gave linux-x64-gnu and linux-x64-musl artifacts identical constraints.
//
// Oracle: publisher intent as encoded in the shipped path. A package that ships
// BOTH a musl and a non-musl artifact for the same arch is asserting they are not
// interchangeable, so a correct deriver must separate them. This validates
// DERIVATION, not loading -- confirming a musl artifact actually fails on a glibc
// host needs a Linux host and is out of reach here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readElf } from '../../src/artifact/elf.mjs';

const HOME = process.env.USERPROFILE;

function discover(root, depth) {
  const out = [];
  const walk = (d, left) => {
    if (left < 0) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith('.node')) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

// Expectation derived from the shipped path, not from the bytes.
const expectOs = (f) => /freebsd/i.test(f) ? 'freebsd' : /openbsd/i.test(f) ? 'openbsd' : 'linux';
const expectLibc = (f) => /musl/i.test(f) ? 'musl' : 'glibc';

const seen = new Set();
const rows = [];
for (const f of [
  ...discover(path.join(HOME, 'AppData/Roaming/npm/node_modules'), 9),
  ...discover(path.join(HOME, '.config/kilo/node_modules'), 6),
  ...discover(path.join(HOME, '.vscode/extensions'), 6),
]) {
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  if (seen.has(h)) continue;
  const elf = readElf(buf);
  if (!elf) continue;
  seen.add(h);
  rows.push({
    rel: f.split(/[\\/]/).slice(-3).join('/'),
    arch: elf.arch, os: elf.os, osabi: elf.osabi, libc: elf.libc,
    wantOs: expectOs(f), wantLibc: expectLibc(f), needed: elf.needed.slice(0, 3),
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`distinct ELF .node artifacts: ${rows.length}`);
console.log();
console.log(pad('artifact', 50) + pad('arch', 8) + pad('os', 9) + pad('want', 9) +
            pad('libc', 7) + pad('want', 7) + 'DT_NEEDED');
console.log('-'.repeat(120));

const tally = { osOk: 0, osBad: 0, osNull: 0, libcOk: 0, libcBad: 0, libcNull: 0 };
for (const r of rows.sort((a, b) => a.rel.localeCompare(b.rel))) {
  if (r.os === null) tally.osNull++; else if (r.os === r.wantOs) tally.osOk++; else tally.osBad++;
  // libc is only a meaningful question on Linux.
  if (r.wantOs === 'linux') {
    if (r.libc === null) tally.libcNull++;
    else if (r.libc === r.wantLibc) tally.libcOk++;
    else tally.libcBad++;
  }
  const bad = (r.os !== r.wantOs) || (r.wantOs === 'linux' && r.libc !== r.wantLibc);
  console.log((bad ? ' !!' : '   ') + pad(r.rel.slice(0, 47), 48) + pad(r.arch ?? '?', 8) +
    pad(r.os ?? '-', 9) + pad(r.wantOs, 9) + pad(r.libc ?? '-', 7) +
    pad(r.wantOs === 'linux' ? r.wantLibc : '-', 7) + r.needed.join(' '));
}

console.log();
console.log(`OS   agree=${tally.osOk}  disagree=${tally.osBad}  undetermined=${tally.osNull}`);
console.log(`libc agree=${tally.libcOk}  disagree=${tally.libcBad}  undetermined=${tally.libcNull}  (linux artifacts only)`);

// The decisive test: where a package ships both flavours for one arch, the
// deriver must give them different constraints.
const fam = new Map();
for (const r of rows) {
  const key = r.rel.toLowerCase().replace(/(linuxmusl|musl|linux|gnu)[-_.]?/g, '')
    .replace(/[-_]+/g, '') + '|' + r.arch;
  if (!fam.has(key)) fam.set(key, []);
  fam.get(key).push(r);
}
console.log();
console.log('packages shipping both flavours for the same arch:');
let sep = 0, collapsed = 0;
for (const [, g] of fam) {
  if (g.length < 2) continue;
  const vals = new Set(g.map((x) => x.libc));
  const ok = vals.size === g.length && !vals.has(null);
  ok ? sep++ : collapsed++;
  console.log(`  ${ok ? 'SEPARATED' : 'COLLAPSED '}  ` +
    g.map((x) => `${x.rel.split('/').slice(-1)[0]}=${x.libc ?? 'null'}`).join('  '));
}
console.log(`\npairs separated: ${sep}   pairs collapsed: ${collapsed}`);
