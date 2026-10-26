# Phase 2 Red-Team: Identity and Compatibility Models

Status: **Gate 4**. Adversarial evaluation of four candidate models, scored against the E001
measurements where the data supports scoring and attacked on first principles where it does not.

Evidence tags follow `knowledge-model.md`: **[LE]** local evidence, **[RC]** research context,
**[UA]** unverified assumption, **[IN]** inference.

---

## Scope boundary, stated before anything else

**[IN]** E001 measures **loadability** — does `process.dlopen()` succeed. Loadability is *necessary*
for correctness and not *sufficient*. An artifact can load and then misbehave (wrong compiled
feature flags, mismatched bundled shared library, an N-API addon that declares a low minimum and
calls a newer symbol on a code path never exercised at load time). No model below can claim to
validate correctness, and this document does not. The claim is narrower and defensible: Nexus can
decide, without executing anything, whether an installed native artifact will load on a given
runtime.

Any model that markets itself as guaranteeing "your install still works" is over-claiming. The
honest promise is "your install will not silently segfault, and you will not rebuild what did not
break."

---

## Model A — One installation-wide hash

*Identity = H(dependency graph ‖ runtime identity ‖ artifact set). Runtime changes ⇒ new identity ⇒
reinstall/rebuild everything.* This is the `built/<abiKey>` shape in **[RC]** `MVP-SPEC.md`, taken to
its logical end.

**Attack 1 — it over-invalidates by more than an order of magnitude. [LE]** Measured on two real
installs on this machine: of 27 packages, 1 ships a `.node` file (3.7%); of 91 packages, 8 do (8.8%).
A runtime-keyed installation hash invalidates 100% of packages when at most 4–9% can possibly be
affected. **[IN]** That is an 11×–27× over-invalidation factor before considering whether the native
artifacts themselves actually broke.

**Attack 2 — even restricted to native artifacts it is wrong in both directions. [LE]** Scored as
`M-abi-only` over the 75 discriminating cells: 30/75 correct, **45 false positives**. It rebuilds 60%
of artifacts that were fine. Over all 291 cells it also produces **72 false negatives**, because an
ABI-keyed identity says nothing about platform: it happily declares a `linux/x64` ELF valid on
Windows whenever the ABI key matches the current runtime.

