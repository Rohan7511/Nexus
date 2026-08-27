// Derive an artifact's compatibility requirement as a CONJUNCTION of constraints.
//
// The central data-model decision of the project (see docs/architecture/
// knowledge-model.md §2): compatibility is not a key and not a tagged union of
// one requirement. It is a set, and every member must hold.
//
// HARD INVARIANT: a derivation that fails emits an explicit {kind:'unknown'}
// constraint. It must NEVER emit an empty array. An empty conjunction is
// vacuously true, so a parse failure would silently become "compatible with
// everything" -- precisely the false-negative shape the conservative default in
// decide() exists to prevent. This is enforced here by construction, in
// assemble(), rather than left to each caller's discipline.

import { readContainer } from './container.mjs';
import { readElf } from './elf.mjs';
import { readPE } from './pe.mjs';
import { classify, nodeImports, readDeclaredNapi, readRawNmVersion } from './pe-addon.mjs';
import * as elfAddon from './elf-addon.mjs';
import * as machoAddon from './macho-addon.mjs';

/** Formats whose requirement axis (N-API level / exact ABI) this build can read. */
const REQUIREMENT_READABLE = new Set(['pe', 'elf', 'macho', 'macho-fat']);

function assemble(platform, requirement, evidence) {
  const constraints = [platform];
  // Guard the invariant at the single point where a constraint set is built.
  constraints.push(requirement ?? { kind: 'unknown', source: 'no requirement derived' });
  return { constraints, ...evidence };
}

/**
 * The N-API minimum, shared by every container format because the rule is a
 * property of N-API, not of the file format.
 *
 * Three sources, in order of strength:
 *   1. the DECLARED minimum -- E001 measured this at 291/291 against real loads;
 *   2. the IMPORT FLOOR -- provably weaker at 288/291, but arch-independent;
 *   3. NODE_API_DEFAULT_MODULE_API_VERSION -- what Node itself assumes when a
 *      module declares nothing. Read from the local headers, not remembered.
 *
 * (2) and (3) are combined with max(): a non-declaring addon must satisfy both the
 * level Node assigns it and the level its own imports require. E005 found addons
 * that need (3): napi-rs Rust artifacts resolve no N-API symbol dynamically, so
 * their import floor is 0, and treating 0 as "loads anywhere" would be a false
 * negative.
 */
function napiRequirement(declared, declaredMethod, napiSyms, napiMap, defaultNapi) {
  const evidence = { declaredNapi: declared, declaredMethod, napiSymbolCount: napiSyms.length };

  if (declared != null && declared > 0) {
    return { requirement: { kind: 'napi-min', napi: declared, source: 'declared' }, evidence };
  }
  // No declared minimum. Without the header map there is no floor to fall back to,
  // and inventing one would be an unmeasured over-accept.
  if (!napiMap) {
    return {
      requirement: { kind: 'unknown',
        source: 'no declared N-API version and no header map available for the import floor' },
      evidence,
    };
  }
  const floor = napiSyms.length ? Math.max(...napiSyms.map((s) => napiMap.get(s) ?? 1)) : 0;
  evidence.importFloor = floor;
  const base = defaultNapi ?? null;
  if (base != null) evidence.defaultNapi = base;
  const napi = Math.max(floor, base ?? 1);
  return {
    requirement: { kind: 'napi-min', napi,
      source: base != null && base >= floor ? 'header-default(WEAK)' : 'import-floor(WEAK)' },
    evidence,
  };
}

/**
 * @param {Buffer} buf raw artifact bytes
 * @param {Map<string,number>|null} napiMap symbol -> min N-API, for the weak fallback
 * @param {{name?:string, defaultNapi?:number|null}} opts filename hint plus the
 *        header-derived default module API version
 * @returns {{class:string, format:string, constraints:object[]}}
 */
export function deriveConstraints(buf, napiMap = null, opts = {}) {
  const c = readContainer(buf);
  const defaultNapi = opts.defaultNapi ?? null;
  // Packages bundle plain shared libraries (.dll/.so/.dylib) alongside their
  // addons. Those are loaded by the OS loader, not by process.dlopen, and carry
  // no Node ABI requirement -- so for them the platform axis is the complete
  // answer. A .node file with no detectable Node linkage is a different thing
  // entirely: it is either not an addon or a gap in this parser, and must refuse.
  const addonExpected = !opts.name || /\.node$/i.test(opts.name);

  // Axis 0 is emitted for EVERY artifact, including ones targeting the host's own
  // OS. E001: six win32-arm64/win32-ia32 PE files were called loadable and all
  // six fail -- 18 false-negative cells caused by checking only foreign formats.
  const platform = {
    kind: 'platform',
    os: c.os,
    arch: c.arch,
    archs: c.archs.length > 1 ? c.archs : undefined,  // fat binaries satisfy any slice
    libc: c.libc ?? undefined,
    source: `container=${c.format}`,
  };

  if (!REQUIREMENT_READABLE.has(c.format)) {
    return {
      class: c.format === 'unknown' ? 'unrecognised-container' : 'foreign-' + c.format,
      format: c.format,
      ...assemble(platform, addonExpected
        ? { kind: 'unknown', source: `requirement axis not derived for ${c.format} containers` }
        : { kind: 'no-requirement', source: 'bundled shared library, not a Node addon' },
      { container: c }),
    };
  }

  if (c.format === 'macho' || c.format === 'macho-fat') {
    return deriveMacho(buf, c, platform, napiMap, defaultNapi, addonExpected);
  }
  return c.format === 'elf'
    ? deriveElf(buf, c, platform, napiMap, defaultNapi, addonExpected)
    : derivePe(buf, c, platform, napiMap, defaultNapi, addonExpected);
}

