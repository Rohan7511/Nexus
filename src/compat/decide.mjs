// The decision procedure: does this constraint set hold on this runtime?
//
// Two properties matter more than accuracy, and both are structural:
//
//  1. CONJUNCTION. Every constraint must hold. The axes are independent -- ABI
//     moved 127 -> 137 -> 141 across the three local runtimes while N-API moved
//     9 -> 10 -> 10 -- so no single scalar can stand in for the set.
//  2. CONSERVATIVE DEFAULT. Anything not understood refuses. The failure modes
//     are asymmetric: a raw-V8 ABI mismatch throws a catchable ERR_DLOPEN_FAILED,
//     but an N-API addon whose minimum exceeds the runtime SEGFAULTS
//     (0xC0000005, measured). A false negative is an uncatchable crash; a false
//     positive is a wasted rebuild. They are not comparable costs.

/** @returns {{ok:boolean, why:string}} */
export function check(c, rt, opts = {}) {
  switch (c.kind) {
    case 'platform': {
      if (c.os == null) {
        return { ok: false, why: 'target OS could not be determined from the container; refusing' };
      }
      if (c.os !== rt.os) {
        return { ok: false, why: `object targets ${c.os}, host is ${rt.os}` };
      }
      // A universal Mach-O binary carries several slices and satisfies any of them.
      if (c.archs?.length) {
        if (!c.archs.includes(rt.arch)) {
          return { ok: false, why: `object provides ${c.archs.join('/')}, host is ${rt.arch}` };
        }
      } else if (c.arch == null) {
        return { ok: false, why: 'object architecture could not be determined; refusing' };
      } else if (c.arch !== rt.arch) {
        return { ok: false, why: `object is ${c.os}/${c.arch}, host is ${rt.os}/${rt.arch}` };
      }
      // libc is a real axis only on Linux, where glibc and musl artifacts are
      // published separately precisely because they are not interchangeable.
      if (c.os === 'linux') {
        if (c.libc == null) {
          return { ok: false, why: 'linux object but libc flavour could not be derived; refusing' };
        }
        if (rt.libc == null) {
          return { ok: false, why: `object needs ${c.libc}, host libc flavour unknown; refusing` };
        }
        if (c.libc !== rt.libc) {
          return { ok: false, why: `object is linux/${c.arch}/${c.libc}, host is ${rt.libc}` };
        }
      }
      const suffix = c.libc ? `/${c.libc}` : '';
      return { ok: true, why: `platform ${c.os}/${c.archs?.join('+') ?? c.arch}${suffix} matches host` };
    }

    case 'napi-min':
      if (rt.napi == null) {
        return { ok: false, why: 'runtime reports no N-API level; refusing' };
      }
      return rt.napi >= c.napi
        ? { ok: true, why: `N-API >= ${c.napi} satisfied by runtime level ${rt.napi}` }
        : { ok: false, why: `needs N-API >= ${c.napi}, runtime provides ${rt.napi} (would segfault)` };

    case 'abi-exact':
      if (rt.abi == null) {
        return { ok: false, why: 'runtime reports no module ABI; refusing' };
      }
      return rt.abi === c.abi
        ? { ok: true, why: `exact ABI ${c.abi} matches runtime` }
        : { ok: false, why: `pinned to NODE_MODULE_VERSION ${c.abi}, runtime is ${rt.abi}` };

    case 'no-requirement':
      // A plain shared library has no Node ABI tie, so platform alone is the
      // complete answer. This is asserted from the ABSENCE of Node linkage plus a
      // non-.node filename -- if the PE parser missed the linkage, this would
      // under-constrain, so --strict refuses rather than trusting it.
      return opts.strict
        ? { ok: false, why: `${c.source}; refused under --strict` }
        : { ok: true, why: `${c.source}; platform axis is the complete requirement` };

    case 'unknown':
      return { ok: false, why: `requirement not derivable (${c.source}); refusing conservatively` };

    default:
      return { ok: false, why: `unrecognised constraint kind '${c.kind}'; refusing` };
  }
}

/**
 * Evaluate a whole constraint set. Collects every failure rather than
 * short-circuiting, so `nexus check` can explain all reasons at once.
 * @returns {{ok:boolean, why:string, failures:{constraint:object, why:string}[],
 *            satisfied:string[]}}
 */
export function decide(constraints, rt, opts = {}) {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    // An empty conjunction is vacuously true, which would make a derivation bug
    // read as universal compatibility. Refuse instead. constraints.mjs prevents
    // this by construction; this is the second line of defence.
    return {
      ok: false, satisfied: [],
      why: 'empty constraint set: derivation produced nothing, refusing',
      failures: [{ constraint: null, why: 'empty constraint set' }],
    };
  }
  const failures = [];
  const satisfied = [];
  for (const c of constraints) {
    const r = check(c, rt, opts);
    if (r.ok) satisfied.push(r.why);
    else failures.push({ constraint: c, why: r.why });
  }
  return {
    ok: failures.length === 0,
    satisfied,
    failures,
    why: failures.length === 0 ? 'all constraints satisfied' : failures.map((f) => f.why).join('; '),
  };
}
