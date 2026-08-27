// Runtime capability descriptor: what the target runtime can actually load.
//
// Deliberately cheap and artifact-free -- probing involves no artifacts, and
// artifact analysis involves no runtime. Keeping the two apart is what lets the
// same stored analysis be re-decided against a new runtime without re-reading a
// single byte of any .node file.
//
// The descriptor is {os, arch, abi, napi, libc}. ABI and N-API are BOTH present
// because they drift independently: 127/9 -> 137/10 -> 141/10 across the three
// runtimes measured locally.

import { execFileSync } from 'node:child_process';

// Runs inside the target runtime. glibc exposes its version through the
// diagnostic report header; a Linux build without it is musl.
const SCRIPT = `
const h = (process.report && process.report.getReport().header) || {};
const linux = process.platform === 'linux';
process.stdout.write(JSON.stringify({
  version: process.version,
  os: process.platform,
  arch: process.arch,
  abi: Number(process.versions.modules) || null,
  napi: Number(process.versions.napi) || null,
  libc: linux ? (h.glibcVersionRuntime ? 'glibc' : 'musl') : null,
  glibcVersion: h.glibcVersionRuntime || null,
}));
`.trim();

/** Descriptor for the runtime this process is running in. No subprocess. */
export function currentRuntime() {
  const h = process.report?.getReport?.().header ?? {};
  const linux = process.platform === 'linux';
  return {
    exe: process.execPath,
    version: process.version,
    os: process.platform,
    arch: process.arch,
    abi: Number(process.versions.modules) || null,
    napi: Number(process.versions.napi) || null,
    libc: linux ? (h.glibcVersionRuntime ? 'glibc' : 'musl') : null,
    glibcVersion: h.glibcVersionRuntime || null,
  };
}

/**
 * Descriptor for another runtime, by executable path. The point of the whole
 * project: answer "will my install work on THAT node" without switching to it.
 */
export function probeRuntime(exe) {
  if (!exe || exe === process.execPath) return currentRuntime();
  let out;
  try {
    out = execFileSync(exe, ['-e', SCRIPT], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    throw new Error(`could not probe runtime '${exe}': ${e.message.split('\n')[0]}`);
  }
  let d;
  try {
    d = JSON.parse(out);
  } catch {
    throw new Error(`runtime '${exe}' produced unparseable descriptor: ${out.slice(0, 120)}`);
  }
  return { exe, ...d };
}

/** Stable one-line form for logs and lockfile provenance. */
export const runtimeLabel = (rt) =>
  `${rt.version} ${rt.os}/${rt.arch}${rt.libc ? '/' + rt.libc : ''} abi=${rt.abi} napi=${rt.napi}`;

/**
 * A HYPOTHETICAL runtime, from a descriptor rather than a probe.
 *
 * This is what the runtime-free constraint model buys: because an artifact's
 * requirement is recorded and never keyed by a runtime, it can be decided against
 * a runtime that does not exist on this machine. That is the only way to answer
 * "will this install load on linux/x64 glibc under Node 22?" from a Windows CI box,
 * and the only way to exercise the ELF requirement axis without a Linux host.
 *
 * Spec: <os>/<arch>[/<libc>]:<abi>:<napi>   e.g. linux/x64/glibc:127:9
 *
 * Every axis is REQUIRED and nothing is defaulted. A descriptor that omits an axis
 * would be filled in from this host, silently answering a question about a
 * different runtime than the one asked about.
 */
export function parseTarget(spec) {
  const m = /^([a-z0-9]+)\/([a-z0-9_]+)(?:\/([a-z0-9+]+))?:(\d+):(\d+)$/.exec(String(spec).trim());
  if (!m) {
    throw new Error(`bad --target '${spec}'; expected <os>/<arch>[/<libc>]:<abi>:<napi>, ` +
                    `e.g. linux/x64/glibc:127:9`);
  }
  const [, os, arch, libc, abi, napi] = m;
  if (os === 'linux' && !libc) {
    // On Linux the libc flavour is part of compatibility, not a detail: E003 showed
    // glibc and musl artifacts are not interchangeable. Refuse rather than pick one.
    throw new Error(`--target linux requires a libc: linux/${arch}/glibc:${abi}:${napi} or .../musl:...`);
  }
  if (os !== 'linux' && libc) throw new Error(`--target ${os} takes no libc component`);
  return {
    hypothetical: true,
    version: `(target ${os}/${arch}${libc ? '/' + libc : ''})`,
    os, arch, libc: libc ?? null,
    abi: Number(abi), napi: Number(napi), glibcVersion: null,
  };
}

/** The runtime a command should decide against: a probe, or a stated target. */
export function targetRuntime(opts) {
  if (opts.target && opts.runtime) {
    throw new Error('--target and --runtime are mutually exclusive: one is stated, one is probed');
  }
  return opts.target ? parseTarget(opts.target) : probeRuntime(opts.runtime);
}
