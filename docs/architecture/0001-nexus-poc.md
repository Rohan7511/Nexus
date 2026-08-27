# ADR 0001 — Nexus POC: runtime-aware artifact compatibility

**Status:** accepted · **Date:** 2026-08-27
**Supersedes:** the `built/<abiKey>` compatibility tier in `MVP-SPEC.md`, which
[E001](../experiments/e001-native-artifact-compatibility.md) falsifies in both directions.

## Context

Phases 0–2 produced two decisive measurements.

- [E001](../experiments/e001-native-artifact-compatibility.md): per-artifact statically-derived
  compatibility constraints score **75/75 (0 FN, 0 FP)** on the discriminating subset of a 97-artifact
  corpus, against **30/75 (45 FP)** for ABI-keyed identity and **70/75 (5 FN)** for the model today's
  package managers use. Two of those 5 false negatives are silent segfaults.
- [E002](../experiments/e002-resolution-hooks.md): `module.registerHooks` is **absent on Node 22.13.1
  LTS**, and where it exists `require.resolve`, `createRequire().resolve`, and `findPackageJSON`
  bypass it.

The [Phase 2 red-team](./compatibility-models-redteam.md) adopts **Model B implemented as Model D**:
three separate identities, with compatibility constraints attached per-artifact and only to
runtime-sensitive artifacts.

## Phase 3 decision — layout and resolution strategy

Compatibility enforcement needs no resolver. The layout question is therefore decided on portability,
not on elegance.

| strategy | Node 22 LTS | bypass-proof | needs privilege | anti-goal | verdict |
|---|---|---|---|---|---|
| **R1 — hardlink store blobs into real directories** | yes | yes (no hooks involved) | **no** — `fs.linkSync` needs none | no | **ADOPT** |
| R2 — virtual table via `registerHooks` | **no (API absent)** | **no** (`require.resolve` escapes) | no | no | reject — E002 |
| R3 — symlinked tree (pnpm-style) | yes | yes | **symlinks may need Developer Mode or admin** | no | reject for POC |
| R4 — patched/custom runtime | — | yes | — | **explicit project anti-goal** | reject |
| R5 — full file copy | yes | yes | no | no | **fallback** when hardlink fails (cross-device) |

**[LE]** Probed on this host: `fs.linkSync` succeeds, produces a shared inode (`nlink=2`), and needs
no elevation. `fs.symlinkSync` for files and directories also succeeds *here* — but that indicates
Developer Mode is enabled on this machine and cannot be assumed generally, whereas hardlinks never
require privilege. R1 with R5 as fallback is the portable choice.

**Consequence:** the POC produces an ordinary `node_modules` directory. Every runtime, bundler, and
tool that walks the filesystem works unchanged. Hook-based resolution is out of scope and, if ever
revisited, must be explicitly marked experimental.

## Decision — what the POC is

A CLI that content-addresses an existing dependency tree, derives per-artifact compatibility
constraints, and answers *"will this install run on this runtime"* without executing any addon.

### Three separate identities (Model B)

1. **Graph identity** — `sha256` over the deterministically serialized package set. Runtime-independent.
   Answers "did dependencies change?"
2. **Runtime capability descriptor** — `{os, arch, abi, napi}` probed from a target `node` executable.
   Never mixed into graph identity.
3. **Artifact constraint set** — conjunction derived from artifact bytes, keyed by the artifact's own
   content hash. Empty for insensitive artifacts; explicit `unknown` on derivation failure, **never**
   an empty set (red-team Attack 2 vs D).

A compatibility check is evaluated per artifact and **reported per package**, because artifacts within
a package are alternatives across platforms and conjuncts within one:

- **applicable** — artifacts whose platform constraint (axis 0 alone) the runtime satisfies.
- **inert** — the rest; unused alternatives, not failures, never reported as findings.
- A package is **ok** iff it has at least one applicable artifact and every applicable artifact
  satisfies its full constraint set.

