// nexus rebuild -- what would have to be rebuilt, and nothing else.
//
// DRY RUN, and there is no non-dry-run: this POC does not shell out to a
// toolchain. It prints the plan, which is the part that carries the argument. The
// number that matters is the one it does NOT list -- an ABI-keyed installation
// hash rebuilds every artifact on a runtime change, and E001 measured that as 45
// spurious rebuilds out of 75 discriminating cells. This command is the difference.

import { evaluate } from './check.mjs';
import { runtimeLabel } from '../runtime/probe.mjs';
import { fmtConstraint, out } from './common.mjs';

export function cmdRebuild(opts) {
  const { rt, packages, counts } = evaluate(opts);
  const broken = packages.filter((p) => !p.ok);

  if (opts.json) {
    out(JSON.stringify({
      runtime: rt, dryRun: true, counts,
      rebuild: broken.map((p) => ({
        package: p.package, version: p.version, path: p.pkgPath, reason: p.reason,
        artifacts: p.broken.map((a) => ({ file: a.file, why: a.verdict.why })),
      })),
    }, null, 2));
    return 0;
  }

  out(`runtime ${runtimeLabel(rt)}`);
  out('');
  if (broken.length === 0) {
    out(`nothing to rebuild. all ${counts.packages} package(s) with native artifacts ` +
        'load on this runtime.');
    out('');
    out(`(${counts.applicable} applicable artifact(s) checked; ${counts.inert} target other ` +
        'platforms and were never candidates.)');
    return 0;
  }

  if (opts.execute) {
    process.stderr.write(
      'nexus rebuild: --execute is not implemented. this POC decides WHAT needs\n' +
      'rebuilding; invoking a toolchain is out of scope. the plan below is complete.\n\n');
  }

  out(`DRY RUN -- ${broken.length} package(s) would need a rebuild:`);
  out('');
  for (const p of broken) {
    out(`  ${p.package}${p.version ? '@' + p.version : ''}`);
    out(`      ${p.reason}`);
    for (const a of (p.broken.length ? p.broken : p.artifacts)) {
      out(`      ${a.file.split('/').slice(-2).join('/')}`);
      for (const c of a.constraints ?? []) out(`        needs ${fmtConstraint(c)}`);
      for (const f of a.verdict.failures) out(`        because ${f.why}`);
    }
    out('');
  }

  out(`${counts.packagesOk} of ${counts.packages} package(s) are unaffected and would NOT be rebuilt.`);
  out(`${counts.applicable - counts.broken} of ${counts.applicable} applicable artifact(s) are fine.`);
  out('an ABI-keyed installation hash would rebuild every one of them.');
  out('');
  out('no rebuild was performed. this command never writes.');
  return 0;
}
