# Nexus Knowledge Model (Phase 1)

Status: **Gate 3**. Written after E001 and E002 produced measurements.
Host for all measurements: `win32/x64`, Windows 11.

Every claim below is tagged:

- **[LE]** LOCAL EVIDENCE — measured on this machine, reproducible by a command in `experiments/`.
- **[RC]** RESEARCH CONTEXT — asserted by `MVP-SPEC.md` / `RESEARCH.md`; treated as a hypothesis, not fact.
- **[UA]** UNVERIFIED ASSUMPTION — believed, not measured here. Load-bearing ones are called out.
- **[IN]** INFERENCE — derived from [LE], with the derivation shown.

---

## 1. The runtime axis is not one axis

**[LE]** Three real Node runtimes exist on this machine, with no version manager involved:

| runtime | version | `process.versions.modules` (ABI) | `process.versions.napi` |
|---|---|---|---|
| node22 | v22.13.1 | 127 | 9 |
| node24 | v24.11.1 | 137 | 10 |
| node25 | v25.1.0 | 141 | 10 |

**[LE]** ABI and N-API level drift **independently**: ABI moved 127 → 137 → 141 across these three,
while N-API moved 9 → 10 → 10. Two runtimes share an N-API level while differing in ABI.

**[IN]** Therefore any compatibility key derived from a single runtime scalar is wrong in one of two
directions. Keying on ABI over-invalidates every N-API addon whenever ABI bumps but N-API does not
(node24 → node25). Keying on N-API under-invalidates every raw-V8 addon whenever ABI bumps but N-API
does not. This is not a tuning problem; it is a structural consequence of two independent version
lines. E001 measures both failure directions (§4).

## 2. Compatibility is a conjunction of constraints, not a key

**[LE]** A native artifact's loadability on a given runtime is decided by three independent
constraints, all of which must hold. E001 derives all three statically and scores the result.

- **Axis 0 — container/platform.** Object file format and machine type. An ELF or Mach-O object,
  or a PE built for a different machine, can never load, whatever its ABI says.
- **Axis 1 — N-API minimum.** N-API addons declare a *minimum* N-API level and are otherwise
  ABI-portable forward.
- **Axis 2 — raw-V8 exact ABI.** Non-N-API addons are pinned to one exact `NODE_MODULE_VERSION`.

**[LE]** Axis 0 is not optional and is not only about foreign OSes. The first E001 corpus (9
artifacts) scored 27/27 *because it happened to contain no wrong-architecture PE file*. Widening the
corpus surfaced six of them — `prebuilds/win32-arm64.node`, `dist/crypt32-arm64.node`,
`win32_arm64/koffi.node`, `win32_ia32/koffi.node` and others — which the two-axis model called
loadable and which in fact all fail. That was 18 false-negative cells caused entirely by
platform-checking only *foreign* containers. **[IN]** The lesson generalizes: axis 0 must apply to
every artifact uniformly, including artifacts for the host's own OS.

**[IN]** Because the axes are a conjunction, the data model must be a constraint *set* per artifact,
not a tagged union of one requirement. `analyze.mjs` emits `constraints: [...]` and `decide()`
requires all to pass.

### 2.1 The conjunction is per artifact; across a package, platforms are alternatives

**[LE]** The conjunction above decides one artifact. It does **not** compose by conjunction up to the
package, and assuming it does produces exactly the over-invalidation this project exists to remove.
E004 measured this directly: `check` on an unmodified better-sqlite3@13.0.3 install reported **7 of
11 artifacts as "cannot load"**, and all 7 were prebuilds for other platforms. A prebuild set ships
every platform *on purpose*; exactly one of its 8 objects is meant to load on any given host.

**[LE]** E001 never saw this because its scoring **stratified** the corpus to host-loadable objects,
so that the ABI/N-API axes were what decided the score. That was treated as a scoring convenience.
It is not — it is the decision procedure:

- **applicable** = artifacts whose *platform* constraint (axis 0) the runtime satisfies.
- **inert** = the rest. These are unused alternatives, **not** failures, and must not be reported as
  findings.
