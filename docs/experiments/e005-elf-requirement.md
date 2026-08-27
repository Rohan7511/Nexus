# E005 — Is the N-API requirement derivable from an ELF artifact, from a Windows host?

**Date:** 2026-08-27 · **Host:** Windows 11, `win32/x64` · **Status:** concluded, derivation confirmed

## Why this experiment exists

[E001](./e001-native-artifact-compatibility.md) established that the *declared* N-API minimum decides
loadability (291/291 measured cells, versus 288/291 for the import floor) and that it is statically
readable — but only for **PE**. [E003](./e003-libc-derivation.md) then extended the *platform* axis to
ELF, deriving `{os, arch, libc}` correctly across 48 artifacts.

That left the system in a lopsided state, recorded as carried risk 0 in the
[red-team](../architecture/compatibility-models-redteam.md):

> the requirement axis is derived for PE only; on ELF and Mach-O every N-API artifact returns
> `unknown`, which refuses. Safe, but **unusable** — a Linux install would be reported as
> uncheckable rather than checked.

A tool that answers "I cannot tell" for every Linux artifact is not a compatibility checker. This
experiment attacks that, under the awkward constraint that the measurement host is Windows: there is no
Linux runtime here to `dlopen` anything, so the usual ground truth is unavailable.

## Hypothesis

The declared N-API minimum is recoverable from a stripped ELF `.node` artifact's bytes across every
architecture that real packages ship for — and that recovery can be **validated without a Linux host**,
by exploiting agreement between independent artifacts that must declare the same value.

## Oracles

No load matrix is available, so correctness has to come from consistency constraints that a wrong
decoder would violate. Two were used.

**O1 — cross-architecture agreement.** One package version's prebuilds are compiled from one source
tree. Whatever `NAPI_VERSION` that source declares, every architecture's build must declare it. Six
*independently written* per-architecture decoders agreeing on one value is strong evidence that all six
are right: an arm64 decoder misreading a `movz` immediate has no reason to land on the same number the
x64 decoder reads out of a `mov eax, imm32`.

**O2 — cross-flavour agreement with validated ground truth.** Several packages ship both ELF and PE
prebuilds of the same version. The PE side's value is *not* an assumption — E001 measured it against
291 real load outcomes. So `elf == pe` transfers established ground truth onto the ELF path.