function derivePe(buf, c, platform, napiMap, defaultNapi, addonExpected) {
  let pe;
  try {
    pe = readPE(buf);
  } catch (e) {
    return {
      class: 'PARSE-FAIL', format: c.format,
      ...assemble(platform, { kind: 'unknown', source: 'pe parse failed: ' + e.message },
        { container: c }),
    };
  }

  const imps = nodeImports(pe);
  const cls = classify(pe, imps);

  if (cls === 'n-api') {
    const d = readDeclaredNapi(pe);
    const syms = imps.filter((s) => /^(napi_|node_api_)/.test(s));
    const { requirement, evidence } = napiRequirement(d.value, d.method, syms, napiMap, defaultNapi);
    return { class: cls, format: c.format,
      ...assemble(platform, requirement, { container: c, ...evidence }) };
  }

  if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
    const r = readRawNmVersion(pe);
    const evidence = { container: c, nmVersion: r.value, nmMethod: r.method,
                       nmCandidates: r.candidates ?? undefined };
    return { class: cls, format: c.format,
      ...assemble(platform, r.value != null
        ? { kind: 'abi-exact', abi: r.value, source: 'nm_version' }
        : { kind: 'unknown', source: 'raw-V8 addon, nm_version not recovered' }, evidence) };
  }

  return { class: 'unknown', format: c.format,
    ...assemble(platform, addonExpected
      ? { kind: 'unknown', source: 'binary imports neither N-API nor node_module_register' }
      : { kind: 'no-requirement', source: 'no Node linkage; plain shared library' },
      { container: c }) };
}

/**
 * E007. The requirement axis for Mach-O -- the last format that had none, and the
 * explicit gate carried out of Phase 7 (ADR 0002).
 *
 * A universal binary is not one image with several architectures; it is several complete
 * images. So the requirement is derived PER SLICE and the slices must AGREE. That turns
 * E005's cross-architecture oracle from a write-up into a runtime invariant: two slices
 * of one file built from one source at one time cannot honestly require different things,
 * so a disagreement means a decoder is wrong and the answer is a refusal, not a vote.
 *
 * Validated with no macOS host by three agreement oracles (experiments/e007-macho):
 * O1 cross-slice 4/4 agree, O2 cross-flavour vs E001-measured PE values 10/10 agree,
 * O3 filename ABI labels on @datadog/pprof and @newrelic 24/24 agree. The LOADING
 * direction on macOS is still unobserved and is what CROSSPLATFORMTEST.md covers.
 */