- A package with artifacts but **no** applicable artifact **is** broken: nothing it ships runs here.
- Every **applicable** artifact must satisfy its **full** constraint set.

**[IN]** Applicability is decided by **axis 0 alone**, and that is the point of the split: it
separates *"this object is not for this machine"* from *"this object is for this machine and is
broken on it."* Only the second is a finding.

**[IN]** This relaxes nothing within a platform. Two artifacts in one package that both target the
host are two distinct components, not two variants, so "at least one loads" would be unsound there.
The alternation holds strictly *across* platforms, where it is a fact about how prebuild sets are
published rather than an assumption about the package. Implemented in `src/compat/resolve.mjs`; see
`docs/experiments/e004-vertical-slice.md` §2.

## 3. The requirements are statically derivable

The user's brief required evaluating candidate methods rather than presuming PE export parsing.
Four were implemented and scored.

**[LE] M2 — declared N-API version (authoritative).** `node_api_module_get_api_version_v1` compiles
to `mov eax, imm32; ret` (`b8 XX XX XX XX c3`). Reading the immediate out of that export yields the
declared minimum. The reader matches the instruction shape explicitly and refuses to guess on an
unrecognized prologue, so a compiler that emits something else degrades to "unknown" rather than to a
wrong answer.

**[LE] M4 — raw `NODE_MODULE_VERSION` (authoritative).** The `NODE_MODULE` macro writes a
`node_module` struct into `.data`/`.rdata`. A naive `[version][flags]` scan false-matched noise and
read `1` instead of `141`. Validating the whole struct shape — `nm_dso_handle` NULL, pointer slots
NULL-or-inside-the-image, exactly one of the two register hooks set, module name present — reads
`141` correctly.

**[LE] M3 — import floor (provably weaker, retained as a control).** A lower bound from which
`napi_*` symbols are imported, mapped to minimum N-API level by parsing the local
`js_native_api.h` / `node_api.h` (112 symbols). It cannot distinguish an addon declaring N-API 10
from one declaring 9 when both use only old symbols: 3 false negatives, including the
deliberately-built `napi10.node` fixture and both copies of better-sqlite3's `win32-x64.node`.

**[LE] M3 collapses entirely for napi-rs addons, and the fix is derived, not guessed.** A Rust
napi-rs artifact defines `napi_register_module_v1` yet imports **zero** `napi_*` symbols, giving an
import floor of **0** — an accept-anything constraint, and the worst false-negative shape available.
`NODE_API_DEFAULT_MODULE_API_VERSION`, read out of the local `node_version.h` (currently **8**), is
what Node itself assigns a module that declares nothing, so it is the correct floor for the load
question rather than a heuristic. The requirement is `max(importFloor, headerDefault)`, tagged
`header-default(WEAK)` or `import-floor(WEAK)` so the weaker provenance stays visible. Adding it left
E001's 291 measured cells unchanged (still 0 FN, 0 FP), so it costs nothing where loading was observed.
See [E005](../experiments/e005-elf-requirement.md).

**[LE] M2 generalises to ELF across six architectures.** The "load an immediate, return" shape is not
PE-specific; it is what any compiler emits for `return <constant>;`. The declaring symbol is found in
`.dynsym` (which survives stripping, unlike `.symtab`), its virtual address is mapped to a file offset
through the section table, and the immediate is decoded per architecture — x64/ia32 `b8 imm32` … `c3`,
arm64 `movz w0,#imm` … `ret`, arm Thumb-2 `movs r0,#imm8` … `bx lr` (with bit 0 set in the function
address), riscv64 `c.li`/`addi` … `c.jr ra`, loong64 `addi.w`/`addi.d`/`ori` … `jirl $zero,$ra`. Each
anchors on the return instruction and refuses on ambiguity. Validated with **no Linux host** by two
oracles: one package version's builds must declare one value (koffi: 8, read identically from 13 builds
across 6 architectures), and an ELF value must match its PE sibling, whose correctness E001 measured
against real loads. 6/6 agree on each, 37 of 48 artifacts read a declared value, 0 left unknown.