Grouping is by **`(package name, version, component)`**, not by package alone (see
[Bugs this surfaced](#three-bugs-this-surfaced) — the first version of this was wrong).

These oracles validate **derivation**. They say nothing about the loading direction on Linux; that
limitation is stated below, not papered over.

## Method

`src/artifact/elf-addon.mjs` + `src/artifact/code-imm.mjs`:

1. **Read `.dynsym`.** The loader-visible symbol table survives stripping, which every shipped prebuild
   has been through; `.symtab` does not. `shndx !== 0` distinguishes *defined* from *imported*.
2. **Classify.** `node_module_register` imported ⇒ raw-V8. `node_api_module_get_api_version_v1` or
   `napi_register_module_v1` defined ⇒ N-API. Any imported `napi_*`/`node_api_*` ⇒ N-API.
3. **Locate the declaring function.** Take the defined `node_api_module_get_api_version_v1` symbol's
   `st_value` (a virtual address), normalise it, and map it to a file offset through the section table,
   skipping `SHT_NOBITS`.
4. **Decode the constant return.** The function is `return <constant>;`, so it compiles to "load
   immediate into the return register, return". Decode that shape per architecture.
5. **Fall back, never guess.** No declaring symbol ⇒ combine the import floor with the
   header-derived default via `max()`. Unreadable code shape ⇒ `null` ⇒ an explicit `unknown`
   constraint, which refuses.

### The six encodings

Each decoder anchors on the **return instruction** and refuses on ambiguity.

| arch | load immediate | return | notes |
|---|---|---|---|
| x64 / ia32 | `b8 imm32` (`mov eax, imm32`) | `c3` | tolerates a `5d`/`c9`/`5b` epilogue between them; `31 c0`/`33 c0` + `c3` ⇒ 0 |
| arm64 | `0x52800000 \| imm<<5` (`movz w0, #imm16`) | `0xd65f03c0` | fixed 4-byte stride |
| arm | `0x20xx` (`movs r0, #imm8`, Thumb-2) | `0x4770` (`bx lr`) | function address has **bit 0 set** |
| riscv64 | `c.li a0` — `(h & 0xef83) === 0x4501`; or `addi a0,zero,imm` — `(w & 0x000fffff) === 0x00000513` | `0x8082` (`c.jr ra`) or `0x00008067` | mixed 2/4-byte encodings; sign-extend |
| loong64 | `addi.w`/`addi.d`/`ori $a0,$zero,imm` — `(w & 0xffc003ff) === 0x02800004`/`0x02c00004`/`0x03800004` | `0x4c000020` | |

## Commands

```bash
node experiments/e005-elf-requirement/run.mjs   # the experiment
node test/regress-e005.mjs                      # the same oracles against shipped src/
```

## Result

48 distinct ELF `.node` artifacts (content-hash deduped), all classified `n-api`:

| axis | breakdown |
|---|---|
| arch | x64 22, arm64 14, ia32 6, arm 2, loong64 2, riscv64 2 |
| os/libc | linux/glibc 28, linux/musl 10, freebsd 6, openbsd 4 |
| method | `const-return:` x64 15, arm64 10, ia32 6, arm 2, loong64 2, riscv64 2; `absent` 11 |

**O1 — 6 agree, 0 disagree** (7 groups had a single build, not comparable). Of the comparable groups,
5 span two or more architectures:

```
better-sqlite3@13.0.1        declared=10  over  2 builds, 1 arch
better-sqlite3@13.0.3        declared=10  over  4 builds, 2 arches
copilot@1.388.0:nodesqlite3  declared=6   over  2 builds, 2 arches
copilot@1.388.0:vscodepolicywatcher declared=8 over 2 builds, 2 arches
koffi@2.16.1:koffi           declared=8   over 13 builds, 6 arches
koffi@2.16.3:koffi           declared=8   over 13 builds, 6 arches
```

koffi is the load-bearing case: **one declared value read identically out of 13 builds across all six
architectures**, twice, at two versions.

**O2 — 6 agree, 0 disagree** (`elf=10 pe=10`, `elf=6 pe=6`, `elf=8 pe=8` ×4). Every ELF value that has
a PE sibling matches a value E001 verified against real loads.

**Coverage of the shipped derivation:**

```
declared value read : 37/48
requirement source  : declared=37  header-default(WEAK)=11
still unknown       : 0
declared present but unread : 0
```

Zero artifacts refuse for want of a readable requirement — the point of the exercise. And no artifact
has a declaring symbol the decoders failed to read, so the residual 11 are genuinely non-declaring, not
decode failures.

## The napi-rs false-negative hole, and how it closed

11 of 48 artifacts declare nothing. Two shapes:

- **onnxruntime-node** — imports `napi_*` symbols; import floor **1**.
- **wreq-js** (napi-rs/Rust) — defines `napi_register_module_v1` but imports **zero** `napi_*` symbols,
  because napi-rs links the N-API entry points through a generated shim. Import floor **0**.

An import floor of 0 or 1 is an *accept-anything* constraint. That is a false negative of exactly the
shape this project treats as unacceptable — the artifact would be waved through onto a runtime older
than it supports.

The fix is not a heuristic. `NODE_API_DEFAULT_MODULE_API_VERSION` is read out of the local
`node_version.h`, currently **8**: it is what Node itself assumes when a module declares nothing, so it
is a *derived* floor, not a guess. The requirement becomes `max(importFloor, headerDefault)`, tagged
`header-default(WEAK)` or `import-floor(WEAK)` so the weaker provenance stays visible in output.

Derived finding: on this corpus the header default **dominates** for all 11 — no ELF import floor
exceeds 8. And re-scoring E001's 291 measured cells with the default in the production path leaves the
result unchanged (**291/291, FN 0, FP 0**, `test/regress-e001.mjs`), so the stronger floor costs nothing
in false positives against everything actually measured.

## Three bugs this surfaced

1. **OpenBSD retguard defeated proximity matching.** koffi's `openbsd_x64` build puts ~26 bytes of
   return-address cookie check and `int3` padding between the immediate and the `ret`, so requiring them
   to be adjacent read nothing. Fixed with two tiers: tier 1 requires a near `ret` (the common shape);
   tier 2 accepts a lone `b8 imm32` provided the function contains a `ret` anywhere in the window.
   Differing immediates still refuse, so a stray `b8` costs a false *positive*, never a false negative.
2. **A grouping bug in my own oracle, which briefly manufactured a disagreement.** Grouping by
   `(package, version)` put `copilot`'s two bundled addons — `nodesqlite3` (declares 6) and
   `vscodepolicywatcher` (declares 8) — in one group and reported them as a decoder disagreement. They
   are separate components that legitimately declare different values. Fixed by adding a component key
   derived from the artifact path with platform tokens stripped. Worth recording: the first instinct on
   seeing a disagreement was to distrust the decoder, and the oracle was at fault.
3. **ARM address bit 0.** Thumb function addresses carry bit 0 set. Masking it unconditionally reads one
   byte early on other architectures — which is how sharp's `b8 09 00 00 00 c3` first appeared as
   `ff b8 09 ...`. `normalizeFuncAddr` now masks for `arm` only, and a test pins that asymmetry.

## What this changed in the product

- **ELF requirement axis is live.** `nexus analyze` on real prebuilds: koffi `linux_x64` →
  `N-API >= 8 (declared)` via `const-return:x64` with `DT_NEEDED libstdc++.so.6 libm.so.6 libgcc_s.so.1
  libc.so.6`; better-sqlite3 `linux-arm64` → `N-API >= 10 (declared)` via `const-return:arm64`;
  wreq-js `linux-x64-gnu` → `N-API >= 8 (header-default(WEAK))`, evidence `import floor 0, header
  default 8, 0 napi symbols`.
- **`--target`, a hypothetical runtime** (`<os>/<arch>[/<libc>]:<abi>:<napi>`). Because a constraint is
  recorded runtime-free by construction, a stored analysis can be decided against a runtime that is not
  on this machine — the only way to exercise the ELF *decision* path from here. Every axis is required;
  nothing is defaulted, because a filled-in axis would silently answer a question about a different
  runtime. `nexus run --target` is refused by design: there is nothing to exec, and executing under the
  host runtime instead would mean the gate checked one runtime while the command ran on another.
- **The analysis cache key was wrong, and this is the project's own thesis turned on itself.** Derived
  constraint sets were cached under the artifact's content hash alone — but a derivation is a pure
  function of *(bytes, symbol map, header default)*. A key covering only the bytes serves a stale answer
  after the headers change: the same class of bug as keying a lockfile by the runtime, which is the bug
  Nexus exists to diagnose. Entries are now addressed `analysis/<sha>.<derivationKey>.json`, and
  superseded entries are left in place — never rewritten, never deleted.
- **`nexus analyze` never printed its evidence lines**, because it read `r.evidence?.*` while
  `assemble()` spreads evidence onto the record. Fixed; the evidence is how a `(WEAK)` provenance
  becomes visible at all.

Cross-platform prediction, demonstrated from this Windows host on a tree of three real Linux prebuilds:

```
--target linux/x64/glibc:137:10  -> OK, 3/3 applicable
--target linux/x64/glibc:127:9   -> INCOMPATIBLE, 1 package:
                                    better-sqlite3 needs N-API >= 10, runtime provides 9
                                    (would segfault); 2 of 3 fine
--target linux/x64/musl:137:10   -> all 3 refused: object is linux/x64/glibc, host is musl
--target linux/arm64/glibc:137:10-> all 3 refused: object is linux/x64, host is linux/arm64
```

The middle case is the differentiation claim on the ELF path: **one** of three packages is invalidated
by the runtime change, not all three and not none — and the refusal is grounded, because
better-sqlite3's declared 10 is the value O2 tied to E001's measured PE loads.

## Conclusion

The hypothesis holds. The declared N-API minimum is derivable from stripped ELF artifacts across six
architectures, with zero disagreements against both oracles and zero artifacts left unreadable, and it
was validated without a Linux host. Carried risk 0 narrows from "the requirement axis works on PE only"
to **Mach-O only**.

## Limitations

1. **Derivation, not loading — still.** Same gap as E003, and the honest ceiling on this work: that a
   correctly-derived Linux artifact actually loads (and that an N-API-too-new one actually segfaults) on
   a Linux host is unmeasured. O2 transfers *measured* ground truth for the six packages that ship both
   flavours; it does not remove the need for a Linux load matrix.
2. **O1 proves agreement, not truth.** Six decoders agreeing rules out independent errors, not a shared
   systematic one. O2 is what rules that out, and it covers only 6 of 13 groups.
3. **Raw-V8 ELF deliberately refuses.** All 48 local ELF artifacts are N-API, so a `node_module` struct
   reader for ELF would ship with no validation evidence whatsoever. It returns `unknown` instead. An
   untested parser returning a plausible number is the exact false-negative source this project cannot
   afford — but this *is* a coverage gap, and raw-V8 ELF addons exist in the wild.
4. **Minimum glibc version still not derived.** `GLIBC_2.xx` version tags are present in `.dynstr`
   (E003 limitation 4). Until they are read, a glibc artifact built against a newer glibc than the host
   provides is a known false negative — Linux-only, and the last one in the platform axis.
5. **`header-default(WEAK)` is a floor, not the truth.** For the 11 non-declaring artifacts the real
   requirement could be higher than 8; the default is what Node *assumes*, which is what decides
   loading, so it is correct for the load question — but it is not evidence about what the source
   actually needs.
6. **Decoders are corpus-fitted.** They recognise the shapes these 48 artifacts happen to contain. A
   different compiler or optimisation level could emit a shape none of them recognise; that path returns
   `unknown` and refuses, which is safe but is a false positive.
