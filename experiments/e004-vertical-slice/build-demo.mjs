// Build the demo tree used by E004, so the end-to-end run is reproducible.
//
// The tree is deliberately a MIX, because a demo containing only broken artifacts
// or only working ones proves nothing. It contains:
//
//   - a pure-JS package                 -> insensitive, no constraints, never rebuilt
//   - a package with a postinstall      -> sensitive with NO native object (red-team
//                                          Attack 1 vs Model D)
//   - napi9 / napi10 / rawabi141        -> the three built fixtures, whose ground
//                                          truth is known from E001
//   - better-sqlite3's real prebuilds/  -> 8 platforms, one of which (win32-x64)
//                                          requires N-API >= 10 and SEGFAULTS on
//                                          node22 while carrying no version
//                                          information in its filename at all
//
//   node experiments/e004-vertical-slice/build-demo.mjs

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '../..');
const DEMO = path.join(HERE, 'demo');
const NM = path.join(DEMO, 'node_modules');
const FIX = path.join(ROOT, 'experiments/fixtures/native');

// Clear any previous build; store entries are read-only, so drop the bit first.
function rmrf(p) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else { try { fs.chmodSync(q, 0o666); } catch { /* ignore */ } }
    }
  };
  try { walk(p); } catch { /* absent */ }
  fs.rmSync(p, { recursive: true, force: true });
}
rmrf(DEMO);

const write = (rel, content) => {
  const p = path.join(NM, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const pkg = (name, extra = {}) =>
  JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...extra }, null, 2) + '\n';

// 1. pure JS: must be classified insensitive and never appear in a rebuild plan
write('plain-js/package.json', pkg('plain-js'));
write('plain-js/index.js', 'module.exports = 42;\n');
write('plain-js/lib/util.js', 'exports.noop = () => {};\n');

// 2. sensitive without shipping a native object
write('gyp-builder/package.json', pkg('gyp-builder', { scripts: { install: 'node-gyp rebuild' } }));
write('gyp-builder/index.js', "module.exports = require('./build/Release/x.node');\n");
write('gyp-builder/binding.gyp', '{ "targets": [ { "target_name": "x", "sources": [ "x.cc" ] } ] }\n');

// 3. the three fixtures with known ground truth
for (const [name, file] of [['addon-napi9', 'napi9.node'],
                            ['addon-napi10', 'napi10.node'],
                            ['addon-rawabi141', 'rawabi141.node']]) {
  const src = path.join(FIX, file);
  if (!fs.existsSync(src)) {
    console.error(`missing fixture ${src}; run experiments/fixtures/native/build.bat`);
    process.exit(2);
  }
  write(`${name}/package.json`, pkg(name));
  write(`${name}/index.js`, `module.exports = require('./build/Release/${file}');\n`);
  const dest = path.join(NM, name, 'build/Release', file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 4. a real multi-platform prebuild set, copied verbatim
const CANDIDATES = [
  path.join(process.env.USERPROFILE || '', 'AppData/Roaming/npm/node_modules/omniroute/node_modules/better-sqlite3'),
  path.join(process.env.USERPROFILE || '', 'AppData/Roaming/npm/node_modules/omniroute/dist/node_modules/better-sqlite3'),
];
const real = CANDIDATES.find((c) => fs.existsSync(path.join(c, 'prebuilds')));
let copied = 0;
if (real) {
  write('better-sqlite3/package.json',
    fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
  // prebuild-install puts the objects directly in prebuilds/ (flat), while other
  // tools use prebuilds/<platform>/<name>.node. Walk both shapes.
  const copyDir = (rel) => {
    for (const d of fs.readdirSync(path.join(real, rel), { withFileTypes: true })) {
      if (d.isDirectory()) { copyDir(path.join(rel, d.name)); continue; }
      if (!d.name.endsWith('.node')) continue;
      const dest = path.join(NM, 'better-sqlite3', rel, d.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(real, rel, d.name), dest);
      copied++;
    }
  };
  copyDir('prebuilds');
} else {
  console.error('note: better-sqlite3 prebuilds not found; demo will omit them');
}

fs.writeFileSync(path.join(DEMO, 'package.json'), pkg('nexus-demo', { private: true }));

const n = fs.readdirSync(NM).length;
console.log(`built ${DEMO}`);
console.log(`  ${n} packages, ${copied} real prebuilt artifact(s) copied from better-sqlite3`);
