// nexus run -- check first, execute only if every artifact can load.
//
// This is where the asymmetry pays off. Without a check, an N-API addon whose
// declared minimum exceeds the runtime does not throw; it takes the process down
// with 0xC0000005 and no JS-observable error. Refusing to start is strictly
// better than crashing halfway through.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluate } from './check.mjs';
import { runtimeLabel } from '../runtime/probe.mjs';
import { out } from './common.mjs';

export function cmdRun(opts) {
  const cmd = opts.rest;
  if (!cmd || cmd.length === 0) throw new Error('usage: nexus run [dir] -- <command...>');
  // A stated target describes a runtime that is not here, so there is nothing to
  // exec. Silently executing under the HOST runtime instead would mean the gate
  // checked one runtime and the command ran on another.
  if (opts.target) {
    throw new Error('--target describes a hypothetical runtime and cannot be executed; ' +
                    'use `nexus check --target` to ask the question, or --runtime <exe> to run it');
  }

  // verify, not strict. `run` is a safety gate, so it derives from bytes even
  // though v2 sidecars are bound against independent sidecar/artifact edits. It
  // deliberately does NOT imply --strict, which would additionally refuse artifacts
  // whose requirement is asserted rather than derived -- that is a policy choice for
  // the caller, not something a gate should silently impose.
  const { rt, ok, packages, counts, unexamined } = evaluate({ ...opts, verify: true });
  if (!ok) {
    const broken = packages.filter((p) => !p.ok);
    process.stderr.write(
      `nexus run: refusing to execute -- ${broken.length} of ${counts.packages} package(s) ` +
      `cannot load on ${runtimeLabel(rt)}\n`);
    for (const p of broken.slice(0, 5)) {
      process.stderr.write(`  x ${p.package}${p.version ? '@' + p.version : ''}: ${p.reason}\n`);
      for (const a of p.broken.slice(0, 2)) {
        process.stderr.write(`      ${a.file}\n        ${a.verdict.why}\n`);
      }
    }
    if (broken.length > 5) process.stderr.write(`  ... and ${broken.length - 5} more\n`);
    process.stderr.write('run `nexus check` for the full report.\n');
    return 1;
  }

  // A gate that quietly narrows its own scope is worse than no gate: the caller
  // reads "OK, executing" as covering the tree. Warn even under --quiet, because
  // this is a limit on what was checked, not progress chatter.
  if (unexamined.length) {
    process.stderr.write(
      `nexus run: WARNING -- ${unexamined.length} native artifact(s) live outside node_modules ` +
      `and were NOT checked (e.g. ${unexamined[0]})\n`);
  }

  if (!opts.quiet) {
    out(`nexus: ${counts.applicable} applicable artifact(s) across ${counts.packages} package(s) ` +
        `OK on ${runtimeLabel(rt)}; executing`);
  }

  // When a specific runtime was checked, that runtime must also be the one the
  // command sees -- otherwise the check answered a different question.
  const env = { ...process.env };
  if (opts.runtime) {
    env.PATH = path.dirname(path.resolve(opts.runtime)) + path.delimiter + env.PATH;
  }
  // No shell. `shell: true` concatenates argv into a command line and re-splits
  // it, which mangles anything containing spaces or quotes -- Node warns about it
  // (DEP0190) for good reason. Windows still needs a shell to launch .cmd/.bat
  // wrappers like npm, so fall back only when the direct spawn finds nothing.
  let r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env, shell: true });
  }
  if (r.error) throw new Error(`could not execute '${cmd[0]}': ${r.error.message}`);
  return r.status ?? 1;
}