**[LE] Delay-load imports are mandatory, not an edge case.** node-gyp links Windows addons with a
delay-load hook for `node.exe`, so an addon's `napi_*` imports live in PE data directory **13**
(delay imports), not directory 1. Parsing only directory 1 made `Release/keytar.node` and
`x64/onnxruntime_binding.node` — ordinary, working N-API addons — look like they import nothing from
Node, classify as `unknown`, and get conservatively refused: 6 false positives. Reading both tables
fixes all 6.

## 4. Measured model comparison

**[LE]** `node experiments/e001-napi-extraction/run.mjs`. Corpus: 97 distinct artifacts
(content-hash deduped, so an addon installed in three places does not get three votes) × 3 runtimes
= 291 cells. Ground truth is `process.dlopen()` in a child process, so a segfaulting addon cannot
take the harness down. Only 3 fixtures and 6 hand-inspected artifacts informed the analyzer's design;
the other 88 are held-out.

Headline, all 291 cells:

| model | correct | false-neg (unsafe) | false-pos (over-invalidation) |
|---|---|---|---|
| M-static (three-axis, derived) | **291/291** | 0 | 0 |
| M-import-floor (weak static N-API) | 288/291 | 3 | 0 |
| M-abi-only (`built/<abiKey>`) | 174/291 | 72 | 45 |
| M-no-platform (ABI/N-API, no axis 0) | 75/291 | 216 | 0 |
| M-optimistic (npm/pnpm/yarn today) | 70/291 | 221 | 0 |

**[IN]** The headline overstates the achievement, and the honest number is the stratified one. Most
of the corpus is prebuild directories shipping every platform, which axis 0 refuses trivially.
Restricting to cells where the artifact *is* a loadable object for this host — so that ABI/N-API
reasoning is what actually decides — gives 75 discriminating cells:

| model | correct | false-neg (unsafe) | false-pos (over-invalidation) |
|---|---|---|---|
| M-static (three-axis, derived) | **75/75** | 0 | 0 |
| M-import-floor (weak static N-API) | 72/75 | 3 | 0 |
| M-abi-only (`built/<abiKey>`) | 30/75 | 0 | **45** |
| M-optimistic (npm/pnpm/yarn today) | 70/75 | **5** | 0 |

**[IN]** The two realistic alternatives fail in opposite directions, which is the differentiation
result the project needs. The ABI-keyed model is safe but over-invalidates 45 of 75 — 60% spurious
rebuilds on a runtime change that broke nothing. Today's package managers are cheap but miss 5 of 75
unsafe loads. Nexus's contribution is being simultaneously safe and precise on this corpus, and the
reason it can be is that it reasons per-artifact on three axes instead of keying on a runtime scalar.

## 5. Failure modes are asymmetric, which sets the safety posture

**[LE]** Raw-V8 ABI mismatch produces a catchable `ERR_DLOPEN_FAILED` naming both module versions.
An N-API addon whose declared minimum exceeds the runtime's level **segfaults**: Windows exit code
3221225477 (`0xC0000005`), reproduced on `napi10.node` and on both copies of better-sqlite3's
`win32-x64.node` under node22.

**[IN]** This asymmetry is why "let it fail and catch the error" is not an available strategy, and
why zero false negatives is the correct objective function. A false negative is a process crash with
no JS-observable error; a false positive is a wasted rebuild. They are not comparable costs.

**[IN]** Hence the policy in `decide()`: an unrecognized artifact refuses. Unknown is expensive but
safe. The 0-false-positive result is therefore *contingent* on the classifier recognizing real
addons — as the delay-import bug showed, a classification gap converts directly into
over-invalidation.

## 6. Resolution is a weak foundation (E002)

