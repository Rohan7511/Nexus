<h1 align="center"><b>NEXUS</b></h1>

**Nexus checks whether native Node.js dependencies can safely run on a different Node.js runtime before you run them.**

When switching Node versions, not every native package needs rebuilding. Nexus analyzes `.node` binaries and determines, per artifact:

- which packages remain compatible
- which packages are incompatible
- the exact reason they fail
- which packages actually need rebuilding

## Table of Contents

- [Why?](#why)
- [Example](#example)
- [What Nexus Currently Checks](#what-nexus-currently-checks)
- [Installation](#installation)
- [Commands](#commands)
- [Current Limitation](#current-limitation)
- [The Story Behind Nexus](#the-story-behind-nexus)
  - [Where the Idea Came From](#where-the-idea-came-from)
  - [The Actual Problem](#the-actual-problem)
  - [How the Architecture Was Discovered](#how-the-architecture-was-discovered)
  - [The Process Matters More Than the First Idea](#the-process-matters-more-than-the-first-idea)
  - [Built With AI](#built-with-ai)
  - [What I Think This Says About Building Projects With AI](#what-i-think-this-says-about-building-projects-with-ai)
  - [A Note on Authorship](#a-note-on-authorship)
- [The Principle Behind Nexus](#the-principle-behind-nexus)
- [Roadmap](#roadmap)
- [Long-Term Vision](#long-term-vision)
- [Status](#status)

---

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

Requires Node.js 22 or later.

### From source

```bash
git clone <repository-url>
cd nexus
npm install
```

### Environment Variables

Copy [`.env.example`](.env.example) as a reference for the supported `NEXUS_` variables. Nexus reads environment variables from the process; it does not load a `.env` file automatically.

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

> `rebuild` is currently a planning feature. Nexus identifies what needs rebuilding; automatic rebuilding is future work.

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

---

## The Story Behind Nexus

### Where the Idea Came From
Nexus started with a simple question: *Why does every Node.js project need to independently deal with the consequences of changing Node versions?*

The original idea was much broader. I was thinking about a "Conda for JavaScript": a system that could combine shared package storage, isolated JavaScript environments, dependency graphs, and multiple Node.js runtimes.

The initial assumption was that the main problem was package duplication. That turned out to be wrong or at least incomplete. Tools such as pnpm already solve a large part of the physical package duplication problem through shared storage and linking. Yarn Plug'n'Play explores an alternative module-resolution model. Node version managers already handle switching runtimes.

So I kept asking a more important question: *If these tools already exist, what problem is actually left?* That question eventually led to Nexus's current focus.

### The Actual Problem
When a Node.js runtime changes, native dependencies may or may not remain compatible. The obvious approach is to rebuild everything. But that raises another question:

*Why rebuild a package if its existing native binary can already run on the new runtime?*

The answer cannot safely be determined from the Node version alone. Different native artifacts have different compatibility requirements. Some are tied to an exact Node ABI. Others use N-API and can remain compatible across multiple Node versions, depending on the minimum N-API level they require.

This became the core idea behind Nexus: **Determine compatibility per native artifact, then rebuild only what actually cannot run.**

### How the Architecture Was Discovered
Nexus was not designed by starting with a large architecture diagram and assuming the design was correct. The architecture evolved through research, experiments, and attempts to disprove the original assumptions.

The process roughly looked like this:
1. **Big idea:** "Conda for JavaScript"
2. **Research:** Look into existing tools.
3. **Realize:** Package deduplication is already largely solved.
4. **Pivot:** Look for the remaining unsolved problem and focus on Node runtime transitions.
5. **Discover:** Native artifacts have varying compatibility requirements.
6. **Test:** Verify those requirements against real Node runtimes.
7. **Reject:** Installation-level compatibility.
8. **Adopt:** Per-artifact compatibility.
9. **Build Nexus.**

The most important architectural decision came from experimentation. A simple ABI-based model was not sufficient. Local testing showed two separate compatibility axes:
* **Raw V8 addon:** Requires an exact Node ABI.
* **N-API addon:** Requires a sufficient N-API level.

This meant that rebuilding an entire installation because one runtime property changed could over-invalidate packages that were perfectly compatible. Nexus therefore models compatibility at the artifact level rather than treating an entire `node_modules` installation as one compatibility unit.


### Built With AI
Nexus was developed in an AI-assisted workflow. Most of the implementation was produced with AI coding agents, including major parts of the source code, tests, experiments, documentation, and adversarial review.

I do not want to misrepresent that. The project was not created by manually writing every line of code myself. My contribution was primarily in the direction and engineering process:
- identifying the original problem
- forming the initial project hypothesis
- deciding what questions needed answering
- researching and comparing existing approaches
- challenging the idea when existing tools already solved parts of it
- steering the architecture toward the actual remaining problem
- designing experiments and asking for assumptions to be falsified
- reviewing results and changing direction when evidence contradicted the original model
- deciding the project's scope and what it should explicitly not claim to solve
- testing the resulting software against real projects and multiple Node.js versions

The AI was used as an implementation and reasoning collaborator, not as something to hide behind.


### A Note on Authorship
Nexus is mostly AI-generated code, guided and directed by me. I believe that is worth stating openly.

The value I want to demonstrate through this project is not that I personally typed every line. It is that I could take a vague idea, investigate whether it was already solved, narrow it into a falsifiable technical hypothesis, guide an AI-assisted development process, and produce a project whose claims are backed by experiments and documented limitations. I consider that process part of the project.

---

## The Principle Behind Nexus

Don't rebuild because the runtime changed.
Rebuild only when the artifact proves it cannot survive the change.

---

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


The goal is to eventually make Nexus and existing package managers work together: **pnpm/npm/Yarn manage packages, while Nexus provides compatibility intelligence about what can survive a runtime change.**

## Status

**Experimental.**

The current proof of concept has passed adversarial testing on its supported scope, but cross-platform validation and several runtime compatibility axes are still in progress.

