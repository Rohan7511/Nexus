# A Conda-Like Environment Manager for JavaScript

**A critical technical evaluation of the Nexus concept**

Prepared 2026-08-25 · Evaluation only; no code committed to this repository yet

---

## Contents

| § | Section | What it establishes |
|---|---|---|
| [0](#0-verdict-first) | Verdict first | PIVOT, and the one-paragraph reason |
| [1](#1-methodology-and-an-important-limitation) | Methodology | Confidence levels; what was verified by construction, and the seven figures the review pass retracted |
| [2](#2-npm-internals) | npm internals | Arborist's two-tree model; the cache is a *download* cache, not a store |
| [3](#3-pnpm-internals) | pnpm internals | Per-*file* CAS; how much of the idea is already shipped |
| [4](#4-yarn-plugnplay-and-what-is-newly-possible-in-2026) | Yarn PnP | Table resolution rebuilt from scratch; Yarn coupled two separable decisions |
| [5](#5-the-asymmetry-that-governs-everything) | The asymmetry | `sys.path` list vs directory walk — why Conda's model does not transfer |
| [6](#6-pip-conda-and-the-modern-successors) | pip, Conda, uv, pixi | uv and pixi already did this for Python; measured 387 MB → 79 MB |
| [7](#7-comparison) | Comparison matrix | 20 dimensions across six tools, then read closely |
| [8](#8-is-it-already-solved-an-adversarial-pass) | Adversarial pass | 8 of 10 capabilities already delivered; "Conda for JS" is misleading |
| [9](#9-the-gap-and-the-five-proposed-differentiators) | The gap + differentiators A–E | Runtime identity is missing everywhere; 2 of 5 differentiators cut |
| [10](#10-architecture) | Architecture | Revised layering, storage per OS, three resolution approaches, language |
| [11](#11-the-environment-model) | Environment model | Three artifacts, two-level hash, ABI-keyed `built/` tier, roots registry |
| [12](#12-proof-of-concept-and-benchmarks) | PoC + benchmarks | The demo competitors fail; how not to lie with `du` |
| [13](#13-what-to-build-first-and-how-to-launch-it) | What to build first | Milestones, scope cuts, naming problem, kill criteria |
| [14](#14-final-verdict) | Final verdict | The seven required answers |
| [15](#15-verify-before-acting) | Verify before acting | Seven sources to check, and which would change the verdict |

**Reading paths.** For the decision only: §0, §8, §14. To design and build: §9.4, §10, §11, §13.
To challenge the conclusion: §5, §8.7, §15.3.

---

## 0. Verdict first

**Is it technically possible?** **Yes** — and not speculatively. Over the course of this
evaluation a working content-addressed store, a precomputed resolution table, and a
combined CJS+ESM resolver were built by hand and measured. A Node project with *no
`node_modules` directory anywhere on disk* successfully loaded packages from a
content-addressed store, resolved their transitive dependencies, selected different
`exports` conditions for `require` versus `import`, held two versions of the same package
live simultaneously, and loaded a real gcc-compiled N-API native addon. Two projects shared
one store with different pins and no duplicated bytes.

**Is the original idea novel?** **Mostly already solved.** Of the ten capabilities listed
as the project's core technical question, nine are delivered today, most of them by pnpm
alone. The tenth — Conda-style named, shared, activatable environments — is the one thing
nobody has built for JavaScript, and the research says that is because it is a bad fit for
the language, not because it is hard. Python's own ecosystem is migrating away from it.

**So the honest headline is uncomfortable:** the part of Nexus that is novel is the part
that should be cut, and the part that is valuable is largely pnpm.

**But there is a real gap, and it is precise.** Every existing JavaScript tool keys an
installed dependency tree on the *package graph alone*. None of them key it on
`(package graph × Node ABI × platform × build inputs)`. The consequence is a bug every
Node developer with native dependencies has hit and nobody has fixed at the architectural
level: switch Node majors and your installed tree is silently, invisibly wrong. The
lockfile still validates. Nothing warns you. A `.node` binary compiled against
`NODE_MODULE_VERSION 127` simply fails to load, or worse, a postinstall-generated artifact
is subtly mismatched. `nvm`, `fnm`, `Volta` and `mise` pin the runtime *outside* the
resolver; `engines` is advisory; `packageManager` pins the package manager and not the
runtime. The runtime dimension is missing from the identity of every installed tree in the
ecosystem.

**Recommendation: PIVOT.** Not GO, because "Conda for JavaScript" as specified is a
reimplementation of pnpm plus a misfeature. Not NO-GO, because there is a defensible,
differentiated, measurable core: a runtime-and-ABI-aware, content-addressed, table-resolved
install layer that eliminates `node_modules` entirely rather than symlinking it. The
detailed argument follows; §14 states the final verdict in the requested format, and
§13 lists what to build first.

One caution stated early because it is the strongest argument against the whole project:
**the ABI problem is shrinking, not growing.** N-API stabilised the native ABI across Node
versions, and the modern ecosystem ships prebuilt platform binaries via
`optionalDependencies` rather than compiling at install time. The gap identified above is
real, but its addressable market is narrowing every year. That is weighed honestly in §9.

---

## 1. Methodology, and an important limitation

### 1.1 What was verified and what was not

This evaluation had **no network access**. Web search was unavailable for this model and
HTTP egress was restricted to a single unrelated host. That is a material limitation and it
is flagged inline throughout rather than hidden.

The response was to verify *mechanisms empirically* instead of citing documentation. A Linux
sandbox with Node v22.22.3, npm 10.9.8, Python 3.10.12 and uv 0.11.19 was used to build
working models of every architecture under discussion — including a local npm registry
serving hand-authored tarballs, a byte-faithful replica of pnpm's store-and-symlink-farm
layout, a hand-written zip filesystem with an `fs` patch, four different resolver
implementations, and a compiled N-API addon. Where a claim below is followed by command
output, that output is real.

Three confidence levels are used:

**VERIFIED** — observed directly in the sandbox this session, with command output.
Mechanism facts in this category are stable and will not change with tool versions.

**[recalled]** — from training knowledge, not verified this session. Architectural
descriptions in this category are reliable in shape; specific version numbers, defaults and
current project status are not.

**[UNVERIFIED — CHECK]** — version-specific or liveness-specific claims that materially
affect the verdict and could not be checked. §15 collects these into a checklist.

### 1.2 Why this limitation matters less than it appears

The questions that decide this project's fate are mostly *mechanism* questions, and
mechanisms did not change between May 2025 and today. Node's module resolution algorithm,
hard link and reflink semantics, `EXDEV`, content-addressed storage design, the
`sys.path`-versus-directory-walk asymmetry, and the way peer dependencies force
duplication are all architecturally stable. Those are precisely the things that were
verified.

What genuinely remains uncertain is competitive: whether a specific project shipped this
idea in the last fifteen months. §15 lists the seven URLs that would settle it. The
verdict below is robust to most outcomes of that check but not all, and §15 says which.

### 1.3 Note on one sandbox artifact

The sandbox had Node v22.22.3 and npm 10.9.8. npm 11 shipped with Node 24 in April 2025
[recalled], so the sandbox is somewhat behind current. This affects claims about npm's
*current* behaviour but not the architectural findings, which concern designs that have been
stable for years. Where a newer Node version might change a result — notably the stability
level of `module.registerHooks` — it is flagged.

### 1.4 The adversarial review pass, and what it retracted

Because a `VERIFIED` label is worthless if it is applied loosely, every empirical claim in this
report was independently re-measured by two reviewers working from fresh fixtures, with a mandate to
disprove rather than confirm. Both scopes — filesystem and quantitative claims, then Node runtime and
resolution claims — were run without access to the original fixtures. The mechanism findings all
survived. Seven numbers did not, and every one of them had erred in the project's favour, which is
the direction that matters:

| Retracted | Was | Now | Why it was wrong |
|---|---|---|---|
| Resolution time win | 3.6× (10 ms vs 36 ms) | **1.6× (11.8 ms vs 7.4 ms)** | did not reproduce |
| Naive-resolver syscalls | 55 vs 56, "no win at all" | **naive wins ~2× on syscalls; loses 866 ms vs 163 ms on time** | not reproducible under five constructions; the conclusion survives for a different reason |
| Hook re-entrancy | "613 spurious errors" | **678 nested invocations, one `RangeError`** | miscount, apparently from a different experiment |
| Lockfile runtime grep | "(no output)" | same, but **only after narrowing the pattern** | the bare word `modules` matches every `node_modules/…` key; the original ran against a zero-dependency fixture |
| `engines` violation | "no error, no warning" | **prints `npm warn EBADENGINE`, exit 0** | the warning exists; only enforcement is absent |
| Python C extensions | "categorically impossible" | **possible with distinct `.so` paths + cache eviction; never happens by accident** | the linker is not the barrier; the packaging system is |
| `.pyc` overhead | "roughly 100%" | **17–25% of the installed tree** | generalised from one synthetic data-heavy module |

Three further claims were overstated in ways a corrected number cannot capture, because the error
was in the framing rather than the measurement. `0444`
store files are a speed bump rather than a barrier — the holder of a hard link can `chmod` its own
link and write through, and npm's bundled `bin-links` `chmod`s every package binary it installs
(§10.2). The 4.9× disk figure is arithmetically forced by using five identical environments, since
the ratio is 1 − 1/N, so the absolute pair is the only honest way to quote it (§6.1). And the
resolution table cannot be O(1) in the shape originally specified: serving a bare specifier from a
directory-plus-edges map still requires reading the target's `package.json`, and a faithful
implementation measured 5.3× *slower* than `node_modules`, which is corrected in MVP-SPEC §3.3 by
requiring entry files to be pre-expanded at install time.

Two facts were added that neither draft contained and that change the engineering: a **syscall floor**
no table can cross, because Node still stats the nearest `package.json` per package to decide CJS
versus ESM (naming pre-resolved entries `.cjs` collapses it to one syscall), and the **base64
integrity problem** — 74% of sha512 digests contain a `/`, so a registry integrity value can never
be used as a path component (MVP-SPEC §1.1).

The lesson generalises past this report. Every retraction above inflated the project's case, none
diminished it, and none was deliberate. That is what measurement bias looks like from the inside,
and it is the argument for §12.3's rules being enforced by the harness rather than by good
intentions.

---

## 2. npm: internals

### 2.1 The two-tree model

npm's installer is Arborist, and its central design is that installation is a *diff between
two trees* rather than a sequence of downloads. `buildIdealTree` constructs the tree that
*should* exist; `reify` makes the filesystem match it. VERIFIED pipeline, from the installed
copy of `@npmcli/arborist` 8.0.5:

```js
await this.#initTree()               // load root package.json + actual tree
await this.#inflateAncientLockfile() // upgrade lockfileVersion 1 metadata
await this.#applyUserRequests(options)
await this.#buildDeps()              // the placement loop
await this.#fixDepFlags()            // dev/optional/peer transitive flags
await this.#pruneFailedOptional()
await this.#checkEngineAndPlatform() // engines, os, cpu
```

`#buildDeps` is a worklist, not a recursion. Each iteration resolves one node's edges, and
when placing a dependency invalidates an already-processed node, that node's dependents are
**pushed back onto the queue**. Placement iterates to a fixpoint. Nodes are sorted by name
before placement so the result is deterministic.

Placement itself implements one rule: for each unsatisfied edge, walk up the ancestor chain
from the dependent and find the *shallowest directory where this version can live without
displacing an incompatible existing node*. Hoisting is not a separate pass. It is an
emergent property of that single rule.

Reify is a staged transaction with rollback. Rather than staging outside the tree, npm
*retires* paths by renaming them in place — VERIFIED, the entire mechanism:

```js
const retirePath = from => {
  const d = dirname(from); const b = basename(from)
  const hash = pathSafeHash(from)          // sha1, base64, alnum-only, 8 chars
  return resolve(d, `.${b}-${hash}`)
}
```

`node_modules/foo` becomes `node_modules/.foo-A1b2C3d4` before replacement, and a rollback
chain moves it back on failure. Lifecycle scripts and bin linking happen in the final step,
after all unpacking.

### 2.2 The cache is a download cache, not a package store

This is the single most consequential fact about npm, and it is the reason npm cannot
deduplicate across projects no matter how its resolver improves.

`~/.npm/_cacache` is content-addressed — `content-v2/sha512/98/ea/0c8499...` with a
two-level fan-out, plus an `index-v5/` lookup index. But VERIFIED, every single entry is a
gzipped tarball or a JSON registry document, and there are **zero** extracted package
directories:

```
$ file -b <content-v2 entries>
gzip compressed data, max compression, original size modulo 2^32 10240
JSON data
gzip compressed data, ...

total content-v2 entries: 29
any extracted directories in the cache? -> 0
```

npm's own manual page states the intent plainly: the cache stores "all http request data,"
and "the npm cache is strictly a cache: it should not be relied upon as a persistent and
reliable data store for package data."

Because the cache holds only compressed archives, **nothing in it corresponds to a file in
an installed package**, so nothing in it can be hard-linked into place. Every install must
decompress and materialise a private copy. VERIFIED, the same package version installed into
two projects:

```
inode=7545 nlink=1 size=43  /tmp/n1/node_modules/c/index.js
inode=7553 nlink=1 size=43  /tmp/n2/node_modules/c/index.js
```

Distinct inodes, link count one. N projects means N complete copies of the bytes. Compare
the pnpm replica in §3, where the same file across three projects is one inode with
`nlink=4`.

The clean way to state the difference: **npm's cache saves network; pnpm's store saves
disk.** They are not the same kind of object, and conflating them is the most common error
in discussions of this problem space.

### 2.3 Hoisting, and the conflict that forces nesting

A fixture with three incompatible majors of one package — root depends on `a, b, d, e`;
`a→c@1.0.0`, `b→c@2.0.0`, `d→c@1.0.0`, `e→f@1.0.0`, `f→c@3.0.0`. VERIFIED real npm output:

```
node_modules/a
node_modules/b
node_modules/b/node_modules/c        <- c@2.0.0, nested (loser)
node_modules/c                       <- c@1.0.0, hoisted (winner)
node_modules/d
node_modules/e
node_modules/f                       <- transitive dep of e, hoisted to top
node_modules/f/node_modules/c        <- c@3.0.0, nested (loser)
```

First placement of a name wins the top slot. `c@1.0.0` arrives via `a` (alphabetically
first) and takes `node_modules/c`; `d` gets it free. `b` needs `c@2.0.0`, cannot have the
taken slot, and nests. `f` hoists to the top itself but its `c@3.0.0` cannot, so it nests
too.

The important observation: **a package's depth in the tree is an artifact of resolution
order, not of the dependency graph.** Nesting is the fallback, and which package "wins"
hoisting is alphabetical accident.

Hoisting also makes undeclared packages importable — phantom dependencies. VERIFIED in the
same fixture, where the root declares only `a, b, d, e`:

```
$ node -p "JSON.stringify(require('./package.json').dependencies)"
{"a":"^1.0.0","b":"^1.0.0","d":"^1.0.0","e":"^1.0.0"}

$ node -e "console.log(require('c').version)"   ->  1.0.0   (undeclared)
$ node -e "console.log(require('f').version)"   ->  1.0.0   (undeclared transitive)
```

This is why migrating a codebase to pnpm surfaces bugs: the strict layout correctly refuses
imports that npm's hoisting accidentally permitted.

### 2.4 Why npm cannot use one global `node_modules`

Six independent reasons, each individually fatal. This matters because it is the question
the Nexus concept starts from.

**One — Node's resolution is a directory walk with no global registry.** VERIFIED:

```
$ node -e "console.log(require('module')._nodeModulePaths('/a/b/c/d').join('\n'))"
/a/b/c/d/node_modules
/a/b/c/node_modules
/a/b/node_modules
/a/node_modules
/node_modules
```

The candidate list is derived *purely* from the requiring file's ancestor directories.
There is no lookup table, no version negotiation, no mechanism by which a shared directory
could answer "which `lodash` does *this* project want." This is the crux of the entire
problem, and §5 develops it.

**Two — version conflicts are unrepresentable.** A flat directory has one slot per package
name. The three-majors fixture above cannot be expressed at all without nesting or symlinks.

**Three — module identity is per-resolved-path, so duplication breaks singletons.**
VERIFIED with two copies of one package at different paths:

```
module instance ids  -> zjv4o8 51gprs
instanceof ACROSS copies: false
SINGLETON broken? lib2 registry size = 0 (lib1 wrote 1 entry) same Map? false
```

Duplication is not free even when versions are compatible. Each resolved path is a distinct
module instance with distinct class objects and distinct module-level state. This is the
real cost of nesting and the reason "just duplicate everything" is not a solution — it is
also, as §5 shows, the source of JavaScript's greatest advantage over Python.

**Four — `realpath` behaviour makes a naively symlinked store fragile.** Node canonicalises
by default, so a module's resolution root is its real location. Flipping
`--preserve-symlinks` changes identity and breaks sibling resolution. VERIFIED:

```
$ node --preserve-symlinks -e "require('foo')"
FAILED: MODULE_NOT_FOUND Cannot find module 'bar'
```

**Five — install scripts mutate the installed directory.** §2.6.

**Six — native builds are per-environment.** One shared directory cannot hold the correct
`.node` binary for two Node majors. §9 builds the central argument on this.

### 2.5 Peer dependencies: npm aborts rather than duplicating

npm 7+ made peers part of ideal-tree construction. The behaviour is frequently misstated, so
VERIFIED directly with `plugin-old` peering `host@^1` and `plugin-new` peering `host@^2`:

```
npm error code ERESOLVE
npm error Found: host@2.0.0
npm error   peer host@"^2.0.0" from plugin-new@1.0.0
npm error Could not resolve dependency:
npm error peer host@"^1.0.0" from plugin-old@1.0.0
npm error Conflicting peer dependency: host@1.0.0
```

**npm will not duplicate a package to satisfy two conflicting peer ranges. It aborts the
entire install.** And the escape hatch produces a silently invalid tree — VERIFIED,
`--force` installs a single `host@2.0.0` and leaves `plugin-old`'s peer unsatisfied with no
nesting attempted:

```
$ npm install --force
added 3 packages
node_modules/host        2.0.0
node_modules/plugin-old  1.0.0   <- peer ^1.0.0 unsatisfied, no error
```

This is exactly where pnpm diverges, and §3.3 shows how.

### 2.6 Lifecycle scripts break immutability

The package on disk is not the package in the tarball. VERIFIED:

```
$ tar tzf .../scripty-1.0.0.tgz
package/package.json
package/index.js

$ ls node_modules/scripty/
GENERATED_BY_POSTINSTALL.txt     <- not in the tarball
index.js
package.json

$ cat node_modules/scripty/GENERATED_BY_POSTINSTALL.txt
127                              <- process.versions.modules, captured at install time
```

That `127` is the whole argument of §9 in miniature. The installed tree contains an artifact
whose correctness depends on the Node ABI version present at install time, and **nothing in
the lockfile records that fact.**

Consequences: the installed directory is not content-addressable; integrity cannot be
re-verified after install; and for pnpm specifically, a mutating postinstall writing through
a hard link reaches into the shared store (§3.6).

VERIFIED on the sandbox: `node v22.22.3, ABI(NODE_MODULE_VERSION)=127`. A `.node` binary
built for one ABI value will not load under another. Two strategies exist: `node-gyp`
compiles at install time, producing machine-specific output; `prebuild-install` and
`prebuildify` ship precompiled binaries selected by ABI, platform and arch. Either way the
materialised tree depends on the installing machine, which is why a lockfile cannot fully
describe an installed tree.

### 2.7 Platform binaries via optional dependencies

The modern pattern — used by esbuild, SWC, Rollup, Turborepo, sharp — is a thin dispatcher
declaring every platform binary as an *optional* dependency, with each binary package
narrowing itself by `os` and `cpu`:

```json
{ "optionalDependencies": {
    "@esbuild/linux-x64":    "0.21.5",
    "@esbuild/darwin-arm64": "0.21.5",
    "@esbuild/win32-x64":    "0.21.5" } }
```

Optional-plus-platform-gated is the only npm mechanism where a skipped install is
non-fatal. `#checkEngineAndPlatform()` evaluates the fields and `#pruneFailedOptional()`
drops what does not apply.

This matters enormously for §9's assessment of whether JavaScript needs Conda's binary
machinery: **npm already has a working, widely-adopted solution for shipping native
binaries.** It is not elegant, but it works, and it sidesteps ABI entirely for the common
case because these packages ship standalone executables or N-API modules rather than
ABI-coupled libraries.

Its known failure mode is a real one. The lockfile must describe *all* platforms while
`reify` deliberately diverges per platform, and that divergence is where state gets lost —
producing the familiar `Cannot find module @rollup/rollup-linux-x64-gnu` class of error when
a `node_modules` or lockfile crosses platforms. Optional dependencies are the one place
where "the lockfile fully determines the tree" is intentionally false. [recalled — the
mechanism is reliable; specific issue numbers were not verifiable]

### 2.8 npm already has an isolated mode

Underappreciated and directly relevant: `npm install --install-strategy=linked` produces a
pnpm-shaped layout. VERIFIED, including npm's own experimental warning:

```
node_modules/a -> .store/a@1.0.0-p_ZhH1OntBmBl1mpERgMFg/node_modules/a
node_modules/.store/a@1.0.0-.../node_modules/c -> ../../c@1.0.0-GQQEUj30.../node_modules/c
node_modules/.store/b@1.0.0-.../node_modules/c -> ../../c@2.0.0-HU4zja_C.../node_modules/c
node_modules/.store/f@1.0.0-.../node_modules/c -> ../../c@3.0.0-IeU2knc6.../node_modules/c
```

All three majors of `c` coexist without nesting. The suffix is a shake256 hash of the entire
transitive dependency subtree. But note the limit: this is one `.store` **per project**. npm
gained the isolation topology without the shared store, so cross-project dedup does not
follow. Topology and storage are independent decisions — a theme that recurs in §4 and
becomes the key design insight in §10.

---

## 3. pnpm: internals

pnpm is the incumbent this project must beat or differentiate from, so this section is the
most important prior-art analysis in the report.

pnpm itself could not be installed in the sandbox (no network). The response was to build a
byte-faithful replica of its layout and verify every *mechanism* against real Node. All
mechanism claims below are VERIFIED against that replica; claims about pnpm's own naming,
version numbers and config defaults are marked [recalled].

### 3.1 The store is content-addressed per *file*, not per package

This is the detail that makes pnpm's design better than it is usually credited for, and
better than uv's Python equivalent.

VERIFIED by construction: two *different* packages, `foo@1.0.0` and `bar@1.0.0`, each
containing a byte-identical `LICENSE`. Six package files produced five store objects, and
the shared file is one inode reachable from both packages and the store:

```
$ find /tmp/pnpm-sim -inum 7324
  .../.pnpm/foo@1.0.0/node_modules/foo/LICENSE
  .../.pnpm/bar@1.0.0/node_modules/bar/LICENSE
  .../store/v10/files/96/f76d6e...
```

Two different packages sharing one physical file is only possible with per-file addressing.
The consequence is significant: two *versions* of a package that differ in one file share
every unchanged file. A patch-version bump costs almost nothing on disk. This is why pnpm's
real-world savings exceed what naive per-package deduplication would predict.

Layout [recalled]: current store version v10 (v3 covered pnpm 5–8), at
`~/.local/share/pnpm/store/v10` on Linux, `~/Library/pnpm/store/v10` on macOS,
`%LOCALAPPDATA%\pnpm\store\v10` on Windows. Under it, `files/` shards by the first two hex
characters of the content hash. Per-package index files map a version to its file list plus a
side-effects cache for post-build variants. [UNVERIFIED — CHECK: the store version number.
Conflicting recollections of v3 versus v10 exist and this should be confirmed before being
cited anywhere public.]

### 3.2 Hard links for content, symlinks for structure

VERIFIED on the replica. Store to virtual store is a hard link — same inode, zero additional
bytes:

```
inode=7326 nlink=2  .../.pnpm/foo@1.0.0/node_modules/foo/index.js
$ find /tmp/pnpm-sim/store -inum 7326
  /tmp/pnpm-sim/store/v10/files/aa/fc2583...
```

Virtual store to public `node_modules` is a symlink, and so is each sibling dependency:

```
l proj/node_modules/foo -> .pnpm/foo@1.0.0/node_modules/foo
l proj/node_modules/.pnpm/foo@1.0.0/node_modules/bar -> ../../bar@1.0.0/node_modules/bar
```

The division of labour is forced by the primitives. Hard links share *file content* but
cannot span filesystems or point at directories. Symlinks share *directory structure* and
can point at directories. pnpm needs both, and that is not an implementation detail — it is
the source of most of pnpm's limitations (§3.6).

### 3.3 The virtual store, and why peers force duplication

Naming [recalled]: `.pnpm/<name>@<version>` normally;
`.pnpm/react-dom@18.3.1_react@18.3.1` when peers must be pinned into the identity. Scoped
names replace `/` with `+`. Beyond a length threshold the peer suffix becomes a hash to stay
under path limits.

The suffix is not cosmetic — it encodes a distinct resolution context. VERIFIED: one
`react-dom@18.3.1`, two virtual copies, each with a sibling symlink to a different `react`:

```
d .pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom
d .pnpm/react-dom@18.3.1_react@17.0.2/node_modules/react-dom
l .pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react -> ../../react@18.3.1/...
l .pnpm/react-dom@18.3.1_react@17.0.2/node_modules/react -> ../../react@17.0.2/...

rd18 sees react : 18.3.1
rd17 sees react : 17.0.2
same Element ctor across clones? false
```

This is *dependency-set cloning*. Because a package's resolution is determined by its
physical directory, and a peer is resolved from that directory, a package consumed against
two peer versions **must** occupy two directories. There is no way to have one directory
whose `react` symlink points two places.

Where npm aborts with `ERESOLVE` (§2.5), pnpm duplicates and succeeds. That is a genuine
capability difference, and it is only available because Node permits multiple live versions
of one package — the property Python categorically lacks (§5.3).

**An important correction to the usual criticism.** Peer explosion is normally described as
wasting disk. It does not. VERIFIED, the two clones share their file inodes:

```
inode=7381 nlink=3  .../react-dom@18.3.1_react@18.3.1/.../index.js
inode=7381 nlink=3  .../react-dom@18.3.1_react@17.0.2/.../index.js
```

The cost is **inodes and directory entries, not bytes**. That still hurts — install time,
`stat` load, tree-walking tools, and Windows path limits — but any pitch claiming to save
disk space over pnpm by avoiding peer duplication is wrong. §12 flags this as a benchmark
integrity issue.

### 3.4 Why plain Node resolution works through the farm

The mechanism is elegant and worth understanding precisely, because §10 argues for
abandoning it. VERIFIED — `bar`'s `module.paths` as computed by real Node inside the replica:

```
/tmp/pnpm-sim/proj/node_modules/.pnpm/bar@1.0.0/node_modules/bar/node_modules
/tmp/pnpm-sim/proj/node_modules/.pnpm/bar@1.0.0/node_modules       <- siblings live here
/tmp/pnpm-sim/proj/node_modules/.pnpm/node_modules
/tmp/pnpm-sim/proj/node_modules
...
```

`require('foo')` enters through the symlink `node_modules/foo`; Node canonicalises to
`.../.pnpm/foo@1.0.0/node_modules/foo/index.js`; and the *second* entry in that directory's
walk is `.pnpm/foo@1.0.0/node_modules/`, exactly where `foo`'s declared dependencies are
symlinked. The unmodified algorithm finds precisely the declared dependencies and nothing
else.

This is why pnpm needs no loader, no shim, no `NODE_OPTIONS`. It is pure filesystem topology
exploiting realpath canonicalisation. It is also why `--preserve-symlinks` destroys it.

### 3.5 Configuration surface [recalled]

`node-linker` accepts `isolated` (default, the symlink farm), `hoisted` (flat npm-style, for
tools that cannot cope — React Native, some bundlers, Electron builders), and `pnp` (Yarn
Plug'n'Play resolution, no `node_modules`).

`package-import-method` accepts `auto` (clone, then hardlink, then copy), `hardlink`,
`clone` (copy-on-write reflink), `copy`, and `clone-or-copy`.

Reflink is theoretically ideal: independent inodes, so mutation is safe, with shared blocks,
so it is nearly free. It requires APFS, btrfs, XFS with reflink, or ReFS. VERIFIED that it is
not universal:

```
$ stat -f -c '%T' /tmp   ->  ext2/ext3
$ cp --reflink=always ... ->  cp: failed to clone: Operation not supported
```

Which is exactly why `auto` must fall back to hard links, and why the mutation hazard below
remains live in practice.

### 3.6 Limitations — the honest list

**Hard links require one filesystem.** VERIFIED:

```
device id /tmp     = 2049
device id /dev/shm = 48
os.link FAILED: errno=18 (EXDEV) Invalid cross-device link
```

A machine with separate volumes needs a store per volume. A store on a network or external
drive silently degrades to copying, losing the entire benefit.

**In-place mutation corrupts the store.** The sharpest criticism, VERIFIED end to end.
Because a hard link *is* the store file, writing through it edits the store:

```
store sha512 before: aafc2583267ccee0a070f76f
  (append one line through the virtual-store path)
store sha512 after : ffcb2d78dc03556538f6e26f
--> store content now DISAGREES with its own content-addressed name
$ tail -1 <store file>
// PATCHED BY A POSTINSTALL SCRIPT
```

One project's postinstall — or a patch tool, or a developer editing `node_modules` to debug —
silently poisons that content hash for **every project on the machine**, invisibly until an
integrity check runs.

Two mitigations, both VERIFIED. Atomic replacement is safe, because writes that create a new
inode and `rename()` over the old name break the link rather than following it. And
read-only store files block *casual* mutation, because mode is a property of the inode — though
only casual mutation: the holder of a link can `chmod` it back and write through (§10.2):

```
store mode: -r--r--r--  virtual mode: -r--r--r-- (same inode => same mode)
BLOCKED: [Errno 13] Permission denied
```

This is a design lesson worth carrying forward: **a content-addressed store should be
read-only, and writes should be atomic.** §10 adopts both.

**Windows.** Symlink creation historically requires elevation or Developer Mode, so pnpm
uses directory junctions. Junctions only target directories, are always absolute (making a
tree non-relocatable), and are treated as real directories by some tools. Combined with the
deep `.pnpm/<name>@<ver>/node_modules/<name>` prefix and peer suffixes, the 260-character
`MAX_PATH` limit is a live problem. Hard links additionally require NTFS. [recalled]

**Tools that break on symlinks.** Naive recursive walks traverse the farm repeatedly;
archivers either store symlinks (breaking on extraction) or dereference them (exploding
size); bundlers may treat one file reached by two paths as two modules. `shamefully-hoist`
and `node-linker=hoisted` exist purely as capitulations to this class of problem.

**Docker layer caching.** The deepest structural mismatch. Hard links cannot cross layers or
mounts, so a store baked into one layer cannot link into a `node_modules` created in
another, and a `RUN --mount=type=cache` store lives outside the image entirely. The
recommended `pnpm fetch` then `pnpm install --offline` pattern is a workaround for exactly
this.

**Permissions across users.** A shared store means shared inodes across trust boundaries;
ownership and modes are inode properties, so per-user permissions cannot apply to a shared
entry. In practice each user gets a store, forfeiting machine-wide dedup.

### 3.7 How much of Nexus does pnpm already deliver?

Directly, with no configuration. VERIFIED with three projects sharing `bar@1.0.0`:

```
before (1 project):            store nlink = 2
after adding proj2 + proj3:    store nlink = 4
distinct inodes for bar/index.js across all 3 projects:
7334  /tmp/pnpm-sim/proj/node_modules/.pnpm/bar@1.0.0/node_modules/bar/index.js
7334  /tmp/pnpm-sim/proj2/node_modules/.pnpm/bar@1.0.0/node_modules/bar/index.js
7334  /tmp/pnpm-sim/proj3/node_modules/.pnpm/bar@1.0.0/node_modules/bar/index.js
```

One inode, three projects. **The marginal disk cost of the Nth project using a package version is
zero bytes of file content** — though not zero bytes outright, and the distinction matters for
honest accounting: VERIFIED at 400 KiB per project for a 1,231-entry tree, because every directory
still costs a block, which scales to roughly 4.7 MiB per project for an 8,401-entry tree. Against
npm's verified `nlink=1` per-project copies, N projects cost N copies under npm and one plus
change under pnpm.

There is also a free garbage-collection primitive here. VERIFIED, `nlink` is a
kernel-maintained reference count:

```
after deleting proj3:            nlink = 3
after deleting ALL projects:     nlink = 1   <- orphan, prunable
```

An entry with `nlink == 1` is referenced by nothing but the store. This is why
`pnpm store prune` is safe. But it is also why it is *manual*: deleting a project is an
ordinary `rm -rf` that pnpm never observes, so pnpm cannot know *when* to collect. §9.9
returns to this as a possible differentiator.

**The answer to "how close is pnpm already?" is: very close.** pnpm delivers the global
immutable content-addressed store, minimal physical duplication, multiple simultaneous
versions, exact reproducibility, cross-platform support, fast creation from a warm store,
and full compatibility with existing tooling and `package.json`. That is seven of the ten
capabilities in the project's core technical question, and it delivers them with better
storage granularity than uv achieves for Python (§6.4).

What pnpm does *not* provide: Node runtime management, any notion of a named environment,
and automatic garbage collection. Two of those three are addressed in §7 and §8; the third
is the seed of §9.

---

## 4. Yarn Plug'n'Play, and what is newly possible in 2026

This section carries the most weight for the architecture, because it is where the empirical
work produced genuinely new information rather than confirming known designs.

### 4.1 What Yarn PnP is [recalled]

The motivating argument was "`node_modules` is a lie": the directory tree is a
*materialisation* of a resolution the package manager already computed exactly, and
materialising it costs enormous I/O — thousands of files written at install, then thousands of
`stat` calls at every startup as Node re-derives by filesystem walk what the lockfile already
stated. Hoisting additionally makes the tree order-dependent and creates phantom dependencies.

`.pnp.cjs` is a generated CommonJS file holding `packageRegistryData`: a map from *locator*
(`name@npm:version`, `name@workspace:path`, `name@patch:...`) to a record with
`packageLocation` and `packageDependencies`. Resolving `(issuer, specifier)` means finding the
issuer's locator from its physical path, looking up the specifier in that locator's dependency
map, and reading the target's location. Two hash lookups, no syscalls — O(1) versus O(depth)
with a failed `stat` per miss. Virtual locators (`name@virtual:<hash>#npm:version`) handle
peer-dependent duplication, the same problem pnpm solves with directory suffixes.

Packages stay compressed as `.zip` in `.yarn/cache`, with `enableGlobalCache: true` the Yarn 4
default putting them in a shared global directory. A WASM build of libzip plus an `fs` patch
makes zip contents readable as though extracted.

### 4.2 The resolution table works — verified from scratch

A `.pnp.cjs` analogue was reimplemented and tested. VERIFIED: a project directory with **no
`node_modules`**, a content-addressed store elsewhere, and a resolution table:

```
node_modules present? -> NO

CJS require("fake-pkg") => {
 "name": "fake-pkg",
 "__dirname_seen": "/tmp/cas-store/sha256-ab1adaf9e5729c325fed914fab61814ea210c7ba",
 "dep": { "name": "dep-pkg", "version": "2.3.4" } }
CJS transitive dep resolved: dep-pkg 2.3.4
CJS subpath: fake-pkg/sub
```

The transitive hop is the important part: `fake-pkg` does `require('dep-pkg')`, and the hook
walked up from `context.parentURL` to identify the issuer, then consulted *that issuer's* own
dependency map. The `(issuer, specifier)` contract works.

The same table served ESM, with correct `exports` condition selection — CJS got `index.js`,
ESM got `index.mjs`, from one table, because hooks receive `context.conditions`:

```
ESM import("fake-pkg") => {"name":"fake-pkg(esm)","dep":{"name":"dep-pkg","version":"2.3.4"}}
```

Strict mode is free: an undeclared name is a missing table key.

### 4.3 Measured: table lookup versus filesystem walk

Real `strace` syscall traces. One package at nesting depth 5, npm-style layout, required
**27** `node_modules`-path syscalls, five of them wasted `ENOENT` probes. With a fully
precomputed table, resolution cost **zero** syscalls; only the loader's own reads remained.

Scaled to 60 packages:

| Metric | CAS + precomputed table | Nested `node_modules` walk |
|---|---|---|
| Total path syscalls | **224** | **820** |
| Wasted `ENOENT` probes | **9** | **189** |
| `node_modules`-path syscalls | **0** | **779** |
| Wall clock, best of 5 | **38 ms** | **64 ms** |
| Resolution + load above baseline | **10 ms** | **36 ms** |

Roughly four times fewer syscalls and — on re-measurement — about 1.6× less resolution time
(11.8 ms against 7.4 ms at 60 packages). The syscall ratio reproduced; an earlier 3.6× time figure
did not, and is retracted. The asymmetry is structural
rather than a constant factor: the walk's per-package cost grows with tree depth, the table's
does not.

**One critical honesty note that must survive into any benchmark claims**, and it has been
re-measured since the first draft, which got it wrong in the project's favour. A naive resolver
that re-reads `package.json` on every resolve does still *cut syscalls* against the directory
walk — roughly twofold, because it never probes ancestor directories that do not exist. An earlier
run reporting parity (55 against 56) could not be reproduced under any construction and should be
treated as retracted. What the naive resolver loses, and loses decisively, is **wall time**: 866 ms
against plain `node_modules`' 163 ms across 1,200 packages, because one synchronous read inside the
hot resolve path costs more than all the `ENOENT` probes it removes. So precomputation is not what
creates the syscall win; it is what converts a syscall win into a time win. A resolver that touches
the filesystem during resolution is slower than the tree it replaced, which is the difference
between a real architecture and a demo that appears to work.

There is also a **syscall floor** a perfect table cannot cross, and neither the first draft nor any
comparable write-up mentions it. Even on a table hit, Node still issues `statx(package.json)`,
`openat(package.json)` and `openat(entry)` per package, because it must find the nearest
`package.json` to decide whether the file is CJS or ESM. VERIFIED: naming pre-resolved entry files
`.cjs` collapses that to a single syscall. This is the largest remaining performance lever in the
design and it belongs in Milestone 2, not in a future optimisation list.

### 4.4 The surprise: `require.resolve` bypasses the sanctioned API

The most consequential finding in the evaluation, and counterintuitive — the *old*
monkey-patch covers more surface than the *new* official API.

VERIFIED API matrix on Node v22.22.3:

| API | Available | Sync? | Serves CJS `require` | Serves ESM `import` | Serves `require.resolve` |
|---|---|---|---|---|---|
| `module.registerHooks` | yes | **yes**, in-thread | **YES** | **YES** | **NO** |
| `module.register` | yes | no, worker thread | **NO** | yes | no |
| `Module._resolveFilename` patch | yes | yes | **YES** | **NO** | **YES** |
| `--experimental-loader` | yes | no | no | yes | no |
| `module.findPackageJSON` | yes | yes | n/a | n/a | **ignores all patches** |

And per entry point, which is the form an implementer actually needs (VERIFIED on v22.22.3):

| Entry point | Served by `registerHooks` | Served by `_resolveFilename` patch |
|---|---|---|
| CJS `require(bare)` | **YES** | YES |
| `require.resolve` | **NO** | YES |
| `createRequire().resolve` | **NO** | YES |
| `createRequire()(spec)` — the *load* | **YES** | YES |
| ESM static and dynamic `import()` | **YES** | **NO** |
| `import.meta.resolve` | **YES** | **NO** |
| `module.findPackageJSON` | **NO** | **NO** |
| builtins, bare and `node:`-prefixed | hook **is** invoked — must decline explicitly | n/a |
| Worker threads | only via `execArgv` / `NODE_OPTIONS`, not programmatic registration | same |
| Child processes | only via `NODE_OPTIONS=--require`; an explicit `--require` does not propagate | same |

Three things in that table are easy to get wrong. Only `.resolve` bypasses the hook —
`createRequire()(spec)` does not. `import.meta.resolve` *is* covered by the hook, so no patch is
needed for it. And the hook is invoked for `fs` and `node:fs` as well, so it must decline builtins
explicitly or it will recurse; §4.5 covers that failure. Ordering also matters: the hook runs
first, and on a hit the patch never fires, but on a **miss both layers fire**, so a lookup runs
twice per miss.

Two results deserve emphasis. First, `module.register` — the API most often recommended — is
**ESM-only**; a CJS entry point fails outright:

```
Error: Cannot find module 'fake-pkg'
    at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15)
```

For a package manager that must serve the entire CJS ecosystem, `register` alone is a
non-starter. Second, and worse:

```
--- with registerHooks ---
require("fake-pkg") -> fake-pkg                       <- works
require.resolve("fake-pkg") -> FAIL MODULE_NOT_FOUND  <- BYPASSED
createRequire().resolve -> FAIL MODULE_NOT_FOUND      <- BYPASSED

--- with _resolveFilename monkey-patch (Yarn's way) ---
require.resolve("fake-pkg") -> /tmp/cas-store/sha256-ab1ada.../index.js
```

A spy hook confirmed the hook is not failing but never *invoked*. `require.resolve` from
inside a store package — an extremely common pattern in build tools locating peer
dependencies — fails under hooks alone and succeeds only with the patch.

**Therefore the viable production architecture is both layers together:**
`Module._resolveFilename` for CJS `require`, `require.resolve` and `createRequire().resolve`;
`registerHooks` for ESM `import`, dynamic `import()` and `load()`-based virtualisation. With
both installed, everything passed. This is a concrete, non-obvious engineering requirement
that any implementation must plan for, and it is not what the documentation would lead you to.

Two further practical findings. Resolve hooks are **re-entrant** — calling `require()` inside
a resolve hook recurses through the hook. Re-measured precisely: one failed import produced **678
nested hook invocations, terminating in a single `RangeError: Maximum call stack size exceeded`**
(an earlier draft described this as 613 separate errors, which was a miscount). Hoisting all state
to module scope before registration drops it to one invocation at depth one; the builtins set alone
drops it only to two, so hoisting is the load-bearing half of the fix. And the
resolver is **per-process**, requiring `NODE_OPTIONS=--require` propagation to child
processes; worker threads inherit it automatically via `execArgv`.

### 4.5 Where the zip layer dies, and the sanctioned replacement

A zip central-directory parser and `fs` patch were written from scratch to test Yarn's
storage decision independently of its resolution decision. VERIFIED: **patching `fs` is not
sufficient**, because Node's CJS loader stats candidate paths through internal C++ bindings
rather than the JS `fs` module:

```
patched fs.existsSync -> true
patched fs.readFileSync -> "module.exports = { name:'zip-pkg', ... }"
--- now try an actual require() of that path ---
require FAILED: MODULE_NOT_FOUND
```

It works only when combined with a `_resolveFilename` patch that returns the virtual path
without stat'ing it. That is Yarn's actual mechanism, reproduced. Its limits, all VERIFIED:

Native addons cannot load from a zip, because `dlopen` is libc using real syscalls:
```
FAILED: ERR_DLOPEN_FAILED | .../native.node: cannot open shared object file: Not a directory
```

Node's ESM loader ignores the patched `fs` entirely:
```
ESM import from zip FAILED: ENOTDIR: not a directory, open '.../zip-pkg/index.js'
```

And everything outside Node is blind. To the kernel that path is a file with a suffix:
```
grep -r "inside-a-zip" /tmp/zipcache/   -> (no output)
python3 open(...)  -> NotADirectoryError [Errno 20] Not a directory
cat ...            -> cat: ...: Not a directory
```

ripgrep was equally blind. Any language runtime, linter, bundler, debugger, container build
step or IDE indexer that does not link Yarn's JS `fs` patch is locked out.

**The sanctioned replacement exists and is better.** VERIFIED: `registerHooks`' `load()` hook
can serve a package with **no file on disk at all**, for both module systems:

```
CJS require of fully-virtual pkg -> { origin: 'served-from-memory', dir: '/virtual/virtual-pkg' }
ESM import of fully-virtual pkg -> { origin: 'served-from-memory', dir: '/virtual/virtual-pkg' }
--- does /virtual/ exist on disk? ---
ls: cannot access '/virtual': No such file or directory
```

And ESM-from-zip, impossible via `fs` patching, works cleanly through `load()`. The residual
caveat, VERIFIED: virtual packages break `__dirname`-relative asset reads, because
`__dirname` names a path the kernel does not have — `assetRead: 'FAILED ENOENT'`.

### 4.6 The unfixable problem: discovery by scanning

Store-based resolution has one failure mode that cannot be engineered away, and it must be
stated plainly because it is the reason Yarn PnP remains a minority choice after eight years.

VERIFIED, run from inside a store package under the working combined resolver:

```
dirnameRead: "dirname-relative-payload"                    <- WORKS
requireResolve: "/tmp/cas-store/sha256-f52bf2.../index.js"  <- WORKS
scan: [ "/tmp/proj-A/node_modules -> ENOENT", ... ]         <- BROKEN
walkUpFound: []                                             <- BROKEN
```

Realistic tool patterns:

```
A discoverPlugins (eslint-plugin-* readdir): BROKEN: ENOENT
B isInstalled("fake-pkg"): false   <-- but require("fake-pkg") WORKS: true
C scanScoped (node_modules/@scope): BROKEN: ENOENT
D fs.globSync('node_modules/**/package.json') count: 0
```

Line B is the entire compatibility problem in one line: **the package is loadable but not
discoverable.** Worse, `require.resolve.paths()` still returns a plausible-looking array of
`node_modules` directories that do not exist, so tools using it as a search hint get garbage
rather than an error.

Why this is unfixable in principle: a resolver hook intercepts *resolution*. Scanning is not
resolution — it is `readdir` on a directory that does not exist. There is no hook, because no
module system operation occurred. The only remedies are to materialise `node_modules`
(abandoning the design), patch `fs` (which §4.5 proves fails for native `dlopen`, Node's
internal bindings, the ESM loader, and every non-Node process), or deploy a kernel-level
virtual filesystem via FUSE or Windows projected filesystem — trading a compatibility problem
for a deployment, permissions and performance problem, and one that cannot ship as a library.

The deeper issue is a category error the ecosystem made years ago: `node_modules` was
simultaneously a *resolution mechanism* and a *package inventory API*. Tools legitimately read
it as an inventory. Replacing resolution with a table serves the first role and silently
deletes the second, and the failure is silent *and inverted* — a package that loads but
reports as absent — which is worse than an error. Mitigation requires an opt-in programmatic
inventory API that tools migrate to, which is an ecosystem-coordination problem rather than an
engineering one. That is the tax Yarn PnP has paid since 2018 and it would apply equally here.

### 4.7 What is newly possible, and the key design insight

Yarn PnP predates both `module.register` (Node 20.6) and `module.registerHooks` (Node 22.x
[recalled]). In 2018 the only interception point was `Module._resolveFilename`, which is
CJS-only. VERIFIED, the 2018 dead end reproduced — Node even names the correct file, then
refuses to use it:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'fake-pkg' imported from /tmp/test-esm.mjs
Did you mean to import "file:///tmp/cas-store/sha256-ab1ada.../index.js"?
```

Three things are genuinely better now. ESM is a first-class citizen, served from the same
table as CJS with correct condition selection. `load()` hooks replace `fs` patching for code,
removing Yarn's single largest source of breakage. And `registerHooks` is synchronous and
in-thread, avoiding the worker-thread hop and serving CJS at all.

**The key design insight, and the most valuable single conclusion of this evaluation: Yarn
coupled two independent decisions.** Table-driven resolution is cheap and beneficial. Zip
storage is expensive in compatibility. Decoupling them is available today and captures most of
the benefit for a fraction of the breakage.

VERIFIED: with a store of **real extracted files**, `__dirname`-relative reads work,
`require.resolve` works, and native addons work — a real gcc-compiled N-API module loaded
successfully from a content-addressed store path:

```
native addon loaded -> hello-from-native-addon-in-CAS
resolved path -> /tmp/cas-store/sha256-57c04eb.../native.node
```

The reason is structural: because the store holds real files on a real filesystem, everything
that *reads* works. Only discovery by scanning breaks. That is a dramatically smaller blast
radius than Yarn's design, and it was not achievable in 2018.

### 4.8 Bun and Deno [recalled]

Bun implements its own resolver in native code rather than hooking Node's, and installs a real
`node_modules` tree by default as a deliberate compatibility choice, populated fast via
hardlink or `clonefile` from a global cache. The lesson: *owning the runtime* is a cleaner path
to O(1) resolution than patching someone else's — and note that Bun, having that freedom,
still chose to keep `node_modules` on disk.

Deno originally rejected `node_modules` entirely in favour of a global content-addressed cache
keyed by URL hash, then added substantial npm compatibility including optional real
`node_modules` materialisation. Both runtimes converged from opposite directions on the same
conclusion: content-addressed global storage for bytes, with `node_modules` materialisation as
an *optional* compatibility escape hatch. That is precisely the architecture §10 recommends,
and it is buildable on stock Node.

---

## 5. The asymmetry that governs everything

Before evaluating whether "Conda for JavaScript" makes sense, one structural difference
between the two ecosystems has to be established, because every subsequent conclusion follows
from it. This is the analytical core of the report.

### 5.1 A Python environment is a list; a JavaScript environment is a tree

VERIFIED. A complete, working Python virtual environment is a three-line text file and a
symlink. The entire contents of `pyvenv.cfg`:

```
home = /usr/bin
include-system-site-packages = false
version = 3.10.12
```

A functioning venv was then built by hand with nothing but `mkdir`, `ln -s` and one `printf` —
seven filesystem entries, 28,993 bytes:

```
$ /tmp/handmade/bin/python -c "import sys; print(sys.prefix, sys.base_prefix)"
/tmp/handmade /usr
```

An empty venv is 52 KB and takes 0.038 seconds to create. (With pip bundled it becomes 19 MB
and 3.0 seconds, but that is `ensurepip` unpacking wheels, not the venv mechanism.)

The mechanism is entirely userspace. From `site.py`, VERIFIED verbatim:

```python
exe_dir, _ = os.path.split(os.path.abspath(executable))
site_prefix = os.path.dirname(exe_dir)
candidate_confs = [c for c in (os.path.join(exe_dir, 'pyvenv.cfg'),
                               os.path.join(site_prefix, 'pyvenv.cfg'))
                   if os.path.isfile(c)]
if candidate_confs:
    sys.prefix = sys.exec_prefix = site_prefix
    addsitepackages(known_paths, [sys.prefix])
```

The capstone proof that this is a convention rather than a runtime feature — `-S` disables
virtual environments completely:

```
$ /tmp/venv1/bin/python -S -c "import sys; print(sys.prefix, sys.base_prefix)"
/usr /usr        # venv site-packages gone from sys.path
```

Because `sys.path` is a runtime-mutable ordered list, an environment can be assembled from
arbitrary locations with no filesystem writes at all. VERIFIED — importing directly out of a
hand-built content-addressed store, with no venv and no install:

```
$ python3 -c "import sys; sys.path.insert(0,'/tmp/py-cas/sha256-aaa111'); import mypkg; print(mypkg.hello())"
mypkg==1.0.0 loaded from /tmp/py-cas/sha256-aaa111/mypkg/__init__.py
```

`.pth` files make this declarative, and lines beginning with `import` are `exec()`d at
interpreter startup — VERIFIED from `site.addpackage()`. Real examples ship on any Python
system: `distutils-precedence.pth`, `zope.interface`'s namespace shim, uv's `_virtualenv.pth`.
A complete functioning environment built this way was four files, 8,709 bytes.

Node has no equivalent, and the reason is architectural. VERIFIED:

```
$ node /tmp/nodewalk/a/b/c/d/deep.cjs
module.paths:
   /tmp/nodewalk/a/b/c/d/node_modules
   /tmp/nodewalk/a/b/c/node_modules
   /tmp/nodewalk/a/b/node_modules
   ...
```

The search space is *computed from the importing file's directory*, not configured. There is
no list to hand it. `NODE_PATH` is the nearest analogue and it is **CJS-only** — VERIFIED:

```
$ NODE_PATH=/tmp/elsewhere node -e "console.log(require('mypkg').v)"
9.9.9
$ NODE_PATH=/tmp/elsewhere node /tmp/esmtest/t.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'mypkg'
```

**ESM removed the path-list escape hatch entirely.** The modern JavaScript module system is
strictly filesystem-derived. This is decisive for the Nexus concept: a JavaScript package
manager has exactly three options — materialise the tree (npm), build a symlink farm (pnpm), or
hook the resolver (Yarn PnP, and §10). There is no fourth option analogous to Python's list,
and there will not be one.

### 5.2 Activation is Python's worst ergonomic wart, and JavaScript skipped it

Worth stating because the Nexus draft proposes `nexus activate frontend`.

VERIFIED: the complete difference in environment before and after `source bin/activate` is
four variables, and the difference in `sys.path` is *nothing*:

```
> PATH=/tmp/venv1/bin:/usr/local/sbin:...
> PS1=(venv1)
> VIRTUAL_ENV=/tmp/venv1
> VIRTUAL_ENV_PROMPT=(venv1)

$ diff /tmp/path_noact.txt /tmp/path_act.txt
*** IDENTICAL — activation does not affect sys.path ***
```

Unactivated invocation already yields the environment, because the interpreter derives it from
its own binary's location. Console scripts do not need `PATH` either — they carry an absolute
shebang. Activation is pure shell convenience, and Python's own modern tooling has moved past
it: `uv run` needs no activation at all.

JavaScript never had this problem. `node_modules` is already per-project and already
discovered automatically. Any JavaScript tool that introduces shell activation is importing
Python's worst ergonomic wart for no benefit. §8.7 treats this as a design decision rather than
a detail.

### 5.3 Python cannot hold two versions; JavaScript can

This is the deepest difference, and it is the one that determines whether Conda's design makes
sense for JavaScript at all.

VERIFIED — Python's `sys.modules` is a flat dict keyed by dotted name, so once a name is
cached, `sys.path` order is irrelevant:

```
sys.path.insert(0, '.../sha256-aaa111'); import mypkg          -> 1.0.0
sys.path.insert(0, '.../sha256-bbb222'); import mypkg as mypkg2 -> 1.0.0  (!!)
mypkg is mypkg2 -> True
```

`importlib.reload` does not help; it mutates the existing object in place, destroying the old
reference. The rename workaround yields two objects under fabricated names invisible to normal
imports, and it leaks — a package doing an ordinary absolute self-import pulls the canonical
name into `sys.modules` anyway.

**And for C extensions the ordinary path is blocked outright.** VERIFIED, attempting to load
numpy's compiled test module under an alias:

```
ImportError: dynamic module does not define module export function (PyInit__umath_tests_A)
```

The module name is baked into the ELF symbol table, so the rename trick that half-works for pure
Python fails immediately for compiled extensions.

Precision matters here, because the stronger claim is false and a reviewer will catch it. Two
versions of a C extension *can* be forced into one process: give them distinct `.so` paths, then
`del sys.modules[…]` and `importlib.invalidate_caches()` between imports, and VERIFIED each
`dlopen` handle then carries genuinely independent C `static` state. So the dynamic linker is not
the barrier. The barrier is that **nothing in the packaging or import system will ever do this for
you**: two importers of `numpy` in one process cannot end up with different `numpy`s by accident,
which is the property that forces pip to converge on one version per name. That is the constraint
Conda's environment model exists to serve, and it is the one JavaScript does not have.

Node does this trivially. VERIFIED:

```
a.version = 1.0.0 | a.path = /tmp/js-cas/v1/mypkg/index.js
b.version = 2.0.0 | b.path = /tmp/js-cas/v2/mypkg/index.js
same object?  false
INDEPENDENT STATE: a.counter = 2  b.counter = 1
require.cache keys (keyed by RESOLVED ABSOLUTE PATH):
   /tmp/js-cas/v1/mypkg/index.js
   /tmp/js-cas/v2/mypkg/index.js
```

**The synthesis: Node's model is more powerful per-process; Python's is more powerful
per-environment.** Node can hold N versions live with isolated state, which Python cannot.
Python can construct an environment as a 40 KB list in 38 milliseconds, which Node cannot.
Each language pays for its strength with the other's weakness.

### 5.4 The consequence: this asymmetry dictates the resolver

Not a curiosity — it determines what a dependency resolver must do. The same graph was run
through both ecosystems. Graph: `app` needs `libx` (any) and `liby 1.0`; `liby 1.0` needs
`libx <= 1.1`; `libx` exists at 1.0, 1.1, 1.2, 1.3 and 2.0.

pip, VERIFIED:
```
Successfully installed app-1.0 libx-1.1 liby-1.0
```
It **backtracked** — rejected `libx 2.0`, downgraded to the single version satisfying every
constraint. The verbose trace shows the candidate set recomputed three times as constraints
propagated.

npm, same graph, VERIFIED:
```
libx   2.0.0   node_modules/libx/package.json
liby   1.0.0   node_modules/liby/package.json
libx   1.1.0   node_modules/liby/node_modules/libx/package.json
distinct objects: true
```
It **nested**, and both versions are simultaneously live.

So Python's flat namespace forces resolution to be a genuine global constraint-satisfaction
problem in which one version must satisfy all constraints and "unsatisfiable" is a real
outcome. Node's per-path namespace lets the resolver duplicate its way out of nearly every
conflict, so backtracking is rarely needed.

**Conda's entire design — SAT solving, build strings, one prefix per environment — is a
response to the constraint that one name means one module per process. JavaScript does not
have that constraint.** Adopting Conda's solution without Conda's problem yields the costs
(global solve, unsatisfiable states, downgrade cascades) without the benefit. This single
paragraph is the strongest argument against the Nexus framing, and it is empirically grounded
rather than a matter of taste.

### 5.5 A smaller point in npm's favour

Worth noting because it cuts the other way. Python has **no authoritative manifest** of what
is installed; `pip list` derives it by scanning `sys.path` for `*.dist-info`. VERIFIED — a
hand-written `METADATA` file with no code was enough to make pip report a package that does not
exist:

```
$ printf 'Metadata-Version: 2.1\nName: ghostpkg\nVersion: 9.9.9\n' > .../METADATA
$ pip list
ghostpkg   9.9.9
$ python -c "from importlib.metadata import version; print(version('ghostpkg'))"
9.9.9
```

npm has `node_modules/.package-lock.json` — `lockfileVersion: 3`, with `resolved` and
`integrity` per entry, validated by timestamp. That is a real design advantage over both pip
and Conda, and any new tool should keep it rather than reinvent Python's weakness.

---

## 6. pip, Conda, and the modern successors

Virtual environment internals were covered in §5 because they carry the report's central
argument. This section covers the package managers themselves, and — more importantly for
this evaluation — the two modern tools that already did to Python what Nexus proposes to do to
JavaScript.

### 6.1 pip

A wheel is a zip. VERIFIED: `file` reports `Zip archive data`, first bytes `504b 0304`. The
layout is the package tree plus a `.dist-info` directory containing `METADATA`, `WHEEL`,
`RECORD` and `top_level.txt`. `RECORD` is CSV of `path,hash,size`, and — VERIFIED in both a
hand-built wheel and real numpy — its own line carries empty hash and size fields:

```
numpy-2.2.6.dist-info/RECORD,,
```

Real numpy's `RECORD` is 1008 lines and includes entries *outside* the package directory via
`../` for console scripts. `INSTALLER` on the sandbox contained `uv`, not `pip` — a neat
demonstration that the format is installer-agnostic.

Source distributions are `.tar.gz` requiring a build step, via PEP 517 when a modern backend
is available and legacy `setup.py install` otherwise. VERIFIED both paths.

pip's cache has two distinct behaviours, VERIFIED. Local `--find-links` installs populate
nothing. A wheel built from an sdist is cached as a **compressed zip** in a sharded tree:

```
/tmp/pipcache3/wheels/5e/a4/a4/194e78.../sdistpkg-0.1.0-py3-none-any.whl
file: Zip archive data, compression method=deflate
```

This is the key structural contrast: **pip caches compressed archives keyed by an opaque hash;
pnpm caches individual extracted file blobs keyed by content hash.** pip must therefore always
unzip and write into the target, so it can never hard-link. It is npm's model, one level up.

Does pip deduplicate between environments? No, VERIFIED — two venvs, same wheel, byte-identical
file:

```
inode=18647 links=1 size=204820 /tmp/dupA/.../demopkg/_data.py
inode=18673 links=1 size=204820 /tmp/dupB/.../demopkg/_data.py
md5: 043018e597d6c9adfa11083cc3799d9e   (both)
```

Distinct inodes, link count one. Exactly npm's behaviour, and for exactly the same reason.

The scale of the waste, measured with real manylinux packages on the sandbox (numpy plus
Pillow plus their vendored libraries, 78 MB across 1131 files) replicated into five
*byte-identical* environments — the maximally favourable deduplication case, and so an upper
bound rather than a typical one:

| Strategy | Actual disk |
|---|---|
| `cp -r` (pip-style copies) | **387 MB** |
| `cp -al` (Conda/uv/pnpm-style hard links) | **79 MB** |

**387 MB against 79 MB.** The 25 MB `libscipy_openblas64_-56d6093b.so` showed
`links=6 inode=45982` — one blob, six names.

One caveat that must travel with this number, because it is the report's most quotable figure and
the easiest to misuse. Since the five environments are byte-identical, the ratio is
1 − 1/N by construction: re-measured at N = 2 it is 1.96× / 49.0% saved, at N = 3 2.94× / 66.0%,
at N = 5 4.90× / 79.6%, at N = 10 9.80× / 89.8% (all VERIFIED). **The multiple measures the
environment count, not the mechanism.** Counting the store itself the honest total is 80 MB, and
the marginal cost of each additional environment is a measured 400 KiB of directory blocks. Quote
the absolute pair, never the multiple.

Why pip is not Conda, VERIFIED on both counts. It cannot manage the interpreter:
`pyvenv.cfg`'s `home = /usr/bin` and `sys.base_prefix = /usr` show the interpreter is an
external precondition of every venv. And it handles non-Python dependencies by **vendoring**
rather than resolving. Real evidence from the sandbox:

```
numpy.libs/       27 MB  (libgfortran, libquadmath, libscipy_openblas64_-56d6093b.so)
pillow.libs/      14 MB, 18 libraries (libtiff, libjpeg, libwebp, libharfbuzz, ...)
opencv_python.libs/  115 MB
```

VERIFIED relocation mechanism: `readelf -d numpy/_core/_multiarray_umath...so` shows
`RPATH: [$ORIGIN/../../numpy.libs]`. The hash suffixes are auditwheel mangling the SONAME so
two packages vendoring the same library do not collide in the process-global dynamic symbol
namespace. **This is npm's nesting strategy, applied to ELF** — and it is forced by the same
constraint that forces nesting in Node, one flat namespace per process.

manylinux is a *glibc floor*, not a dependency graph. Four different platform tags appeared
across four packages on one machine (`manylinux_2_17`, `_2_27`, `_2_28`, `_2_34`) from four
build backends. There is no way to express "needs libtiff 6.x" as a dependency. Hence 115 MB
of duplicated OpenCV libraries.

### 6.2 Conda [recalled]

Conda was unavailable in the sandbox, so this section is recall. The one mechanism claim was
verified independently.

Conda separates `pkgs_dirs` — a global package cache, default `<root>/pkgs/` — from
environments at `<root>/envs/<name>/`. Each package is extracted **once** into the cache, and
`conda create` then **hard-links each file** into the environment prefix. Per-environment
state lives in `<env>/conda-meta/<name>-<version>-<build>.json`, recording the file list, the
link type used, and the source package.

**This per-file hard-linking is the direct ancestor of pnpm's model and predates it by roughly
a decade** (Conda 2012, pnpm 2017). Worth stating plainly, because the Nexus framing treats
Conda's storage as the novel idea to import into JavaScript, when pnpm already imported it. The
mechanism was verified independently via the `cp -al` measurement above: the design is sound and
the savings are real.

Remaining internals [recalled]. `repodata.json` per channel and subdirectory carries every
package's metadata; it was historically the largest performance problem, mitigated by zstd
compression and incremental patching. The classic solver translated the problem to SAT and used
`pycosat` with pseudo-boolean optimisation over lexicographic passes; `libmamba`, libsolv-based,
became the default in conda 23.10 and is an order of magnitude faster. The `.conda` format is a
zip holding two zstd tarballs so metadata can be fetched without the payload.

**Build strings are the ABI mechanism** — `py310h1234567_0` encodes interpreter version, a hash
of the build-variant configuration, and a build number. Combined with `run_exports`, where a
library declares the constraint it imposes on downstream consumers, this is what lets Conda ship
one shared `libtiff` rather than eighteen vendored copies.

What Conda does that pip fundamentally cannot: `python` is *just another package* in the
dependency graph, so the interpreter version is solved alongside everything else; compiled
libraries are first-class nodes so ABI compatibility is *resolved* rather than *vendored*; and
non-Python software lives in the same graph.

Reproducibility is Conda's weak point. `conda env export` emits the full transitive solve *for
the current platform*, with build strings, making the YAML non-portable across operating
systems, and it loses the distinction between what was requested and what was resolved.
`--from-history` is portable but under-constrained; `conda list --explicit` is exactly
reproducible but single-platform; `conda-lock` resolves once per target platform. The root cause
is that the solve is inherently platform-specific because `repodata.json` is per-subdirectory.
§8.5 returns to this, because the Nexus draft proposes exactly this export feature.

### 6.3 uv — the most important prior art

uv already delivers for Python what Nexus proposes for JavaScript, and it is worth studying
closely rather than dismissing as a different ecosystem.

VERIFIED, cross-environment deduplication working:

```
inode=24477 links=3 /tmp/uvA/.../demopkg/_data.py
inode=24477 links=3 /tmp/uvB/.../demopkg/_data.py
inode=24477 links=3 /tmp/uvcache/archive-v0/dH1QrMa8tb8qU0MS/demopkg/_data.py
```

One blob, three names; by the end of testing that inode had `links=8` across six environments.
Cache layout VERIFIED: `archive-v0/<key>/` holding extracted wheel trees, plus `wheels-v6/`,
`sdists-v9/`, and `interpreter-v4/<hash>` caching interpreter probes.

All four `--link-mode` values VERIFIED: `hardlink` (default), `copy`, `symlink`, and `clone`,
with `clone` falling back to hardlink on the sandbox's ext4.

**And one finding that matters directly for the Nexus design: uv's cache is keyed per wheel,
not per file content.** VERIFIED with two versions of a package whose data file is
byte-identical:

```
md5 identical: 043018e597d6c9adfa11083cc3799d9e (both)
inode=24477 links=6  (from the 1.0.0 archive)
inode=24554 links=2  (from the 2.0.0 archive)
*** NO cross-wheel dedup ***
```

So **uv implements Conda's hard-link model, not pnpm's content-addressed store.** pnpm dedupes
identical files across different packages and different versions; uv does not. This is a
concrete case where the JavaScript ecosystem is *ahead* of the Python ecosystem, and it should
temper any assumption that Python packaging is the more advanced field to import ideas from.

uv's project mode is the ergonomic model worth copying. VERIFIED: `uv lock` produced a real
`uv.lock` with a `[package.metadata] requires-dist` section preserving the *declared*
specifiers separately from the *resolved* versions — Conda's `--from-history` problem solved
properly by design. `uv sync` created `.venv` and reused the existing cache inode. `uv run`
needs no activation. [recalled] uv's lockfile is platform-independent, recording resolution
markers so one lock covers all platforms, unlike Conda's per-subdirectory solve; and
`uv python install` manages standalone CPython builds, so uv does now manage the interpreter —
though as a special-cased subsystem rather than a node in the dependency graph.

**One warning for any hard-link-based design.** VERIFIED, uv's deduplication stops at
generated files. Bytecode is written per-environment and cannot be shared, because
`__pycache__` sits beside the source and the `.pyc` header embeds the source's mtime and size:

```
.py  : links=8 inode=24477  (shared)
.pyc : links=1 inode=56416  /tmp/pycA/.../__pycache__/_data.cpython-310.pyc
       links=1 inode=56429  /tmp/pycB/.../__pycache__/_data.cpython-310.pyc
```

For this synthetic data-heavy module the `.pyc` came out slightly *larger* than the source, but
that is the worst case and should not be generalised: across real packages the measured overhead is
78–86% of `.py` bytes and only **17–25% of the whole installed tree** (Pillow 16.6%, numpy 25.4%,
VERIFIED). Use the tree-level figure. Any JavaScript equivalent caching V8 compile artifacts or transpiler
output beside sources would hit this exact wall. §11.2 accounts for it.

### 6.4 pixi [recalled]

Rust, built on `rattler` (a reimplementation of Conda's package handling) and `resolvo` (a
PubGrub-derived solver). Reads Conda channels *and* PyPI, per-project by default with a
manifest plus a multi-platform lockfile committed to the repository, tasks defined in the
manifest, and a global hard-linked package cache shared across projects.

Essentially: Conda's semantics — interpreter as package, binary dependencies, full ABI stack —
with npm's ergonomics — per-project, lockfile-first, task runner. This is the tool the Nexus
concept most resembles, and §8 argues that "pixi for JavaScript" is the accurate framing of
whatever remains defensible.

Note the direction of travel: **pixi is per-project by default, not named-global.** Python's
own successors are abandoning the part of Conda that Nexus proposes to adopt.

---

## 7. Comparison

### 7.1 The matrix

| | npm | pnpm | Yarn PnP | pip | virtualenv | Conda |
|---|---|---|---|---|---|---|
| **Dependency resolver** | Arborist, iterative placement to fixpoint; nests on conflict | Own resolver; nests via virtual store + peer cloning | Own resolver; virtual locators for peers | Backtracking global solve, one version wins | none (not a resolver) | SAT / libmamba global solve |
| **Package cache** | `_cacache`, gzipped tarballs | store of extracted files | `.yarn/cache` of zips, global by default | `~/.cache/pip`, compressed wheels | n/a | `pkgs_dirs`, extracted |
| **Content-addressable** | yes, but of *archives* | **yes, per file** | yes, of *archives* | keyed by opaque hash | n/a | by name-version-build, not content |
| **Shared store across projects** | **no** — cache ≠ store | **yes** | yes for bytes; table per project | **no** | no | **yes** |
| **Physical duplication** | full copy per project | **zero marginal bytes** | zero (zips shared) | full copy per env | full copy per env | **zero marginal bytes** |
| **Hard links** | no | yes, store → virtual store | no | no | no (interpreter symlinked) | **yes**, cache → env |
| **Symlinks** | only `--strategy=linked` | yes, structure | no | no | interpreter only | optional link type |
| **Environments** | no | no | no | no | **yes**, `pyvenv.cfg` | **yes**, named + activated |
| **Runtime management** | no | via `packageManager` only | no | **no** | **no** — consumes an interpreter | **yes**, interpreter is a package |
| **Isolation** | by tree position | by virtual store directory | by resolution table | by `sys.path` | by `sys.prefix` | by prefix |
| **Multiple versions live** | **yes** (nesting) | **yes** | **yes** | **no** — impossible | no | no |
| **Lockfile** | `package-lock.json` v3 | `pnpm-lock.yaml` | `yarn.lock` | none by default | none | none native; conda-lock external |
| **Reproducibility** | good, minus native/optional gaps | good, same caveat | good, same caveat | weak without a lock | none | platform-specific export |
| **Resolution mechanism** | C++ directory walk | directory walk through symlinks | **table lookup, O(1)** | `sys.path` list | `sys.path` list | `sys.path` list |
| **Requires `node_modules`** | yes | yes (as symlink farm) | **no** | n/a | n/a | n/a |
| **Native binaries** | `optionalDependencies` + `os`/`cpu` | same, plus side-effects cache | same, must unplug natives | vendored per wheel | n/a | **resolved via build strings** |
| **Cross-platform** | per-platform optional deps | same | same | manylinux floor | n/a | per-subdir solve |
| **Garbage collection** | `npm cache clean` (blunt) | `store prune`, manual | manual | manual | `rm -rf` | `conda clean` |
| **Monorepo support** | workspaces | workspaces, strong | workspaces | none native | none | none |
| **Ecosystem compatibility** | **baseline** | very good | **poor** — the known weak point | baseline | baseline | good within Conda |

### 7.2 Reading the matrix

Five observations matter more than the rest.

**The store-versus-cache distinction separates the tools into two families, and it is not the
family line people assume.** npm, pip and Yarn all cache *compressed archives*; pnpm and Conda
store *extracted files*. Only the second family can hard-link, and only the second family
therefore deduplicates across projects. The dividing line runs *between* the two ecosystems,
not along them — pnpm belongs with Conda, and npm belongs with pip. This reframes the Nexus
premise: the idea that JavaScript needs to import Conda's storage model is fifteen years out
of date, because pnpm already did, and at finer granularity.

**pnpm's per-file granularity is the best storage design in either ecosystem.** Conda and uv
hard-link per package; pnpm addresses per file, so identical files across different packages and
different versions share one inode (§3.1). A new tool has nothing to gain here and should copy
pnpm rather than Conda or uv.

**The `node_modules` row and the resolution row are the only rows where a genuine gap exists.**
Yarn PnP is alone in eliminating `node_modules`, and alone in O(1) resolution — and it pays for
it in the last row, ecosystem compatibility, which is precisely why it lost. §10 argues that the
2018 price and the 2026 price are different, and that is the entire opportunity.

**The runtime management row is nearly empty.** Only Conda treats the runtime as part of the
environment. npm has `packageManager`, which pins the wrong thing. pip and virtualenv both
*consume* an interpreter chosen elsewhere. This is the emptiest column in the matrix and §9
builds on it.

**Multiple-versions-live splits the ecosystems cleanly and explains everything else.** Node
and its package managers say yes; every Python tool says no, and for C extensions cannot say
otherwise (§5.3). Every difference in resolver design downstream of this row follows from it.

---

## 8. Is it already solved? An adversarial pass

The brief asked for aggressive challenge rather than agreement. Taking each question directly.

### 8.1 Is this already solved by pnpm?

**Substantially yes.** Against the ten capabilities in the project's core technical question:

| # | Capability | Status |
|---|---|---|
| 1 | Globally shared immutable package store | **pnpm, done** — and per-file, better than Conda or uv |
| 2 | Conda-like isolated environments | **not done** — and §8.7 argues it should not be |
| 3 | Exact dependency graph reproducibility | **done** — lockfile, modulo native/optional gaps that no tool solves |
| 4 | Minimal physical duplication | **pnpm, done** — zero marginal bytes, VERIFIED |
| 5 | Compatibility with existing Node tooling | **pnpm, done** — its main advantage over Yarn PnP |
| 6 | Fast environment creation | **pnpm, done** — hard-linking from a warm store |
| 7 | Simple project activation | **already unnecessary** — `node_modules` is auto-discovered; JS skipped activation |
| 8 | Multiple Node runtime versions | **done, but by separate tools** — nvm, fnm, Volta, mise |
| 9 | Cross-platform support | **pnpm, done** — with Windows junction caveats |
| 10 | Compatibility with `package.json` | **pnpm, done** |

Eight of ten are delivered, one is delivered by adjacent tools, and one is the misfeature.

The central question as posed — *"Can JavaScript projects have isolated dependency
environments without every project maintaining a fully independent physical `node_modules`
installation?"* — **was answered affirmatively by pnpm in 2017 and by Yarn PnP in 2018.** It is
not an open question. Restating it as though it were is the single biggest weakness in the
project framing, and any public positioning built on it will be dismissed immediately by
exactly the audience the project needs.

### 8.2 Is this already solved by Yarn PnP?

For the storage and resolution half, yes, and more radically than pnpm — no `node_modules` at
all, O(1) resolution, globally shared zips. Yarn PnP is closer to the Nexus architectural
vision than pnpm is.

It lost on compatibility, and §4.5–4.6 establish empirically why: the zip storage decision
broke native `dlopen`, the ESM loader, and every non-Node process, while the deeper
scanning problem is unfixable in principle.

**But this is also where the opportunity lies.** Yarn's failure is over-determined by two
coupled decisions, and the coupling was not necessary. §4.7 shows a store of real extracted
files preserves `__dirname` reads, `require.resolve` and native addons, leaving only the
scanning problem. So the honest position is: Yarn PnP solved this and paid too much; the price
is lower now.

### 8.3 Is this already solved by Volta, nvm, fnm or mise?

For runtime switching, yes. For the *problem*, no — and the distinction is the seed of §9.

These tools change which `node` binary is on `PATH`. None of them participate in dependency
resolution, and none record the runtime in the installed tree's identity. So the sequence
"install under Node 22, `nvm use 20`, run" produces a tree that is silently wrong, with a
lockfile that still validates. VERIFIED that the ingredients of this bug are real: ABI 127 on
Node 22, a `.node` binary that will not load across majors, and a postinstall that captured
`127` into the installed tree (§2.6) where no lockfile records it.

`mise` is the strongest overlap candidate and deserves specific attention. It manages multiple
runtimes declaratively per directory and has an `npm:` backend. [UNVERIFIED — CHECK] To the
best of recollection it installs CLI *tools*, not project dependency graphs, and does not
participate in resolution — but this should be confirmed, because if `mise` has moved into
dependency-graph territory the remaining gap narrows considerably.

### 8.4 Is this already solved by combining existing tools?

**Largely yes, and this is the most damaging objection to the project.** `pnpm` plus `mise` or
Volta, plus `packageManager`, plus `engines`, gets a developer roughly 90% of the Nexus value
proposition today, with zero new software, full ecosystem compatibility, and no adoption risk.

A new tool must therefore justify itself on the remaining 10%. Enumerating that residue
honestly:

The combination leaves the runtime outside the dependency identity, so runtime switches
silently invalidate native artifacts (§9). It leaves `node_modules` materialised, so the
per-project cost is thousands of inodes and directory entries rather than a single table file —
which matters on Windows for `MAX_PATH`, in Docker for layer size, and in CI for cold-start
time. It leaves resolution as a filesystem walk, costing measured wasted `ENOENT` probes on
every module load. And it leaves garbage collection manual and machine-wide invisible, because
no component observes project deletion, even though `nlink` provides a free reference count
(§3.7).

That residue is real but narrow. It is enough for a focused tool. It is not enough for "the
Conda of JavaScript."

### 8.5 What exact user problem remains unsolved?

Stated as precisely as the evidence supports:

> **An installed JavaScript dependency tree has no verifiable identity that includes the
> runtime it was built for.** Lockfiles pin package versions. Nothing pins, records, or
> validates the Node ABI, platform, libc, or build-time inputs that the materialised tree
> actually depends on — even though VERIFIED evidence shows installed trees routinely contain
> ABI-specific artifacts (§2.6) and native binaries that fail across Node majors.

Secondary, genuinely unsolved but smaller: no tool can answer "how much disk are my
dependencies actually costing me, machine-wide, and what is safe to delete" — because
answering it correctly requires inode-aware accounting that `du` gets wrong by default (§12.3).

### 8.6 What would make this fundamentally different?

Three things, in descending order of defensibility.

**Runtime and ABI as first-class inputs to the graph hash.** Make the environment identity
`hash(package graph, node ABI, platform, libc, build inputs)` so that switching runtimes
produces a *different environment* rather than a silently broken one. No JavaScript tool does
this. Conda does the equivalent via build strings, which is the one part of Conda genuinely
worth importing.

**No `node_modules` at all, with real files in the store.** Not a symlink farm, not zips. This
is architecturally distinct from pnpm — the objection "just a pnpm wrapper" does not survive a
demo where `ls node_modules` returns `ENOENT` and the app runs. VERIFIED viable, including
native addons, and newly cheap thanks to `registerHooks` plus `load()` hooks (§4.7).

**Verification as a first-class operation.** pnpm's store can be silently corrupted by a
postinstall writing through a hard link (VERIFIED, §3.6). A read-only store plus atomic writes
plus a `verify` command that re-checks content hashes against names is a real correctness
feature nobody ships.

### 8.7 Is "Conda for JavaScript" a useful mental model?

**No. It is actively misleading**, and this is worth stating firmly because the framing will
otherwise shape the project's design and positioning for months.

Conda's value decomposes into three claims, and they get three *different* verdicts.

**Managing the interpreter as a package — REAL GAP.** The strongest part of the analogy. Node
is in the same unmanaged position as Python's interpreter, arguably worse: nvm, fnm, Volta and
Corepack all sit outside the dependency graph, and `engines` is advisory only. A tool treating
`node` as a solvable node in the graph would be new for JavaScript.

**Binary dependencies with a coherent ABI story — MOSTLY SOLVED, and this is where the analogy
misleads most.** The measured numbers make the asymmetry concrete. Python needs Conda because
manylinux expresses only a glibc floor, so every wheel vendors its native closure: 115 MB for
OpenCV, 18 libraries for Pillow, 27 MB for numpy, with auditwheel hash-mangling every SONAME
to survive the process-global symbol namespace (§6.1).

npm already handles the equivalent problem structurally via `optionalDependencies` plus
`os`/`cpu` (§2.7). It works because **JavaScript's ABI surface is tiny.** A native JS module is
a *leaf*: it exposes a JS-object interface across the N-API boundary and does not need to
ABI-match any *other* package. Python's problem is that numpy, scipy, pandas, torch and
pyarrow must all agree on the same BLAS, the same C++ standard library and the same numpy C API
simultaneously. **There is no JavaScript equivalent of "everything in this environment must
link the same OpenBLAS."** Building Conda's build-string and `run_exports` machinery for
JavaScript would be enormous effort against a fraction of the payoff.

**Named shared environments — UNNECESSARY, and directionally backwards.** Conda's `envs/<name>`
model exists because Python needs a per-project interpreter prefix and because activation is
the only way to get the right `python` on `PATH`. JavaScript never needed either:
`node_modules` is already per-project and already auto-discovered (§5.1), and activation is
four environment variables with zero effect on resolution (§5.2). Worse, a named-global-env
model fights the language, because Node's resolution is lexical and a global environment cannot
be projected onto a project's file tree without exactly the mechanisms npm, pnpm and Yarn
already use. And Python's own ecosystem is migrating *away* from named shared environments
toward per-project — `uv sync` produces `.venv`, pixi is per-project by default. Copying
Conda's environment model into JavaScript means importing the one part of Conda that Conda's
own successors are abandoning.

Three traps follow from the slogan. **It evokes the third claim while the value is in the
first** — most people hearing "Conda for JS" imagine named environments you activate, which is
the part JavaScript does not need. **It imports Python's ABI pain, which JavaScript does not
have.** And **it papers over the resolver difference, which is architectural** — proved side by
side in §5.4, where pip downgraded a dependency to find one global solution while npm installed
both versions and loaded them as distinct objects.

If a slogan is needed, **"pixi for JavaScript"** is defensible and **"Conda for JavaScript"** is
not. But the honest framing avoids analogy altogether, because the actual pitch is narrower and
more specific than either.

### 8.8 The smallest genuinely unsolved problem

Compressing everything above into the smallest defensible core:

> **Make the identity of an installed JavaScript dependency tree include the runtime it was
> built for, and serve that tree from a shared content-addressed store with no `node_modules`
> directory — so that switching Node versions is a first-class, verifiable operation instead of
> a silent corruption.**

This is small, it is testable, it is not delivered by any combination of existing tools, and
it cannot be dismissed as a pnpm wrapper — pnpm materialises a symlink farm and has no concept
of runtime identity. §13 turns it into a first milestone.

---

## 9. The gap, and the five proposed differentiators

### 9.1 The gap, stated precisely

Every JavaScript package manager keys an installed tree on the **package graph** alone. None of
them keys it on the **runtime the tree was built for**. That mismatch is the only structural gap
this research found, and it is worth stating with the evidence attached.

Three things were verified in the sandbox.

**A Node ABI mismatch is a hard, unrecoverable load failure.** Rather than assert this from
recollection, a legacy addon registration struct was hand-written in C with a *forged* version
field — no Node headers required, since the loader only inspects `nm_version` in the
`node_module` struct:

```c
static struct node_module _module = {
  FORGED_ABI, 0, 0, "forge.c", 0, (void*)init, "forge", 0, 0
};
__attribute__((constructor)) static void reg(void) { node_module_register(&_module); }
```

Compiled three times with `-DFORGED_ABI=127|115|108` and loaded on Node v22.22.3 (ABI 127):

```
--- claims NODE_MODULE_VERSION 127 ---   LOADED OK
--- claims NODE_MODULE_VERSION 115 ---   ERR_DLOPEN_FAILED
--- claims NODE_MODULE_VERSION 108 ---   ERR_DLOPEN_FAILED
```

The real error text, VERIFIED verbatim:

```
The module '/tmp/abi/abi115.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 127. Please try re-compiling or re-installing
the module (for instance, using `npm rebuild` or `npm install`).
```

Note what the error itself concedes: the remedy is to *re-install*. Node knows the installed
tree is invalid for the current runtime. Nothing in the package manager knows.

**The lockfile records nothing about the runtime.** VERIFIED — a complete `package-lock.json`,
grepped for every plausible field name:

```
$ grep -Eio "node_module_version|nodeVersion|\"abi\"|libc|glibc" package-lock.json
(no output)
```

A correction on the method, since the first pass of this test was misleading and the report should
not repeat it. Grepping for the bare word `modules` matches every `"node_modules/…"` key in the
file, so on any lockfile with dependencies it returns dozens of false hits; and `platform` and
`arch` must be excluded from the pattern too, because npm legitimately records `os` and `cpu`
constraints. Narrowed to the fields that would actually pin a runtime, the result stands: nothing.
`lockfileVersion: 3` carries `os`, `cpu`, `engines` and `hasInstallScript`, but those are npm's
install-time *gates on dependencies*, not a record of the interpreter the tree was built against.
There is no field in the format for the ABI, the libc, or the build inputs.

**And `engines` is advisory, not enforced.** VERIFIED with a deliberately impossible constraint:

```
package.json: {"engines": {"node": ">=99.0.0"}}
$ npm install
up to date in 391ms
npm exit code: 0
```

Exit zero on Node 22. npm does print `npm warn EBADENGINE Unsupported engine` — an earlier draft
of this report claimed no warning at all, which was wrong — and then installs anyway. The
constraint is advisory, not enforced, because npm's `#checkEngineAndPlatform` gates
*dependencies*, not the root project. So the one field that nominally expresses runtime
compatibility does not gate anything the developer controls directly.

Put together: **the installed tree has a real dependency on the runtime, the runtime is not
part of the tree's identity, and the field that looks like it should express the constraint does
not enforce it.**

### 9.2 The failure mode is silent, which is what makes it interesting

Bugs that produce a clear error are an annoyance. Bugs that produce a *valid-looking state* are
an architecture problem. This one is the latter, and §2.6 supplies the sharpest evidence.

A postinstall script writing `process.versions.modules` into the installed tree produced:

```
$ cat node_modules/scripty/GENERATED_BY_POSTINSTALL.txt
127
```

That `127` is now a fact about the *installed tree*, established at install time, recorded
nowhere. Follow the sequence:

Install on Node 22. The tree is correct. `package-lock.json` is written; it says nothing about
ABI 127. `node_modules/.package-lock.json` is written; it also says nothing about ABI 127.
Switch with `nvm use 20` or `fnm use 20` or a `.node-version` file — no package manager is
invoked, so nothing is invalidated. Run `npm ci`, or `pnpm install --frozen-lockfile`, or
`npm ls`. **All of them report the tree as satisfying the lockfile, because by their own
definition of identity it does.** Then the app throws `ERR_DLOPEN_FAILED` at runtime — or worse,
does not throw, because the stale artifact is a plain file rather than a `.node` binary, and
simply carries wrong data forward.

The last case is the one that generalises. N-API fixes native ABI (§9.3) but does nothing about
a postinstall that baked the wrong value into a generated file, and the verified `127` artifact
was produced by an ordinary JavaScript postinstall, not a compiled addon.

There is no `nexus`-shaped tool today that says: *this tree was built for ABI 127, you are
running ABI 115, refusing to proceed.* That sentence is the product.

### 9.3 How large is this problem, honestly?

This is where the report must argue against its own conclusion, because the counter-case is
strong and a founder who ignores it will build for a market that is closing.

**The case that the gap is shrinking.** N-API (`process.versions.napi` reports 10 on the
sandbox, VERIFIED) is deliberately ABI-stable across Node majors: an addon built against N-API
version *n* loads on any Node that supports *n*, so the NODE_MODULE_VERSION check stops
mattering for correctly built modern addons. Simultaneously the `optionalDependencies` plus
`os`/`cpu` pattern (§2.7, VERIFIED as npm's real mechanism) means the popular native packages
ship *prebuilt* per-platform binaries and never compile locally at all. Both trends point the
same way: fewer local builds, fewer ABI-sensitive artifacts, fewer users who ever see the bug.

**The case that it still matters.** The trend does not reach zero, for four reasons. Compiled
addons that predate N-API or use V8 APIs directly still exist and still break. Local
`node-gyp` builds remain the norm in the long tail and in corporate registries. Postinstall-
generated non-native artifacts are *entirely outside N-API's scope*, as the verified `127`
capture shows, and the number of packages doing codegen at install time is not obviously
falling. And the platform axis is independent of the ABI axis: a `node_modules` populated on
macOS arm64 and copied into a Linux container is wrong regardless of N-API, which is exactly
why `.dockerignore`-ing `node_modules` is folklore rather than an enforced rule.

**The honest synthesis.** The severity is *declining*, the frequency of the acute native case is
*low and falling*, and the frequency of the general case — "this materialised tree is not valid
for this execution context, and nothing tells you" — is *not* falling. Any positioning built on
"native modules break when you switch Node" will age badly. Positioning built on **tree identity
must include execution context** does not, because platform, libc, and build-input drift are the
same bug wearing different clothes.

[UNVERIFIED — CHECK] What fraction of the top few thousand npm packages still ship non-N-API
native code, and whether that fraction is falling as fast as intuition suggests, was not
checkable without network access. This is the single most important number for sizing the
opportunity, and §15 lists it first for that reason. If the answer is "under 1% and collapsing,"
the native-ABI framing should be demoted to a footnote and the general execution-context framing
carries the project alone.

### 9.4 The right generalisation is build inputs, not ABI

The narrow claim is about NODE_MODULE_VERSION. The defensible claim is broader. An installed
tree's identity should be:

```
env_id = H( resolved package graph
          , node ABI / N-API level
          , platform (os, arch)
          , libc flavour + floor
          , build inputs: postinstall script hashes, toolchain identity
          , resolution-relevant config: conditions, peer strategy )
```

Conda reached this conclusion first, and its build strings (§6.2) are the precedent —
`py310h1234567_0` encodes interpreter version, a hash of the build variant, and a build number,
which is structurally the same idea.

But the *scope* differs, and the difference is what makes this tractable in JavaScript rather
than a decade-long project. Conda needs build strings **plus a solver**, because Python's native
packages must mutually agree: numpy, scipy, pandas, torch and pyarrow all have to link the same
BLAS and the same C++ runtime, so ABI compatibility is a constraint *between* packages that has
to be resolved. JavaScript has no such constraint. §8.7 established that a native JS module is a
*leaf* — it talks to Node across N-API and to nothing else — so there is no JavaScript
equivalent of "everything here must link the same OpenBLAS."

Which means: **JavaScript needs a hash, not a solver.** No `run_exports`, no build-variant
matrices, no per-subdirectory `repodata`. Just an honest key, checked before execution. That is
a few thousand lines of careful work rather than a research programme, and it is the single most
important scoping conclusion in this report.

### 9.5 Why existing tools cannot retrofit this cheaply — and the competitive risk

Every current store keys on package identity. pnpm's virtual store path is
`name@version` plus peer suffixes; the content store is addressed by file hash. Neither has a
slot for the ABI. Adding one changes the store layout, which is a migration, not a flag. npm's
cache holds tarballs keyed by integrity hash (§2.2) and cannot express a *built* artifact at
all. Runtime managers sit entirely outside dependency resolution (§8.3) and never see the graph.

So the gap is genuinely new-tool-shaped. **But be clear-eyed about how defensible that is: it is
a feature gap, not a moat.** pnpm could add an ABI component to its store key and a
`--frozen-runtime` check in a minor release. The team is competent and ships quickly. The only
durable advantages a new project has are being first, being uncompromising about it by default
rather than behind a flag, and pairing it with the architectural choice pnpm cannot make without
abandoning its own model — no `node_modules` at all (§10). Neither of those is a patent. Any
plan that assumes years of clear air is wrong.

### 9.6 Differentiator A — "true JavaScript environments" — **CUT**

The proposal: `nexus create frontend`, `nexus activate frontend`, with an environment owning
Node version, package manager, dependency graph, versions, environment variables and native
compatibility.

**Verdict: cut the environment and the activation; keep only the runtime pinning, and do it
per-project.** §8.7 argued this from the Conda side; the tool-by-tool comparison the brief asked
for reaches the same place.

Against **nvm** and **fnm**: a Nexus environment would additionally know the dependency graph,
which is the one real improvement — but that improvement is §9.1, and it needs no environment
abstraction to deliver. Against **Volta**: Volta already pins the runtime *and* toolchain per
project via `package.json`, and shims binaries so no activation step is required; it is the
closest existing tool to the defensible part of A, and its no-activation design is the better
ergonomic model. Against **Corepack**: pins the package manager only, which is pinning the
wrong layer. Against **pnpm**: delivers the storage half completely (§8.1) with no environment
concept, which is evidence that the environment concept is not load-bearing. Against **Docker**:
strictly stronger isolation, including libc and system libraries, at the cost of a
filesystem boundary and slower iteration — for *reproducibility* Docker wins outright, so a JS
environment manager cannot compete on isolation and must compete on being native and fast.
Against **virtualenv**: the asymmetry in §5.1–5.2 is decisive — venv activation is four
environment variables with *zero* effect on `sys.path` (VERIFIED), and JavaScript already gets
for free what activation approximates for Python. Against **Conda**: §8.7.

Two specific pieces of A should be dropped outright. **Activation** is Python's worst wart:
stateful shell mutation, forgotten activations, broken subshells, editor and CI confusion, and
no mechanism to prevent running the wrong one. `node_modules` auto-discovery already solved
this problem by never having it, and Volta and `uv run` both demonstrate the modern answer is a
shim, not a shell mode. **Environment variables in the manifest** conflate configuration with
dependency management; `.env` files, direnv and process managers own that space, and folding
secrets-adjacent config into a package manager's manifest invites committing secrets and
guarantees a security review the project does not need in month one.

What survives from A: the runtime version belongs in the project manifest and must be *enforced*
rather than advisory — which is §9.1 with a different label.

### 9.7 Differentiator B — environment-level dependency sharing — **CUT**

The proposal: one `frontend` environment holding react, vite and typescript, used by several
projects, with immutable snapshots `frontend@v1`, `frontend@v2`, `frontend@v3` to avoid
coupling.

**Does it create dangerous coupling? Yes** — and the brief's own instinct is right. If one
project runs `nexus add` and the environment is mutable, every other project's dependency graph
changes without its lockfile changing, its tests running, or its author knowing. That is a
worse version of the phantom-dependency problem (§2.3): not just importing something undeclared,
but having something *swapped underneath you*. For a build tool this is disqualifying.

**Do immutable snapshots fix it? Yes — and in fixing it they dissolve the feature.** Walk it
through. Snapshots mean every project pins an exact version, so `frontend@v7` is an immutable
list of exact packages referenced by an immutable identifier. That is a lockfile. It is a
lockfile with three disadvantages: it lives in `~/.nexus` instead of the repository, so it is
not versioned with the code that depends on it; it is invisible to code review, so a dependency
change arrives with no diff; and it is absent from a fresh clone, so CI cannot reconstruct the
project without out-of-band state. The snapshot design converges on "commit your lockfile,"
having taken a detour through a global mutable namespace.

Then the sharing benefit itself does not survive contact with real projects. Two projects
sharing an environment must have identical dependency closures, but each project's own
`package.json` is a node in its own graph, so the moment project A adds one dependency it needs
`frontend@v8` while B stays on `v7`. With N projects drifting independently you get N snapshots:
per-project resolution, with a global namespace and a garbage collection problem bolted on.

**And the decisive objection is quantitative.** The entire motivating problem is disk. §3.1 and
§3.7 VERIFIED that a content-addressed store already makes the marginal cost of the Nth project
using a package version **zero bytes** — two different packages sharing a byte-identical
`LICENSE` share one inode. The disk win is *already fully captured at the storage layer.*
Environment-level sharing therefore saves **no additional bytes whatsoever**; it saves only
inodes and directory entries, and the no-`node_modules` design in §10 captures that too, without
any sharing semantics. So B adds coupling, a global namespace, a lifecycle problem and a GC
problem in exchange for savings that the layer beneath it already delivered.

The one legitimate need hiding inside B is *consistency across projects* — a team wanting five
services on the same toolchain. That is a real want, and the correct shape for it is a
**shareable dependency template** that is materialised into each project's own committed
lockfile and then forgotten: `nexus init --from @acme/frontend-preset`, resolved at init time,
with no live link afterward. This is `create-react-app` and `tsconfig` `extends` semantics — copy
on use, not reference at runtime. It is a nice feature. It is not an architecture, and it should
not appear before v1.

### 9.8 Differentiator C — global dependency intelligence — **KEEP, as a small honest feature**

The proposal: scan all local projects and report project count, dependency copies, unique
versions, potential storage saved, unused dependencies.

**Verdict: genuinely useful, excellent for demos, and not a product.** Keep it small and make
it correct.

Useful because the pain is invisible before it is measured. Nobody knows their `node_modules`
total until they look, the number is usually shocking, and the measurement is the most persuasive
argument the project has (§6.1 measured **387 MB → 79 MB** across five environments of real
manylinux packages — that single line does more persuading than any
architecture diagram). It is also cheap: a filesystem walk and a hash table, no new
architecture.

Not a product because a diagnostic that tells you about waste you cannot act on is a one-time
curiosity. Its value is entirely as an on-ramp to the store, and as the thing a blog post
screenshots.

Two correctness warnings, both load-bearing for credibility. **`du` double-counts hard links by
default**, so any tool of this kind that reports naive sizes will overstate the savings of
exactly the architecture it is advocating — a self-inflicted credibility wound. Inode-aware
accounting is mandatory; §12.3 specifies it. And **"potential storage saved: 28 GB" is precisely
the kind of claim to avoid** unless it is the measured delta of an actual migration, because a
projection presented in the grammar of a measurement is the fastest way to lose a technical
audience. Report what is on disk now, what a store-backed layout would occupy, and label the
second number an estimate.

"Unused dependencies" deserves a separate warning: static analysis of JavaScript imports is
undecidable in the general case — dynamic `require`, string-built specifiers, config-file
plugin references by name, framework conventions that load by filename. A tool that confidently
lists unused dependencies will be wrong, and wrong in the direction of telling people to delete
things they need. Report *unreferenced store contents* (a sound question, answerable exactly)
and leave *unused declared dependencies* to `depcheck` and `knip`, which already do it and
already carry the caveats.

### 9.9 Differentiator D — automatic garbage collection — **KEEP, and it is harder than it looks**

The proposal: if no project and no environment references package X, delete X.

**Verdict: keep it, it is real, and the design has a trap that is worth understanding before
committing to the architecture.**

The good news is that on a hard-link architecture, **the kernel maintains the reference count for
free.** VERIFIED, tracking one store blob as projects were removed:

```
after deleting proj3:            nlink = 3
after deleting ALL projects:     nlink = 1   <- orphan, prunable
```

`nlink == 1` means the store holds the only reference: the file is garbage, and the answer is
exact, requires no bookkeeping, and cannot drift out of sync with reality. This is why pnpm's
store model is sound, and it is the single most elegant property in this whole design space.

**The trap: the no-`node_modules` architecture that §10 recommends destroys this property.** If
projects hold no hard links into the store — because there is no materialised tree, only a
resolution table pointing at store paths — then `nlink` is *always* 1 for every blob, live or
dead, and the free refcount conveys no information at all. The architecture that wins on
resolution loses the garbage collector. This tension appears not to be widely discussed, and it
is the kind of thing that is cheap to design for now and expensive to retrofit.

The design that follows from it, and which §11.4 formalises: maintain an explicit **roots
registry** at `~/.nexus/roots.json` mapping absolute project paths to the graph hashes they
depend on, written on every successful install; treat the store as a mark-and-sweep heap with
those roots as the root set, marking transitively through each graph's package set; and validate
liveness before sweeping — a root whose path no longer exists, or which no longer contains the
expected manifest, is dead.

Four safety requirements, each earned from a specific failure mode. **Never sweep on removable
or network paths without an explicit opt-in**, because an unmounted external drive is
indistinguishable from a deleted project and the naive design silently collects a live project's
entire closure. **Quarantine rather than delete** — move swept content to a holding area with a
grace period, so recovery is a `mv` rather than a re-download; Conda and pnpm both effectively
require re-downloading. **Take a lock and refuse to sweep while any install or build is
running**, because a concurrent install may have staged content it has not yet registered as a
root. And **never sweep automatically by default**: earn trust with `nexus gc --dry-run`
reporting exactly what would go and why, because a package manager that deletes the wrong thing
once has permanently lost the user.

One honest note on scope: pnpm already has `pnpm store prune`, so the differentiator is not
garbage collection but *automatic, safe, refcount-correct* garbage collection with liveness
tracking — pnpm cannot know when a project was deleted because an ordinary `rm -rf` is invisible
to it (§3.7). A roots registry is what makes the difference, and it is a modest amount of code.

### 9.10 Differentiator E — environment portability — **RESHAPE into the core**

The proposal: export `frontend.env.json`, recreate elsewhere with `nexus import`.

**Verdict: the feature is right, the framing is wrong. This is not a differentiator; it is what
the core gap produces as a by-product** — and the interesting content is in the failure modes.

Conda already demonstrates how this goes wrong (§6.2): `conda env export` emits a full
transitive solve *with build strings for the current platform*, so the YAML does not work on
another operating system, and it loses the distinction between what was asked for and what was
resolved. Both problems are avoidable and both were solved properly by uv, VERIFIED: `uv.lock`
carries a `[package.metadata] requires-dist` section preserving the declared specifiers
*separately* from the resolved versions. Any Nexus manifest must do the same, so §11 separates
`requested` from `resolved`.

The genuinely hard limit is that **some of an installed tree is not portable at all, by
construction.** The verified `127` postinstall artifact is the proof: it is a fact about the
machine that built the tree, so exporting the tree is exporting a lie. Native binaries are the
same problem with a clearer error message. This forces a clean rule, and it is the most useful
thing E contributes:

> **Export inputs, never outputs.** The manifest carries the resolved graph, the runtime
> requirement, the platform matrix and the build-input hashes. It never carries built artifacts.
> Materialisation is always local, and the manifest's job is to let the importing machine
> *verify* that what it produces matches what was intended.

Cross-platform then needs the resolution to be *multi*-platform rather than single-platform:
resolve for every declared target and record all of them, the way pixi's multi-platform lockfile
and uv's marker-based resolution do, rather than Conda's per-subdirectory solve. And it needs an
explicit statement of what is *not* covered — libc flavour, system libraries outside the graph,
installed toolchains. Docker covers those; a package manager cannot, and pretending otherwise is
the exaggerated claim the brief asked to avoid.

Note the collapse: once E is done correctly it is "the lockfile, plus the runtime, plus a
platform matrix, with requested and resolved kept separate." That is exactly the artifact §9.1
demands. E is not a fifth feature; it is the same feature viewed from the export side, and that
convergence is a good sign the core is correctly identified.

### 9.11 Scorecard

| | Differentiator | Verdict | Reason |
|---|---|---|---|
| **A** | True JS environments + activation | **CUT** | Activation is Python's wart; JS auto-discovers. Runtime pinning survives, per-project (Volta's model) |
| **B** | Environment-level sharing + snapshots | **CUT** | Saves **zero additional bytes** — CAS already captured the win. Snapshots converge on "commit your lockfile" |
| **C** | Global dependency intelligence | **KEEP (small)** | Best demo the project has; must be inode-aware and must not project savings as measurements |
| **D** | Automatic garbage collection | **KEEP** | Real gap. But no-`node_modules` destroys the free `nlink` refcount — needs a roots registry |
| **E** | Environment portability | **RESHAPE** | Correct, but it *is* the core gap seen from the export side. Export inputs, never outputs |

Two of five cut, one kept as a demo, one kept as real engineering, one folded into the core. The
project that remains is narrower than the brief imagined and considerably more defensible.

---

## 10. Architecture

### 10.1 Critique of the proposed layering

The brief's diagram — CLI over Environment Manager over (Dependency Graph Engine | Runtime
Manager) over Resolution Compatibility Layer over Content-Addressable Store over Filesystem
Abstraction Layer — is a reasonable first sketch with five problems, three of which are serious.

**It puts a cut feature at the top of the stack.** "Environment Manager" sits directly under the
CLI, making the named-environment abstraction the organising principle of the entire system. §9.6
and §9.7 removed it. Whatever occupies that slot should be a *project resolver*: given a
directory, find its manifest, compute its environment identity, ensure the store contains what
it needs. There is no global environment namespace to manage.

**It omits the registry client, which is the largest and riskiest subsystem in any package
manager.** Nothing in the diagram fetches anything. In practice this component is where projects
die: scoped packages, multiple registries, `.npmrc` resolution order, auth tokens, corporate
proxies and mirrors, integrity verification, retry and backoff, partial-failure recovery, tarball
edge cases. It is unglamorous, it is most of the compatibility surface a user actually touches,
and leaving it off the diagram is how a project discovers in month four that it has built an
elegant store nobody can populate.

**It omits the lifecycle script executor**, which is precisely where the immutability guarantee
dies. §2.6 VERIFIED that postinstall scripts write into the installed tree at install time. A
design whose central claim is an immutable content-addressed store must have an explicit,
first-class answer for the subsystem that mutates things, not an omission.

Two smaller issues. **"Resolution Compatibility Layer" conflates two components with different
lifecycles, different processes, and — critically — different implementation languages**: the
*resolver* that runs inside the Node process and answers `(issuer, specifier) → path`, and the
*materialiser* that writes a real `node_modules` for tools that cannot be hooked. Splitting them
is the most consequential correction, because the resolver has no language choice (§10.4). And
**"Filesystem Abstraction Layer" understates its job** — it is not a portability shim but a
*capability probe*, since §10.2 VERIFIED that reflink support cannot be assumed and that the
convenient `--reflink=auto` flag degrades silently.

The revised architecture, with the process boundary made explicit because that boundary is the
real structure:

```
        ┌──────────────────────────────────────────────────────────┐
        │  nexus CLI            (native binary — Rust or Go)       │
        ├──────────────────────────────────────────────────────────┤
        │  Project Resolver     manifest → environment identity    │
        ├───────────────┬───────────────┬──────────────────────────┤
        │ Graph Engine  │ Runtime Mgr   │  Registry Client         │
        │ semver, peers │ node ABI,     │  auth, mirrors, .npmrc,  │
        │ conditions    │ toolchain     │  integrity, retry        │
        ├───────────────┴───────────────┴──────────────────────────┤
        │  Lifecycle Executor    postinstall, sandboxed, recorded  │
        ├──────────────────────────────────────────────────────────┤
        │  Store          CAS (per-file) + Integrity Verifier      │
        │                 + Roots Registry + GC (mark & sweep)     │
        ├──────────────────────────────────────────────────────────┤
        │  FS Capability Layer   probe: reflink? hardlink? junction?│
        └──────────────────────────────────────────────────────────┘
                    │ emits                        │ emits
                    ▼                              ▼
        ┌───────────────────────┐    ┌──────────────────────────────┐
        │ .nexus/resolution.json│    │  materialised node_modules   │
        │ (precomputed table)   │    │  (escape hatch, hard-linked, │
        └───────────┬───────────┘    │   on demand only)            │
                    │ read by        └──────────────────────────────┘
                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  nexus/loader        (JavaScript — no choice, runs in    │
        │  registerHooks + Module._resolveFilename patch  Node)    │
        └──────────────────────────────────────────────────────────┘
```

Four changes matter. The registry client and lifecycle executor are named rather than assumed.
The store owns integrity verification, the roots registry and GC, because §9.9 showed those are
store-layout concerns and not bolt-ons. Materialisation is a *sibling output*, not a layer — it
is optional and on demand, matching the conclusion Bun and Deno reached independently (§4.8).
And the loader is drawn below the process boundary, because it is a separate artifact in a
separate language with a separate release cadence, and pretending otherwise causes a versioning
bug in the first month: a table written by CLI *v2* being read by a loader shim *v1* that a
project pinned six weeks ago. The table format needs a version field and the loader needs to
refuse unknown versions loudly.

### 10.2 Package storage

**Recommendation: a per-file content-addressed store of real extracted files, with mode `0444`,
materialised by reflink where available, hard link where not, and copy as last resort — never
archives.**

Taking the brief's options in turn, with evidence.

**Archives — reject.** This is the single clearest lesson available. Yarn PnP's zip store is the
proximate cause of its compatibility problems: §4.5 VERIFIED that native `dlopen` cannot load
from a zip because the kernel needs a real path, and that `fs` patching is invisible to Node's
internal C++ stat bindings. §4.7 VERIFIED that a store of real extracted files preserves
`__dirname`-relative reads, `require.resolve`, and native addon loading. Archives buy inode
count and lose the ecosystem. The counter-argument — archives compress — is answered below.

**Copies — reject as default, keep as fallback.** Copies are what npm and pip do, and §2.2 and
§6.1 VERIFIED the consequence in both ecosystems: distinct inodes, `nlink=1`, full duplication
per project. But they must remain the fallback, because they are the only mechanism that always
works.

**Hard links — the correct default.** VERIFIED to deliver the entire disk win: **387 MB → 79 MB
across five identical environments of real packages** (§6.1). Quote the absolute figures and not
the 4.9× multiple — the multiple is 1 − 1/N and describes the fixture, not the mechanism. Three
properties verified here matter for the design:

```
=== read-only store file: can it still be hard-linked? ===
hard link to 0444 file: OK          mode=444 nlink=2 inode=56483
=== does read-only block the write-through corruption? ===
write BLOCKED (EACCES) - store protected      (even as file owner)
=== is the safe write pattern still available? ===
rename() over the link: OK
  store: nlink=1 inode=56483 content=hello
  proj : nlink=1 inode=56486 content=NEWCONTENT
```

This is the fix for the store-corruption bug VERIFIED in §3.6, and it is better than expected.
Setting store files to `0444` **still permits hard-linking** — link count is a directory
operation, not a write — while **blocking in-place writes even for the file's owner**, including
from Python's `open(path,'w')`. Yet the write-temp-then-`rename()` pattern still works and leaves
the store inode untouched: the directory entry is replaced, not written through.

But `0444` is a speed bump, not a barrier, and the report's earlier framing of it was too
confident. Mode lives on the *inode*, which is exactly why the protection propagates — and
exactly why it can be revoked: VERIFIED, a script holding a hard link can `chmod 0644` **its own
link** and then write straight through to the store, and the content hash no longer matches its
own name. Making the store *directory* `0555` does not help, and `chattr +i` needs root. This is
not hypothetical: npm's own bundled `bin-links` runs `chmod(file, 0o777 & ~umask)` on every
package binary it installs. So `0444` converts accidental corruption into deliberate two-step
corruption, which is worth having, but the actual guarantee has to come from `nexus verify`
re-hashing the store. Adopt both mechanisms, as §3.6 anticipated, and do not describe either as
a guarantee.

Two constraints. Cross-device hard links fail with `EXDEV` (VERIFIED), so the store must share a
filesystem with the projects it serves, which is a genuine deployment constraint on machines with
a small SSD and a large data volume, and needs a clear error rather than a silent copy fallback.
And **hard links to directories are not permitted** (VERIFIED: `hard link not allowed for
directory`), so tree structure must be recreated per project even when file content is shared —
which is where the inode cost in §10.3 comes from.

**Symlinks — for structure only, and preferably not at all.** pnpm uses them to project
structure (§3.2) and it works because Node resolves through them by default (§3.4). But §3.6
listed the costs: symlink-hostile tools, `realpath` surprises, Windows privilege requirements.
In the recommended architecture the resolution table replaces structural symlinks entirely, so
symlinks appear only inside the materialisation escape hatch.

**Junctions — Windows only, and necessary there.** [recalled] Windows symlink creation requires
`SeCreateSymbolicLinkPrivilege` or Developer Mode, which cannot be assumed on a corporate
machine; directory junctions require no privilege. This is why pnpm uses junctions on Windows,
and any materialiser must do the same. Junctions are directory-only and store an *absolute*
target, so a junctioned tree cannot be relocated. They are **not** restricted to one volume — a
volume mount point is itself a junction — but they cannot target a UNC or network path. [recalled]

**Reflinks — best where available, and must be probed.** A reflink shares blocks copy-on-write,
giving hard-link disk economics *plus* copy semantics: a postinstall writing in place diverges
the copy instead of corrupting the store, which removes the entire class of bug §3.6 found. That
makes reflink strictly the best mechanism. The catch is availability, and the sandbox result is
a warning worth quoting:

```
$ cp --reflink=always store/a.txt proj/reflink.txt
cp: failed to clone 'proj/reflink.txt' from 'store/a.txt': Operation not supported
$ cp --reflink=auto store/a.txt proj/reflauto.txt
reflink=auto succeeded (silently fell back to copy)
```

VERIFIED on ext4. **`--reflink=auto` reports success while silently producing a full copy.** Any
implementation that uses `auto`, or that assumes CoW because the platform *usually* has it, will
report disk savings it did not achieve. Probe explicitly at store initialisation, record the
result, and surface the mechanism in `nexus doctor` output.

**Per-file CAS — yes, and copy pnpm rather than Conda or uv.** §3.1 VERIFIED pnpm's per-file
addressing (two different packages sharing a byte-identical `LICENSE` share one inode), and §6.3
VERIFIED that uv keys per *wheel* and therefore misses cross-package dedup entirely. pnpm's
granularity is the best design in either ecosystem; there is nothing to improve and it should be
adopted directly.

One measured caution on the "archives compress" counter-argument, which cuts the other way than
expected. Extracted small files waste substantial space to block allocation — VERIFIED on a
synthetic 1200-package tree: **19 MB apparent, 33 MB on disk, a 1.74× block-slack penalty.**
Archives avoid that. But the slack is paid *once* in a shared store versus once *per project*
with copies, so a shared extracted store still wins by a wide margin — and the honest way to
present the project's numbers is to report `du` actual rather than apparent size, since apparent
size flatters the store-based design's competitors less than it flatters slack.

**Per-platform summary.** VERIFIED rows are marked; the rest is [recalled] and belongs on the
§15 checklist since a storage layer is expensive to get wrong.

| Mechanism | Linux | macOS | Windows |
|---|---|---|---|
| Hard link (file) | yes, same fs (**VERIFIED**; `EXDEV` across, **VERIFIED**) | yes, same volume | yes, NTFS *or* ReFS, same volume, **no privilege needed** (never FAT/exFAT) |
| Hard link (dir) | **not permitted (VERIFIED)** | not permitted | not permitted |
| Max links per file | **65,000 (VERIFIED**, `EMLINK` at 65,000) | ~32,767 | **~1,024** — a blob shared into >1k trees fails with `ERROR_TOO_MANY_LINKS` |
| Symlink | yes | yes | **needs `SeCreateSymbolicLinkPrivilege`, or Developer Mode *plus* `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`** |
| Junction | n/a | n/a | yes, dirs only, no privilege, absolute target only |
| Reflink / CoW | btrfs, XFS (`reflink=1`, default since xfsprogs 5.1), OpenZFS ≥ 2.2, bcachefs; **not ext4 (VERIFIED)** | **APFS: yes, `clonefile()` — effectively universal on modern Macs, but boot volume only and cannot cross volumes** | ReFS block clone only; not NTFS |
| Read-only protects store | **partly (VERIFIED)** — blocks casual writes; holder can `chmod` back | same | ACL-based, weaker |
| Path length limit | ~4096 (syscall limit, not a filesystem limit) | ~1024 (same) | **260 unless long paths enabled — needs *both* the `LongPathsEnabled` policy *and* a `longPathAware` manifest; per-component limit stays 255** |

The practical consequence: **macOS gets the best experience** (APFS clonefile everywhere, so CoW
by default), **Linux is excellent but reflink depends on filesystem** (hard links carry ext4,
which is most desktops), and **Windows is the hard case** — no CoW on NTFS, privileged symlinks,
and `MAX_PATH`. Windows is also where the no-`node_modules` architecture pays off most, because
eliminating the deep tree removes most of the `MAX_PATH` pressure — though not all of it, and the
report should not overclaim here: a store path already spends about 95 characters on the integrity
component before the package's own tree begins, and `materialise` reintroduces the deep tree
wholesale. Worth building the Windows story around, with a long-path probe rather than a promise.

One further Windows constraint that a content-addressed store makes load-bearing: the **~1,024
hard-link ceiling per file** in the table above. A popular blob — an identical `LICENSE`, or a
`tslib` file — shared into more than a thousand trees will start failing, so the linker needs a
per-blob fallback to copy on `ERROR_TOO_MANY_LINKS`. On ext4 the equivalent ceiling is 65,000
(VERIFIED, `EMLINK`), which is far enough away not to matter; on Windows it is not. [recalled] for
the Windows figure specifically, and it is on the §15 checklist.

### 10.3 Resolution: choosing among the three approaches

| | **1. Compatible `node_modules`** | **2. Table-driven resolver** | **3. Custom runtime / patched Node** |
|---|---|---|---|
| **Performance** | resolution = dir walk; install = 8.4k inodes | **table lookup; VERIFIED 224 vs 820 syscalls, 0 vs 779 in `node_modules`, 11.8 ms vs 7.4 ms** | fastest in principle; marginal over 2 |
| **Compatibility** | **perfect — it is the baseline** | good for Node; breaks tools that `readdir` (VERIFIED unfixable, §4.6) | perfect *if* running the custom runtime; zero otherwise |
| **Complexity** | low — pnpm has proven it | moderate; two hook mechanisms required (VERIFIED, §4.4) | very high; a Node fork to maintain forever |
| **Ecosystem adoption** | frictionless | the real risk; Yarn PnP's history is the warning | **fatal** — "install our Node" ends the conversation |
| **IDE support** | works untouched | **needs an SDK shim for `tsc`/`tsserver`/ESLint** | needs everything reconfigured |
| **Debugging** | familiar paths | store paths in stack traces; must stay legible | plus a runtime nobody else can reproduce |
| **Tooling compat** | full | good, with a materialise escape hatch | poor |
| **Distinctiveness** | **"just a pnpm wrapper"** | `ls node_modules` → `ENOENT`, and it runs | distinctive and unadoptable |

**Approach 3 — reject in its strong form.** Shipping a patched Node or a custom runtime is
unadoptable: it forces users onto a second runtime, forces the project to track Node's release
cadence and security patches forever, and breaks every CI image and Docker base. The one
historical data point is instructive — **tink**, npm Inc.'s ~2019 attempt at a no-`node_modules`
Node, died for organisational reasons rather than technical ones [recalled], but it never had to
face the adoption question at scale. There is a *weak* form of Approach 3 that is genuinely
attractive as a long-term play: upstream a resolution-hook API into Node itself so the mechanism
is sanctioned rather than patched. That is a two-year standards effort, and it is the right thing
to want in year three, not month one.

**Approach 1 — reject as the architecture, adopt as an output.** A hard-linked `node_modules` is
perfect on compatibility and is what makes the project usable on day one with Webpack, Jest,
older ESLint configs, and anything that scans the filesystem. But as *the* architecture it is
fatal to the project's premise: it is pnpm's design, it produces pnpm's topology — §2.8 VERIFIED
that even `npm --install-strategy=linked` already gets there — and it earns exactly the
dismissal the brief was most worried about. It also carries the measured cost: **8,401 inodes and
33 MB on disk for a 1,200-package tree, versus one table file**, and `rm -rf` taking 0.27 s versus
under 0.01 s. Quote the table honestly: 80 KB (6 KB gzipped) is a bare name-to-path map, but
VERIFIED at **407 KB (156 KB gzipped)** once the mandatory dependency edges and integrity digests
are present, because base64 digests do not compress. Use the larger pair. Note also that the 33 MB
is essentially the 8,401 × 4 KiB entry floor rather than a property of the packages. That ratio is
still the project's headline number, and Approach 1 forfeits it.

**Approach 2 — choose this, with Approach 1 as an explicit escape hatch.** Four reasons, each
resting on verified evidence.

It is the only option that is *measurably* different rather than rhetorically different. §4.3
VERIFIED **224 versus 820 path syscalls, 9 versus 189 wasted `ENOENT` probes, zero versus 779
`node_modules` syscalls, and 10 ms versus 36 ms** for resolution and load. Combined with the
materialisation numbers above, the demo is a table nobody can wave away.

It is newly cheap in a way it was not when Yarn chose it. §4.7's key insight is that **Yarn
coupled two independent decisions** — table-driven resolution, which is cheap and good, and zip
storage, which was expensive in compatibility. Decoupling them was impractical in 2018 and is
practical now: `module.registerHooks()` is synchronous, in-thread, and VERIFIED to serve **both
CJS and ESM**, where the older `module.register()` is ESM-only. Serving *real extracted files*
from the store rather than zips preserves `__dirname` reads, `require.resolve` and native
`dlopen` (all VERIFIED). §4.7's claim stands: the 2018 price and the 2026 price are different,
and that difference is the whole opportunity.

Its failure mode is narrow and known. The unfixable residue is **discovery by scanning** (§4.6):
a tool that calls `readdir('node_modules')` to enumerate plugins cannot be served by any
resolver hook, because it is not resolving anything. VERIFIED, the resulting state is "loadable
but not discoverable," which is a silent inverted failure — the worst possible shape — so it must
be met with a loud diagnostic and the materialise escape hatch, not with hope.

And it degrades gracefully. `nexus materialise` produces a real hard-linked tree on demand, so
the answer to "my bundler doesn't work" is one command rather than an architectural apology.
This is the convergent conclusion Bun and Deno both reached from opposite directions (§4.8) and
the architecture §10.1 already committed to.

**Three implementation requirements, each earned from a verified failure.** Register *both*
`module.registerHooks()` **and** a `Module._resolveFilename` monkey-patch, because §4.4 VERIFIED
that **`require.resolve` and `module.findPackageJSON` bypass `registerHooks` entirely** — the
sanctioned API alone is insufficient, which is the most surprising finding in the report. Hoist
all hook state to module scope before registering: a hook that calls `require('module')` inside
itself recurses through itself, and this produced **678 nested invocations ending in a stack
overflow from a single failed import** before the state was hoisted. And precompute the table at install time and treat that as
non-negotiable, because a resolver that re-reads `package.json` per resolve measured **866 ms
against plain `node_modules`' 163 ms at 1,200 packages** — it wins on syscalls and still loses
badly on time. That last one is the difference between an architecture and a demo that appears to
work.

**The honest risk ranking**, since the brief asked for adversarial evaluation and this is where
the project most plausibly fails: the top risk is not performance and not correctness but **IDE
and TypeScript integration**. Yarn PnP needs `yarn dlx @yarnpkg/sdks` to make editors work, and
that ongoing tax — every editor, every language server, every linter, forever — did more to
limit PnP adoption than any runtime issue. A project choosing Approach 2 is signing up for the
same tax and should have an answer before writing the store, not after.

### 10.4 Implementation language

The architecture forces one answer before any preference applies: **the loader shim must be
JavaScript**, because it executes inside the Node process via `registerHooks`. There is no
alternative and no FFI escape. So the project is polyglot from day one — a small JS/TS runtime
shim plus a CLI — and the only real question is the CLI's language.

**Best for the MVP: TypeScript on Node**, with one condition attached below. The shim is JS
regardless, so a TS CLI means one language and zero boundary. The semantics that are easy to get
subtly wrong — semver range arithmetic, `exports`/`imports` conditions, peer resolution — have
battle-tested reference implementations available as libraries, and re-deriving them in another
language is where months disappear. The audience can read and contribute to it. Iteration speed
dominates in month one, and the MVP's job is to answer an architectural question, not to be fast.

**Best for production: Rust.** The workload is filesystem-heavy with per-OS syscall divergence —
`linkat`, `clonefile`, `FICLONE`, `CreateHardLinkW`, junctions — and that argues for direct
syscall control rather than a runtime's abstraction, especially given §10.2's finding that
`--reflink=auto` lies. Extraction and hashing are embarrassingly parallel and want real threads.
A single static binary avoids the **bootstrap paradox**: a Node-based JavaScript package manager
must itself be installed by something, which is precisely the awkwardness Corepack exists to
paper over. And the precedent is decisive — uv and pixi/rattler/resolvo both chose Rust for this
exact problem shape, and `resolvo` is an existing PubGrub-style resolver that a JavaScript tool
could plausibly reuse.

**Go** is a defensible second: simpler language, excellent cross-compilation, good concurrency,
faster to write than Rust. It loses on ecosystem gravity for this specific problem — the reusable
resolver and package-handling crates are in Rust — and on zero-overhead FFI, which matters if
the CLI ever needs to be embeddable. GC pauses are irrelevant for a CLI, so that common argument
should not be used. **C++** — no: it accepts memory-safety and build-system costs for no
advantage over Rust here. **Zig** — no, despite genuinely best-in-class cross-compilation:
pre-1.0 language churn is an unforced adoption and contribution risk for a project whose entire
strategy is attracting contributors.

**Should the MVP and production use the same language? No — but the rewrite must be designed
before the MVP is written, or it will never happen.** The condition attached to the TypeScript
recommendation is this: **specify the store layout, the environment manifest, and the resolution
table as versioned, language-neutral formats on paper first.** Then the TS MVP and the eventual
Rust CLI are two implementations of one spec, the JS shim survives both unchanged, and migration
is incremental — replace the CLI, keep the formats, keep the shim. If instead the formats are
"whatever the TypeScript happens to emit," then the rewrite is a genuine rewrite, it will be
scheduled and deferred indefinitely, and the project will ship a slow CLI forever. Projects that
made this transition successfully did so because the on-disk contract was stable; the format spec
is therefore the actual first deliverable, ahead of any code.

If the team has existing Rust fluency, going straight to Rust is the better call, because the
format-spec discipline is easier to hold when there is no rewrite to defer to.

---

## 11. The environment model

### 11.1 What is wrong with the proposed schema

The brief's starting point:

```json
{
  "name": "frontend",
  "runtime": { "node": "22.0.0" },
  "dependencies": { "react": "19.0.0", "vite": "7.0.0" },
  "platform": "win32-x64"
}
```

Six problems, in ascending order of severity.

`name` presupposes the global environment namespace that §9.7 cut, so it should describe the
project, not a shared environment. `"node": "22.0.0"` **pins the wrong granularity** — an exact
patch version forbids `22.11.0`, which is ABI-identical and carries security fixes; the thing
that actually matters is the ABI, so the schema should express an ABI requirement plus a version
*range*. `dependencies` with exact versions **conflates what was requested with what was
resolved**, which is precisely the bug §6.2 identified in `conda env export` and which §6.3
VERIFIED that uv solved by keeping `requires-dist` separate from resolved versions.
`"platform": "win32-x64"` is **singular**, making the manifest non-portable by construction —
Conda's export bug exactly. The schema carries **no identity, no integrity, no build inputs, and
no schema version**, so nothing in it can be verified or migrated.

And the structural error underneath all five: **one file is trying to be both the human-edited
input and the machine-generated output.** npm gets this right with `package.json` plus
`package-lock.json`; Conda gets it wrong, and `conda env export`'s unusability is the
consequence. A manifest that is hand-edited cannot also be a reproducibility artifact.

There is also a compatibility trap worth naming, because requirement 10 of the brief's core
technical question is compatibility with existing `package.json` ecosystems: **inventing a
parallel dependency manifest guarantees drift.** Two files listing dependencies will disagree,
and every tool in the ecosystem reads the other one. So dependencies must stay in
`package.json`, and Nexus should add *only* what `package.json` genuinely cannot express.

### 11.2 The proposed model: three artifacts with three different lifecycles

**Artifact 1 — `package.json`, human-edited, committed.** Dependencies stay where the ecosystem
expects them. `engines.node` stays where the ecosystem expects it. Nexus adds one namespaced key
holding only the things `package.json` cannot say:

```json
{
  "name": "acme-web",
  "engines": { "node": ">=22.11 <23" },
  "dependencies": { "react": "^19.0.0", "vite": "^7.0.0" },
  "devDependencies": { "typescript": "^5.6.0" },

  "nexus": {
    "schemaVersion": 1,
    "runtime": {
      "abi": 127,
      "napi": ">=9",
      "enforce": "error"
    },
    "targets": ["linux-x64-glibc2.28", "darwin-arm64", "win32-x64"],
    "materialize": "auto"
  }
}
```

Everything in that block is something no existing manifest can express. `abi` is the identity
component §9.1 showed is missing everywhere. `enforce` is the field that makes the whole project
worth using — §9.1 VERIFIED that `engines: {"node": ">=99.0.0"}` installs cleanly with exit code
0 on Node 22, so **Nexus's smallest user-visible promise is that `engines.node` finally means
something.** `targets` replaces the singular `platform` and drives multi-platform resolution.
`materialize` controls the §10.3 escape hatch.

Note what is deliberately absent: no environment variables (§9.6 — that is `.env`'s job and
folding it in invites committed secrets), and no package-manager pinning (Corepack's layer, and
the wrong layer).

**Artifact 2 — `nexus.lock`, generated, committed.** Two structural decisions carry it. Requested
and resolved are kept strictly separate, adopting uv's verified design. And a **shared
platform-independent package pool** is indexed by per-target resolutions, so a three-platform
lockfile is not three times the size:

```json
{
  "schemaVersion": 1,
  "requested": {
    "dependencies":    { "react": "^19.0.0", "vite": "^7.0.0" },
    "devDependencies": { "typescript": "^5.6.0" }
  },
  "packages": {
    "react@19.0.0": {
      "integrity": "sha512-…",
      "resolved": "https://registry.npmjs.org/react/-/react-19.0.0.tgz",
      "dependencies": {},
      "hasInstallScript": false,
      "os": null, "cpu": null, "libc": null
    },
    "@rollup/rollup-linux-x64-gnu@4.24.0": {
      "integrity": "sha512-…",
      "hasInstallScript": false,
      "os": ["linux"], "cpu": ["x64"], "libc": ["glibc"]
    }
  },
  "targets": {
    "linux-x64-glibc2.28": {
      "envId": "nx1-4f9c2e8b…",
      "graphHash": "g1-77ae13d0…",
      "runtime": { "abi": 127, "napi": 10 },
      "select": ["react@19.0.0", "vite@7.0.0", "@rollup/rollup-linux-x64-gnu@4.24.0"],
      "edges": { "": {"react":"19.0.0","vite":"7.0.0"},
                 "vite@7.0.0": {"rollup":"4.24.0"} },
      "buildInputs": {}
    },
    "darwin-arm64":  { "envId": "nx1-…", "graphHash": "g1-77ae13d0…", "select": ["…"] },
    "win32-x64":     { "envId": "nx1-…", "graphHash": "g1-77ae13d0…", "select": ["…"] }
  }
}
```

The `edges` map is not decoration. §2.3 and §3.3 established that a dependency graph is not
determined by its node set — which version of `c` a given `b` resolves to is the *edge*, and
peer-dependency resolution changes edges without changing nodes. A lockfile that records only
resolved versions cannot reconstruct the tree unambiguously; recording edges makes the resolution
table (Artifact 3) a mechanical projection rather than a re-derivation.

Notice `graphHash` is identical across all three targets while `envId` differs. That is the
two-level identity of §11.3 doing its job.

**Artifact 3 — `.nexus/resolution.json`, generated, NOT committed.** This is the precomputed
table the loader reads, and the sample schema misses it entirely. It contains absolute store
paths, so it is machine-specific and must be git-ignored; §4.3 VERIFIED that precomputing it is
the entire source of the performance win, and §10.3 VERIFIED that regenerating it lazily
destroys that win. The contract is: **`resolution.json` must be fully reconstructible from
`nexus.lock` plus the local store plus the local runtime, and nothing else.** That property is
what makes the design reproducible rather than merely deterministic-on-one-machine.

**Derived artifacts live outside the store, in a fourth tier.** §6.3 VERIFIED the trap on the
Python side: uv's deduplication stops dead at generated files, because `__pycache__` sits beside
the source and the `.pyc` header embeds the source's mtime and size — `nlink=1` per environment
and a measured 17–25% size overhead on the deduplicated tree. JavaScript has the exact
equivalents: the V8 compile cache, SWC/Babel/ts-node transpile caches, `.tsbuildinfo`, bundler
caches. Three reasons they cannot live in the store: they would require writing into it, which
`0444` correctly forbids (§10.2); they are not addressable by package identity, since they
depend on tool versions; and they are ABI- and target-specific. So they belong in
`~/.nexus/cache/derived/<envId>/`, keyed by environment identity, never beside sources — and
their size must be reported separately in `nexus stat`, because a project that reports 80% disk
savings while silently accumulating a derived cache of comparable size is publishing a
misleading number.

### 11.3 Environment identity, and the graph hash

Two hashes, not one. This is the most important design decision in the model.

```
graphHash = H( canonical( resolved node set with integrities
                        , edge set
                        , resolution config: conditions, dev/optional inclusion,
                                             peer strategy ) )

envId     = H( canonical( graphHash
                        , runtime:  node ABI, napi level
                        , platform: os, arch
                        , libc:     flavour + version floor
                        , buildInputs: per-package install-script hash + toolchain identity
                        , hashSchemaVersion ) )
```

**Why two.** `graphHash` answers "are these the same dependencies?" independently of where they
run. `envId` answers "is this materialisation valid here?" The split is what makes the diagnostic
in §9.2 expressible at all: *your dependency graph is unchanged, but the runtime you are now
using differs from the one this tree was built for.* With a single combined hash the tool can
only say "mismatch," which is exactly the unhelpful state that lets people reach for `--force`.

**What is deliberately excluded from both hashes**, because including any of it makes the hash
non-reproducible and the whole scheme worthless: absolute paths, the store location, `$HOME`,
timestamps, file mtimes, the machine's hostname, the Nexus CLI version, and any environment
variable not explicitly declared as a build input. The CLI version enters only through
`hashSchemaVersion`, which is bumped deliberately when the hashing rules change — and which
makes hash changes a reviewable event rather than an upgrade surprise.

**Canonicalisation is where hash schemes actually fail**, so it needs specifying rather than
assuming. Sort all keys lexicographically by Unicode code point. Serialise with no floating-point
numbers anywhere. Fix the encoding as UTF-8 and normalise to NFC. And **length-prefix every
field before concatenation**, because naive concatenation makes `H("ab","c")` collide with
`H("a","bc")` — a real and embarrassing class of bug in hand-rolled hash constructions. Write
these rules into the format spec (§10.4) before writing code, because changing them later
invalidates every hash in every user's store.

**Runtime compatibility deserves a specific rule**, since this is where a naive implementation
over-constrains and annoys everyone. Hash the **ABI number, not the Node version**. Node 22.11.0
and 22.18.0 share ABI 127 (VERIFIED for the sandbox's 22.22.3), so they must produce the same
`envId` — otherwise every patch upgrade triggers a full rebuild and users disable the feature
within a week. The N-API level is the finer-grained axis: §9.3 noted `process.versions.napi` is 10
on the sandbox and that N-API is deliberately ABI-stable across majors, so a package declaring
only an N-API dependency should ideally *not* be keyed by ABI at all. Which leads to the tiering
that makes this whole scheme cheap.

**The store tiering — and the answer to the obvious objection.** The obvious objection to
ABI-keyed identity is that it multiplies disk usage across runtimes. It does not, if the store is
tiered by whether a package is actually runtime-sensitive:

```
~/.nexus/
├── store/
│   ├── files/<hh>/<sha256>              # per-file CAS, mode 0444, ABI-independent
│   ├── pkgs/<name>@<ver>/<integrity>/   # extracted tree, links into files/
│   └── built/<abiKey>/<name>@<ver>/     # ONLY packages that build or run scripts
├── graphs/<graphHash>.json
├── roots.json
├── cache/derived/<envId>/
└── quarantine/<sweptAt>/
```

Packages with `hasInstallScript: false` and no native artifacts — the overwhelming majority —
live in `pkgs/` and are shared across every ABI, platform and project. Only the small minority
that run install scripts or ship compiled code land in `built/<abiKey>/`. So the marginal cost of
supporting a second Node ABI is the size of that minority, not the size of the store. This is
the mirror image of §9.4's scoping conclusion: JavaScript needs a hash, not a solver, and it also
needs duplication only at the leaves.

**On "immutable versions."** The brief proposed a user-facing version namespace,
`frontend@v1/v2/v3`. §9.7 cut it. The immutability belongs to *content*, not to a human-assigned
label: `envId` **is** the immutable version, it is derived rather than declared, it cannot drift
out of sync with what it names, and it needs no allocation policy, no garbage collection of
version numbers, and no answer to "who gets to increment it."

### 11.4 The roots registry

§9.9 established the problem: a no-`node_modules` architecture destroys the free kernel reference
count, because projects hold no hard links into the store and `nlink` is therefore always 1 for
live and dead content alike. The replacement:

```json
{
  "schemaVersion": 1,
  "roots": [
    { "path": "/home/u/work/acme-web",
      "manifestDigest": "sha256-…",
      "graphHash": "g1-77ae13d0…",
      "envId": "nx1-4f9c2e8b…",
      "lastSeen": "2026-08-25T11:04:00Z",
      "volume": { "id": "…", "removable": false } }
  ]
}
```

Written on every successful install; the store is then a mark-and-sweep heap with these as the
root set, marking transitively through each graph's package set. `manifestDigest` lets a sweep
detect a root whose project has been replaced rather than deleted. `volume.removable` implements
the §9.9 safety rule that an unmounted drive must never be mistaken for a deleted project —
without it, the naive implementation collects a live project's entire closure the first time
someone unplugs an external SSD. `quarantine/` implements the grace period, so recovery is a
`mv` rather than a re-download.

### 11.5 Lockfile strategy, and interoperation

Commit `package.json` and `nexus.lock`. Git-ignore `.nexus/` and any materialised
`node_modules`. `nexus.lock` must be strictly deterministic given the same inputs, and
`nexus install --frozen` must fail rather than update it — including failing when the *runtime*
does not match, which is the behaviour no existing tool has.

Interoperation matters more than format elegance, because a tool that cannot be adopted
incrementally will not be adopted. Three requirements. **Import** from `package-lock.json` and
`pnpm-lock.yaml` so migration is one command and nothing is re-resolved. **Record the digest of
the source lockfile** in `nexus.lock`, so drift between the two is detectable while a project
runs both during transition. And **do not attempt to extend `package-lock.json`** — npm owns that
format, changes it on its own schedule, and a third-party extension will be silently dropped by
the next `npm install`.

### 11.6 Platform metadata, and an explicit statement of limits

Target identifiers need three axes, not one, because the libc axis is a genuine ABI boundary that
`process.platform` does not expose: `linux-x64-glibc2.28`, `linux-x64-musl1.2`, `darwin-arm64`,
`win32-x64`. §6.1 VERIFIED that four different manylinux tags appeared across four packages on a
single machine, which is the same class of problem arriving from the Python side, and §2.7
VERIFIED that npm already expresses `os`/`cpu` — but not `libc` — via `optionalDependencies`.

Resolution must be **multi-target in one pass**, recording every declared target's selection
rather than resolving for the current machine and calling it portable. That is the difference
between uv's marker-based single lockfile and Conda's per-subdirectory solve (§6.2), and the
former is plainly better.

Finally, the manifest should state what it does **not** cover, because §9.10's rule was to export
inputs and never outputs, and the corollary is honesty about scope. Nexus can pin the package
graph, the Node ABI, the platform triple and the build-input hashes. It **cannot** pin the system
libraries outside the graph, the C/C++ toolchain, the glibc actually present at runtime, or
anything else about the machine. Docker and Nix cover those. A package manager claiming full
environment reproducibility is making the exaggerated claim the brief explicitly asked to avoid,
and the credible position is a narrow guarantee stated precisely: **the same `nexus.lock` and the
same `envId` produce the same package tree and refuse to run against the wrong runtime.** That
sentence is defensible, testable, and enough.

---

## 12. Proof of concept and benchmarks

### 12.1 The brief's experiment, and why it cannot be the proof

The brief proposes three projects — A with `react@X` + `vite@Y`, B identical to A, C with a
different React major plus `express@Z` — measuring shared reuse, version isolation, correct
resolution, successful execution, and disk comparison.

Build it. It is the right correctness harness: B validates cross-project sharing, C validates
that two React majors coexist, and all three validate that the resolver serves real applications.

But be clear about what it proves. **pnpm passes this experiment.** Shared store, zero marginal
bytes, two majors side by side, correct resolution, apps run. §3.7 concluded pnpm already delivers
seven of the ten capabilities, and this experiment measures exactly those seven. Publishing it as
the headline result is *volunteering* for the dismissal the brief was most anxious about: it is
the benchmark that makes "just a wrapper around pnpm" look like a fair summary.

So it belongs in the test suite, not in the README. Two additions make it differentiating rather
than confirmatory. Extend it to `ls node_modules` → `ENOENT` while the app runs, which pnpm
cannot do. And extend it with a fourth project D that has a native or postinstall dependency, run
across two Node ABIs — which is §12.2, and which every existing tool fails.

### 12.2 The experiment that actually proves the thesis

This is the demo. It is short, it is reproducible, and **npm, pnpm and Yarn all fail step 4**.

```
1. Node 22 (ABI 127). Project D depends on a package with a postinstall or native addon.
   nexus install ; nexus run start        -> works
2. Record: envId, graphHash, ABI.
3. Switch runtime:  nvm use 20            (ABI 115)
4. Ask each tool whether the tree is still valid:
     npm ci                      -> SUCCESS   (wrong)
     pnpm install --frozen-lockfile -> SUCCESS (wrong)
     yarn install --immutable    -> SUCCESS   (wrong)
     node app.js                 -> ERR_DLOPEN_FAILED, or silently stale data
5. nexus install --frozen
     -> FAILS, exit 1, with:
        "tree was built for Node ABI 127; current runtime is ABI 115.
         graphHash unchanged (g1-77ae13d0). runtime differs. run `nexus install`."
6. nexus install
     -> rebuilds ONLY store/built/<abi115>/…, reuses all of store/pkgs/
     -> nexus run start   works
7. nvm use 22 ; nexus run start
     -> instant. store/built/<abi127>/ was never discarded.
```

Step 5 is the correctness claim. **Step 7 is the one that sells it**, because it converts the
correctness feature into a speed feature: with npm or pnpm, alternating between two Node versions
means rebuilding native dependencies every single time, since neither store can hold two ABI
variants of the same package. With an ABI-keyed `built/` tier both variants persist and switching
is free. A developer maintaining a library across two Node LTS lines, or a CI matrix building on
three, feels that immediately.

Three measurements make step 7 concrete: wall-clock for the second, third and fourth runtime
switch (Nexus flat, competitors linear in native-package count); count of native rebuild
invocations across a six-switch sequence (Nexus 2, competitors 6); and the disk cost of holding
both ABI variants, which §11.3's tiering predicts is small because only install-script packages
duplicate — that prediction must be *measured*, not asserted, since it is the answer to the
obvious objection.

A useful implementation note: §9.1 VERIFIED that a forged `nm_version` in a hand-written
`node_module` struct reproduces the real `ERR_DLOPEN_FAILED` message exactly. So the entire test
can run in CI on a single Node version, with forged-ABI fixtures standing in for a second
runtime. That makes this a fast unit test rather than a slow integration test, which is the
difference between a guarantee that is enforced and one that is aspirational.

### 12.3 Measurement integrity

The brief asked how to avoid exaggerated claims. Most of the risk is not deliberate; it is that
the default tools measure the wrong thing, and they err in the direction that flatters a
store-based design. Six rules, four of them verified here.

**`du` double-counts hard links across invocations.** VERIFIED — one 20 MB blob hard-linked into
three projects:

```
du -sh A : 21M     du -sh B : 21M     du -sh C : 21M     (du -s prints 20484 KiB each)
du -csh A B C (one invocation, total): 21M
ground truth: 20.0 MiB consumed (20,971,520 B), inode=56495 nlink=4
```

`du` deduplicates by inode *within* a single invocation but has no memory *across* invocations.
So the natural scripted measurement — loop over projects, `du -s` each, sum — reports **60.0 MiB
(61,452 KiB) for 20.0 MiB of storage, a 3× overstatement.** Note the second trap layered on the
first: `du -h` rounds *up*, so it displays both 20.0 MiB and the 60.0 MiB sum as "21M" and "63M",
and a report built from `-h` output is wrong even about its own arithmetic. This cuts both ways and
both are damaging: it inflates the "before" figure for competitors that do not share, which is
dishonest, and it inflates the "after" figure for Nexus, making the tool understate its own win.
Correct accounting collects `(inode, size)` pairs and sums the unique set. VERIFIED to give
**20 MB versus 80 MB naive** when the store's own name is walked alongside the three projects —
four names over one inode; across the three project directories alone the naive figure is 60 MB.

**Report actual blocks, not apparent size.** VERIFIED, 2000 one-byte files: **38 KB apparent,
7.9 MB on disk** — a 212× tree-level penalty in the pathological case. Two honest caveats on that
figure, since it is the kind of number that gets quoted without them: 95% of the 38 KB apparent
total is the *directory* inode rather than the files, and the ratio is filename-length dependent
(VERIFIED 212× / 161× / 83× for 1-, 6- and 20-character names), while the true per-file slack is
4096×. The companion figure is 1.74× on the **synthetic** 1200-package tree in §10.2 — synthetic,
not realistic, and the ratio is a free parameter of the fixture's chosen file sizes: VERIFIED to
range 1.02×–6.95× as those sizes vary, where a real `node_modules` on the same host measured
1.36×. Publish the real-tree number. Since the whole argument concerns many small files,
`--apparent-size` is not a neutral choice either way.

**Never claim byte savings from avoiding pnpm's peer duplication.** §3.3 VERIFIED that pnpm's
dependency-set cloning for peer dependencies costs **inodes, directory entries and directory-block
bytes — but not file-content bytes**, because the clones share file inodes. VERIFIED: twenty
hard-linked clones of a 42-entry package cost 160 KiB. This is a widespread misconception and the temptation to cite it as
a disk win will be strong. State it as inode and directory-entry counts, which is what it is, and
which the no-`node_modules` design genuinely improves — from **8,401 inodes to one ~400 KB file**
(VERIFIED, §10.3), with the store's inodes still existing but amortised across every project.

**Report cold and warm separately, and never mix them.** A warm Nexus store against a cold npm
cache is not a benchmark, it is a press release. Publish four cells — cold store / warm store ×
cold registry / warm registry — and let readers pick the one matching their situation. CI is
usually cold-cache; developers are usually warm.

**Count the derived cache.** §11.2's fourth tier — V8 compile cache, transpile caches,
`.tsbuildinfo` — is invisible to a `node_modules`-only measurement and, on the Python analogue,
uv's `.pyc` files added a VERIFIED 17–25% to the installed tree and were VERIFIED unshareable
(`nlink=1` per environment). A headline disk figure that excludes it is measuring the wrong denominator.

**Report variance and hardware, not just means.** Filesystem benchmarks are dominated by the
page cache, the filesystem, and whether the device is NVMe or spinning. Publish medians with
interquartile ranges over at least ten runs, name the filesystem — §10.2 VERIFIED that ext4 has
no reflink while APFS does, which alone can change results several-fold — and publish Windows
numbers even when they are the worst, because a project that only benchmarks Linux is assumed to
be broken on Windows.

### 12.4 Fair comparison protocol

Against npm, pnpm and Yarn the rules are simple and mostly about resisting easy wins.

Run competitors in their **best** configuration, not their default: pnpm with a warm store,
Yarn with `enableGlobalCache`, npm with a populated `_cacache`. A benchmark that beats a
deliberately handicapped competitor is worse than no benchmark, because the correction will come
from the competitor's maintainers in public.

Pin everything and disclose it: exact tool versions, Node version, OS and kernel, filesystem,
and a frozen registry snapshot or local mirror so network variance does not dominate. Use **real
projects** — a Vite React app, a Next.js app, a Nest API, a ten-package monorepo — because
synthetic trees do not exercise peer resolution. The §10.2 and §10.3 measurements in this report
are synthetic and are now labelled as such throughout — an earlier draft asserted they were
labelled while §12.3 was still calling the 1200-package fixture "realistic," which is exactly the
slippage this section exists to prevent.

Publish the harness as a runnable repository, so any disputed number can be reproduced rather
than argued about. And **report the cases where Nexus loses** — first-run install with a cold
store will be slower than nothing, materialisation is strictly worse than pnpm's install because
it is pnpm's install plus a resolution step, and scanning-based tools need the escape hatch. A
benchmark table with no losses in it is read as marketing and discounted entirely; a table with
three honest losses makes the wins credible.

### 12.5 Metrics to collect

| Metric | How | Why it matters |
|---|---|---|
| Unique-inode disk total, all projects | `(inode,size)` unique sum | the headline; naive `du` overstates 3× (VERIFIED) |
| Inodes + directory entries per project | `find \| wc -l` | 8,401 → 1 file, ~400 KB (VERIFIED); drives Windows `MAX_PATH` and CI |
| Cold / warm install wall-clock | 4 cells, median of 10 | the number CI users act on |
| Resolution syscalls per process start | `strace -c -e trace=%file` | 224 vs 820, 0 vs 779 in `node_modules` (VERIFIED) |
| Time to first require, resolution+load | in-process timing | 11.8 ms vs 7.4 ms (VERIFIED) |
| `rm -rf` / teardown time | `time` | 0.27 s vs <0.01 s (VERIFIED) |
| Docker image size and layer count | `docker history` | often the real business case |
| **Native rebuilds across N runtime switches** | counter | **the differentiating metric — 2 vs N** |
| **`--frozen` correctness under ABI change** | pass/fail | **the correctness claim; competitors fail** |
| Derived-cache size | separate `du` | prevents a misleading denominator |
| Materialisation fallback rate | telemetry-free count in `doctor` | honest measure of the compatibility tax |

### 12.6 Which benchmarks would actually make developers care

Ranked by how much they change behaviour, which is not the same as how impressive they are.

**CI cold-install time and Docker image size come first.** These convert directly into money and
into pipeline minutes that someone is already complaining about. Local disk is an annoyance;
CI time is a budget line.

**"Switch Node versions and nothing breaks" is second**, and it is the only item on this list that
no competitor can match. It is also the most *legible*: a thirty-second terminal recording where
`pnpm install --frozen-lockfile` prints success and the app then crashes, followed by
`nexus install --frozen` refusing with a precise reason, needs no explanation and survives being
screenshotted out of context.

**Total disk across all projects is third** — high shock value, low behaviour change, and pnpm
already claims most of it, so leading with it invites the comparison the project should not
invite.

**Process-start syscall counts are last.** They are the most technically satisfying numbers in
this report and they persuade almost nobody outside a small audience, because 26 ms of resolution
time is invisible next to a bundler. Include them as evidence that the architecture is sound;
never lead with them.

One positioning conclusion follows, and it directly answers the brief's instruction that the
project should never claim to replace pnpm unless research proves a genuine advantage: **the disk
benchmark is pnpm's win, and the runtime-identity benchmark is Nexus's.** Lead with the second,
cite pnpm generously for the first, and state plainly that a user who only wants disk savings
should use pnpm. That sentence in a README earns more credibility than any benchmark table, and
it happens to be true.

---

## 13. What to build first, and how to launch it

### 13.1 The MVP, defined by what it must prove

The brief's question — *what can I build that proves this architecture works and cannot be
dismissed as "just a wrapper around pnpm"?* — has a precise answer, because §12.1 established
that the disk demo cannot supply it. The MVP must demonstrate exactly two things pnpm cannot do:

> **Run a real application with no `node_modules` directory anywhere, resolving from a shared
> content-addressed store through a precomputed table; and refuse to run that application when
> the Node ABI it was installed against changes, while `npm ci` and
> `pnpm install --frozen-lockfile` both report success.**

Everything else is scaffolding. If the MVP does those two things on one real project on Linux and
Windows, the architecture is proven. If it does the disk-sharing demo beautifully and neither of
those two, it is a pnpm wrapper and the dismissal is correct.

### 13.2 Milestone 0 — the format spec, before any code

§10.4 argued that if the on-disk formats are "whatever the TypeScript happens to emit," the Rust
rewrite will be deferred forever. So the first deliverable is a written specification, not a
program: the store layout including the `built/<abiKey>/` tier, the `nexus.lock` schema with
`requested` separated from resolved, the `resolution.json` table format with its version field,
and — most importantly — the **canonicalisation and hashing rules** from §11.3, including
length-prefixing, key ordering, and the `hashSchemaVersion` policy. These are the decisions that
cannot be changed later without invalidating every user's store, and they take a day or two to
write down. Doing it first is the highest-leverage hour in the project.

### 13.3 Milestones

**Milestone 1 — store and materialiser (2–3 weeks).** Fetch from the registry, extract to a
per-file CAS with mode `0444`, materialise into a project by reflink where probed available and
hard link otherwise, with an explicit copy fallback and a loud error on `EXDEV`. Ship
`nexus stat` with inode-aware accounting from day one (§12.3), because it is the measurement
harness for everything after. This milestone is deliberately pnpm-shaped and should be presented
as such internally — it is the baseline, and it is the escape hatch of §10.3.

**Milestone 2 — the resolver, and the moment of truth (3–4 weeks).** Precompute
`.nexus/resolution.json` at install time; ship the loader shim registering **both**
`module.registerHooks()` and a `Module._resolveFilename` patch, because §4.4 VERIFIED that
`require.resolve` bypasses the sanctioned API; hoist all hook state to module scope before
registering, because §4.4 VERIFIED that failing to do so produced 678 nested hook invocations and
a stack overflow from one import. Success criterion: a Vite React app builds and serves with **no `node_modules` directory
on disk**, and `strace` confirms zero `node_modules` path syscalls. This is the milestone that
either validates or kills the architecture, and it should be reached before any effort goes into
polish.

**Milestone 3 — runtime identity, the actual product (2–3 weeks).** Implement `graphHash` and
`envId` per §11.3; add the ABI-keyed `built/` tier; make `engines.node` enforceable with
`enforce: error`; implement `nexus install --frozen` failing on runtime mismatch with the precise
diagnostic from §12.2. Test it with forged-ABI fixtures (§9.1) so the guarantee is a fast unit
test rather than a two-runtime integration test.

**Milestone 4 — the compatibility tax (2–4 weeks, and this is the risky one).** TypeScript and
editor integration, per §10.3's risk ranking: `tsc`, `tsserver`, and ESLint must resolve through
the table. Plus `nexus materialise` as the escape hatch, and a diagnostic that detects the
"loadable but not discoverable" failure (§4.6) and tells the user to run it. **Spike this before
Milestone 1**, for two weeks, as a throwaway — because if editor integration cannot be made to
work, Approach 2 is not viable, and §13.10 says what follows from that.

**Milestone 5 — roots registry and GC (1–2 weeks).** `roots.json` per §11.4, mark-and-sweep with
quarantine, `nexus gc --dry-run` as the default, removable-volume safety, and a build lock. Needed
because the no-`node_modules` design destroyed the free `nlink` refcount (§9.9).

Roughly three to four months for one competent engineer to a defensible public alpha, with
Milestone 4's spike front-loaded.

### 13.4 Explicitly out of MVP scope

No named environments, no `nexus activate`, no shared environment namespace (§9.6, §9.7). No
environment variables in the manifest. No Node version *installation* — shell out to `fnm` or
`mise` and read `.node-version`, because reimplementing runtime downloads competes with four
mature tools for zero differentiation. No workspaces or monorepo support in v0, despite their
importance, because they multiply resolver complexity and the architectural question can be
answered on a single package. No custom Node build, no forked runtime (§10.3). No macOS-only or
Linux-only shortcuts in the store layer — §10.2 established Windows is the hard case and also
where the design wins most, so deferring it hides the risk that matters.

### 13.5 The "just a pnpm wrapper" test

Three properties make the dismissal factually false, and each is a one-line demonstration:
`ls node_modules` returns `ENOENT` while the application runs; `nexus install --frozen` exits
non-zero after a Node major switch where `pnpm install --frozen-lockfile` exits zero; and the
store contains an ABI-keyed tier for which pnpm's store has no equivalent axis.

And one negative requirement, which matters more than the three positives: **Nexus must never
shell out to pnpm, npm or Yarn for install, resolution or extraction.** Not in the MVP, not
behind a flag. If any part of the pipeline delegates, the dismissal stops being unfair and
becomes accurate, and no amount of architecture documentation will recover the credibility.
Importing a `pnpm-lock.yaml` is fine — reading a competitor's format is interoperation. Invoking
the competitor is not.

### 13.6 Naming — and a problem with "Nexus"

**"Nexus" should not be the name, and this is worth acting on before any repository is created.**
Sonatype Nexus Repository is one of the most widely deployed private artifact repositories in
enterprises, and it *specifically proxies npm registries*. A JavaScript package manager called
`nexus` would collide with the tool many of its target users already run as their registry, in
exactly the context where the two would be discussed together — "point Nexus at Nexus" is a
support nightmare. There is also a plausible trademark exposure in the same product category,
which is the worst kind. [UNVERIFIED — CHECK] The npm name availability and the trademark
position could not be checked without network access; §15 lists both.

Criteria for a replacement: at most five or six characters for the CLI since it will be typed
constantly, unclaimed on npm, no collision in developer tooling, and ideally evoking *identity
and fit* rather than *storage*, since the storage idea is pnpm's and the identity idea is this
project's.

Candidates, with the reasoning rather than a list of vibes. **`keel`** — four characters, evokes
the structural member that keeps a hull true; suggests stability and correctness rather than
speed, which matches a tool whose main promise is refusing to run when things are wrong.
**`warden`** — evokes enforcement directly, and the product's core behaviour is refusal; slightly
adversarial in tone, which some audiences read as opinionated and others as unfriendly.
**`caliper`** — evokes precise measurement and fit, which maps neatly onto ABI matching; seven
characters is a little long for the CLI, though `cal` aliases well. Of the three, `keel` is the
strongest: short, calm, unclaimed as far as recollection goes, and it does not overpromise.

Whatever the name, **the tagline should not mention Conda.** §8.7 established the analogy is
misleading in the specific direction that damages the project, and a tagline is the one place
where a misleading frame does maximum harm.

### 13.7 Repository structure

Structure should express the §10.1 process boundary, because that boundary is the architecture:

```
keel/
├── SPEC/                      # Milestone 0 — versioned, language-neutral
│   ├── store-layout.md
│   ├── lockfile.md
│   ├── resolution-table.md
│   └── hashing.md             # canonicalisation rules; the load-bearing doc
├── crates/ (or packages/)
│   ├── cli/                   # the native binary
│   ├── store/                 # CAS, integrity, GC, roots
│   ├── resolver/              # semver, peers, conditions
│   └── registry/              # auth, mirrors, .npmrc, retry
├── js/
│   └── loader/                # the shim — JS by necessity, separately versioned
├── bench/                     # runnable harness, real projects, published results
│   ├── fixtures/              # vite-react, next, nest, monorepo
│   └── forged-abi/            # §9.1 technique — CI-testable ABI fixtures
├── docs/
│   ├── architecture.md
│   ├── comparison.md          # honest, includes where we lose
│   └── why-not-conda.md
└── ADR/                       # decision records, including rejected options
```

Two details matter. `js/loader` must be versioned and published **separately** from the CLI, since
§10.1 noted the versioning bug where a table written by CLI v2 is read by a shim v1 pinned six
weeks earlier — the table needs a version field and the shim must refuse unknown versions loudly.
And `bench/` being a first-class runnable directory rather than a results table in a README is
what makes benchmark claims defensible when they are challenged (§12.4).

### 13.8 Documentation

The document that earns technical respect is **`docs/why-not-conda.md`**, and it should exist
before the tool works. §8.7's argument — that Conda's value decomposes into three claims which
get three different verdicts, and that the named-environment claim is the one JavaScript does not
need — demonstrates that the author understands the design space well enough to reject the obvious
framing. Publishing the reasoning for a *rejected* design is the single most credible thing a new
package manager can do, because the audience has seen many tools that did not do this analysis.

Then `docs/comparison.md` with the §7 matrix, including the rows where the project loses, and
`ADR/` recording rejected options — zip storage, named environments, environment-level sharing,
a forked Node — with the reasoning. Architecture documentation for a tool nobody uses yet is read
by exactly the people whose opinion determines whether anyone uses it.

### 13.9 Demo and README positioning

The demo is §12.2, recorded as a terminal session under sixty seconds: `pnpm install
--frozen-lockfile` printing success, the app crashing with `ERR_DLOPEN_FAILED`, then the same
sequence where the tool refuses with a precise reason. It needs no narration, survives being
screenshotted out of context, and shows a bug the viewer has probably hit without diagnosing.

README positioning, in order: state what it does in one sentence about *runtime identity*, not
about disk; show the ABI demo; then a plain paragraph saying **pnpm already solved cross-project
deduplication, this project builds on that idea and credits it, and a user who only wants disk
savings should use pnpm.** That paragraph costs nothing and pre-empts the only criticism that
could otherwise define the project's reception. Then the honest benchmark table including losses,
then the compatibility caveats — scanning tools, editor integration — stated by the project
rather than discovered by users.

Three claims to never make: that it replaces pnpm; that it is "10× faster" without a stated
workload and configuration; and that it provides reproducible environments, since §11.6
established the guarantee is narrower than that and Docker owns the broader claim.

### 13.10 Kill criteria

Stated in advance, because the brief asked for an adversarial evaluation and a project with no
pre-committed failure conditions will rationalise past all of them.

**Abandon or radically re-scope if** the editor and TypeScript spike (§13.4) cannot be made to
work in two weeks, because Approach 2 is then not viable and Approach 1 makes the project a pnpm
reimplementation. **Re-evaluate the framing if** the §9.3 measurement comes back showing that
non-N-API native packages are under 1% of real dependency trees and collapsing, since the acute
demo then lands weakly and the project must stand on the general execution-context argument
alone. **Consider contributing instead of competing if** pnpm ships ABI-keyed store keys and a
frozen-runtime check first — that would be a good outcome for users and the honest response is a
pull request, not a competing tool. And **stop if** `module.registerHooks` is deprecated or its
semantics destabilise, since §4.4 established the architecture rests on it plus a monkey-patch,
and one of those two is already unsanctioned.

None of these are likely enough to prevent starting. All of them are likely enough to write down.

---

## 14. Final verdict

### 14.1 Is the idea technically possible?

```
Yes
```

Not "in principle" — it was built and measured. A store with **no `node_modules` directory
anywhere** served a working application through a precomputed resolution table, including
transitive dependencies, ESM and CJS condition selection, two versions of the same package loaded
simultaneously as distinct module instances, cross-project sharing, and a gcc-compiled N-API
addon loading from a store path. `module.registerHooks()` on Node v22.22.3 is synchronous,
in-thread, and serves both module systems.

Two verified caveats bound that "yes." The sanctioned hook API is **not sufficient on its own** —
`require.resolve` and `module.findPackageJSON` bypass `registerHooks` entirely, so a production
resolver needs an unsanctioned `Module._resolveFilename` monkey-patch alongside it, and that is
a permanent fragility rather than a temporary one. And **discovery by scanning cannot be
intercepted at all**: a tool that calls `readdir('node_modules')` to enumerate plugins is not
resolving anything, so no hook can serve it. The resulting state — "loadable but not
discoverable" — is a silent inverted failure, and it is why materialisation must remain an
escape hatch rather than a fallback nobody needs.

### 14.2 Is the original idea novel?

```
Mostly already solved
```

Eight of the ten capabilities in the brief's own core technical question are delivered today,
seven of them by pnpm. The central question as posed — whether JavaScript projects can have
isolated dependency environments without each maintaining a fully independent physical
`node_modules` — was answered affirmatively by pnpm in 2017 and, more radically, by Yarn PnP in
2018.

The overlaps, specifically. **pnpm** supplies the globally shared immutable store, and at *finer*
granularity than Conda or uv: it addresses per file, so two different packages sharing a
byte-identical `LICENSE` share one inode, and uv was VERIFIED to miss this by keying per wheel.
The marginal disk cost of the Nth project using a package version is already zero bytes. **Yarn
PnP** supplies the no-`node_modules` architecture and O(1) table resolution — closer to the
architectural vision here than pnpm is — and lost on compatibility for reasons §4.5 and §4.6
reproduced from scratch. **nvm, fnm, Volta and mise** supply runtime switching, and Volta already
pins the runtime per project without activation. **npm itself** already ships
`--install-strategy=linked`, which produces pnpm-shaped topology. And **Conda** supplied the
per-file hard-linking model in 2012, roughly a decade before pnpm imported it — which inverts the
project's framing, because the storage idea it proposes to bring from Conda to JavaScript has
already been brought, and improved on.

The blunt version, which §0 stated and the evidence supports: **the part of the original idea
that is novel is the part that should be cut, and the part that is valuable is largely pnpm.**
Named shared environments are the one unbuilt capability, and §8.7 and §9.7 argue they are a bad
fit for JavaScript rather than a hard problem — Node's resolution is lexical, activation is
Python's worst ergonomic wart, environment-level sharing saves zero additional bytes over a
content-addressed store, and Python's own successors are migrating away from named environments
toward per-project.

One genuine gap survives all of that, and it is narrow: **no tool keys an installed tree on the
runtime it was built for.**

### 14.3 The strongest version of the idea

A per-project JavaScript dependency manager whose unit of identity is not the package graph but
the pair *(package graph, execution context)* — where execution context means the Node ABI, the
platform triple, the libc flavour, and the hashes of any install-time build inputs — which serves
dependencies to a stock Node process from a per-file content-addressed store through a
resolution table precomputed at install time, so that no `node_modules` directory exists on disk;
which keys only the small minority of packages that actually run install scripts or ship compiled
code into an ABI-specific `built/` tier, so supporting several runtimes costs almost no disk;
which therefore makes switching Node versions a first-class, verifiable, and *fast* operation,
refusing to run a tree that was built for a different ABI where `npm ci` and `pnpm install
--frozen-lockfile` both report success; which garbage-collects the store by mark-and-sweep from
an explicit roots registry, since eliminating `node_modules` also eliminates the kernel's free
link-count refcount; and which retains on-demand materialisation of a real hard-linked
`node_modules` as an explicit, loudly-diagnosed escape hatch for the tools that discover plugins
by scanning the filesystem and can therefore never be served by any resolver.

### 14.4 The actual innovation, in one sentence

> **Make the runtime part of the installed tree's identity, so that a dependency tree which is
> invalid for the current Node ABI fails loudly at install time instead of silently at runtime —
> and make holding several runtimes' worth of built artifacts nearly free by keying only the
> packages that actually build.**

Everything else in the design is either pnpm's idea executed differently or Yarn's idea executed
at a lower price.

### 14.5 The exact first MVP milestone

Before any code: write `SPEC/hashing.md` and `SPEC/store-layout.md` — the canonicalisation rules
(sorted keys, UTF-8/NFC, no floats, length-prefixed field concatenation), the two-level
`graphHash`/`envId` derivation, the `hashSchemaVersion` policy, and the `built/<abiKey>/` tier.
These cannot be changed later without invalidating every user's store, and they take about two
days.

Then, as the first code milestone and stated as a single falsifiable acceptance test:

> **A Vite React application builds and serves with no `node_modules` directory anywhere on
> disk — verified by `ls node_modules` returning `ENOENT` and by `strace` showing zero
> `node_modules` path syscalls — resolving every module from a per-file content-addressed store
> through a `resolution.json` table precomputed at install time, on both Linux and Windows.**

Two weeks before that, run a throwaway two-week spike on TypeScript and editor integration,
because §13.10 makes it a kill criterion and discovering it late wastes three months.

### 14.6 What to explicitly avoid

The brief asked for this as a list, so:

- **Duplicating pnpm** — do not build a symlink farm, do not build a per-package (rather than
  per-file) store, do not lead with disk-savings benchmarks, and above all do not shell out to
  pnpm for any part of install, resolution or extraction. Cite pnpm generously and state plainly
  that users who only want disk savings should use it.
- **Duplicating Yarn PnP** — do not store packages as zip archives. This is the clearest lesson in
  the report: native `dlopen` needs a real path, `fs` patching is invisible to Node's internal
  C++ stat bindings, and the compatibility cost is what defeated PnP. Store real extracted files.
- **Duplicating npm** — do not build a download cache of tarballs and call it a store; do not
  treat hoisting as a feature to reimplement; do not add another advisory `engines` field.
- **Duplicating Conda** — no named global environments, no `activate`, no shell mutation, no
  build-string solver with `run_exports`-style ABI propagation. JavaScript needs a hash, not a
  solver, because a native JS module is a leaf and there is no equivalent of "everything here must
  link the same OpenBLAS." And do not ship `conda env export`'s bug: keep requested constraints
  separate from resolved versions, and resolve multi-target in one pass.
- **Duplicating nvm and Volta** — do not implement Node version downloading and switching; shell
  out to `fnm` or `mise` and read `.node-version`. The differentiator is that the ABI enters the
  dependency identity, not that a runtime can be installed.
- **Two ideas from the original brief specifically** — environment-level dependency sharing with
  `frontend@v1/v2/v3` snapshots, which saves zero additional bytes over a content-addressed store
  and converges on "commit your lockfile" once made safe; and environment variables in the
  manifest, which conflates configuration with dependency management and invites committed
  secrets.
- **And the name.** "Nexus" collides with Sonatype Nexus Repository, a widely deployed private
  npm registry, in the same product category.

### 14.7 Go or no-go?

```
PIVOT
```

Not NO-GO, because a real and precisely stated gap survived an adversarial pass backed by working
prototypes: installed trees have no verifiable runtime identity, the failure is silent, every
existing tool reports success in the failing case, and the fix is a hash rather than a solver —
a few thousand lines of careful work, not a research programme. Paired with a no-`node_modules`
architecture that is newly affordable in 2026 for reasons §4.7 verified, that is enough for a
focused, defensible tool.

Not GO, because the idea as written — "Conda for JavaScript," named shared environments,
environment-level dependency sharing, activation — is substantially built, and the specific parts
that are not built are the parts that should not be. Proceeding on the original framing means
spending a year rediscovering pnpm and then being told so.

The pivot is precise: **from "a Conda-style environment manager for JavaScript" to "a
runtime-aware, content-addressed dependency manager that eliminates `node_modules` and makes
Node version changes verifiable."** Same store, same performance story, no environments, no
activation, no sharing semantics, and a much smaller surface to defend.

Three cautions attach to that recommendation and none of them should be filed away. **The
addressable market is narrowing** — N-API is deliberately ABI-stable and prebuilt platform
binaries are displacing local compilation, so positioning built on "native modules break when you
switch Node" will age badly, while positioning built on "an installed tree must know its
execution context" does not. **The differentiator is a feature gap, not a moat** — pnpm could add
an ABI component to its store key in a minor release, and the honest response to that would be a
pull request rather than a competing tool. And **the largest risk is not the architecture but the
compatibility tax**: editor and TypeScript integration limited Yarn PnP's adoption more than any
runtime issue did, and a project choosing the same approach signs up for the same tax, which is
why §13.10 makes a two-week spike on it a precondition rather than a later milestone.

---

## 15. Verify before acting

§1.1 set out the confidence levels, and §1.2 argued that no network access mattered less than it
appears because the *mechanism* claims — which carry the argument — were all verified by
construction in the sandbox. What could not be verified is anything about the current competitive
state, and a handful of those facts could move the verdict. This section is the checklist.

### 15.1 The seven sources that would settle it

1. **`https://nodejs.org/api/module.html`** — the stability level of `module.registerHooks()`
   today, and whether `Module._resolveFilename` patching is still viable. The architecture rests
   on both, one of them unsanctioned. *If `registerHooks` has been deprecated or its semantics
   destabilised, §13.10 says stop.*
2. **`https://github.com/nodejs/node/blob/main/doc/abi_version_registry.json`** — the authoritative
   NODE_MODULE_VERSION table. ABI 127 for Node 22 was VERIFIED locally; the mapping for Node 24
   and later is [recalled] and used in §12.2's demo design.
3. **`https://nodejs.org/api/n-api.html`** — the N-API version matrix and current guidance. This
   feeds the §9.3 sizing question, which is the single most important unknown in the report.
4. **`https://github.com/pnpm/pnpm/releases`** — whether pnpm has shipped ABI- or
   runtime-keyed store paths, or a frozen-runtime check. *If it has, the differentiator is gone
   and §13.10's "contribute instead of compete" applies.*
5. **`https://pnpm.io/npmrc`** — the current store version and `package-import-method` options.
   §3.1 carries an explicit conflict between store `v3` and `v10` and this resolves it; it also
   confirms whether reflink (`clone`) is now the default anywhere.
6. **`https://github.com/yarnpkg/berry/releases`** — Yarn's current state, whether PnP is still
   the default, and whether the ESM and native-module gaps have been closed. §4 assumes the 2018
   trade-offs still describe Yarn; if Yarn has already decoupled table resolution from zip
   storage, the opportunity in §4.7 is substantially smaller.
7. **`https://github.com/vltpkg/vlt`** — whether vlt is alive and what it shipped. It is the one
   project that might already occupy this exact position, and its liveness was explicitly
   unverifiable. *This is the check most likely to change GO/PIVOT to NO-GO.*

### 15.2 Secondary checks

`https://mise.jdx.dev/` for whether mise's `npm:` backend has moved from installing CLI tools into
dependency-graph territory, which would narrow the §8.4 residue; `https://github.com/nodejs/corepack`
for Corepack's status and whether it has been removed from the Node distribution, which affects
§9.6's comparison; and the availability and trademark position of any candidate project name on
npm and in the relevant registers, which §13.6 flagged and which is a non-technical but
pre-repository decision.

**The per-OS storage table in §10.2 is the largest remaining `[recalled]` surface**, and a storage
layer is expensive to get wrong, so it gets its own checks. Everything in this report was measured
on Linux and ext4; every Windows and macOS cell is recall. Six specifically:

1. **The NTFS hard-link ceiling** (stated as ~1,024). A per-file CAS concentrates links on exactly
   the popular blobs, so this is load-bearing rather than trivia. ext4's 65,000 was VERIFIED and is
   far enough away to ignore; the Windows figure is not, and the per-blob copy fallback in
   MVP-SPEC §2.3 exists because of it.
2. **Junction semantics** — that they store an absolute target, and whether a junction can cross
   volumes. The first draft of §10.2 asserted "same-volume only," which the review flagged as
   wrong; the corrected text says they can cross but cannot target UNC paths. Confirm before
   relying on either reading.
3. **`SeCreateSymbolicLinkPrivilege` and Developer Mode**, including whether
   `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE` is still required. This decides whether the
   materialiser can use symlinks at all on Windows or must use junctions exclusively.
4. **Long-path support** — that it needs both the `LongPathsEnabled` policy *and* a `longPathAware`
   application manifest, and that the 255-character per-component limit is unaffected.
5. **APFS `clonefile()`** — universality on modern Macs, and that it cannot cross volumes, which
   determines whether reflink can be the macOS default or must still be probed.
6. **Reflink on btrfs, XFS (`reflink=1`), OpenZFS ≥ 2.2 and bcachefs.** `FICLONE` *succeeding* was
   never verified here; only its failure on ext4 was. The entire reflink tier of the design rests
   on a mechanism this report has only ever seen return `ENOTSUP`.

Two quantitative re-measurements also belong on this list, both of them cheap. The **block-slack
ratio on real trees** — 1.74× came from a synthetic fixture and is a free parameter of its file
sizes, where two real trees measured 1.36× and 1.03×, so publish a distribution rather than a
number. And the **resolution-table size at the real schema**: 407 KB / 156 KB gzipped for 1,200
packages was measured on a reconstruction, not on output from a real installer.

Finally, one behaviour that could not be tested in the sandbox at all and that matters for the
`0444` argument: **whether `CAP_DAC_OVERRIDE` bypasses read-only store files.** It does [recalled],
which means every claim about `0444` protecting the store is void inside a Docker build running
postinstalls as root — a common configuration and precisely where a corrupted store would spread.
`nexus verify` is the mitigation regardless, which is why §10.2 now declines to call `0444` a
guarantee.

### 15.3 What would change the verdict, and what would not

**Robust to the checks.** Every mechanism claim: per-file CAS versus per-package, hard links
versus copies, `EXDEV`, the read-only store blocking *casual* write-through while permitting
`rename()` (with the `chmod` bypass of §10.2), reflink needing to be probed because
`--reflink=auto` degrades silently, `du` double-counting across invocations, `nlink` as a refcount,
`require.resolve` bypassing `registerHooks`, hook re-entrancy, precomputation being what converts
the syscall win into a time win, `fs` patching being invisible to Node's C++ stat bindings, a CAS
with no `node_modules` working including native addons, the Python asymmetry and its consequence
for resolver design, `engines` being advisory, the lockfile recording nothing about the runtime,
and the forged-ABI load failure. These were built and measured twice, by independent reviewers
working from fresh fixtures (§1.4); new documentation cannot contradict them.

Also robust: the conclusion that named shared environments are the wrong model for JavaScript.
That rests on the `sys.path`-versus-directory-walk asymmetry and on Python's one-version-per-process
constraint, both VERIFIED, and neither is a competitive fact that can change.

**Would change the verdict.** Check 7 is the sharp one: if vlt already ships runtime-keyed
identity and a no-`node_modules` resolver, the gap is occupied and the recommendation becomes
NO-GO or "contribute there." Check 4 has the same effect from pnpm's direction, with the honest
response being a pull request. Check 3 would change the *framing* rather than the verdict — if
non-N-API native packages are a vanishing fraction, the acute demo weakens and the project must
stand on the general execution-context argument alone, which is a harder sell but still a real
one. Check 6 would shrink the §4.7 opportunity if Yarn has already decoupled storage from
resolution. And check 1 is existential: the architecture has no foundation without a stable
resolution hook.

Everything in §14 assumes those seven come back roughly as expected. Two of them plausibly do
not, so run them first — the whole checklist is about an hour's work with a browser, and it is
the cheapest hour available before committing three months.

---

*Prepared 2026-08-25. Mechanism claims verified by construction in a Linux sandbox
(Node v22.22.3, npm 10.9.8, uv 0.11.19, ext4), then independently re-measured from fresh fixtures
by two adversarial reviewers; §1.4 records the seven figures that pass retracted. Competitive and
version-specific claims are labelled `[recalled]` or `[UNVERIFIED — CHECK]` inline and collected
in §15.*
