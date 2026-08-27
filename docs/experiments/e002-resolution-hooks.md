# E002 — Which Node entry points does `module.registerHooks()` actually serve?

**Date:** 2026-08-27 · **Host:** Windows 11, `win32/x64` · **Status:** concluded, resolution confirmed subordinate

## Hypothesis

A no-`node_modules` resolver can be built on `module.registerHooks()` if and only if that hook serves
*every* path by which dependency code reaches the module system. **[RC]** `RESEARCH.md` asserts that
some `require.resolve`-family entry points bypass the hook on Node 22.x. This experiment measures the
bypass set directly, on all three runtimes available.

## Setup

A resolve hook is registered for the specifier `nexus-virtual-pkg`, which exists in no
`node_modules` directory anywhere on the machine. If an entry point is served by the hook it returns
the virtual target; if it bypasses the hook it fails to resolve. There is no ambiguity in the signal —
absence of the package on disk is what makes the test sharp.

Six entry points probed: `require`, `require.resolve`, `createRequire().resolve`,
`import.meta.resolve`, `Module.findPackageJSON`, and dynamic `import`.

## Commands

```bash
for exe in node22 node24 node25; do "$exe" experiments/e002-hooks/hooktest.mjs; done
```

## Result

**Node 22.13.1 (ABI 127): `module.registerHooks` does not exist.**

```
runtime: v22.13.1 ABI127
module.registerHooks: NOT AVAILABLE on this runtime
```

**Node 24.11.1 (ABI 137) and Node 25.1.0 (ABI 141): identical behaviour.** 3 hook invocations for 6
entry points.

| entry point | served by hook? | failure code when bypassed |
|---|---|---|
| `require(spec)` | **SERVED** | — |
| `import.meta.resolve(spec)` | **SERVED** | — |
| dynamic `import(spec)` | **SERVED** | — |
| `require.resolve(spec)` | BYPASS | `MODULE_NOT_FOUND` |
| `createRequire().resolve(spec)` | BYPASS | `MODULE_NOT_FOUND` |
| `Module.findPackageJSON(spec)` | BYPASS | `ERR_MODULE_NOT_FOUND` |

## Conclusion

The hypothesis fails on two counts, one of them stronger than the research indicated.

1. **The API is absent on Node 22 LTS** (v22.13.1). A resolver built on it cannot support Node 22 at
   all — not degraded, not slower: unavailable. `RESEARCH.md` discussed the bypass set on 22.x without
   noting that `registerHooks` may not be present in a given 22.x patch release.
2. **Even where available, the bypass set is fatal for the intended purpose.** `require.resolve` is
   ubiquitous in build tooling, plugin loaders, and monorepo path resolution. Any dependency calling it
   escapes the virtual table and sees the real filesystem — so a no-`node_modules` install would work
   until some transitive package asks where a file actually is, then fail in a way the resolver cannot
   intercept.

Half of the entry points a real dependency graph uses are unreachable from the hook, on the two
runtimes where the hook exists at all.

This independently confirms the architectural priority the project set: **resolution stays
subordinate**. The compatibility work in [E001](./e001-native-artifact-compatibility.md) requires no
runtime hooks, no API that might be missing from an LTS release, and works identically on all three
runtimes. Resolution via `registerHooks` is a portability liability; artifact-level compatibility
analysis is not. The POC therefore uses real directory layouts and treats hook-based resolution as an
explicitly experimental, non-load-bearing extension.

## Limitations

1. Three runtimes on one host. `registerHooks` may exist in later 22.x patch releases — the finding is
   that a *shipping, current* 22 LTS build lacks it, not that all of 22.x does.
2. Only the `resolve` hook was probed. A `load` hook may have a different serving surface.
3. The bypass set was measured for a *missing* specifier. Whether hooks are consulted for specifiers
   that also exist on disk, and which wins, was not tested — irrelevant for the no-`node_modules`
   question, relevant if hooks were ever used for override or interposition.
