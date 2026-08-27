# MVP Engineering Specification

**Companion to [RESEARCH.md](./RESEARCH.md). Read §14 of that document first —
this spec implements the pivoted scope, not the original brief.**

Prepared 2026-08-25

---

## 0. Scope

This is the buildable specification for the narrowed project that RESEARCH.md §14.7 recommends.
It deliberately omits everything that evaluation cut: named environments, shell activation,
environment-level dependency sharing, environment variables in the manifest, and Node version
installation.

**The MVP exists to prove exactly two claims.** Everything here serves one or the other.

> **Claim 1.** A real application runs with no `node_modules` directory anywhere on disk,
> resolving from a shared per-file content-addressed store through a table precomputed at
> install time.
>
> **Claim 2.** When the Node ABI changes, `install --frozen` fails with a precise diagnostic,
> where `npm ci` and `pnpm install --frozen-lockfile` both report success.

Claim 1 makes the project architecturally distinct from pnpm. Claim 2 makes it *useful*. A
milestone that does not advance one of them is out of scope for the MVP.

The working name below is `keel`, for the reasons in RESEARCH.md §13.6 — **"nexus" collides with
Sonatype Nexus Repository, a widely deployed private npm registry, in the same product
category.** Substitute freely; the CLI name appears only in §4.

---

## 1. Milestone 0 — the format spec, written before any code

The store layout, lockfile schema, resolution-table schema, and hashing rules must be written as
versioned prose documents first. Two reasons. They cannot be changed later without invalidating
every user's store. And RESEARCH.md §10.4 recommends a TypeScript MVP with a Rust production
implementation — a migration that only stays feasible if the on-disk contract is a spec that two
implementations read, rather than whatever the first implementation happened to emit.

Budget: two days. Deliverables: `SPEC/store-layout.md`, `SPEC/lockfile.md`,
`SPEC/resolution-table.md`, `SPEC/hashing.md`.

### 1.1 Canonicalisation and hashing rules

These are the load-bearing rules. Hash schemes fail here, not in the choice of hash function.

Use SHA-256 throughout; store digests as lowercase hex with a scheme prefix (`sha256-…`).
Serialise to canonical JSON: keys sorted lexicographically by Unicode code point, UTF-8 encoded,
normalised to NFC, no floating-point numbers anywhere, no insignificant whitespace.

**Length-prefix every field before concatenation.** Without this, `H("ab","c")` collides with
`H("a","bc")` — a real class of bug in hand-rolled hash constructions. Concretely, each field is
fed as `<byte-length as u32 big-endian><bytes>`.

**Never put a registry `integrity` value in a path.** Registry integrity arrives as *standard*
base64, whose alphabet includes `/` and `+`. Verified over 2,000 sha512 digests: **74.1% contain a
`/`** and 73.1% contain a `+` (the theoretical rate is 1 − (63/64)^86 = 0.742). Used as a directory
name, three quarters of all packages would silently acquire an extra path component — and on
Windows a path separator in the middle of a name. Re-encode to lowercase hex before the value
touches the filesystem, and write it with a distinct prefix so the two encodings can never be
confused: `sha512hex-<128 hex chars>`. The rule above about the project's own digests applies to
borrowed ones too.

Two hashes, per RESEARCH.md §11.3:

```
graphHash = "g1-" || H( node set with integrities
                      , edge set
                      , resolution config: conditions, dev/optional inclusion, peer strategy )

envId     = "nx1-" || H( graphHash
                       , runtime:  nodeAbi, napiLevel
                       , platform: os, arch
                       , libc:     flavour, versionFloor
                       , buildInputs: {package -> installScriptHash, toolchainId}
                       , hashSchemaVersion )
```

Hash the **ABI number, not the Node version.** Node 22.11.0 and 22.18.0 share ABI 127 and must
produce the same `envId`; if patch upgrades trigger rebuilds, users will disable the feature
within a week.

**Excluded from both hashes, without exception:** absolute paths, store location, `$HOME`,
hostname, timestamps, file mtimes, the CLI version, and any environment variable not declared as
a build input. The CLI version enters only through `hashSchemaVersion`, bumped deliberately so
hash changes are a reviewable event rather than an upgrade surprise.

The `edges` set is not optional. A dependency graph is not determined by its node set — which
version of `c` a given `b` resolves to is an edge, and peer resolution changes edges without
changing nodes (RESEARCH.md §2.3, §3.3). Omitting edges makes the resolution table a re-derivation
instead of a projection.

---

## 2. Store layout

