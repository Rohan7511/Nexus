# E004 — Vertical slice: does artifact-level compatibility survive contact with a real install?

**Status:** complete. **Date:** 2026-08-26. **Host:** win32/x64, Node v25.1.0 (ABI 141, N-API 10).

E001 established that a per-artifact constraint model scores 291/291 on a runtime ×
artifact load matrix while an ABI-keyed model scores 174/291. That was a *scoring*
result: a harness, a corpus, and a table. E004 asks the product question instead —
when the same model is wired into an installer, a lockfile, a store, and a `run`
command, does it still hold, and does anything break that a scoring harness could
not see?

Two things came out of it. The mechanism held, unchanged, end to end. And the slice
surfaced one design defect that E001's stratified scoring had been quietly hiding.

---

## 1. What was built

Seven commands over the promoted `src/` modules, zero dependencies:

| command | role |
| --- | --- |
| `ingest` | scan tree → content-address every file → derive constraints → write runtime-free lock + compat |
| `check` | can this install load on this runtime? per-package verdict, named reasons |
| `analyze` | single-artifact evidence dump (what was read from which bytes) |
| `rebuild` | dry run: what *would* be rebuilt, and what would not |
| `run` | check first; execute only if every artifact can load |
| `materialize` | build a tree from the store (hardlink, or `--copy`) |
| `store` | stats; states the append-only invariant |

**Demo tree** (`experiments/e004-vertical-slice/build-demo.mjs`, reproducible):

```
packages        6  (5 runtime-sensitive, 83.3%)
files           24 (16.4 MiB)
artifacts       11 native/shared file(s), 11 distinct by content
graph identity  12170439095b5676...
```

Six packages chosen to cover the interesting shapes: `plain-js` (insensitive),
`gyp-builder` (sensitive, install script + `binding.gyp`, *no* native object),
three synthetic fixtures pinning known constraints, and **better-sqlite3@13.0.3's
8 real prebuilds** — an unmodified prebuild set covering win32/linux/darwin ×
x64/arm64 × glibc/musl.

---

## 2. The defect the slice surfaced

First run of `check` on the demo tree reported **7 of 11 artifacts INCOMPATIBLE**.

Every one of the 7 was a better-sqlite3 prebuild for another platform.

This is wrong, and not wrong in a safe direction. A prebuild set ships every
platform *on purpose*; exactly one of the 8 is meant to load here. Reporting the
other 7 as "cannot load" is the over-invalidation this project exists to eliminate,
dressed up as caution. Worse, it is the failure mode that would make the tool
useless in practice: almost every native package on npm now ships prebuilds, so
almost every package would be permanently red.

E001 never showed this because its scoring **stratified** the corpus — it restricted
to host-loadable objects precisely so the ABI/N-API axes were what decided the
score. That stratification was treated as a scoring convenience. It is not. It is
the decision procedure, and it belongs in the product.

**The correction** (`src/compat/resolve.mjs`): the verdict is reported at PACKAGE
level over per-artifact decisions, because *artifacts within a package are
alternatives across platforms and conjuncts within one*.

```
applicable = artifacts whose PLATFORM constraint the runtime satisfies
inert      = the rest; unused alternatives, not failures

* a package with artifacts but NO applicable artifact is broken:
  nothing it ships can run here.
* every APPLICABLE artifact must satisfy its full constraint set.
  Artifacts targeting the same platform are distinct components, not
  variants, so "at least one loads" would be unsound at this level.
```

Applicability is decided by **axis 0 alone**. That is the whole point of the split:
it separates *"this object is not for this machine"* from *"this object is for this
machine and is broken on it."* The first is not a finding. The second always is.

Note what this does **not** relax. Within the host platform the rule stays a
conjunction — two host-targeting artifacts in one package are two components, and
both must load. The alternation is strictly across platforms, where it is a fact
about how prebuild sets are published, not an assumption about the package.

After the correction:

```
artifacts 11 total: 4 apply to this runtime, 7 target other platforms
```

