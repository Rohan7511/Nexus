// Public surface, for embedding the analysis without the CLI.

export { readContainer } from './artifact/container.mjs';
export { readElf } from './artifact/elf.mjs';
export { readMacho } from './artifact/macho.mjs';
export { readPE } from './artifact/pe.mjs';
export { deriveConstraints } from './artifact/constraints.mjs';
export { buildNapiMap, resolveNapiMap } from './artifact/napi-map.mjs';
export { check, decide } from './compat/decide.mjs';
export { analyzeTree } from './compat/analyze-tree.mjs';
export { currentRuntime, probeRuntime, parseTarget, targetRuntime, runtimeLabel } from './runtime/probe.mjs';
export { Store } from './store/cas.mjs';
export { scanTree, isNativeObject, isSharedLibrary } from './graph/scan.mjs';
export { canonical, canonicalFile, sha256, hashJson, graphId } from './graph/serialize.mjs';
