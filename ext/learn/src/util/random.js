// Seedable RNG. mulberry32 — small, fast, 2^32 period. Matches the
// convention used by arborist (validation.js) and @gcu/scitra so seeds
// are interchangeable across the GCU stack.
//
// Pre-seeded RNG instances are not accepted as random_state inputs (the
// fourth JS-imposed deviation in SPEC-learn §3.6); pass an integer.

export function mulberry32(seed) {
  let s = (seed | 0) >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolve a random_state value into a uniform [0, 1) sampler.
 * `null` / `undefined` returns Math.random; an integer seeds mulberry32;
 * any other type raises (per SPEC-learn §3.6 deviation 4).
 */
export function makeRng(random_state) {
  if (random_state == null) return Math.random;
  if (typeof random_state === 'number' && Number.isInteger(random_state)) {
    return mulberry32(random_state);
  }
  throw new TypeError(
    `random_state must be an integer or null; got ${typeof random_state}. ` +
    `(Pre-seeded RNG instances are not accepted; see SPEC-learn §3.6.)`,
  );
}

// Box-Muller cached-pair normal sampler.
export function makeNormalSampler(uniform) {
  let cached = null;
  return function () {
    if (cached !== null) { const v = cached; cached = null; return v; }
    let u1, u2;
    do { u1 = uniform(); } while (u1 === 0);
    u2 = uniform();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    cached = z1;
    return z0;
  };
}
