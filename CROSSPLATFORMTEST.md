# Cross-platform validation protocol

**Status:** this is a manual protocol. It has not been run on macOS or Linux by
the current Windows-hosted work. A passing static parse is not evidence that an
artifact loads; record both results separately.

## 1. Prepare the repository

Run these commands from a clean checkout of this repository. Nexus has no npm
dependencies, but requires Node **22 or newer** (`package.json` `engines.node`).
Use a supported Node release that is native to the host architecture.

```sh
git clone <repository-url> Nexus
cd Nexus
node --version
npm test
```

`npm test` is the portable invariant suite. Its expected result is a non-zero
pass count and **0 failed** (currently 67 passes). It uses synthetic ELF and
Mach-O inputs, so it verifies parser branches but does not load either format.

For the complete recorded experiment command, run:

```sh
npm run regress
```

This invokes E001, E005, E007, and E008 after the unit suite. It is not a
self-contained cross-platform acceptance test: the experiment scripts discover
the original Windows-local corpora, and their corpus-size guards can fail when
those artifacts are absent. Record that as **unsupported corpus**, not as a
macOS/Linux parser failure. Do not claim the old numerical totals from a new
host unless the same corpus is present.

Record the active runtime before each run:

```sh
node -e 'const h=(process.report&&process.report.getReport().header)||{}; console.log(JSON.stringify({node:process.version,os:process.platform,arch:process.arch,abi:process.versions.modules,napi:process.versions.napi,libc:process.platform==="linux"?(h.glibcVersionRuntime?"glibc":"musl"):null,glibcVersion:h.glibcVersionRuntime||null},null,2))'
```

On macOS, `os` must be `darwin` and `arch` must match the binary being tested
(`arm64` or `x64`). On Linux, record both `libc` and `glibcVersion`; Nexus
currently derives and checks the libc *flavour* only, not a minimum GLIBC
version, so a glibc-version result is a known Phase 8 limitation.

## 2. Create a real native-artifact fixture

Use an otherwise disposable directory. Replace `<nexus-repo>` with the absolute
path to this checkout and `<package>` with the dependency you actually test.
The package manager is only used to obtain real artifacts; Nexus is not being
tested as a package manager.

```sh
mkdir -p /tmp/nexus-native-fixture
cd /tmp/nexus-native-fixture
npm init -y
npm install <package>
find node_modules -type f \( -name '*.node' -o -name '*.so' -o -name '*.dylib' -o -name '*.dll' \) -print

node <nexus-repo>/bin/nexus.mjs ingest . --store "$PWD/.nexus-store"
node <nexus-repo>/bin/nexus.mjs check . --store "$PWD/.nexus-store" --all
```

`ingest` writes `nexus-lock.json` and `nexus-compat.json`. The first normal
`check` should report `source nexus-compat.json`; it must name every analyzed
native/shared artifact, and must report any native artifact outside
`node_modules` as `UNEXAMINED` rather than silently treating it as covered.

For a byte-derived answer on one artifact, use the actual CLI command:

```sh
node <nexus-repo>/bin/nexus.mjs analyze node_modules/<package>/<path-to-addon.node> --all
```

Classify candidates by Nexus's output, not filename:

- An **N-API** candidate prints `class n-api` and `needs N-API >= N`.
- A **raw-V8** candidate prints `class raw-v8` (or `raw-v8-noreg`) and
  `needs NODE_MODULE_VERSION == N`.
- `UNKNOWN` or an unreadable `nm_version` is a conservative refusal, not a
  compatible result and not a parser-validation success.

`@napi-rs/*` packages are useful N-API candidates when they provide a native
prebuild for the selected platform. `@datadog/pprof` and `@newrelic/*` are
useful raw-V8 candidates when the installed release contains a `.node` file
that Nexus classifies as raw-V8. Availability, prebuild support, and compiler
toolchain installation are manual prerequisites; use a package/version that
`npm install` actually provides for the host and record it.

If npm compiles instead of downloading a prebuild, install the normal local
build prerequisites first (a supported C/C++ compiler, Python, and the headers
required by node-gyp). A successful locally built artifact is still valid for
the runtime-load portion, but it does not validate a publisher's prebuild.

## 3. macOS protocol

Use a native macOS Node executable. Exercise both a thin artifact matching the
host architecture and, when available, a universal Mach-O artifact.

```sh
file node_modules/<package>/<path-to-addon.node>
lipo -info node_modules/<package>/<path-to-addon.node>  # macOS only; optional for thin files
node <nexus-repo>/bin/nexus.mjs analyze node_modules/<package>/<path-to-addon.node> --all
node <nexus-repo>/bin/nexus.mjs check . --store "$PWD/.nexus-store" --verify --all
```

Expected parser results:

- `container macho` or `container macho-fat`;
- the platform constraint is `darwin/<arch>` (or all listed universal slices);
- an N-API artifact derives its declared/import-floor requirement;
- a readable raw-V8 artifact derives an exact `NODE_MODULE_VERSION`;
- a fat binary with disagreeing slice requirements is refused; a chained-fixups
  raw-V8 binary is conservatively refused as unsupported by the current reader.

For an N-API artifact, use two installed Node executables if available. Set the
following values to actual executable paths; do not infer ABI from a Node major
version.

```sh
NODE_A=/absolute/path/to/node-a
NODE_B=/absolute/path/to/node-b
"$NODE_A" -e 'console.log(process.version, process.versions.modules, process.versions.napi)'
"$NODE_B" -e 'console.log(process.version, process.versions.modules, process.versions.napi)'

node <nexus-repo>/bin/nexus.mjs check . --runtime "$NODE_A" --store "$PWD/.nexus-store" --verify
node <nexus-repo>/bin/nexus.mjs run . --runtime "$NODE_A" --store "$PWD/.nexus-store" -- "$NODE_A" -e "require('<package>'); console.log('loaded')"
```