**[LE]** `module.registerHooks` **does not exist** on node22 v22.13.1. On node24 and node25 it
serves `require`, `import.meta.resolve`, and dynamic `import`, but is **bypassed** by
`require.resolve`, `createRequire().resolve`, and `Module.findPackageJSON`.

**[RC]** `RESEARCH.md` describes a similar bypass set for 22.x; the shape of the claim is confirmed
here on 24/25, but the API's total absence on 22.13.1 is a stronger constraint than the research
stated.

**[IN]** A no-`node_modules` resolver built on `registerHooks` cannot support Node 22 LTS at all, and
even on 24/25 any dependency that calls `require.resolve` — a very common pattern in build tooling —
escapes the virtual table and sees the real filesystem. This independently confirms keeping
resolution **subordinate**: it is a portability liability, whereas the compatibility work above needs
no runtime hooks and works on all three runtimes.

## 7. Load-bearing unverified assumptions

These are the claims most likely to break the model. Listed because they bound what E001 proves.

**[UA] → [LE] libc flavour and true OS: RESOLVED by E003.** Originally recorded here as the biggest
hole: `ngrok.linux-x64-gnu.node` and `ngrok.linux-x64-musl.node` yielded identical `linux/x64`
constraints, and every ELF was hardcoded `os: 'linux'` — so koffi's FreeBSD and OpenBSD objects would
have been accepted on a Linux host. [E003](../experiments/e003-libc-derivation.md) closes both:
`DT_NEEDED` from `.dynstr` plus `EI_OSABI` derives OS 48/48 and libc 38/38 with zero disagreements
across 3 OSes and 6 architectures, separating all four genuine same-arch gnu/musl pairs. The platform
constraint is now `{os, arch, libc}`. **Still unmeasured:** the loading direction (see below).

**[UA] glibc minimum version is not derived.** `GLIBC_2.xx` symbol version tags sit in `.dynstr` and
could give a *minimum glibc version* constraint — the ELF analogue of the N-API floor. Not implemented.
An artifact built against glibc 2.38 would currently be accepted on a glibc 2.28 host.

**[UA] Single-host measurement.** Axis 0 is validated only in the refusing direction. That a
`linux/x64` ELF *does* load on a `linux/x64` Node was never measured. Cross-platform confirmation
needs a second host. `--target <os>/<arch>[/<libc>]:<abi>:<napi>` makes the question *askable* from
here — a constraint is recorded runtime-free, so deciding it against a hypothetical runtime is the same
operation as deciding it against a probed one — but asking is not observing.

**[UA] → [LE] Compiler generality of M2: substantially widened.** Originally recorded because every
artifact was MSVC-built or PE-prebuilt. E005 read the same construct out of ELF objects for six
architectures, produced by whatever toolchains koffi, better-sqlite3, onnxruntime and copilot's
prebuild pipelines use, including an OpenBSD build whose retguard inserts ~26 bytes between the
immediate and the `ret`. Residual assumption: an unseen toolchain or optimisation level could still emit
an unrecognised shape, which degrades to `unknown` → refuse (safe, costly), not to a wrong answer.

**[UA] Raw-V8 ELF is not derived at all.** M4's `node_module` struct reader is validated on PE only;
the local corpus contains **zero** raw-V8 ELF addons, so there is no evidence to validate an ELF
version against. Such artifacts return `unknown` and refuse. Shipping the parser anyway would mean
publishing an unvalidated number as a derived fact.

**[UA] Mach-O requirement axis is not derived.** With ELF closed by E005, Mach-O is the only container
format where an N-API artifact's requirement is still `unknown`. Sound, but it makes the tool unusable
on macOS.

**[UA] Mach-O fat binaries.** Not parsed for architecture (`arm64/kerberos.node` → `darwin/?`).
Refused on this host via the OS check.

**[UA] Honesty of declared N-API.** The model trusts the declared minimum. An addon that declares a
low minimum but calls a newer symbol at runtime would pass statically and fail dynamically. Not
observed in this corpus; not excluded.

**[UA] Electron and other embedders** report their own ABI; entirely out of scope of these
measurements.