```
~/.keel/
├── store/
│   ├── files/<hh>/<sha256>              # per-file CAS, mode 0444
│   ├── pkgs/<name>@<ver>/<integrityHex>/ # extracted tree; entries link into files/ (§1.1)
│   └── built/<abiKey>/<name>@<ver>/     # ONLY packages that build or run scripts
├── graphs/<graphHash>.json
├── roots.json                           # GC root set
├── cache/
│   ├── tarballs/<integrityHex>          # network cache, prunable independently
│   └── derived/<envId>/                 # V8 compile cache, transpile output, .tsbuildinfo
├── quarantine/<sweptAt>/                # GC grace period
└── config.json                          # probed FS capabilities
```

### 2.1 Content-addressed files

Address **per file, not per package.** RESEARCH.md §3.1 verified that pnpm's per-file granularity
lets two *different* packages sharing a byte-identical `LICENSE` share one inode, and §6.3 verified
that uv keys per wheel and therefore misses cross-package dedup entirely. pnpm's granularity is
the best design in either ecosystem; copy it directly.

Shard by the first two hex characters of the digest (`files/9f/9f3a…`) to keep directory sizes
manageable.

**Set mode `0444` on every store file.** This is the fix for a verified bug — pnpm's store can be
silently corrupted by a postinstall writing through a hard link, after which store content no
longer matches its own content-addressed name. Verified behaviour of `0444`:

- hard-linking a `0444` file still works (link count is a directory operation, not a write)
- in-place writes are blocked with `EACCES` **even for the file's owner**, including from
  Python's `open(path,'w')`
- write-temp-then-`rename()` still works, and leaves the store inode untouched — the directory
  entry is replaced, not written through
- **but the holder of a link can `chmod 0644` its own link and then write straight through**,
  because mode lives on the shared inode — verified, and the store's content no longer matches its
  own name afterwards

So `0444` blocks the *accidental* write-through and forces any corruption to be a deliberate
two-step act. It is not a barrier. Making the store directory `0555` does not help and `chattr +i`
needs root; meanwhile npm's own bundled `bin-links` runs `chmod(file, 0o777 & ~umask)` on every
package binary it installs, so scripts that adjust modes are the norm rather than the exception.
Treat `0444` as defence in depth and put the actual guarantee in `keel verify`, which re-hashes
store contents against their names.

### 2.2 The `built/` tier — the core of the design

Packages are classified at install time:

| Class | Condition | Location | Shared across ABIs |
|---|---|---|---|
| **pure** | no install script, no `.node` files, no platform constraints | `pkgs/` | yes |
| **built** | `hasInstallScript`, or ships/produces `.node` | `built/<abiKey>/` | no |

`abiKey` is `node<ABI>-<os>-<arch>-<libc>`, e.g. `node127-linux-x64-glibc`.

This tiering is the answer to the obvious objection that ABI-keyed identity multiplies disk usage.
It does not: the overwhelming majority of packages are pure and shared across every ABI, platform
and project, so the marginal cost of supporting a second runtime is the size of the built minority.
**This prediction must be measured in the benchmark harness (§6), not asserted** — it is the single
number most likely to be challenged.

### 2.3 Filesystem capability probing

Probe once at store initialisation, record in `config.json`, and surface in `keel doctor`.

| Capability | Probe | On failure |
|---|---|---|
| reflink | `ioctl(FICLONE)` / `clonefile()` on a temp pair | fall back to hard link |
| hard link | `link()` store→project temp | fall back to copy, warn |
| same filesystem | compare `st_dev` | **hard error**, not silent copy |
| link-count ceiling | `link()` in a loop to first `EMLINK` | copy that blob instead; per-blob, not global |
| junction (Windows) | create + remove a temp junction | materialisation unavailable |
| long paths (Windows) | create a >260-char path | warn; recommend no-materialise mode |

The link-count probe matters more than it looks. ext4 allows 65,000 links per file (verified,
`EMLINK` at exactly 65,000) but Windows allows roughly 1,024 [recalled], and a per-file CAS store
concentrates links precisely where the ceiling bites: one identical `LICENSE` or `tslib` blob shared
into every tree on the machine. The fallback must be per-blob, so that one popular file degrading to
copies does not disable linking for the whole store.

**Never use `cp --reflink=auto` or its API equivalent.** Verified: on ext4 it reports success and
silently produces a full copy. An implementation that trusts `auto` will report disk savings it
did not achieve.

Preference order for materialisation: **reflink → hard link → copy.** Reflink is strictly best
because it gives hard-link disk economics with copy semantics, so an in-place write diverges the
copy rather than corrupting the store — eliminating the §2.1 bug class entirely rather than
merely blocking it. Availability is the constraint: APFS supports it (effectively universal on
modern macOS), btrfs and XFS with `reflink=1` support it, **ext4 does not** (verified), and NTFS
does not.

