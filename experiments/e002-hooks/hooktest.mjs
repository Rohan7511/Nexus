// E002: Which Node entry points does module.registerHooks() actually serve?
// Verified against the live runtime, no recall. Runnable on any runtime so the
// availability of the API itself is part of the measurement.
import Module from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABI = process.versions.modules;
const VIRT = path.join(HERE, `.virtual-target-${ABI}.cjs`);
fs.writeFileSync(VIRT, 'module.exports = "SERVED-FROM-TABLE";\n');

// This specifier is never present in any node_modules directory.
const MAGIC = 'nexus-virtual-pkg';
const hits = [];

console.log('runtime:', process.version, 'ABI' + ABI);

if (typeof Module.registerHooks !== 'function') {
  console.log('module.registerHooks: NOT AVAILABLE on this runtime');
  fs.unlinkSync(VIRT);
  process.exit(0);
}

Module.registerHooks({
  resolve(spec, ctx, next) {
    if (spec === MAGIC) {
      hits.push('resolve-hook');
      return { url: pathToFileURL(VIRT).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const req = createRequire(import.meta.url);
const results = {};
const t = (name, fn) => {
  try { results[name] = { ok: true, value: String(fn()).slice(0, 40) }; }
  catch (e) { results[name] = { ok: false, code: e.code || e.name }; }
};

t('require(MAGIC)', () => req(MAGIC));
t('require.resolve(MAGIC)', () => req.resolve(MAGIC));
t('createRequire().resolve(MAGIC)', () => createRequire(import.meta.url).resolve(MAGIC));
t('import.meta.resolve(MAGIC)', () => import.meta.resolve(MAGIC));
t('Module.findPackageJSON(MAGIC)', () => Module.findPackageJSON(MAGIC, import.meta.url));

let dyn;
try { dyn = { ok: true, value: String((await import(MAGIC)).default).slice(0, 40) }; }
catch (e) { dyn = { ok: false, code: e.code || e.name }; }
results['dynamic import(MAGIC)'] = dyn;

console.log('hook invocations recorded:', hits.length);
for (const [k, v] of Object.entries(results)) {
  console.log((v.ok ? '  SERVED  ' : '  BYPASS  ') + k.padEnd(32) + (v.ok ? v.value : v.code));
}
fs.unlinkSync(VIRT);
