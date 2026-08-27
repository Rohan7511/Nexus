
# Nexus

**Nexus checks whether native Node.js dependencies can safely run on a different Node.js runtime — before you run them.**

When switching Node versions, not every native package needs rebuilding. Nexus analyzes `.node` binaries and determines, per artifact:

- which packages remain compatible
- which packages are incompatible
- the exact reason they fail
- which packages actually need rebuilding

## Why?

Traditional dependency tooling can treat a Node runtime change as an installation-wide compatibility problem.

But native addons have different requirements:

- **Raw V8 addons** may require an exact Node ABI.
- **N-API addons** may work across multiple Node versions, as long as the runtime provides a sufficient N-API level.

Nexus checks these requirements **per artifact**, avoiding unnecessary rebuilds.

```text
Node version changes
        │
        ▼
      Nexus
        │
        ├── Package A → still compatible ✓
        ├── Package B → still compatible ✓
        ├── Package C → needs rebuild ✗
        └── Package D → still compatible ✓
```

## Example

```bash
nexus check --all
```

```text
runtime   v17.0.0 win32/x64 abi=102 napi=8

INCOMPATIBLE -- 1 package(s):

x @img/sharp-win32-x64@0.34.3
  needs N-API >= 9
  runtime provides 8
  would segfault

compatible -- 3 package(s)

3 of 4 package(s) are fine and need no rebuild.
```

## What Nexus Currently Checks

Nexus currently focuses on **native Node.js artifacts (`.node`)**.

It can analyze:

- N-API compatibility
- raw V8 / Node ABI compatibility
- Windows native binaries
- Linux ELF requirements
- platform-specific native artifacts
- per-package compatibility
- artifacts that are outside `node_modules`
- incompatible packages without executing the binaries

Nexus does **not currently replace npm, pnpm, Yarn, or Node version managers**.

## Installation

### From source

```bash
git clone <repository-url>
cd nexus
npm install
```

Run the CLI:

```bash
node bin/nexus.mjs check /path/to/project
```

Or link it globally during development:

```bash
npm link
```

Then:

```bash
nexus check /path/to/project
```

## Commands

Check a project:

```bash
nexus check .
```

Show all compatible packages:

```bash
nexus check --all
```

Verify compatibility directly from binaries instead of trusting cached analysis:

```bash
nexus check --verify
```

Inspect a specific native artifact:

```bash
nexus analyze path/to/addon.node
```

See what Nexus would rebuild:

```bash
nexus rebuild
```

> `rebuild` is currently a dry-run/planning feature. Nexus identifies what needs rebuilding; automatic rebuilding is future work.

## Current Limitation

Nexus currently solves **native runtime compatibility**, not general JavaScript package compatibility.

For example, a package declaring:

```json
{
  "engines": {
    "node": ">=18"
  }
}
```

is not yet the core of Nexus's compatibility model.

Nexus's current thesis is narrower:

> **When a Node runtime changes, determine exactly which native artifacts remain safe and which ones actually require rebuilding.**

## Roadmap

- [ ] Automatic rebuild execution
- [ ] Full Linux validation
- [ ] Full macOS / Mach-O support
- [ ] GLIBC version requirement detection
- [ ] Stronger compatibility metadata authentication
- [ ] Better integration with npm and pnpm
- [ ] Runtime-switch integration with nvm, Volta, fnm, and similar tools
- [ ] Automatic compatibility checks when changing Node versions
- [ ] Reuse compatible native artifacts from a shared store
- [ ] Environment-level dependency and runtime management
- [ ] Expand beyond native artifacts where a sound per-package compatibility model is possible

## Long-Term Vision

Nexus is exploring a more efficient model for Node.js runtime switching:

```text
Shared package store
        +
Multiple Node.js runtimes
        +
Per-artifact compatibility knowledge
        =
Reuse what still works.
Rebuild only what doesn't.
```

The goal is not to replace pnpm.

The goal is to eventually make Nexus and existing package managers work together: **pnpm/npm/Yarn manage packages, while Nexus provides compatibility intelligence about what can survive a runtime change.**

## Status

**Experimental.**

The current proof of concept has passed adversarial testing on its supported scope, but cross-platform validation and several runtime compatibility axes are still in progress.

Nexus should currently be treated as a research project and compatibility analysis tool, not production dependency infrastructure.