Cross-device hard links fail with `EXDEV` (verified). This must be a clear actionable error
naming both paths and suggesting `KEEL_STORE_DIR`, not a silent degradation to copies.

---

## 3. Manifest and lockfile

### 3.1 `package.json` — human-edited, committed

Dependencies stay in `package.json`. A parallel dependency manifest guarantees drift, and every
other tool in the ecosystem reads `package.json`. Add only what it cannot express:

```json
{
  "name": "acme-web",
  "engines": { "node": ">=22.11 <23" },
  "dependencies": { "react": "^19.0.0", "vite": "^7.0.0" },

  "keel": {
    "schemaVersion": 1,
    "runtime": { "abi": 127, "napi": ">=9", "enforce": "error" },
    "targets": ["linux-x64-glibc2.28", "darwin-arm64", "win32-x64"],
    "materialize": "auto"
  }
}
```

`enforce` is the field that makes the project worth using. Verified: `engines: {"node":
">=99.0.0"}` installs with exit code 0 on Node 22 — npm prints `npm warn EBADENGINE Unsupported
engine` and proceeds anyway — because npm's engine check gates *dependencies*, not the root project.
A warning nobody reads on a field nobody trusts is the status quo being replaced. **The smallest user-visible promise here is that
`engines.node` finally means something.**

`enforce` values: `error` (refuse), `warn`, `off`. Default `error` — the guarantee must be the
default, not a flag, or it does not differentiate.

`materialize`: `never` | `auto` | `always`. `auto` materialises only after a scanning failure is
detected (§4).

