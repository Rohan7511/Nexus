# E001 — Can native-addon compatibility be derived statically from the artifact?

**Date:** 2026-08-27 · **Host:** Windows 11, `win32/x64` · **Status:** concluded, hypothesis supported

Interpretation and carried risks live in [`../architecture/knowledge-model.md`](../architecture/knowledge-model.md).
This document records what was done and what came out.

## Hypothesis

For an installed native addon, the requirements that determine whether it can load on a given Node
runtime can be derived from the artifact's bytes alone, without executing it — precisely enough to
avoid unnecessary rebuilds (few false positives) while never declaring an incompatible artifact
loadable (zero false negatives).

Null hypothesis to beat: keying artifacts on the runtime's ABI, as `MVP-SPEC.md` proposes with
`built/<abiKey>`, is already good enough.

## Ground truth

`process.dlopen({exports:{}}, file)` executed in a **child process**, because an N-API addon whose
declared minimum exceeds the runtime's level segfaults rather than throwing, and would otherwise kill
the harness. Exit 0 ⇒ loads. Non-zero, or Windows status 3221225477 (`0xC0000005`), ⇒ does not.

## Setup

Three Node runtimes already present on the machine — no version manager, no downloads:

| runtime | version | ABI | N-API |
|---|---|---|---|
| node22 | v22.13.1 | 127 | 9 |
| node24 | v24.11.1 | 137 | 10 |
| node25 | v25.1.0 | 141 | 10 |

ABI and N-API drift independently across these three (127→137→141 vs 9→10→10), which is what makes
the matrix able to separate the two axes.

**Fixtures** (`experiments/fixtures/native/`) — built to create known ground truth for cases the real
corpus might not contain:

```
build.bat   napi9.c      napi9.node      # NAPI_VERSION 9  -> should load on all three
build.bat   napi10.c     napi10.node     # NAPI_VERSION 10 -> must fail on node22
buildxx.bat rawabi141.cc rawabi141.node  # raw V8 NODE_MODULE -> only node25
```

Compilation drives MSVC through a `.bat` wrapper that calls `vcvars64.bat` internally; setting
`INCLUDE`/`LIB` from the MSYS shell mangles paths containing spaces. `rawabi141.cc` additionally needs
`/std:c++20 /Zc:__cplusplus` because `v8config.h` rejects the `__cplusplus` value MSVC reports by
default.

**Corpus** — fixtures plus every `.node` file discovered under `~/AppData/Roaming/npm/node_modules`,
`~/.config/kilo/node_modules`, and `~/.vscode/extensions`, deduplicated **by SHA-256 of contents** so
an addon installed in three places does not get three votes. Result: **97 distinct artifacts**, of
which only the 3 fixtures and 6 hand-inspected files informed the analyzer's design. The other 88 are
held out.

97 artifacts × 3 runtimes = **291 measured cells**.

## Candidate methods evaluated

| method | what it reads | result |
|---|---|---|
| M1 classify | node/napi imports + exports | distinguishes raw-V8 from N-API reliably |
| **M2 declared N-API** | immediate in `node_api_module_get_api_version_v1` (`b8 imm32 c3`) | **authoritative** |
| M3 import floor | which `napi_*` symbols are imported, mapped via local headers | lower bound only; 3 FN |
| **M4 raw ABI** | `NODE_MODULE_VERSION` in the validated `node_module` struct | **authoritative** |
| axis 0 container | ELF/Mach-O/PE magic + machine type | mandatory; see below |

## Commands

```bash
node experiments/e001-napi-extraction/run.mjs        # full matrix + model scores
```

Writes `experiments/e001-napi-extraction/results.json` (per-artifact constraints, per-runtime measured
load, model totals, stratified totals).

## Result

Headline, all 291 cells:

| model | correct | false-neg | false-pos |
|---|---|---|---|
| **M-static (three-axis, derived)** | **291/291** | **0** | **0** |
| M-import-floor (weak static N-API) | 288/291 | 3 | 0 |
| M-abi-only (`built/<abiKey>`) | 174/291 | 72 | 45 |
| M-no-platform (ABI/N-API, no axis 0) | 75/291 | 216 | 0 |
| M-optimistic (npm/pnpm/yarn today) | 70/291 | 221 | 0 |

