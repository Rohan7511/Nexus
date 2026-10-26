# ADR 0002 — Phase 7 verdict: GO, with a named gate

**Date:** 2026-08-27 · **Host:** Windows 11, `win32/x64` · **Decides:** whether the Nexus POC continues

## The question this POC was built to answer

> Can dependency *correctness* be distinguished from execution *compatibility* — when the Node runtime
> changes but the lockfile does not, are the installed native artifacts still valid?

And the thesis under test: **artifact-level compatibility analysis, not installation-level runtime
hashing.** The primary objective was to derive compatibility requirements from artifacts, model raw-V8
and N-API compatibility separately, compare per-artifact requirements against probed runtime
capabilities, minimize false positives while prioritizing zero false negatives, and validate against a
ground-truth runtime × artifact load matrix.

## Verdict: **GO**

The hypothesis is confirmed on the two container formats that cover Windows and Linux, with measured
ground truth, and the differentiation over runtime-keyed invalidation is demonstrated end to end. One
named gate stands between this and a usable cross-platform tool, and it is a coverage gap rather than a
soundness problem.

### What was falsifiable, and what would have made it STOP

Stated plainly so the verdict is not merely a conclusion in search of evidence. Any one of these would
have ended it:

| would have been STOP | what happened |
|---|---|
| The requirement cannot be read statically at all — needs execution | **Read from bytes.** `node_api_module_get_api_version_v1` compiles to a constant return; recovered on PE and on ELF across six architectures |
| A single runtime scalar is as good as per-artifact constraints | **It is not.** ABI and N-API drift independently (127→137→141 vs 9→10→10), so any scalar key must over- or under-invalidate |
| Non-zero false negatives — the tool says OK and the process dies | **Zero, across every measurement**, including the adversarial phase |
| False-positive rate so high the tool is unusable | **Zero spurious refusals** on an uncurated 128,286-file install after the E006 exclusion rule |
| Too slow to leave switched on | **~5 s** on that 128k tree; **0.3–0.8 s** for a verified gate |

### The measured evidence

**[LE] Ground truth, E001.** A 3 runtimes × 97 artifacts load matrix, executed: **291/291 cells
predicted correctly, FN 0, FP 0**, and **75/75** on the discriminating subset (artifacts where the
runtimes disagree, i.e. where the answer is not free). The declared N-API minimum decides loadability;
the import-floor alternative scores 288/291, so the stronger method is also the correct one.

**[LE] The differentiation claim, E004.** One unchanged install, moving Node 25 → Node 24: the ABI goes
141 → 137, which invalidates an ABI-keyed installation hash **entirely**, while Nexus rebuilds **1
package of 4** — because N-API did not move. That is the whole thesis in one number.

**[LE] Coverage, E003 + E005 + E007 + E008.** Platform axis derived for PE, ELF and Mach-O (OS 48/48,
libc 38/38, all four same-arch gnu/musl pairs separated). Requirement axis derived for **all three**
container formats: N-API and raw-V8 on PE (E001), ELF (E005/E008) and Mach-O (E007), with 0 unknown
left on the measured corpus. Validated with no Linux or macOS host via cross-architecture,
cross-flavour, and filename-label agreement (E005 O1 6/6, O2 6/6; E007 O1 4/4, O2 5/5, O3 24/24;
E008 O1 44/44, O2 13/13, O3 44/44). The loading direction on Linux and macOS is what
`CROSSPLATFORMTEST.md` carries.

**[LE] Adversarial survival, E006.** Five defects found and fixed; **none in the derivation.** Cost,
trust, and three times over *scope*. Every constraint derived from every artifact was correct throughout.

**[LE] Safety posture holds under garbage.** Empty, text, JSON, truncated PE, truncated ELF, truncated
fat binary: all yield an explicit UNKNOWN constraint and refuse. Derivation failure never produces `[]`.

### Why GO rather than PIVOT

The obvious pivot would be toward the resolver — and the governing instruction was explicit that the
resolver experiment must not dominate unless the compatibility hypothesis was first shown sound and
meaningfully differentiated. It has been, so the pivot is unnecessary. Independently,
[E002](../experiments/e002-resolution-hooks.md) found resolution to be a weak foundation, so pivoting
toward it would trade a validated mechanism for an unvalidated one.