Deliberately absent: environment variables (that is `.env`'s job; folding it in invites committed
secrets) and package-manager pinning (Corepack's layer, and the wrong layer).

### 3.2 `keel.lock` — generated, committed

Two structural decisions. Requested and resolved are kept strictly separate — this is
`conda env export`'s bug and uv's verified fix. And a **shared platform-independent package pool**
is indexed by per-target selections, so a three-platform lockfile is not three times the size.

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
      "peerDependencies": {},
      "hasInstallScript": false,
      "class": "pure",
      "os": null, "cpu": null, "libc": null
    },
    "@rollup/rollup-linux-x64-gnu@4.24.0": {
      "integrity": "sha512-…",
      "hasInstallScript": false,
      "class": "pure",
      "os": ["linux"], "cpu": ["x64"], "libc": ["glibc"]
    }
  },
  "targets": {
    "linux-x64-glibc2.28": {
      "envId": "nx1-4f9c2e8b…",
      "graphHash": "g1-77ae13d0…",
      "runtime": { "abi": 127, "napi": 10 },
      "select": ["react@19.0.0", "vite@7.0.0", "@rollup/rollup-linux-x64-gnu@4.24.0"],
      "edges": {
        "":              { "react": "19.0.0", "vite": "7.0.0" },
        "vite@7.0.0":    { "rollup": "4.24.0" }
      },
      "buildInputs": {}
    },
    "darwin-arm64": { "envId": "nx1-…", "graphHash": "g1-77ae13d0…", "select": ["…"] },
    "win32-x64":    { "envId": "nx1-…", "graphHash": "g1-77ae13d0…", "select": ["…"] }
  },
  "importedFrom": { "kind": "pnpm-lock.yaml", "digest": "sha256-…" }
}
```

`graphHash` is identical across targets while `envId` differs — the two-level identity doing its
job, and what makes the §4.3 diagnostic expressible.

Resolution is **multi-target in one pass.** Resolving for the current machine and calling the
result portable is Conda's per-subdirectory bug.

Target identifiers carry three axes because libc is a genuine ABI boundary that
`process.platform` does not expose: `linux-x64-glibc2.28`, `linux-x64-musl1.2`, `darwin-arm64`,
`win32-x64`.

`importedFrom` records the digest of a migrated `package-lock.json` or `pnpm-lock.yaml`, so drift
is detectable while a project runs both during transition. **Do not attempt to extend
`package-lock.json`** — npm owns that format and will silently drop third-party additions.

### 3.3 `.keel/resolution.json` — generated, git-ignored

The precomputed table the loader reads.

```json
{
  "schemaVersion": 1,
  "envId": "nx1-4f9c2e8b…",
  "storeRoot": "/home/u/.keel/store",
  "entries": {
    "": { "loc": "/home/u/work/acme-web",
          "deps": { "react": "react@19.0.0", "vite": "vite@7.0.0" } },
    "react@19.0.0": { "loc": "pkgs/react@19.0.0/sha512hex-…", "deps": {} },
    "vite@7.0.0":   { "loc": "pkgs/vite@7.0.0/sha512hex-…",
                      "deps": { "rollup": "rollup@4.24.0" } }
  }
}
```

Contains absolute store paths, so it is machine-specific and **must be git-ignored.** The
reproducibility contract: `resolution.json` must be fully reconstructible from `keel.lock` plus
the local store plus the local runtime, and nothing else.

**It must be precomputed at install time, and it must be precomputed all the way down to entry
files.** This is the single easiest way to build a version of this project that is slower than the
`node_modules` it replaces, so the requirement is stated as a contract rather than a suggestion.

A resolver that re-reads `package.json` during resolution *does* cut syscalls against the directory
walk — roughly twofold, since it never probes ancestor directories that do not exist — but it
measured **866 ms against plain `node_modules`' 163 ms across 1,200 packages**, because one
synchronous read in the hot resolve path costs more than every `ENOENT` probe it eliminates. (An
earlier draft cited 55 syscalls against 56, i.e. parity; that figure did not reproduce and is
retracted. The direction of the conclusion is unchanged and the reason for it is different.)

The `entries` shape above is therefore **not sufficient as a resolve-time structure**. `loc` is a
directory and `deps` maps a specifier to a package key, so serving a bare `require('react')` from it
still means locating the requesting package from `parentPath` and then reading the target's
`package.json` to find its entry file — a scan and a read, not a table hit. A faithful
implementation of the literal schema measured **5.3× slower than `node_modules`**. Two additional
precomputed maps are mandatory:

- `dirmap`: realpath prefix → owning package key, resolved by longest prefix, so `parentPath` →
  owner is a lookup rather than a walk
- `flat`: `${ownerKey}\0${specifier}` → **absolute path of the entry file**, with the entry field,
  conditional `exports`, subpath `exports` and `imports` all expanded at install time, per
  condition set

With those present, resolution reads no `package.json` at all and the O(1) claim is true. Without
them it is marketing. Emit `flat` for every `(owner, specifier)` pair the graph permits, including
subpaths — the count is bounded by the graph and this is a build-time cost.

One syscall floor survives even a perfect table: Node still stats and opens the nearest
`package.json` per package to decide CJS versus ESM. Verified: naming pre-resolved entry files
`.cjs` collapses that to one syscall. Do this in Milestone 2.

`schemaVersion` is mandatory and the loader must refuse unknown versions loudly, because the CLI
and the loader shim ship separately and a v2 table will eventually meet a v1 shim.

### 3.4 Derived artifacts

`cache/derived/<envId>/` holds the V8 compile cache, SWC/Babel/ts-node output, `.tsbuildinfo`, and
bundler caches. Never beside sources, for three reasons: writing there would require writing into
a `0444` store; they are not addressable by package identity because they depend on tool versions;
and they are ABI- and target-specific.

The precedent is verified on the Python side — uv's deduplication stops dead at `__pycache__`
because the `.pyc` header embeds the source's mtime and size, giving `nlink=1` per environment and a
measured 17–25% size overhead on the deduplicated tree (Pillow 16.6%, numpy 25.4%). Report this tier's size **separately**
in `keel stat`; a headline disk saving that excludes it is measuring the wrong denominator.

---

## 4. CLI surface

Small on purpose. Every command below serves Claim 1 or Claim 2.

| Command | Behaviour |
|---|---|
| `keel install` | Resolve, fetch, populate store, write `keel.lock` + `.keel/resolution.json`, register root. Rebuilds the `built/` tier if the ABI changed. |
| `keel install --frozen` | **Claim 2.** Verify lockfile *and* runtime. Non-zero exit on any mismatch. Never writes `keel.lock`. |
| `keel add <pkg>` / `remove` | Update `package.json`, re-resolve, re-emit. |
| `keel run <script>` | Run a `package.json` script with the loader shim injected via `NODE_OPTIONS=--import`. No activation, no shell state. |
| `keel exec <cmd>` | As above for arbitrary commands. |
| `keel materialize` | Write a real hard-linked `node_modules`. The escape hatch. |
| `keel unmaterialize` | Remove it. |
| `keel stat` | Inode-aware disk accounting (§6.2). Derived cache reported separately. |
| `keel doctor` | Probed FS capabilities, link mechanism in use, ABI, store health, materialisation status. |
| `keel verify` | Re-hash store content against its own names. Detects the §2.1 corruption class. |
| `keel gc --dry-run` | Mark-and-sweep report. **`--dry-run` is the default**; sweeping requires `--yes`. |
| `keel import` | Migrate from `package-lock.json` / `pnpm-lock.yaml` without re-resolving. |

**No `keel activate`.** No global environment namespace. No `keel node install` — read
`.node-version` and shell out to `fnm` or `mise`.

### 4.1 Execution model

`keel run` sets `NODE_OPTIONS=--import <shim>` and executes. No shell mutation, no `PATH`
rewriting, no stateful activation — the Volta and `uv run` model, which RESEARCH.md §5.2 and §9.6
argue is strictly better than Python's activation.

Binaries from `bin` fields are exposed via a per-project `.keel/bin/` prepended to `PATH` for the
child process only.

### 4.2 The loader shim

Published separately from the CLI, versioned independently, JavaScript by necessity — it runs
inside the Node process.

**Three requirements, each earned from a verified failure.**

**Register both hooks.** `module.registerHooks()` is synchronous, in-thread, and serves both CJS
and ESM (where the older `module.register()` is ESM-only and fails for CJS `require` outright).
But **`require.resolve` and `module.findPackageJSON` bypass `registerHooks` entirely** — verified,
the hook is never invoked. So the shim must *also* monkey-patch `Module._resolveFilename`. This is
the most surprising finding in the research and the most likely thing for an implementer to miss.

**Hoist all hook state to module scope before registering.** A hook that calls `require('module')`
inside itself recurses through itself. Verified: this produced **678 nested hook invocations ending
in one `RangeError: Maximum call stack size exceeded`** from a single failed import. Hoisting state
to module scope drops it to one invocation at depth one; the builtins `Set` alone drops it only to
two, so hoisting is the load-bearing half and the `Set` is the cheap half.

**Decline builtins explicitly.** The hook *is* invoked for `fs` and `node:fs` — being a builtin does
not exempt a specifier from the hook. This is why the guard exists and why it must be the first
statement in both the hook and the patch.

**Know which entry points each layer covers.** Verified per entry point on v22.22.3: the hook serves
`require`, static and dynamic `import`, `import.meta.resolve` and `createRequire()(spec)`; the patch
serves `require.resolve` and `createRequire().resolve`; **`module.findPackageJSON` is served by
neither** and will throw `ERR_MODULE_NOT_FOUND` against a store path. The hook runs first, so a hit
short-circuits the patch — but a *miss* runs both, so `lookup` executes twice per miss and must be
cheap on the miss path. Neither layer propagates to child processes except through
`NODE_OPTIONS=--require`; an explicit `--require` does not survive a spawn.

**Serve real extracted files, never archives.** Verified: native `dlopen` cannot load from a zip
because the kernel needs a real path, and `fs` patching is invisible to Node's internal C++ stat
bindings (`internalModuleStat`) — patched `fs.existsSync`/`readFileSync` returned correct data
while `require()` of the same path threw `MODULE_NOT_FOUND`. Serving real files from `pkgs/`
preserves `__dirname`-relative reads, `require.resolve`, and native addon loading (all verified,
including a gcc-built N-API module loaded from a store path).

Skeleton:

```js
// ---- hoisted BEFORE registerHooks: all state, no lazy requires in the hot path ----
const Module = require('node:module');
const { builtinModules } = Module;
const BUILTINS = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const TABLE = JSON.parse(require('node:fs').readFileSync(tablePath, 'utf8'));
if (TABLE.schemaVersion !== 1) throw new Error(`keel: unsupported table v${TABLE.schemaVersion}`);