and the 7 are listed, by derived platform, as inert:

```
darwin/arm64, darwin/x64, linux/arm64/glibc, linux/x64/glibc,
linux/arm64/musl, linux/x64/musl, win32/arm64
```

Those labels are derived from artifact bytes, never from filenames or metadata —
and `linux/x64/glibc` vs `linux/x64/musl` appearing as *distinct platforms* is
E003's libc derivation showing up in product output.

---

## 3. The differentiation result, end to end

One unchanged install, ingested under Node 25, then checked against three runtimes.
Nothing in the tree or the lockfile changes between rows — only the runtime.

| runtime | ABI | N-API | Nexus would rebuild | ABI-keyed hash would rebuild |
| --- | --- | --- | --- | --- |
| v25.1.0 *(ingest runtime)* | 141 | 10 | 0 of 4 | 0 of 4 |
| v24.11.1 | 137 | 10 | **1** of 4 | 4 of 4 |
| v22.13.1 | 127 | 9 | **3** of 4 | 4 of 4 |

The **v24 row is the argument**. The ABI moved 141 → 137, so every ABI-keyed
installation hash invalidates the entire install. Nexus rebuilds one package —
`addon-rawabi141`, the only raw-V8 artifact — because N-API did *not* move, and the
two N-API addons plus better-sqlite3's prebuild remain valid by their own declared
constraints. Verbatim:

```
runtime v24.11.1 win32/x64 abi=137 napi=10

DRY RUN -- 1 package(s) would need a rebuild:

  addon-rawabi141@1.0.0
      1 applicable artifact(s) cannot load
      Release/rawabi141.node
        needs platform win32/x64
        needs NODE_MODULE_VERSION == 141
        because pinned to NODE_MODULE_VERSION 141, runtime is 137

3 of 4 package(s) are unaffected and would NOT be rebuilt.
3 of 4 applicable artifact(s) are fine.
an ABI-keyed installation hash would rebuild every one of them.

no rebuild was performed. this command never writes.
```

Across the two off-ingest runtimes: **8 ABI-keyed rebuilds, 4 of them spurious**,
with **0 missed incompatibilities**.

**Honest scope.** This tree is an existence proof of the mechanism, not a
measurement of the rate. It has 6 packages, 2 of them synthetic fixtures built to
fail, so its 50% spurious-rebuild figure carries no statistical weight. The
measurement is E001's: **45 spurious rebuilds out of 75 discriminating cells (60%)**
on a real corpus. E004's contribution is that the same mechanism produces the same
kind of answer once it has to survive a store, a lockfile, and a process launch.

---

## 4. What `run` prevents, measured on this host

The asymmetry argued in the knowledge model is not theoretical, and this is the one
place the slice could confirm it directly rather than by reasoning.

Loading the N-API-10 fixture under Node 22 (N-API 9), with no Nexus in the path:

```
$ node22 -e "process.dlopen({exports:{}}, '.../napi10.node')"
Segmentation fault
```

No JS-observable error. No exception to catch. The process is simply gone —
`0xC0000005` on Windows, reported as SIGSEGV through the shell. A raw-ABI mismatch
throws a catchable `ERR_DLOPEN_FAILED`; **an N-API-too-new addon does not.** This is
exactly why the objective function is zero false negatives rather than balanced
error: one class of mistake is a diagnosable failure, the other takes the process
down with no trace.

`nexus run` on the same tree and runtime:

```
nexus run: refusing to execute -- 3 of 4 package(s) cannot load on v22.13.1 win32/x64 abi=127 napi=9
  x addon-napi10@1.0.0: 1 applicable artifact(s) cannot load
      node_modules/addon-napi10/build/Release/napi10.node
        needs N-API >= 10, runtime provides 9 (would segfault)
  ...
exit 1
```

Refusing to start is strictly better than crashing partway through, and every
refusal names the constraint that caused it — an unexplained refusal is
indistinguishable from over-invalidation.

---

