# E006 — Adversarial review: attacking the shipped system

**Date:** 2026-08-27 · **Host:** Windows 11, `win32/x64` · **Status:** concluded, five defects found and fixed

## Why this experiment exists

Phases 5 and 6 built the vertical slice and validated the derivation ([E001](./e001-native-artifact-compatibility.md),
[E003](./e003-libc-derivation.md), [E004](./e004-vertical-slice.md), [E005](./e005-elf-requirement.md)).
Every one of those experiments tested the *derivation* — given an artifact, is the constraint right?
None of them tested the *product*: given a real tree and a real user, does the tool answer correctly,
fast enough to leave switched on, and does it lie when someone wants it to?

This is Phase 7. The posture is deliberately hostile: assume the system is wrong and go find where.
A checker that is sound on curated fixtures and unusable or dishonest on real installs has not
validated the hypothesis — it has validated a parser.

## Method

Five attacks, each against the shipped `src/`, not against a reimplementation:

1. **Cost** — run `check` on the largest tree available and see whether it is usable at all.
2. **Trust** — forge the cached sidecar file and see whether the gate can be talked into executing.
3. **Scope** — point it at a tree whose artifacts are not where it looks.
4. **Coverage** — compare what the scan claims to see against what is on disk, file by file.
5. **False positives** — run it on an uncurated working install and count refusals that are wrong.

Plus regression attacks kept from earlier phases: garbage input, Mach-O, exit-code plumbing, and the
gate's actual behaviour under a runtime that should refuse.

## Attack 1 — cost: the tool was unusable on a real tree

`check` on the global npm tree did not finish inside a 120-second timeout. On a smaller tree the cost
was measurable and absurd:

| tree | files | artifacts to answer about | before | after |
|---|---|---|---|---|
| one extension | 3,667 | 2 | **26.352 s** | **0.489 s** |
| global npm | 128,286 | 95 | did not finish in 120 s | **~5.0 s** (5.23 / 5.09 / 4.95 s) |

**Root cause.** `walkFiles` read and SHA-256'd *every file in the tree*. The verdict never depends on
the hash of a `.js` file — only artifact hashes matter, and those only because they key the analysis
cache. The tool was paying for a whole-tree content address to answer a two-artifact question.

**Fix.** `scanTree(root, {hashes: 'all'|'artifacts'})`. Partial mode records only files that can carry a
runtime requirement. `check` and `run` use it; `ingest` still hashes everything, because a content
address is its entire purpose.

**The fix introduced a soundness trap, which is the interesting part.** The existing guard in `graphId`
was "throw if any file has no hash". Under partial mode that guard silently stops working: a package
with no artifacts has `files: []`, which is *indistinguishable from a complete scan of a package with no
files*. A partial scan could therefore produce a graph identity that looked like a whole-tree identity —
the exact class of bug Nexus exists to diagnose, committed by Nexus. Closed with a structural
`partial: true` marker on **every package** (not just the scan root, so it cannot be lost when a package
is detached from its scan), which `graphId` refuses outright. Verified: recorded graph identities are
byte-identical after the change (demo lock `12170439095b5676…`, MATCH).

This attack is a prerequisite for the next one. Re-deriving from bytes is only an acceptable default for
a gate if re-deriving is cheap.

## Attack 2 — trust: a forged sidecar file produced a wrong OK

`nexus-compat.json` caches the derived constraints. Its `graphId` is cross-checked against the lock — but
that covers the **tree**, not the **constraint payload**. Editing every `napi-min` down to 1 and every
`abi-exact` to 127, leaving `graphId` untouched, yields a file that passes every structural check and a
tree that reports **OK**. Under `nexus run` that means: gate says fine, process segfaults.

**Root cause.** Cache-distrust and strictness were the same flag. The only way to make the tool
re-derive was `--strict`, which *also* changes what counts as loadable (it refuses requirements asserted
from the absence of Node linkage). A gate cannot be forced to adopt a stricter policy just to stop
trusting an unauthenticated file.

**Fix.** Two independent flags:

| flag | question |
|---|---|
| `--verify` | do not trust `nexus-compat.json`; re-derive from the artifact bytes |
| `--strict` | additionally refuse artifacts whose requirement axis is *asserted*, not derived (implies `--verify`) |

`nexus run` implies `--verify` and deliberately **not** `--strict` — distrusting a cache is a gate's job,
choosing a stricter policy is the caller's.

Verified at the time: `run` on the forged tree refuses (exit 1); `check --verify` refuses and names the
real constraint (`N-API >= 10`). Phase 8 narrows the trust boundary further: a v2 lock binds the compat
payload and covered artifact bytes, so normal `check` rejects independent sidecar or artifact edits.
This remains content binding rather than authentication against a writer who can edit both files. Cost
of the verified gate: 0.327–0.817 s.

## Attack 3 — scope: "0 packages with native artifacts — OK" for a tree holding 17 addons