// O(1) by construction: `dirmap` is a longest-prefix map realpath -> owner key, and `flat` is
// keyed `${owner}\0${specifier}` -> ABSOLUTE ENTRY FILE, pre-expanded at install time across
// entry field, conditional exports, subpath exports and `#` imports. No package.json is read
// here. Returns null for anything the table does not own, so the real resolver still runs.
function lookup(specifier, parentPath) {
  if (BUILTINS.has(specifier)) return null;            // must be first — the hook sees builtins
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('data:') || specifier.startsWith('file:')) return null;
  const owner = TABLE.dirmap.lookupLongestPrefix(normalise(parentPath));
  if (owner === undefined) return null;
  return TABLE.flat[owner + '\0' + specifier] ?? null;
}

// `parentURL` (hook) and `parent.filename` (patch) are different shapes for the same thing.
// Normalising in exactly one place is not optional; skipping it mis-resolves silently on Windows.
function normalise(p) {
  return p && p.startsWith('file:') ? require('node:url').fileURLToPath(p) : p;
}

function resolve(specifier, context, nextResolve) {
  const hit = lookup(specifier, context && context.parentURL);
  if (!hit) return nextResolve(specifier, context);
  // `context.conditions` is delivered here and MUST select among pre-expanded variants:
  //   CJS  -> ["require","node","node-addons","module-sync"]
  //   ESM  -> ["node","import","module-sync","node-addons"]
  // Ignoring it hands ESM importers the CJS `main`, which is a silent wrong-answer bug.
  return { url: pathToFileURL(hit).href, shortCircuit: true, format: formatOf(hit) };
}