This was added during Phase 5, after `check` on an unmodified better-sqlite3 prebuild set reported 7
of 11 artifacts as broken. See [E004](../experiments/e004-vertical-slice.md) §2 and the amendment in
[the red-team](compatibility-models-redteam.md#amendment-e004--the-check-is-reported-at-package-level).

### Commands

| command | behaviour |
|---|---|
| `nexus ingest <dir>` | content-address a `node_modules` tree into the store, derive constraints, write `nexus-lock.json` + `nexus-compat.json` |
| `nexus materialize <dir> <dest>` | reconstruct the tree from the store by hardlink (`--copy` for a writable tree) |
| `nexus check [dir] [--runtime <exe>\|--target <spec>]` | evaluate all constraints against a probed runtime or a stated hypothetical one, explain every refusal, non-zero exit if incompatible |
| `nexus analyze <file...>` | single-artifact evidence dump: what was read, from which bytes, by which method |
| `nexus run [dir] -- <cmd...>` | `check` with `--verify`, then exec only if compatible; `--target` refused (see Consequences) |
| `nexus rebuild [dir]` | list packages needing rebuild — **dry-run always**; `--execute` is deliberately unimplemented |
| `nexus store` | store stats; states the append-only invariant |

Two options govern how much the tool trusts, and they are separate on purpose:

| option | question it answers |
|---|---|
| `--verify` | do not trust `nexus-compat.json`; re-derive every constraint from the artifact bytes |
| `--strict` | *additionally* refuse artifacts whose requirement axis is asserted from the absence of Node linkage rather than derived (implies `--verify`) |

They were one flag until [E006](../experiments/e006-adversarial-review.md), which is a defect: a gate
that wants to stop trusting an unauthenticated sidecar file should not have to adopt a stricter loading
policy to do it. `run` implies `--verify` and deliberately not `--strict` — distrusting a cache is a
gate's job, choosing a policy is the caller's. Re-deriving is affordable only because analyses are
content-cached, which is why the cost work in E006 had to land first.

`ingest` rather than a registry client: the project rules bar a full registry client unless necessary,
and it is not necessary to demonstrate the thesis. Resolution and fetching are SUBORDINATE; ingest
exercises the store, graph identity, materialization, and compatibility logic without them.

### Store layout

```
<store>/cas/<hh>/<sha256>                  immutable file blobs, mode 0444
<store>/analysis/<sha256>.<derivKey>.json  derived constraints, keyed by content AND derivation inputs
<store>/meta/                              cached N-API symbol map + header default (reproducibility)
<store>/tmp/                               staging for atomic temp+rename writes
```

Constraint derivation is a pure function of **(artifact bytes, N-API symbol map, header default)** — not
of the bytes alone. The first version of this store cached by content hash only, which would serve a
stale answer after the headers change: the same class of bug as keying a lockfile by the runtime, which
is the bug Nexus exists to diagnose. The cache key now covers every input, so a derivation performed
under different headers is a MISS rather than a silent stale hit, and the superseded entry is left in
place. Blobs are `0444` because materialized trees hardlink them: a writable shared inode would let one
project corrupt every other project that shares it.

### Invariants

- The store is append-only. Nothing already written is mutated.
- No command deletes store data. `rebuild` and any future `gc` default to dry-run.
- Serialization is deterministic: sorted keys, `\n` endings, stable number formatting.
- **Derivation failure yields `{kind:'unknown'}`, never `[]`.** `decide` refuses on `unknown`.
- **A derived cache is keyed on every input it depends on**, never on a convenient subset. A key that
  omits an input is the failure this project is about; it is not permitted inside the tool either.
- **The scope of a verdict is part of the verdict.** An artifact the tool did not examine is never
  allowed to look like one it approved: unexamined artifacts and self-excluded packages are counted and
  named alongside the answer, never folded into it and never silently dropped.
- Refusal is always explained with the specific constraint that failed and the runtime value it was
  compared against.

## Consequences

**Accepted, and now implemented.** Phase 5 built all seven commands and exercised each one; see
[E004](../experiments/e004-vertical-slice.md). Safe and precise on the measured corpus; no reliance on
a possibly-absent runtime API; produces a layout every existing tool understands; the expensive part
(derivation) is content-cached. The differentiation claim is demonstrated end to end on one unchanged
install: moving from Node 25 to Node 24 bumps the ABI 141 → 137, which invalidates an ABI-keyed
installation hash entirely, while Nexus rebuilds **1 package of 4** because N-API did not move.

**Costs and carried risks.** Requires a binary parser per container format, and parser coverage gaps
convert directly into spurious rebuilds. `ingest` is not a package manager — no resolution, no
fetching.

The red-team's former top risk — **libc flavour not derived** — is **closed** by
[E003](../experiments/e003-libc-derivation.md) (OS 48/48, libc 38/38, all four same-arch gnu/musl
pairs separated), and shows up in product output as `linux/x64/glibc` and `linux/x64/musl` being
distinct platforms.

The gating risk has narrowed from two container formats to one. [E005](../experiments/e005-elf-requirement.md)
derived the ELF requirement axis across six architectures — 37 of 48 artifacts read a declared value,
the remaining 11 floor at the header-derived `NODE_API_DEFAULT_MODULE_API_VERSION`, and **none** is left
`unknown` — validated with no Linux host by cross-architecture agreement (koffi declares 8 identically
across 13 builds and 6 architectures) plus cross-flavour agreement with the PE values E001 measured
against 291 real loads. **Mach-O is now the only format whose requirement axis is underived**, so Nexus
is *sound but unusable* on macOS alone. Two secondary gaps remain: minimum glibc *version* is still not
derived, which is the one known false-negative hole and is Linux-only; and raw-V8 **ELF** addons refuse
by construction, because the local corpus contains none and an unvalidated struct reader that returns a
plausible number is worse than a refusal.

Nexus can now answer a question about a runtime that is not present, via `--target
<os>/<arch>[/<libc>]:<abi>:<napi>`. This is not a convenience feature — it is a direct consequence of the
central design choice. Because a constraint is recorded runtime-free, deciding it against a hypothetical
runtime is the same operation as deciding it against a probed one, which is how the ELF *decision* path
is exercised from a Windows host at all. Every axis is required and nothing is defaulted: a filled-in
axis would silently answer a question about a different runtime than the one asked. `nexus run --target`
is refused — there is nothing to exec, and falling back to the host runtime would mean the gate checked
one runtime while the command ran on another.

**Phase 7 attacked the product rather than the derivation, and that distinction is the finding.**
[E006](../experiments/e006-adversarial-review.md) found five defects and fixed all five — and **none was
in the derivation.** Every constraint derived from every artifact was correct throughout. The failures
were in cost (a whole-tree content address to answer a two-artifact question: 26.4 s → 0.49 s, and a
128k-file tree from not-finishing-in-120 s to ~5 s), in trust (a forged `nexus-compat.json` produced a
wrong OK that `run` would have executed on), and three times over in **scope** — which artifacts the tool
looked at, and whether it was honest about the ones it did not. Two scope defects were silent coverage
gaps: `check` reporting a clean OK for a tree holding 17 unexamined addons, and a nested
`<pkg>/dist/node_modules/` subtree claimed by neither walk, which swallowed 34 of 80 `.node` files while
reporting `unexamined: 0`. The third was the inverse: once those artifacts became visible, the tool
refused a working install, and 6 of 6 refusals were false positives from packages that declare
`os: ["linux"]` in their own manifest.

The lesson generalises past this codebase: the zero-false-negative posture cannot stop at the parser. An
artifact never examined is a false negative just as surely as one misjudged, and the honest response to a
gap the tool cannot close is to report the verdict's *scope* rather than let the caller assume it.

Two carried risks were added rather than closed by this work: a plain `check` still trusts an
unauthenticated compat file (`--verify` and `run` do not), and package exclusion rests on
`os`/`cpu`/`libc` metadata — the one point where a verdict does not rest on derived bytes, bounded by the
fact that it can only turn a refusal into a reported exclusion and that the failure it could mask is a
catchable `ERR_DLOPEN_FAILED` rather than a segfault.

**Explicitly not in the POC:** registry client, dependency resolution, hook-based resolution,
environment activation, GUI, Node version management. `rebuild --execute` is also out of scope — this
POC decides *what* needs rebuilding; invoking a toolchain does not test the thesis.