`check` on a VS Code extension reported no native artifacts and a clean OK. The extension ships
seventeen. The package scan is `node_modules`-shaped by construction, and in this corpus **19 of 21**
`.node` files were outside any `node_modules` directory (bundled extensions keep them under
`dist/compiled/<os>/<arch>/`).

No wrong *verdict* was demonstrated — none of the 17 was ABI-pinned — but the OK was **vacuous**, and a
vacuous OK is indistinguishable to the caller from a checked one.

**Fix.** `unexaminedArtifacts(root)` — a readdir-only walk that counts artifacts outside `node_modules`
and reports them *alongside* the verdict, never folded into it. Claiming they fail would be as dishonest
as claiming they pass; neither was examined. `check` prints the count and the first five in text and
JSON; `run` writes a stderr warning that fires **even under `--quiet`**, because it is a limit on what was
checked rather than progress chatter.

## Attack 4 — coverage: 34 of 80 artifacts were invisible to *both* code paths

Attack 3's fix invited the obvious next question: does the pair of walks actually cover the tree? Diffing
the scan's artifact set against `find -name '*.node'` on the global tree:

```
scan sees .node: 46      on disk: 80      missed: 34   (42.5%)
```

Every missed file sat under `node_modules/omniroute/dist/node_modules/…` — `better-sqlite3` prebuilds,
all 15 `koffi` architectures, `keytar`, `onnxruntime-node`, the `wreq-js` set.

**Root cause, and it is a nasty one.** Two functions each believed the other owned that subtree:

* `walkFiles` skipped every directory named `node_modules` as "a separate package boundary".
* `readPackage` recursed into nested trees at exactly `<pkg>/node_modules` — not `<pkg>/dist/node_modules`.
* `unexaminedArtifacts` also skipped every `node_modules` at any depth, as "the package scan's territory".

So a bundled tree one level below the package root belonged to **nobody**: invisible to the package scan
*and* excluded from the unexamined report. `unexamined: 0` actively asserted full coverage while 42% of
the artifacts were unseen. This is strictly worse than attack 3 — there, the gap was reported.

**Fix.** `walkFiles` now collects the `node_modules` directories it meets instead of discarding them, and
`readPackage` collects packages from every one, at whatever depth. Verified: **80 of 80**, with zero
reported-but-absent. The two walks are now genuinely complementary, which is what makes
`unexaminedArtifacts`' skip-at-any-depth correct rather than merely convenient.

Graph identities are unchanged for trees without nested bundles (demo lock re-verified). For trees *with*
them, the identity legitimately changes — the previous one omitted whole subtrees.

## Attack 5 — false positives: the fix made the tool refuse a working install

Closing attack 4 exposed 10 more packages, and the verdict on a working, uncurated install flipped from
OK to **INCOMPATIBLE — 6 packages**. Every refusal read `ships 1 native artifact(s), none targeting
win32/x64`. So: are they real?

Local evidence from each package's own `package.json`:

| package | `os` | `cpu` | `libc` | optional dep of |
|---|---|---|---|---|
| `@img/sharp-linux-x64@0.35.3` | `["linux"]` | `["x64"]` | `["glibc"]` | `sharp` |
| `@ngrok/ngrok-linux-x64-gnu@1.7.0` | `["linux"]` | `["x64"]` | `["glibc"]` | `@ngrok/ngrok` |
| `@ngrok/ngrok-linux-x64-musl@1.7.0` | `["linux"]` | `["x64"]` | `["musl"]` | `@ngrok/ngrok` |
| `sqlite-vec-linux-x64@0.1.9` | `["linux"]` | `["x64"]` | — | `sqlite-vec` |
| `keytar@7.9.0` | — | — | — | `omniroute` |
| `onnxruntime-node@1.21.0` | `["win32","darwin","linux"]` | — | — | — |

Four of six **declare `os: ["linux"]` in their own manifest**. That is npm's install-time platform gate:
npm would never have selected them on this host. Five of six are `optionalDependencies` of a parent that
picks among them. These are **false positives**, and not incidental ones — this is how the entire prebuild
ecosystem ships (`sharp`, `esbuild`, `rollup`, `swc`, `ngrok`), so a tool that refuses this shape refuses
nearly every real install. The primary objective says *minimize false positives while prioritizing zero
false negatives*; this violates the first clause about as badly as possible.

**Fix.** E004's insight lifted one level. Artifacts within a package are alternatives across platforms;
**packages within a tree are too**. A package whose own `os`/`cpu`/`libc` excludes the target is reported
as `EXCLUDED` — artifacts moved to `inert`, package does not fail the tree, listed in its own block in
text and JSON with the axis that excluded it. npm's negation syntax (`"!win32"`) is honoured, and an axis
the package did not state cannot exclude anything. Critically, `libc` cannot exclude on a runtime with no
libc (`rt.libc === null` on win32/darwin), or every glibc-tagged package would vanish from a Windows
verdict.

