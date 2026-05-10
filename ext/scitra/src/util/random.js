// Seedable random number generation.
//
// mulberry32 is a small, fast, high-quality PRNG with 2^32 period.
// Same algorithm used by arborist (validation.js) and @gcu/learn —
// keeping the convention consistent across the GCU stack means seeds
// are interchangeable.
//
// Convention: `random_state` is a uint32 seed, or null for non-deterministic
// runs. Pre-seeded RNG instances are not accepted (matches arborist + learn).

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

// Returns a [0, 1) uniform sampler. If random_state is null, uses
// Math.random; otherwise seeds a fresh mulberry32.
export function makeRng(random_state) {
  if (random_state === null || random_state === undefined) return Math.random;
  return mulberry32(random_state);
}

// Box-Muller transform: two uniforms → two independent standard normals.
// We cache the second draw in a closure so consecutive .normal() calls
// pay the trig cost amortized over two samples.
export function makeNormalSampler(random_state) {
  const u = makeRng(random_state);
  let cached = null;
  return function normal() {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    // Marsaglia polar method — avoids transcendentals on the rejection
    // branch, ~1.27× faster than classical Box-Muller in V8 microbenches.
    let x, y, s;
    do {
      x = 2 * u() - 1;
      y = 2 * u() - 1;
      s = x * x + y * y;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt(-2 * Math.log(s) / s);
    cached = y * factor;
    return x * factor;
  };
}
