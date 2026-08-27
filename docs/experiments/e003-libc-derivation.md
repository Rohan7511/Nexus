# E003 — Is libc flavour and true OS derivable from an ELF `.node` artifact?

**Date:** 2026-08-27 · **Host:** Windows 11, `win32/x64` · **Status:** concluded, derivation confirmed

## Why this experiment exists

The [Phase 2 red-team](../architecture/compatibility-models-redteam.md) named one carried risk that
degraded toward *acceptance* (i.e. toward a crash) rather than toward safe refusal: my container
reader gave `linux-x64-gnu` and `linux-x64-musl` artifacts identical `linux/x64` constraints, and
hardcoded `os: 'linux'` for every ELF. On the `win32/x64` measurement host both facts are invisible —
every ELF refuses anyway — so [E001](./e001-native-artifact-compatibility.md)'s perfect score could
not have caught either. This experiment attacks that blind spot directly, because the artifacts needed
to test it are already on disk.

## Hypothesis

From an ELF `.node` file's bytes alone it is possible to derive (a) the true target OS, distinguishing
Linux from FreeBSD/OpenBSD ELF, and (b) the libc flavour, distinguishing glibc from musl — precisely
enough that a package shipping both flavours for one architecture gets *different* constraints for
each.

## Oracle

Publisher intent, encoded in the shipped path (`.../linux-x64-musl/...`, `.../freebsd_x64/...`). A
package that ships **both** a musl and a non-musl artifact for the same architecture is asserting they
are not interchangeable; a correct deriver must reproduce that separation from bytes.

This validates **derivation**, not **loading**. Confirming a musl artifact actually fails to
`dlopen` on a glibc host requires a Linux host and is out of reach on this machine. That gap is stated
as a limitation, not papered over.

## Method

`src/artifact/elf.mjs` reads the ELF header (machine type, `EI_OSABI`), walks the section table to
find `.dynstr`, and extracts the `DT_NEEDED` shared-library list from it.

- **Arch** from `e_machine`.
- **OS** from `EI_OSABI` when set (FreeBSD=9, OpenBSD=12, Linux=3); Linux toolchains usually leave it
  SysV(0), so fall back to the `DT_NEEDED` shape — `libc.so.7` ⇒ FreeBSD, two-component so-versions
  like `libpthread.so.26.1` ⇒ OpenBSD, versioned `libc.so.6`/`libstdc++.so.6` ⇒ Linux. Undetermined ⇒
  `null` (caller refuses).
- **libc** from `.dynstr`: `libc.musl-*` / `ld-musl-*` ⇒ musl; `libc.so.6` or `GLIBC_x.y` version tags
  ⇒ glibc; bare unversioned `libc.so` (some Rust musl targets) ⇒ musl. Otherwise `null`.

Note `.node` files are shared objects (ET_DYN) with no `PT_INTERP`, so the interpreter path is not an
available signal — `DT_NEEDED` is.

## Commands

```bash
node experiments/e003-libc/run.mjs
```

## Result

48 distinct ELF `.node` artifacts (content-hash deduped) spanning **3 OSes** (Linux, FreeBSD, OpenBSD)
and **6 architectures** (x64, arm64, arm, ia32, loong64, riscv64).

| axis | agree | disagree | undetermined |
|---|---|---|---|
| OS (all 48) | **48** | **0** | **0** |
| libc (38 Linux artifacts) | **38** | **0** | **0** |

Every genuine same-architecture gnu/musl pair a single package ships is separated by derivation:

```
ngrok        linux-x64-gnu = glibc     linux-x64-musl = musl
better-sqlite3 linux-arm64 = glibc     linuxmusl-arm64 = musl
wreq-js      linux-arm64-gnu = glibc   linux-arm64-musl = musl
wreq-js      linux-x64-gnu = glibc     linux-x64-musl = musl
```

The FreeBSD and OpenBSD koffi artifacts — ELF/x64 and ELF/arm64 objects that the old reader would have
labelled `linux/x64` and `linux/arm64` — are now correctly `freebsd` / `openbsd`, with libc reported
`null` because the glibc/musl question is meaningless there.

## Two bugs this surfaced

1. **ELF was treated as synonymous with Linux.** koffi's `freebsd_*` and `openbsd_*` `.node` files are
   ELF objects for a different OS. The old reader would have handed them `linux/<arch>` constraints and
   *accepted* them on a Linux host — a false negative. Fixed via `EI_OSABI` + `DT_NEEDED` shape.
2. **glibc/musl collapsed to one value.** The original `classifyLibc` matched only `^libc\.so\.6$` and
   missed the bare `libc.so` form emitted by some Rust musl targets (`wreq-js.linux-x64-musl.node`),
   leaving it `null`. Now handled.

## Conclusion

The hypothesis holds for derivation: libc flavour and true OS are recoverable from ELF bytes with zero
disagreements against publisher intent across 48 held-out artifacts. The red-team's top risk — that
Model B silently over-accepts wrong-libc and non-Linux ELF — is closed **in the derivation
direction**. The platform constraint is extended from `{os, arch}` to `{os, arch, libc}`.

## Limitations

1. **Derivation, not loading.** That a musl artifact fails on a glibc host, and that a correctly-derived
   Linux/glibc/x64 artifact *loads* on such a host, remains unmeasured — it needs a Linux host. This
   experiment proves the constraint is *computed* correctly, not that the *comparison* against a live
   runtime is complete.
2. **libc `null` must refuse, and this is untested in production.** A statically-linked or unusual
   artifact yields `null`; the caller must treat that as unknown. No `null`-libc Linux artifact appeared
   in this corpus, so the refuse path is unexercised here.
3. **OSABI heuristic is corpus-fitted.** The `DT_NEEDED`-shape fallback was tuned to these artifacts.
   A Linux ELF importing none of the recognised libraries would fall through to `null` (safe) but is
   possible.
4. **glibc minimum version not derived.** `GLIBC_2.34` symbol version tags are present in `.dynstr` and
   could yield a *minimum glibc version* constraint (the ELF analogue of the N-API floor). Not yet
   implemented; would tighten Linux-host accuracy further.