## 8. Package metadata is not artifact truth

**[LE]** `@msgpackr-extract/msgpackr-extract-win32-x64` ships `node.abi115.node`. The filename claims
ABI 115. The file is in fact an N-API addon requiring N-API ≥ 8, and it loads on all three runtimes
(ABI 127, 137, 141). The name is simply wrong about the artifact.

**[LE]** Conversely `prebuilds/win32-x64.node` (better-sqlite3) carries no version information in its
name at all, yet requires N-API ≥ 10 and segfaults on node22.

**[IN]** Compatibility metadata must be derived from the artifact bytes. Filenames, directory
conventions, and package fields are hints at best and actively misleading at worst. This rules out
package-level compatibility declaration as a *primary* mechanism (see the Phase 2 red-team).

**[LE] But metadata does decide one thing bytes cannot: whether a package is reached at all.** On an
uncurated 128k-file install, 6 of 6 refusals were packages whose *artifacts* were correctly analyzed —
one Linux object each, genuinely unloadable here — but which npm would never have installed on this host:
4 of the 6 declare `os: ["linux"]` in their own `package.json`, and 5 of 6 are `optionalDependencies` of
a parent that selects among them (`@img/sharp-linux-x64`, `@ngrok/ngrok-linux-x64-{gnu,musl}`,
`sqlite-vec-linux-x64`). The byte-derived answer was right and the *verdict* was wrong, because the
question "can this artifact load here" is not the question "is this artifact ever asked to load here".

**[IN]** The two roles are asymmetric and must stay so. Metadata may narrow the *scope* of a verdict — it
may say "nothing on this platform selects this package" — and may never widen it by claiming an artifact
loads. Implemented that way: exclusion can only turn a refusal into a separately-reported `EXCLUDED`,
never the reverse, and a package declaring support for the host is still judged entirely on its bytes.
See [E006](../experiments/e006-adversarial-review.md) attack 5.

**[UA] `os`/`cpu`/`libc` gate npm's installer, not Node's loader.** If a program requires an excluded
package anyway, it fails where Nexus reported nothing wrong. Unmeasured here; bounded by the failure
being a wrong-container `ERR_DLOPEN_FAILED` rather than a segfault.

## 9. An unexamined artifact is a false negative

**[LE]** `check` on a bundled VS Code extension reported `0 packages with native artifacts -- OK` for a
tree containing 17 addons; in that corpus **19 of 21** `.node` files were outside any `node_modules`
directory. **[LE]** Separately, a nested `<pkg>/dist/node_modules/` subtree was skipped by the file
walker as a package boundary, never reached by the package collector, and skipped by the
outside-`node_modules` report as the scan's territory — **34 of 80** `.node` files on a real install,
while the tool reported `unexamined: 0`.

**[IN]** The zero-false-negative posture cannot stop at the parser. Every constraint in both cases was
derived correctly; the verdicts were still unsafe, because the tool answered about a subset of the tree
while presenting the answer as being about the tree. Scope is part of a verdict's meaning, so a gap the
tool cannot close must be *reported* rather than left to the caller's assumption — which is why
`unexamined` and `EXCLUDED` are counted and named next to the answer, and why `run` warns about them even
under `--quiet`.

## 10. Open questions carried forward

1. Can libc flavor be derived statically from ELF (interpreter path, `.dynstr` references to
   `GLIBC_*` versioned symbols)? Needed before any Linux claim.
2. Is there an artifact class that mixes N-API and raw-V8 imports, and which axis wins?
3. Does `nm_version` struct validation survive link-time optimization and non-MSVC linkers?
4. What is the cost of the conservative-refuse policy on a corpus containing artifacts the classifier
   genuinely cannot read? Zero such cases survived here after the delay-import fix, which means the
   policy is currently untested in production terms.
5. Are there artifact locations neither walk reaches? The coverage audit that found the nested-tree hole
   compared `.node` files by extension, so an addon with an unexpected extension would have been missed
   by both the tool and the audit.