A compatible artifact must be reported loadable and then load with the same
runtime. An N-API artifact whose requirement exceeds `process.versions.napi`
must be refused by `check`/`run`; do not manually load it just to prove the
failure, because the known N-API failure mode can crash the process. A raw-V8
artifact with a different module ABI must be refused and, only if you choose to
perform the separate runtime observation, should fail with the runtime's normal
loader error.

## 4. Linux protocol

Run this independently on a glibc distribution and, if in scope, a musl
distribution such as Alpine. Record the output of the runtime-capability command
from section 1 for each host.

```sh
ldd --version || true
find node_modules -type f -name '*.node' -print
node <nexus-repo>/bin/nexus.mjs analyze node_modules/<package>/<path-to-addon.node> --all
node <nexus-repo>/bin/nexus.mjs check . --store "$PWD/.nexus-store" --verify --all
```

Expected parser results for a Linux native addon:

- `container elf` with `platform linux/<arch>/glibc` or `linux/<arch>/musl`;
- a glibc artifact is refused on a musl runtime and vice versa;
- readable N-API and raw-V8 ELF artifacts report the same requirement axes as
  their PE/Mach-O counterparts; malformed, missing, or ambiguous node-module
  structures report `UNKNOWN` and refuse.

For GLIBC coverage, collect the symbol-version evidence alongside Nexus output:

```sh
readelf --version-info node_modules/<package>/<path-to-addon.node> || true
readelf --dynamic node_modules/<package>/<path-to-addon.node> || true
```

Do not mark a newer-GLIBC artifact safe on an older glibc host based on a Nexus
OK alone: minimum GLIBC version is not currently a constraint. This command set
documents the gap and provides the data needed to close it later.

To test a deliberate libc mismatch, install or copy a real prebuild for the
other libc into a separate fixture, retain its package metadata, then run
`analyze` and `check --verify`. Nexus must refuse the applicable artifact on the
platform constraint. Do not relabel a file or rely on its directory name as the
test; the parser result must come from its ELF bytes.

## 5. Runtime changes, unknowns, and sidecar integrity

For each real artifact, make a small matrix in which the Node executable is the
variable and the artifact bytes are not changed. Use `--runtime` for the
decision and the same executable after `--` for the actual load. A raw-V8
artifact must accept only its exact module ABI. An N-API artifact may remain
usable across ABI changes only when its N-API minimum is met.

```sh
node <nexus-repo>/bin/nexus.mjs check . --runtime "$NODE_A" --store "$PWD/.nexus-store" --verify
node <nexus-repo>/bin/nexus.mjs check . --runtime "$NODE_B" --store "$PWD/.nexus-store" --verify
```

Verify the conservative path with a copied/truncated artifact in a disposable
fixture. `analyze` must print an `UNKNOWN` requirement and `check --verify`
must refuse; no unknown or unexamined artifact may be silently reported as safe.

Verify sidecar tampering without changing the lock or artifact. Back up first,
then change only a derived requirement in `nexus-compat.json`:

```sh
cp nexus-compat.json nexus-compat.json.before-tamper
node -e 'const fs=require("fs"); const p="nexus-compat.json"; const j=JSON.parse(fs.readFileSync(p)); const c=Object.values(j.artifacts).flatMap(a=>a.constraints).find(c=>c.kind==="napi-min"||c.kind==="abi-exact"); if(!c) throw Error("no N-API/raw-V8 requirement to alter"); if(c.kind==="napi-min") c.napi=1; else c.abi=1; fs.writeFileSync(p,JSON.stringify(j))'
node <nexus-repo>/bin/nexus.mjs check . --store "$PWD/.nexus-store"
node <nexus-repo>/bin/nexus.mjs check . --store "$PWD/.nexus-store" --verify
mv nexus-compat.json.before-tamper nexus-compat.json
```

Expected results: normal `check` rejects the sidecar because its content digest
does not match `nexus-lock.json`; `--verify` ignores the sidecar and derives the
real requirement from bytes. `run` always implies `--verify`. The binding does
not authenticate an attacker who can modify both sidecar and lock; it avoids
keys and relies on reproducible byte verification for the execution gate.

## 6. Results record

Copy this table for every host/artifact/runtime combination.

| host | Node/version | ABI | N-API | libc/GLIBC | artifact SHA/path | container/class | Nexus constraint | `check --verify` | real load | evidence/notes |
|---|---|---:|---:|---|---|---|---|---|---|---|
| | | | | | | | | | | |

Mark a result **unsupported**, not failed, when the target architecture cannot
execute locally, no real artifact of the required class is available, or a
needed compiler/prebuild is unavailable. Mark it **failed** when Nexus derives
the wrong platform/requirement, accepts an incompatible applicable artifact,
silently accepts an unknown, or its load prediction disagrees with a real load.

## 7. Declaration checklist

- [ ] macOS parser validated: real thin (and, if available, fat) Mach-O outputs recorded.
- [ ] macOS runtime behavior validated: matching and mismatching Node/runtime cases loaded or refused as predicted.
- [ ] Linux parser validated: real ELF outputs recorded on each tested libc/architecture.
- [ ] Linux runtime behavior validated: matching and mismatching Node/runtime cases loaded or refused as predicted.
- [ ] GLIBC coverage validated: `readelf` evidence and an older/newer-glibc outcome recorded. (Not supported by Nexus's current constraint model.)
- [ ] Cross-platform runtime claims remain unverified until the corresponding rows above contain real-load evidence.