## 5. Defects found and fixed while exercising the slice

**`run` used `shell: true` on Windows.** Node's own DEP0190 warning caught it: with
a shell, argv is concatenated into a command line and re-split, mangling any
argument containing spaces or quotes. Demonstrated live — `node -p "process.version
+ ' <- executed'"` died with `Unterminated string constant`. Fixed by spawning
directly and falling back to a shell **only** on `ENOENT` on win32, which is the
case that actually needs it (`.cmd`/`.bat` wrappers like `npm`). Arguments now pass
through intact.

**Regression-harness keying (carried over from E001's re-run).** Ground truth was
matched by a last-two-path-segments label, and that label is not unique —
`x64/kerberos.node` exists under both `darwin/x64/` and `win32/x64/`, so two
distinct artifacts were scored against one truth row, manufacturing 27 phantom
false positives. The tell was that the stratified subset was *simultaneously* 75/75,
which is impossible if those artifacts were genuinely being refused. Rows now carry
a content hash and the harness keys on it.

---

## 6. Invariants confirmed by exercising the commands

- **`materialize` hardlink vs `--copy`** — hardlinked file shares the store inode
  and is mode `444`; `--copy` gets a fresh inode at mode `666`. Both trees contain
  all 6 packages. This is the invariant that matters most for a shared store: a
  hardlinked artifact that were writable would let one project corrupt every other
  project that shares it.
- **`--runtime` governs the child process.** `run --runtime node22` from a Node 25
  parent: the child reported `v22.13.1`. Without the PATH prepend the check would
  have answered a question about a runtime the command never sees.
- **The lock is runtime-free and the decision is late-bound.** A tree materialized
  from the store, then checked against Node 22, reported `source
  nexus-compat.json` — the same recorded constraint sets yielding a different
  verdict for a different runtime, with no re-derivation. `--strict` re-derives from
  bytes instead and agreed.
- **Empty `node_modules` is not a false refusal** — 0 packages, exit 0. A *missing*
  `node_modules` still errors, since that means the tree is not in a state to be
  judged.
- **27/27 invariant tests pass**; **E001 reproduces exactly** through the product
  code path (291/291 all cells, 75/75 discriminating, 0 FN, 0 FP) despite the
  widened platform axis, Mach-O arch sets, and the new `no-requirement` kind.

---

## 7. What E004 does not establish

- **The requirement axis is derived for PE only.** ELF and Mach-O artifacts get an
  explicit `{kind:'unknown'}` constraint, which refuses. Nexus is therefore *safe
  but unusable* on Linux and macOS: correct by construction, and useless in
  practice. This is the single biggest gap and the next experiment (E005).
- **Loading direction is unvalidated off this host.** Every ground-truth load in
  E001 was performed on win32/x64. The claim that a satisfied constraint set implies
  a successful load is verified on one platform only.
- **Minimum glibc version is not derived** — only the glibc/musl *flavour*. A
  glibc artifact built against a newer glibc than the host would pass axis 0 and
  fail at load. Under-invalidation, i.e. a potential false negative, and the one
  known hole in the zero-FN claim on Linux.
- **False-positive rate is a function of parser coverage.** Every unparsed shape
  becomes `unknown` becomes a refusal. The model is only as useful as the parsers
  are complete, and that is a maintenance burden, not a one-time cost.
- **`rebuild --execute` is not implemented and will not be.** This POC decides
  *what* needs rebuilding; invoking a toolchain is out of scope. The command says so
  on stderr rather than pretending.

---

## 8. Verdict

The artifact-level hypothesis is technically sound and meaningfully differentiated,
and it survived being wired into a real install. The slice earned its keep by
finding a defect that scoring could not: the alternatives-vs-conjuncts rule, which
was a stratification convenience in E001 and is a load-bearing part of the decision
procedure in the product.

Phase 5 is complete. The gating question for GO/PIVOT/STOP is no longer *does the
mechanism work* — it is whether the requirement axis extends off Windows (E005).