Module.registerHooks({ resolve /*, load — only needed for in-memory or rewritten sources */ });

// `require.resolve` and `createRequire().resolve` bypass the hook entirely — patch as well
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (!BUILTINS.has(request) && !(options && options.paths)) {
    const hit = lookup(request, parent && parent.filename);
    if (hit) return hit;                      // returned un-stat'd; do not touch fs
  }
  return origResolveFilename.call(this, request, parent, isMain, options);
};
```

**Known gaps in the skeleton above, each reproduced against a faithful reconstruction.** They are
listed rather than hidden because every one of them is a day-one bug report:

- **Subpaths must be in `flat` or nothing works.** Without them `require('app-dep/sub')` throws
  `MODULE_NOT_FOUND` and `import('app-dep/sub')` throws `ERR_MODULE_NOT_FOUND` — which takes out
  `react-dom/client` and `lodash/merge` on the first real project.
- **Conditions must be honoured.** A hook that ignores `context.conditions` returns the CJS `main`
  to an ESM importer. Verified: it fails silently, with a wrong object rather than an error.
- **`#` internal imports and package self-reference** need their own `flat` entries, or they throw
  `ERR_PACKAGE_IMPORT_NOT_DEFINED`.
- **Stale-table diagnostics.** Returning a path un-stat'd is the right performance call, but a
  deleted store entry then surfaces as a raw `ENOENT … open '/home/u/.keel/store/…'`. Wrap
  `Module._load` failures once and re-issue as `keel: store entry missing, run `keel verify``.
- **`isMain` and `options.paths`** are deliberately declined above; confirm that is acceptable for
  the target tooling rather than assuming it.
- Verified working, and worth *not* re-litigating: builtins and the `node:` prefix, relative
  specifiers, extensionless and directory-index resolution, `data:` and `file:` URLs, `__dirname`
  through symlinked store paths, native `.node` addons loaded from the store, and
  `--preserve-symlinks`.

### 4.3 The `--frozen` diagnostic

Claim 2's entire user-visible surface. It must name the axis that changed, because a bare
"mismatch" is what drives people to `--force`:

```
$ keel install --frozen
error: installed tree is not valid for the current runtime

  graphHash   g1-77ae13d0…   unchanged
  built for   Node ABI 127   (node 22.22.3)
  running     Node ABI 115   (node 20.18.1)

  3 packages have ABI-specific artifacts:
    better-sqlite3@11.5.0   native
    sharp@0.33.5            native
    esbuild@0.24.0          postinstall

  run `keel install` to build for ABI 115
  (ABI 127 artifacts are retained; switching back is instant)

exit 1
```

The last line is the sales pitch. With npm or pnpm, alternating between two Node versions rebuilds
native dependencies every time, because neither store can hold two ABI variants of one package.

### 4.4 Detecting the unfixable failure

Discovery by scanning cannot be intercepted by any hook — a tool calling
`readdir('node_modules')` to enumerate plugins is not resolving anything. Verified, the resulting
state is **"loadable but not discoverable,"** a silent inverted failure.

Mitigation: the shim patches `fs.readdir`/`readdirSync` for paths under `node_modules` **purely to
detect the attempt**, emits one clear diagnostic naming the calling module, and — under
`materialize: auto` — offers `keel materialize`. Do not attempt to *satisfy* the scan; a synthetic
listing whose entries do not exist on disk produces a worse failure than an honest one.

---

## 5. Milestones

| # | Deliverable | Est. | Acceptance test |
|---|---|---|---|
| **−1** | **Editor/TS spike (throwaway)** | 2 wk | `tsc --noEmit` and `tsserver` resolve through a hand-written table on a real TS project |
| **0** | Format spec | 2 d | `SPEC/hashing.md` reviewed; canonicalisation rules fixed |
| **1** | Store + materialiser + `stat` | 2–3 wk | 3 projects share one store; inode-aware total matches ground truth; `EXDEV` errors clearly |
| **2** | Resolver + shim | 3–4 wk | **Claim 1:** Vite React app builds and serves; `ls node_modules` → `ENOENT`; `strace` shows 0 `node_modules` path syscalls |
| **3** | Runtime identity + `built/` tier | 2–3 wk | **Claim 2:** forged-ABI fixture makes `--frozen` exit 1 with the §4.3 diagnostic; `npm ci` exits 0 on the same tree |
| **4** | Compatibility: TS/editor + `materialize` | 2–4 wk | Vite, `tsc`, ESLint, Jest all pass; scanning failure produces the §4.4 diagnostic |
| **5** | Roots registry + GC | 1–2 wk | Deleting a project makes its exclusive content sweepable; removable volume is never swept; `--dry-run` default |