The headline flatters the result: most of the corpus is prebuild directories shipping every platform,
which axis 0 refuses trivially. Restricting to cells where the artifact *is* a loadable object for
this host — so ABI/N-API reasoning is what decides — leaves **75 discriminating cells**:

| model | correct | false-neg | false-pos |
|---|---|---|---|
| **M-static (three-axis, derived)** | **75/75** | **0** | **0** |
| M-import-floor | 72/75 | 3 | 0 |
| M-abi-only (`built/<abiKey>`) | 30/75 | 0 | **45** |
| M-optimistic | 70/75 | **5** | 0 |

Both failure classes reproduced, in fixtures *and* in shipping packages:

```
native/napi10.node            napi>=10   X/OK/OK   node22: CRASH(3221225477)
native/rawabi141.node         abi==141   X/ X/OK   node22,24: ERR_DLOPEN_FAILED
prebuilds/win32-x64.node      napi>=10   X/OK/OK   node22: CRASH   (better-sqlite3)
```

## Two design errors the widened corpus exposed

Both were found by held-out data, not by reasoning, and both are recorded because they are the
substance of the experiment's value.

**1. Axis 0 was applied only to foreign containers → 18 false negatives.** The first corpus (9
artifacts) scored 27/27 because it contained no wrong-architecture PE file. Widening it surfaced six —
`prebuilds/win32-arm64.node`, `dist/crypt32-arm64.node`, `win32_arm64/koffi.node`,
`win32_ia32/koffi.node` and others — all called loadable, all in fact failing. A PE built for arm64 is
exactly as unloadable on x64 as an ELF is. Fix: the platform constraint applies to every artifact
uniformly. This also forced the data model from a tagged union of one requirement to a **conjunction
of constraints**.

**2. PE delay-load imports were not parsed → 6 false positives.** node-gyp links Windows addons with
a delay-load hook for `node.exe`, so their `napi_*` imports live in PE data directory **13**, not
directory 1. Reading only directory 1 made `Release/keytar.node` and `x64/onnxruntime_binding.node` —
ordinary working N-API addons — look like they import nothing from Node, classify `unknown`, and get
conservatively refused. Reading both tables fixed all six.

An earlier fix, recorded for completeness: a naive `[version][flags]` scan for `node_module` read
`rawabi141.node`'s ABI as `1` instead of `141`. Validating the full struct shape (`nm_dso_handle`
NULL, pointer slots NULL-or-in-image, exactly one register hook set, module name present)
disambiguates the real struct from noise.

## Conclusion

The hypothesis is supported, and the null hypothesis is falsified in both directions. `built/<abiKey>`
over-invalidates 45 of 75 host-loadable artifacts (60% spurious rebuilds) *and* accepts 72 cells it
should reject, because an ABI key carries no platform information. Meanwhile the model today's
package managers use misses 5 unsafe loads out of 75, two of them silent segfaults.

Derived per-artifact constraints are simultaneously safe and precise on this corpus. This is a
concrete, measurable technical differentiator, and it is the basis for accepting Model B in the
[Phase 2 red-team](../architecture/compatibility-models-redteam.md).

## Limitations

Stated plainly, because the perfect score invites over-reading.

1. **Single host.** Everything ran on `win32/x64`. Axis 0 is validated only in the *refusing*
   direction; that a `linux/x64` ELF actually loads on Linux was never measured.
2. **libc flavor is not derived — the biggest hole.** `ngrok.linux-x64-gnu.node` and
   `ngrok.linux-x64-musl.node` yield identical constraints (`linux/x64`). On this host both refuse
   anyway, so the gap contributes **zero error to 291/291** while being a genuine false-negative
   source on Linux. The score does not measure it.
3. **Loadability ≠ correctness.** `dlopen` succeeding does not mean the addon behaves.
4. **0% false positives is a property of this parser on this corpus,** not of the design. Every format
   or linker the parser under-understands becomes a spurious rebuild — as error 2 above demonstrated.
5. **Only `.node` files examined.** Bundled `.dll`/`.so`, WASM, and `.bin` executables untested.
6. **M2 generality untested** beyond MSVC-built and prebuilt artifacts. A miss degrades to
   `unknown` → refuse (safe, costly), not to a wrong answer.
7. **Declared N-API is trusted.** An addon declaring a low minimum but calling a newer symbol would
   pass statically and fail at runtime. Not observed here; not excluded.