The other conceivable pivot is to package-level declaration instead of byte derivation. The knowledge
model closes that off with local evidence: `node.abi115.node` is in fact an N-API addon that loads on ABI
127, 137 and 141, while `prebuilds/win32-x64.node` carries no version information and segfaults on
node22. Metadata is a hint at best. E006 refined this rather than reversing it — metadata may narrow a
verdict's *scope* (which packages are reached at all) and may never widen it by claiming an artifact
loads.

### The gate — closed

**Mach-O's requirement axis was the gate, and it is derived.** Both requirement axes (declared N-API
minimum and exact `NODE_MODULE_VERSION`) now read from Mach-O bytes, for both thin and fat binaries, with
the per-slice agreement invariant enforced at derivation time. E007 validated it with three oracles needing
no macOS host: cross-slice agreement (4/4), cross-flavour agreement with the E001-validated PE values
(5/5), and filename-label agreement on raw-V8 (24/24). The LOADING direction on macOS is the one thing
none of those cover, and is what `CROSSPLATFORMTEST.md` exists to have run on a Mac.

The raw-V8 ELF hole, named below as secondary item 3, is also closed. E008 found 44 raw-V8 ELF artifacts in
a bundled Electron tree (`@datadog/pprof` and `@newrelic`, across glibc and musl, x64 and arm64, nine ABI
levels), every one with the `NODE_MODULE_VERSION` in its filename. The `node_module` struct read that
refused for want of evidence now agrees with all three independent sources — 44/44 against the labels,
13/13 across builds, 44/44 against the E001-validated PE and Mach-O values — so refusing would have left a
derivable fact underived.

What is still carried, and what is not:

1. **A Linux host.** Every *measurement* here is `win32/x64`. E003, E005, E007 and E008 prove constraints
   are *computed* correctly for Linux and macOS artifacts; that the *comparison* against a live Linux or
   macOS runtime is complete is inferred, not observed. `--target` makes the question askable from here,
   which is not the same as answering it. `CROSSPLATFORMTEST.md` carries the manual protocol.
2. **Minimum glibc version** from `GLIBC_2.xx` tags in `.dynstr`. The one known false-negative hole, and
   Linux-only. Still open.
3. **Analyze** artifacts outside `node_modules` rather than only counting them. Still open.
4. **Bind `nexus-compat.json` to the lock and covered artifact bytes.** Complete for independent
   sidecar/artifact edits: `compatId` and `artifactId` in the v2 lock make normal `check` reject either
   edit. This is deliberately not called a signature: a writer who can change lock and sidecar has no
   external trust boundary to authenticate against, and `run` continues to verify from bytes.

### What this verdict does not claim

- Not that Nexus is a package manager. No registry client, no resolution, no fetching — deliberately, and
  none of it is needed to test the thesis.
- Not that the false-positive rate generalises. One host, one 128k-file corpus, one ecosystem.
- Not that the loading direction is validated off Windows.
- Not that parser coverage is complete. Coverage gaps degrade toward refusal, which is safe but is
  exactly the precision erosion the approach exists to avoid — carried as the top risk.

## Status of the phase plan

| phase | outcome |
|---|---|
| 0 discovery | complete — runtimes probed, corpus inventoried |
| 1 knowledge model | complete — [knowledge-model.md](knowledge-model.md), claims tagged [LE]/[RC]/[UA]/[IN] |
| 2 red-team | complete — [compatibility-models-redteam.md](compatibility-models-redteam.md), Models A–D, D chosen, two amendments since |
| 3 architecture comparison | complete — folded into the red-team decision and [ADR 0001](0001-nexus-poc.md) |
| 4 POC definition | complete — [ADR 0001](0001-nexus-poc.md) |
| 5 vertical slice | complete — seven commands, [E004](../experiments/e004-vertical-slice.md) |
| 6 fixtures / experiments | complete — [E001](../experiments/e001-native-artifact-compatibility.md), [E002](../experiments/e002-resolution-hooks.md), [E003](../experiments/e003-libc-derivation.md), [E005](../experiments/e005-elf-requirement.md) |
| 7 adversarial review + verdict | complete — [E006](../experiments/e006-adversarial-review.md), this ADR |

Regression state at the verdict: **57 tests passed, 0 failed**; E001 replay **291/291 all cells, 75/75
discriminating, FN 0, FP 0**; E005 oracles **O1 6 agree / 0 disagree, O2 6 / 0, declared 37/48, still
unknown 0**.