Roughly three to four months to a defensible public alpha for one engineer.

**Milestone −1 runs first and is a kill criterion.** Editor and TypeScript integration limited
Yarn PnP's adoption more than any runtime issue, and a project choosing the same approach signs up
for the same tax. If it cannot be made to work in two weeks, Approach 2 is not viable — and
Approach 1 (a hard-linked `node_modules`) makes the project a pnpm reimplementation.

**Milestone 3 uses forged-ABI fixtures, so Claim 2 is a fast unit test rather than a two-runtime
integration test.** Verified technique — a hand-written `node_module` registration struct with a
forged `nm_version`, no Node headers required:

```c
struct node_module {
  int nm_version; unsigned int nm_flags; void* nm_dso_handle;
  const char* nm_filename; void* nm_register_func;
  void* nm_context_register_func; const char* nm_modname;
  void* nm_priv; struct node_module* nm_link;
};
extern void node_module_register(void* m);
static void init(void* exports, void* module) { }
static struct node_module _module = {
  FORGED_ABI, 0, 0, "forge.c", 0, (void*)init, "forge", 0, 0
};
__attribute__((constructor)) static void reg(void) { node_module_register(&_module); }
```

Built with `gcc -shared -fPIC -DFORGED_ABI=115 -o abi115.node forge.c`, this reproduces the real
error exactly:

```
The module '/tmp/abi/abi115.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 127. …
```

That is the difference between a guarantee that is enforced in CI and one that is aspirational.

### 5.1 Out of MVP scope

Named environments, activation, environment-level sharing, environment variables in the manifest,
Node version installation, workspaces and monorepos, custom Node builds, and any platform-specific
shortcut in the store layer — Windows is the hard case *and* where the design wins most (eliminating
the deep tree removes most `MAX_PATH` pressure, though a store path already spends ~95 characters on
the integrity component and `materialize` reintroduces the deep tree), so deferring it hides the
risk that matters.

### 5.2 The negative requirement

**Never shell out to pnpm, npm or Yarn for install, resolution or extraction.** Not behind a flag.
If any part of the pipeline delegates, "just a wrapper around pnpm" stops being unfair and becomes
accurate. Reading a competitor's lockfile is interoperation; invoking the competitor is not.

---

## 6. Benchmark harness

`bench/` is a runnable directory, not a results table in a README. Any disputed number must be
reproducible rather than arguable.

### 6.1 Fixtures

Real projects, because synthetic trees do not exercise peer resolution: a Vite + React app, a
Next.js app, a Nest API, a ten-package monorepo (post-MVP), and `forged-abi/` for the Claim 2
tests. Pin a registry snapshot or run a local mirror so network variance does not dominate.

### 6.2 Metrics

| Metric | Method | Verified baseline |
|---|---|---|
| Unique-inode disk total | collect `(inode,size)`, sum unique set | naive `du` sum overstates 3× |
| Inodes + dentries per project | `find \| wc -l` | 8,401 → 1 file (~400 KB, ~150 KB gzipped at the §3.3 schema; store inodes persist, amortised) |
| Cold/warm install time | 4 cells, median of ≥10 | report all four separately |
| Resolution syscalls | `strace -c -e trace=%file` | 224 vs 820; **0 vs 779** in `node_modules` |
| Resolution + load time | in-process timing | 11.8 ms vs 7.4 ms |
| Teardown time | `time rm -rf` | 0.27 s vs <0.01 s |
| Docker image size / layers | `docker history` | often the real business case |
| **Native rebuilds over N switches** | counter | **2 vs N — the differentiating metric** |
| **`--frozen` under ABI change** | pass/fail | **competitors fail** |
| Derived cache size | separate accounting | prevents a misleading denominator |
| Disk cost of a second ABI | `du` on `built/` | tests the §2.2 prediction |

### 6.3 Measurement integrity

Six rules. Four are verified, and all six err in the direction that would flatter this project.

**`du` double-counts hard links across invocations.** Verified — one 20 MB blob linked into three
projects: `du -s` on each reports 20,484 KiB, summing gives **60.0 MiB for 20.0 MiB of storage, a 3×
overstatement**, while a single `du -csh A B C` correctly reports 21M. Note the second trap on top
of the first: `du -h` rounds *up*, displaying both the real 20.0 MiB and the inflated 60.0 MiB sum
as "21M" and "63M", so a report built from `-h` output is wrong even about its own arithmetic. `du`
deduplicates by inode *within* an invocation and has no memory *across* invocations. Correct
accounting collects `(inode, size)` pairs and sums the unique set — verified to give 20 MB against
80 MB naive when the store's own name is walked alongside the three projects.

