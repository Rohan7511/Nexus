// Argument parsing and dispatch. Deliberately dependency-free.

import { cmdIngest } from './commands/ingest.mjs';
import { cmdCheck } from './commands/check.mjs';
import { cmdMaterialize } from './commands/materialize.mjs';
import { cmdRun } from './commands/run.mjs';
import { cmdRebuild } from './commands/rebuild.mjs';
import { cmdAnalyze } from './commands/analyze.mjs';
import { cmdStore } from './commands/store.mjs';

const USAGE = `nexus -- runtime-aware, content-addressed JavaScript install analysis

  nexus ingest [dir]              content-address an installed tree, derive
                                  per-artifact compatibility constraints, write
                                  nexus-lock.json + nexus-compat.json
  nexus check [dir]               decide whether the install can load on a runtime
  nexus analyze <file...>         derive and explain constraints for single artifacts
  nexus materialize <dir> <dest>  reconstruct a tree from the store (hardlink)
  nexus run [dir] -- <cmd...>     check, then exec only if compatible
  nexus rebuild [dir]             list artifacts needing a rebuild (DRY RUN)
  nexus store                     store location and size

options
  --runtime <exe>   probe this node executable instead of the current one
  --target <spec>   decide against a HYPOTHETICAL runtime instead of a probed one:
                    <os>/<arch>[/<libc>]:<abi>:<napi>, e.g. linux/x64/glibc:127:9
                    (answers cross-platform questions from this host; every axis
                    is required, nothing is defaulted)
  --store <dir>     store root (default $NEXUS_STORE or ~/.nexus/store)
  --verify          ignore nexus-compat.json and re-derive constraints from the
                    artifact bytes (implied by \`nexus run\`, which is a gate and
                    always verifies from bytes)
  --strict          also refuse artifacts whose requirement axis is asserted
                    from the absence of Node linkage rather than derived
                    (implies --verify)
  --copy            materialize by copying instead of hardlinking
  --json            machine-readable output
  --all             show satisfied artifacts too, not just refusals
`;

export function parseArgs(argv) {
  const opts = { _: [], rest: null };
  const FLAGS = new Set(['strict', 'json', 'all', 'copy', 'execute', 'help', 'quiet', 'verify']);
  const VALUED = new Set(['runtime', 'store', 'target']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (FLAGS.has(k)) { opts[k] = true; continue; }
      if (VALUED.has(k)) { opts[k] = inline ?? argv[++i]; continue; }
      throw new Error(`unknown option --${k}`);
    }
    if (a === '-h') { opts.help = true; continue; }
    opts._.push(a);
  }
  return opts;
}

const COMMANDS = {
  ingest: cmdIngest,
  check: cmdCheck,
  analyze: cmdAnalyze,
  materialize: cmdMaterialize,
  run: cmdRun,
  rebuild: cmdRebuild,
  store: cmdStore,
};

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`nexus: ${e.message}\n`);
    return 2;
  }
  const cmd = opts._.shift();
  if (!cmd || opts.help || cmd === 'help') {
    process.stdout.write(USAGE);
    return cmd && cmd !== 'help' ? 2 : 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(`nexus: unknown command '${cmd}'\n\n${USAGE}`);
    return 2;
  }
  try {
    return (await fn(opts)) ?? 0;
  } catch (e) {
    process.stderr.write(`nexus ${cmd}: ${e.message}\n`);
    if (process.env.NEXUS_DEBUG) process.stderr.write(e.stack + '\n');
    return 1;
  }
}