Result: **6 refusals → 4 excluded, 2 retained**. The 2 retained are true positives — a Linux-built
bundle physically present inside a Windows install, where `keytar` ships one glibc object and declares no
`os`, and `onnxruntime-node` claims `win32` support but ships no `win32` binary in that pruned copy.
Both would genuinely fail to load if required here.

**Residual risk, stated rather than hidden.** `os` is an install-time gate, not a runtime one. A program
that directly requires an excluded package anyway *will* fail where Nexus reported nothing wrong. Two
reasons this is the right trade: the failure is a wrong-container `ERR_DLOPEN_FAILED` — catchable, never
the silent segfault this project exists to prevent — and the alternative refuses every working install.
The exclusion is also reported, not absorbed into the OK, so the caller can see the verdict rested on a
metadata claim at that one point.

**Deliberately not fixed:** `keytar` is an `optionalDependency`, so its consumer very likely guards the
`require` — but "declared optional" means npm tolerates *install* failure, not that the parent try/catches
the load. Inferring a guard from the dependency kind is speculation, not evidence, so the refusal stands.

## Regression attacks (all still hold after the five fixes)

* **Garbage input** — empty, plain text, JSON, truncated PE, truncated ELF, truncated fat binary: all six
  yield `class unrecognised-container` with an explicit UNKNOWN constraint and exit 1. No crash, no
  silent pass, no `[]`.
* **Mach-O** — platform axis derives (`darwin/arm64`), requirement axis returns
  `UNKNOWN (requirement axis not derived for macho containers)` and REFUSES. Still the only underived
  format.
* **Exit codes**, measured without pipes (an earlier apparent `exit=0` on a refusal was `head`'s status,
  not Nexus's): `check` OK = 0, `check` incompatible = 1, `run` refusing = 1, `run` executing = the
  command's own status (verified 7).
* **The gate gates** — on node22 (abi 127, napi 9) the demo tree refuses 3 of 4 packages and does not
  execute; on host v25 it executes.

## What this changed in the product

| area | change |
|---|---|
| `src/graph/scan.mjs` | `hashes: 'all'\|'artifacts'` mode; per-package `partial` marker; nested `node_modules` collected at any depth; `declared` platform recorded; `unexaminedArtifacts()` |
| `src/graph/serialize.mjs` | `graphId` refuses a partial scan structurally, not by sniffing for absent hashes |
| `src/compat/resolve.mjs` | `declaredExclusion()`; excluded packages reported as a third category with `counts.packagesExcluded` |
| `src/compat/analyze-tree.mjs` | sites carry `declared`, so a compat file round-trips it (absent ⇒ conservative) |
| `src/commands/check.mjs` | `verify` split from `strict`; `EXCLUDED` and `UNEXAMINED` blocks in text and JSON |
| `src/commands/run.mjs` | implies `verify` and not `strict`; warns about unexamined artifacts even under `--quiet` |
| `src/cli.mjs` | `--verify` |
| `test/run.mjs` | 51 → **57** tests |

Suite after all five fixes: **57 passed, 0 failed**; E001 **291/291 all cells, 75/75 discriminating,
FN 0, FP 0**; E005 **O1 6/0, O2 6/0, declared 37/48, still unknown 0**.

## Conclusion

Five defects, all real, all fixed, none fatal to the hypothesis. Their shape is worth naming: **none was
in the derivation.** Every constraint derived from every artifact was correct throughout — the failures
were in cost, in trust, and three times over in *scope*: which artifacts the tool looked at, and whether
it told the truth about the ones it didn't.

That is a meaningful result for the thesis rather than an embarrassment. It says the hard part
(per-artifact compatibility from bytes, without executing anything) held up under attack, and the fragile
part is the mundane plumbing around it — which is testable, and now tested. It also says the
zero-false-negative posture has to extend past the parser: an artifact the tool never examined is a
false negative just as surely as one it misjudged, and two of the five defects were exactly that.

## Limitations

1. **Attack 5's fix rests on metadata.** The one place a verdict does not rest on derived bytes. Bounded:
   it can only ever turn a refusal into an exclusion, it is reported separately, and the failure it could
   mask is catchable rather than fatal.
2. **Phase 8 update — bound sidecars.** A v2 lock now contains a canonical compat digest and a covered
   artifact-set digest. Plain `check` rejects a changed sidecar or covered artifact; old unbound files
   are live-scanned. This is content binding, not a signature: someone able to rewrite both files has
   no external trust boundary, so `run` continues to verify from bytes.
3. **Artifacts outside `node_modules` are counted, not analyzed.** The caller is told the verdict's scope
   and pointed at `nexus analyze`, which is honest but not complete.
4. **One host.** Every measurement is `win32/x64`. The Linux and macOS *loading* direction remains
   unvalidated, as in E003 and E005.
5. **The false-positive count is from one tree.** 128,286 files and 23 artifact-bearing packages is a
   real corpus but not a representative sample; the FP rate on other ecosystems is unmeasured.
6. **`find`-based coverage checking only catches what `find` names.** Attack 4 compared `.node` files. An
   artifact with an unexpected extension would be missed by both the tool and the audit.