function deriveMacho(buf, c, platform, napiMap, defaultNapi, addonExpected) {
  const slices = machoAddon.readSlices(buf);
  if (!slices.length) {
    return { class: 'PARSE-FAIL', format: c.format,
      ...assemble(platform, { kind: 'unknown', source: 'mach-o re-parse found no slices' },
        { container: c }) };
  }

  const per = [];
  for (const sl of slices) {
    const img = machoAddon.readImage(buf, sl.base);
    if (!img) {
      per.push({ arch: sl.arch, cls: 'PARSE-FAIL',
        requirement: { kind: 'unknown', source: 'mach-o slice header unreadable' } });
      continue;
    }
    const syms = machoAddon.readSymbols(buf, img);
    if (!syms.length) {
      per.push({ arch: img.arch ?? sl.arch, cls: 'no-symtab',
        requirement: addonExpected
          ? { kind: 'unknown', source: 'no LC_SYMTAB; cannot read the requirement axis' }
          : { kind: 'no-requirement', source: 'no symbol table; plain shared library' } });
      continue;
    }
    const cls = machoAddon.classify(syms);

    if (cls === 'n-api') {
      const d = machoAddon.readDeclaredNapi(buf, img, syms);
      const napiSyms = machoAddon.napiImports(syms);
      const { requirement, evidence } = napiRequirement(d.value, d.method, napiSyms,
                                                        napiMap, defaultNapi);
      per.push({ arch: img.arch ?? sl.arch, cls, requirement, ...evidence });
      continue;
    }

    if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
      const r = machoAddon.readRawNmVersion(buf, img);
      per.push({ arch: img.arch ?? sl.arch, cls, nmVersion: r.value, nmMethod: r.method,
        requirement: r.value != null
          ? { kind: 'abi-exact', abi: r.value, source: 'nm_version' }
          : { kind: 'unknown', source: `raw-V8 Mach-O addon, nm_version not recovered (${r.method})` } });
      continue;
    }

    per.push({ arch: img.arch ?? sl.arch, cls: 'unknown',
      requirement: addonExpected
        ? { kind: 'unknown', source: 'Mach-O links neither N-API nor node_module_register' }
        : { kind: 'no-requirement', source: 'no Node linkage; plain shared library' } });
  }

  const evidence = { container: c, slices: per };
  // Compare on what the decision actually consumes -- kind plus the number -- not on the
  // provenance string. Two slices that both land on 8, one declared and one via the
  // header default, agree about the requirement even though they disagree about why.
  const key = (r) => `${r.kind}:${r.napi ?? r.abi ?? ''}`;
  const distinct = [...new Set(per.map((p) => key(p.requirement)))];
  const cls = [...new Set(per.map((p) => p.cls))].join('+');

  if (distinct.length > 1) {
    return { class: cls, format: c.format,
      ...assemble(platform, { kind: 'unknown',
        source: 'universal binary slices disagree about the requirement (' +
                per.map((p) => `${p.arch ?? '?'}=${key(p.requirement)}`).join(', ') +
                '); one of the reads must be wrong' }, evidence) };
  }

  return { class: cls, format: c.format,
    ...assemble(platform, per[0].requirement, {
      ...evidence,
      // Hoist the single-slice evidence fields so a thin Mach-O reports the same shape
      // as PE and ELF and `analyze` needs no format-specific branch.
      ...(per.length === 1 ? { ...per[0], requirement: undefined, arch: undefined, cls: undefined }
                           : {}),
    }) };
}

// E005/E008. The requirement axis for ELF. The N-API side was validated by
// cross-architecture agreement (six independent instruction decoders) and by
// cross-flavour agreement with the PE value, which E001 validated against 291 real
// load outcomes. E008 added the raw-V8 side on the same principle: agreement between
// independent sources, never a single plausible-looking read.
function deriveElf(buf, c, platform, napiMap, defaultNapi, addonExpected) {
  const elf = readElf(buf);
  if (!elf) {
    return { class: 'PARSE-FAIL', format: c.format,
      ...assemble(platform, { kind: 'unknown', source: 'elf re-parse failed' }, { container: c }) };
  }
  const syms = elfAddon.readDynsym(buf, elf);
  if (!syms.length) {
    return { class: 'no-dynsym', format: c.format,
      ...assemble(platform, addonExpected
        ? { kind: 'unknown', source: 'no .dynsym; cannot read the requirement axis' }
        : { kind: 'no-requirement', source: 'no dynamic symbols; plain shared library' },
        { container: c }) };
  }

  const cls = elfAddon.classify(syms);

  if (cls === 'n-api') {
    const d = elfAddon.readDeclaredNapi(buf, elf, syms);
    const napiSyms = elfAddon.napiImports(syms);
    const { requirement, evidence } = napiRequirement(d.value, d.method, napiSyms, napiMap, defaultNapi);
    return { class: cls, format: c.format,
      ...assemble(platform, requirement, { container: c, ...evidence }) };
  }

  if (cls === 'raw-v8' || cls === 'raw-v8-noreg') {
    // E008. E005 refused this axis, and its reason was about the CORPUS, not the problem:
    // there were zero raw-V8 ELF addons to validate a struct reader against. A bundled
    // Electron tree supplied 44 (@datadog/pprof and @newrelic, glibc and musl, x64 and
    // arm64, nine ABI levels), all 44 labelled, so the reader is now measured rather than
    // asserted -- 44/44 against filename labels, 13/13 across builds, 44/44 against the
    // E001-validated PE and Mach-O values. Continuing to refuse would leave a derivable
    // fact underived, which is its own kind of unusability.
    const r = elfAddon.readRawNmVersion(buf, elf);
    const evidence = { container: c, nmVersion: r.value, nmMethod: r.method,
                       nmCandidates: r.candidates ?? undefined };
    return { class: cls, format: c.format,
      ...assemble(platform, r.value != null
        ? { kind: 'abi-exact', abi: r.value, source: 'nm_version' }
        : { kind: 'unknown',
            source: `raw-V8 ELF addon, nm_version not recovered (${r.method})` }, evidence) };
  }

  return { class: 'unknown', format: c.format,
    ...assemble(platform, addonExpected
      ? { kind: 'unknown', source: 'ELF imports neither N-API nor node_module_register' }
      : { kind: 'no-requirement', source: 'no Node linkage; plain shared library' },
      { container: c }) };
}