**Report actual blocks, not apparent size.** Verified: 2000 one-byte files occupy 38 KB apparent
and **7.9 MB on disk**. A **synthetic** 1200-package tree measured 19 MB apparent against 33 MB
actual (1.74×) — synthetic, not realistic, and both halves of that need a caveat before publication:
the 33 MB is essentially the 8,401 × 4 KiB directory-entry floor, and the 1.74× ratio is a free
parameter of the fixture's file sizes, verified to range 1.02×–6.95× as they vary. A real
`node_modules` on the same host measured 1.36×. Re-measure on real trees and publish that number.
Since the entire argument concerns many small files, `--apparent-size` is not neutral either way.

**Never claim byte savings from avoiding pnpm's peer duplication.** Verified: pnpm's
dependency-set cloning for peers costs **inodes, directory entries and directory-block bytes — but
not file-content bytes**, because clones share file inodes. Verified: twenty hard-linked clones of a
42-entry package cost 160 KiB, and the marginal cost of an additional project over a 1,231-entry
tree is a measured 400 KiB. So "free" is wrong and "zero bytes" is wrong; state it as inode and
directory-entry counts with the directory-block figure attached.

**Report cold and warm separately.** A warm store against a cold npm cache is not a benchmark.
Publish all four cells.

**Count the derived cache.** Invisible to a `node_modules`-only measurement, and on the Python
analogue it added a verified 17–25% to the installed tree and was verified unshareable.

**Report variance, filesystem, and hardware.** Publish medians with interquartile ranges over ≥10
runs, and name the filesystem — ext4 has no reflink while APFS does, which alone can change results
several-fold. Publish Windows numbers even when they are worst.

### 6.4 Fair comparison

Run competitors in their **best** configuration, not their default: pnpm with a warm store, Yarn
with `enableGlobalCache`, npm with a populated `_cacache`. Beating a handicapped competitor is
worse than no benchmark, because the correction arrives publicly from its maintainers.

**Report the losses.** First-run install with a cold store is slower than nothing; materialisation
is strictly worse than pnpm's install because it *is* pnpm's install plus a resolution step;
scanning tools need the escape hatch. A table with no losses reads as marketing and is discounted
entirely.

And state plainly in the README that **pnpm already solved cross-project deduplication, that this
project builds on that idea, and that a user who only wants disk savings should use pnpm.** The
disk benchmark is pnpm's win; the runtime-identity benchmark is this project's. Leading with the
second and conceding the first costs nothing and pre-empts the only criticism that could otherwise
define the project's reception.

---

## 7. Repository structure

```
keel/
├── SPEC/                  # Milestone 0 — versioned, language-neutral
│   ├── store-layout.md    lockfile.md    resolution-table.md    hashing.md
├── crates/ (or packages/)
│   ├── cli/  store/  resolver/  registry/
├── js/loader/             # separately versioned; JS by necessity
├── bench/
│   ├── fixtures/          # vite-react, next, nest, monorepo
│   └── forged-abi/        # CI-testable ABI fixtures
├── docs/
│   ├── architecture.md
│   ├── comparison.md      # honest, includes where we lose
│   └── why-not-conda.md   # write this before the tool works
└── ADR/                   # decision records, including rejected options
```

`docs/why-not-conda.md` is the document that earns technical respect, and it should exist before
the tool works. Publishing the reasoning for a *rejected* design is the most credible thing a new
package manager can do.

`ADR/` should record the rejected options with their reasoning: zip storage, named environments,
environment-level sharing, a forked Node runtime.

---

## 8. Before writing any code

Two things, in this order.

**Run the seven checks in RESEARCH.md §15.** About an hour with a browser. Two of them could
change the recommendation — specifically whether `vltpkg` already occupies this position, and
whether pnpm has shipped ABI-keyed store paths. Both would make the honest response a contribution
rather than a competing tool.

**Then run Milestone −1**, the two-week editor and TypeScript spike, before Milestone 1. It is the
highest risk in the plan and the cheapest to test.

If both come back clean, the plan above is buildable as written.

---

*Companion to [RESEARCH.md](./RESEARCH.md). Every claim marked "verified" was established by
construction in a Linux sandbox on 2026-08-25 (Node v22.22.3, npm 10.9.8, uv 0.11.19, ext4);
the underlying evidence and the confidence labelling for everything else are in that document.*
