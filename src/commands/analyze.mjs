// nexus analyze -- derive and explain one artifact's requirement. Debug lens.

import fs from 'node:fs';
import path from 'node:path';
import { deriveConstraints } from '../artifact/constraints.mjs';
import { decide } from '../compat/decide.mjs';
import { targetRuntime, runtimeLabel } from '../runtime/probe.mjs';
import { sha256 } from '../graph/serialize.mjs';
import { openStore, napiMapFor, fmtConstraint, fmtBytes, out } from './common.mjs';

export function cmdAnalyze(opts) {
  if (opts._.length === 0) throw new Error('usage: nexus analyze <file...>');
  const store = openStore(opts);
  const napi = napiMapFor(store);
  const rt = targetRuntime(opts);

  const records = [];
  for (const f of opts._) {
    const abs = path.resolve(f);
    const buf = fs.readFileSync(abs);
    const a = deriveConstraints(buf, napi.map, { name: path.basename(abs), defaultNapi: napi.defaultNapi });
    const v = decide(a.constraints, rt, { strict: !!opts.strict });
    records.push({ file: abs, sha: sha256(buf), size: buf.length, ...a, verdict: v });
  }

  if (opts.json) { out(JSON.stringify(records, null, 2)); return records.every((r) => r.verdict.ok) ? 0 : 1; }

  out(`runtime ${runtimeLabel(rt)}`);
  out('');
  for (const r of records) {
    out(`${path.basename(r.file)}   ${fmtBytes(r.size)}  sha ${r.sha.slice(0, 12)}`);
    out(`  container ${r.format}   class ${r.class}`);
    for (const c of r.constraints) out(`  needs     ${fmtConstraint(c)}`);
    // deriveConstraints spreads its evidence onto the record itself rather than
    // nesting it, so read it from there.
    if (r.declaredMethod) {
      out(`  evidence  declared=${r.declaredNapi ?? 'none'} via ${r.declaredMethod}` +
          (r.importFloor != null ? `, import floor ${r.importFloor}` : '') +
          (r.defaultNapi != null ? `, header default ${r.defaultNapi}` : '') +
          (r.napiSymbolCount != null ? `, ${r.napiSymbolCount} napi symbols` : ''));
    }
    if (r.nmMethod) {
      // Candidate count matters: the struct predicate is a scan, so "one record matched"
      // is part of why the number is believable. Ambiguity is not shown separately --
      // the shared reader refuses on it and says so in the method string.
      out(`  evidence  nm_version=${r.nmVersion ?? 'none'} via ${r.nmMethod}` +
          (r.nmCandidates > 1 ? ` (${r.nmCandidates} matching records)` : ''));
    }
    if (r.container?.detail?.needed?.length) {
      out(`  evidence  DT_NEEDED ${r.container.detail.needed.slice(0, 4).join(' ')}`);
    }
    // A universal binary's answer rests on its slices AGREEING, so show the per-slice
    // reads rather than only the merged result. Otherwise the one check that makes a fat
    // verdict trustworthy is invisible in the evidence dump.
    if (r.slices?.length > 1) {
      for (const s of r.slices) {
        const how = s.declaredMethod ?? s.nmMethod ?? 'n/a';
        const val = s.nmVersion ?? s.declaredNapi ?? null;
        out(`  evidence  slice ${(s.arch ?? '?').padEnd(5)} ${s.cls} ` +
            `${val != null ? val + ' ' : ''}via ${how}`);
      }
      out(`  evidence  ${r.slices.length} slices agree on the requirement`);
    }
    out(`  verdict   ${r.verdict.ok ? 'LOADABLE' : 'REFUSED'} -- ${r.verdict.why}`);
    out('');
  }
  return records.every((r) => r.verdict.ok) ? 0 : 1;
}