**Attack 3 — it conflates two questions that have different answers.** Graph correctness ("did the
dependency set change?") and execution compatibility ("can these bytes load here?") change under
different events. Fusing them into one hash means neither can be answered independently, and the
system cannot distinguish "your lockfile changed" from "you switched Node versions."

**Verdict: REJECTED.** Simplest to implement, and empirically the worst-performing model measured.
Its only virtue — a single comparison — is worth less than a 60% spurious rebuild rate.

---

## Model B — Separate identities, per-artifact constraint sets

*Three independent identities: (1) **graph identity** = content hash of the resolved dependency graph;
(2) **runtime capability descriptor** = `{os, arch, abi, napi}` probed from the runtime; (3) **artifact
compatibility constraints** = a conjunction derived from each artifact's bytes. Compatibility is
`decide(constraints, runtime)`; graph identity is untouched by runtime changes.*

**[LE]** This is what E001 implements as `M-static`: **291/291** overall, **75/75** on the
discriminating subset, 0 false negatives and 0 false positives.

Now the attacks, including the ones that land.

**Attack 1 — the constraint deriver had a hole that the score concealed. [LE] Now closed.** As
originally written: libc flavour was not derived, so `ngrok.linux-x64-gnu.node` and
`ngrok.linux-x64-musl.node` produced identical `linux/x64` constraints, and every ELF was labelled
`os: 'linux'` — meaning koffi's FreeBSD/OpenBSD objects would be *accepted* on a Linux host. On this
Windows host all of them refuse for other reasons, so the gap contributed **zero error to 291/291**
while being a live false-negative source. That is the failure mode this project exists to eliminate,
and it was invisible in the headline number.

[E003](../experiments/e003-libc-derivation.md) closes the derivation side: OS **48/48** and libc
**38/38**, zero disagreements against publisher intent across 3 OSes and 6 architectures, all four
genuine same-arch gnu/musl pairs separated. The platform constraint is now `{os, arch, libc}`.

**[UA] What remains open** is the *loading* direction: that a musl artifact genuinely fails on a glibc
host, and that a correctly-derived Linux artifact genuinely loads, needs a Linux host. Also underived:
minimum glibc version from `GLIBC_2.xx` version tags. So B's accuracy on a Linux host is still formally
unmeasured, and it still has a known Linux false-negative hole.

**Attack 2 — a classification gap converts silently into over-invalidation. [LE]** Proven, not
hypothetical: parsing only PE import directory 1 made `keytar.node` and `onnxruntime_binding.node`
look like non-addons, classify `unknown`, and get refused — 6 false positives from one missing table.
**[IN]** The conservative-refuse policy is correct (unknown must never be assumed loadable), but it
means B's false-positive rate is a direct function of parser coverage. Every container format,
linker, and compiler the parser does not fully understand becomes a spurious rebuild. B's 0% FP is a
statement about this corpus and this parser, not a property of the design.

**Attack 3 — coverage is limited to `.node` files.** E001 inspects only `.node` artifacts. Real
packages also ship `.dll`/`.so`/`.dylib` that addons load at runtime, WASM, and platform-specific
executables in `.bin`. **[UA]** Whether those carry runtime-sensitivity that B's model misses is
untested.

**Attack 4 — "pure JS ⇒ no constraints" is an assumption.** **[UA]** JS that branches on
`process.version`, or packages whose `install`/`postinstall` compiles from source, are
runtime-sensitive without shipping a pre-built `.node`. **[LE]** 1 of 27 and 4 of 91 packages have
install/postinstall scripts; 1 has a `binding.gyp`. Those are real and B currently models them as
unconditionally compatible.

**Attack 5 — constraints are not an equivalence relation.** Two artifacts with identical constraints
are *not* interchangeable in the store. Constraints must be metadata *attached to* a
content-addressed artifact, never a substitute for its content hash. A design that keyed storage on
constraints would be unsound.

**Verdict: ACCEPTED as the primary model, with Attack 1 recorded as the top unresolved risk.** It is
the only model measured that is simultaneously safe (0 FN) and precise (0 FP) on the discriminating
subset, and the attacks above are gaps in *coverage* rather than errors in *structure*. Critically,
each gap degrades toward refusal (costly, safe) rather than toward acceptance (crash), except
Attack 1, which degrades toward acceptance and therefore must be closed before any Linux claim.

---

## Model C — Package-level compatibility declaration

*Read compatibility from package metadata: `engines`, `os`, `cpu`, `binary.napi_versions`, prebuild
directory naming conventions.*

**Attack 1 — the metadata is measurably false. [LE]** `@msgpackr-extract/msgpackr-extract-win32-x64`
ships a file named `node.abi115.node`. The name asserts ABI 115. The artifact is actually an N-API
addon requiring N-API ≥ 8, and it loads on ABI 127, 137, and 141. Any model trusting that name
computes the wrong answer for three of three runtimes.

**Attack 2 — absence of metadata is the common case. [LE]** better-sqlite3's
`prebuilds/win32-x64.node` encodes platform and nothing else, yet requires N-API ≥ 10 and
**segfaults** on node22. A package-level model has no signal here and must either guess (unsafe) or
refuse (useless).

**Attack 3 — granularity is wrong.** **[LE]** One package routinely ships many artifacts with
*different* requirements: koffi ships 20 objects across 5 OSes and 6 architectures; onnxruntime-node
ships both a `win32/arm64` and a `win32/x64` binding whose loadability differs on this host. A single
per-package verdict cannot express that, so it must collapse to the most conservative artifact and
over-invalidate the rest.

**Verdict: REJECTED as a primary mechanism. RETAINED as a cross-check.** Declared metadata is useful
precisely where it *disagrees* with derived constraints — that disagreement is a strong signal of a
mispublished package and worth surfacing as a warning. It must never be the source of truth.

---

## Model D — Hybrid: constraints only on runtime-sensitive artifacts

*Graph identity as in B. Compatibility metadata attached only to artifacts that are actually
runtime- or build-sensitive; everything else carries the empty constraint set and is unconditionally
compatible.*

**[IN]** D is not a rival to B — it is B plus an optimization, and the optimization is well
motivated: **[LE]** 91–96% of installed packages ship no `.node` file at all, so computing and
storing constraints for them is pure overhead. `decide([], runtime)` returning `ok` makes the empty
set the natural identity element, and `analyze()` already produces exactly this shape.

**Attack 1 — "runtime-sensitive" must be decided conservatively, and the current test is too narrow.**
Classifying sensitivity by "ships a `.node` file" misses the install-script and `binding.gyp` cases in
Attack 4 against B (**[LE]** 4/91 and 1/27 packages respectively). **[IN]** The predicate must be a
union — ships a native object, *or* has an install/postinstall script, *or* has a `binding.gyp` — and
must default to "sensitive" when uncertain, because the failure direction of a wrong "insensitive"
verdict is a missed incompatibility.

**Attack 2 — the empty constraint set is indistinguishable from a derivation failure.** If a parse
error yields `[]` rather than `[{kind:'unknown'}]`, an unreadable artifact silently becomes
"compatible with everything." **[IN]** This is a live footgun: it is exactly the bug shape that
`decide()`'s conservative default is designed to prevent, and it is defeated by an empty array. The
runner therefore emits an explicit `unknown` constraint on parse failure rather than an empty list,
and that invariant must be enforced by construction, not convention.

**Verdict: ACCEPTED as the implementation form of Model B**, subject to a conservative sensitivity
predicate (Attack 1) and a hard invariant that derivation failure produces an explicit `unknown`
constraint and never an empty set (Attack 2).

---

## Decision

**Adopt B, implemented as D.**

| model | measured accuracy (75 discriminating cells) | verdict |
|---|---|---|
| A — one installation-wide hash | 30/75, 45 FP | rejected |
| B — separate identities, per-artifact constraints | **75/75, 0 FN, 0 FP** | **accepted (primary)** |
| C — package-level declaration | not scorable; falsified by counterexample | rejected as primary, kept as cross-check |
| D — B restricted to sensitive artifacts | equivalent to B by construction | **accepted (implementation form)** |

Three identities, kept separate:

1. **Graph identity** — content hash over the resolved dependency graph. Runtime-independent. Answers
   "did dependencies change?"
2. **Runtime capability descriptor** — `{os, arch, abi, napi}` probed from the target runtime. Cheap,
   no artifact involvement.
3. **Artifact constraint set** — conjunction derived from artifact bytes, attached to (never
   substituting for) the artifact's content hash. Empty set for insensitive artifacts, explicit
   `unknown` on derivation failure.

Compatibility check = for each sensitive artifact in the graph, `decide(constraints, runtime)`. All
must pass.

### Amendment (E004) — the check is reported at package level

The line above, "for each sensitive artifact … all must pass", is **wrong as stated**, and E004 found
it by running the model against an unmodified prebuild set: `check` called **7 of 11 artifacts
"cannot load"**, all 7 being better-sqlite3 prebuilds for other platforms. That is Attack 1 vs Model
A's failure mode — over-invalidation — reappearing inside the accepted model, and it would have made
the tool useless in practice, since prebuild sets are now the norm for native npm packages.

The corrected procedure, a structural addition to B/D rather than a change of model:

```
per artifact:  applicable  <- decide([platform constraint only], runtime).ok
               verdict     <- decide(all constraints, runtime)

per package:   applicable = artifacts where applicable
               inert      = the rest              (unused alternatives, NOT failures)
               broken     = applicable where !verdict.ok
               ok         = (applicable is non-empty) AND (broken is empty)
```

Artifacts within a package are **alternatives across platforms and conjuncts within one**. This is
precisely the stratification E001 already used to score the discriminating subset, promoted from a
scoring convenience to the product's decision procedure — which is why the amendment costs no
accuracy: the regression test reproduces 291/291 and 75/75 unchanged.

Note what it does not weaken. Within the host platform the rule stays a conjunction, because two
host-targeting artifacts in one package are distinct components, not variants; "at least one loads"
would be unsound there. And a package shipping artifacts of which *none* is applicable is broken, not
vacuously fine. Implemented in `src/compat/resolve.mjs`; recorded in
[E004](../experiments/e004-vertical-slice.md) §2.

### Amendment (E006) — packages within a tree are alternatives too

E004's amendment stopped one level too low, and [E006](../experiments/e006-adversarial-review.md) found
it the same way: by running the model against an unmodified working install, where **6 of 6 refusals were
false positives**. All six read `ships 1 native artifact(s), none targeting win32/x64`, and four of the
six **declare `os: ["linux"]` in their own `package.json`** — npm's install-time platform gate, which
means npm would never have selected them on this host. Five of six are `optionalDependencies` of a parent
that picks among them. This is how the whole prebuild ecosystem ships (`sharp`, `esbuild`, `rollup`,
`swc`, `ngrok`), so the rule as written refuses nearly every real install — Attack 1's over-invalidation
resurfacing a second time, one level up.

So the "none applicable ⇒ broken" rule is guarded by the package's own platform declaration:

```
per package:   excludedBy <- the os/cpu/libc axis (if any) whose value excludes the runtime
               if excludedBy:  inert = all artifacts;  ok = true;  reported as EXCLUDED
               else:           the E004 procedure above, unchanged
```

Three properties keep this honest. It can only ever turn a refusal *into* an exclusion, never the
reverse. It is reported as its own category with its own count, never absorbed into the OK — because this
is the one point where a verdict rests on a metadata claim rather than on derived bytes. And it is
checked *before* applicability is scored, since a package npm would not have selected here has no
applicable artifact by construction.

Result on the measured tree: 6 refusals → 4 excluded, **2 retained as true positives** (a Linux-built
bundle physically present inside a Windows install). Not weakened: a package that declares support for
this host is still judged entirely on its bytes, and an axis the package did not state cannot exclude
anything.

### Carried risks, ranked

0. **Minimum glibc version is not derived.** An ELF built against a newer glibc can pass on an older
   glibc host; this is the known Linux false-negative hole and must not be described as closed.
1. **False-positive rate is a function of parser coverage** (Attack 2 vs B). Degrades safely toward
   refusal, but silently erodes the precision advantage that justifies the whole approach.
2. **Loading direction unvalidated off this host.** E003 proves constraints are *computed* correctly for
   Linux/FreeBSD/OpenBSD artifacts, and E005 proves the *requirement* is too — via cross-architecture
   agreement and cross-flavour agreement with E001's measured PE loads. That the *comparison* against a
   live non-Windows runtime is complete is still unmeasured. Needs a Linux host. `--target` lets the
   question be asked from here, which is not the same as answering it by observation.
3. **Sensitivity predicate too narrow** (Attack 1 vs D) -- install scripts and `binding.gyp` packages.
4. **Non-`.node` artifacts unexamined** (Attack 3 vs B) — bundled shared libraries, WASM, `.bin`
   executables. Partially addressed: bundled shared libraries now derive a platform constraint plus an
   explicit `no-requirement` requirement axis, refused under `--strict`.
5. **`header-default(WEAK)` is a floor from what Node assumes, not from the artifact.** For a
   non-declaring addon the requirement is `max(importFloor, NODE_API_DEFAULT_MODULE_API_VERSION)`. That
   is the right answer to the *load* question — it is the version Node hands the module — but it is read
   from the headers of *one* Node install, so a derivation performed against different headers is a
   different answer. Hence the derivation key (below).
6. **The scope of a verdict is part of its meaning.** [E006](../experiments/e006-adversarial-review.md)
   found that an artifact the tool never examined is a false negative just as surely as one it misjudged.
   Artifacts outside `node_modules` are counted and named but not analyzed. A cached sidecar is now
   bound to the lock and current covered artifact hashes; this detects sidecar-only or artifact-only
   edits, but it is not a signature and cannot defend an attacker who can rewrite both files.
7. **Package exclusion rests on metadata, the one place a verdict does not rest on bytes** (E006
   amendment above). `os`/`cpu`/`libc` gate npm's *installer*, not Node's *loader*, so a program that
   directly requires an excluded package anyway will fail where Nexus reported nothing wrong. Bounded:
   the failure is a wrong-container `ERR_DLOPEN_FAILED`, catchable, never the silent segfault this
   project exists to prevent — and the alternative is refusing nearly every real install.

**Closed:** libc flavour and true-OS derivation (was #1) — see
[E003](../experiments/e003-libc-derivation.md).

**Closed:** derived analyses were cached under the artifact's content hash alone, while a derivation is
a pure function of *(bytes, symbol map, header default)*. A key that omits an input is precisely the bug
this project exists to diagnose, committed inside the tool itself. Analyses are now addressed
`analysis/<sha>.<derivationKey>.json`; a superseded entry is left in place, never rewritten and never
deleted. See [E005](../experiments/e005-elf-requirement.md).

**Closed:** a nested `node_modules` below a package's root (`<pkg>/dist/node_modules/…`) was claimed by
neither walk — skipped by the file walker as a package boundary, never reached by the package collector,
and skipped by the unexamined report as the scan's territory. On one real install that swallowed **34 of
80** `.node` files while reporting `unexamined: 0`, i.e. actively asserting a coverage it did not have.
Both walks are now complementary by construction. See
[E006](../experiments/e006-adversarial-review.md) attack 4.

**Closed (bounded):** `nexus-compat.json` is canonically hashed into `nexus-lock.json`, and the lock
also records an identity over the current native/shared artifact sites and hashes. Normal `check`
rejects a changed sidecar or changed/added/removed covered artifact before cached constraints are used;
legacy unbound sidecars are re-derived. This is integrity binding, not authentication against a writer
who can edit both files. `run` still implies `--verify` and derives from bytes.
