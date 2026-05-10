// Special functions used by stats.distributions and friends.
//
// Implementations are well-known closed-form approximations published in
// Numerical Recipes / Abramowitz & Stegun / by Acklam.
//
// Accuracy: erf via A&S 7.1.26 → max abs error ≈ 1.5e-7. ndtri via
// Acklam → max relative error ≈ 1.15e-9 (so absolute error scales with
// the result, e.g. ndtri(0.975) ≈ 1.96 has ~2e-9 absolute error). lgamma
// via Lanczos → ~1e-15 for x > 0.5.
//
// Sufficient for statistical inference at any practical sample size.
// Pegged to scipy's API but not scipy's numerical accuracy.

// ── erf and erfc ─────────────────────────────────────────────────────
//
// Chebyshev-based approximation good to 1.5e-7 for all x. Source:
// Numerical Recipes 3e §6.2 (algorithm 6.2.6, fitted on |t| ≤ 4 with
// double-precision coefficients).

export function erf(x) {
  if (x === 0) return 0;
  if (!Number.isFinite(x)) {
    if (x === Infinity) return 1;
    if (x === -Infinity) return -1;
    return NaN;
  }
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  // Abramowitz & Stegun 7.1.26 — max error ≈ 1.5e-7
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y = 1.0 - (((((
        1.061405429  * t
      - 1.453152027) * t
      + 1.421413741) * t
      - 0.284496736) * t
      + 0.254829592) * t) * Math.exp(-ax * ax);
  return sign * y;
}

export function erfc(x) {
  return 1 - erf(x);
}

// ── inverse normal CDF (probit / Φ⁻¹) ──────────────────────────────
//
// Peter Acklam's algorithm — rational approximation good to ~1.15e-9
// over the whole tail. http://home.online.no/~pjacklam/notes/invnorm/
//
// Used directly for Normal.ppf and via change-of-variable for everything
// else's ppf.

const _A = [
  -3.969683028665376e+01,
   2.209460984245205e+02,
  -2.759285104469687e+02,
   1.383577518672690e+02,
  -3.066479806614716e+01,
   2.506628277459239e+00,
];
const _B = [
  -5.447609879822406e+01,
   1.615858368580409e+02,
  -1.556989798598866e+02,
   6.680131188771972e+01,
  -1.328068155288572e+01,
];
const _C = [
  -7.784894002430293e-03,
  -3.223964580411365e-01,
  -2.400758277161838e+00,
  -2.549732539343734e+00,
   4.374664141464968e+00,
   2.938163982698783e+00,
];
const _D = [
   7.784695709041462e-03,
   3.224671290700398e-01,
   2.445134137142996e+00,
   3.754408661907416e+00,
];

const PLOW = 0.02425;
const PHIGH = 1.0 - PLOW;

export function ndtri(p) {
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p < 0 || p > 1 || !Number.isFinite(p)) return NaN;

  let q, r;
  if (p < PLOW) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((_C[0]*q+_C[1])*q+_C[2])*q+_C[3])*q+_C[4])*q+_C[5]) /
           ((((_D[0]*q+_D[1])*q+_D[2])*q+_D[3])*q+1);
  }
  if (p <= PHIGH) {
    q = p - 0.5;
    r = q * q;
    return (((((_A[0]*r+_A[1])*r+_A[2])*r+_A[3])*r+_A[4])*r+_A[5])*q /
           (((((_B[0]*r+_B[1])*r+_B[2])*r+_B[3])*r+_B[4])*r+1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((_C[0]*q+_C[1])*q+_C[2])*q+_C[3])*q+_C[4])*q+_C[5]) /
          ((((_D[0]*q+_D[1])*q+_D[2])*q+_D[3])*q+1);
}

// inverse erf, derived from inverse normal CDF:
//   erf(x) = 2*Φ(x*√2) − 1   ⇒   erfinv(y) = ndtri((y+1)/2) / √2
export function erfinv(y) {
  if (y === 0) return 0;
  if (y === 1) return Infinity;
  if (y === -1) return -Infinity;
  if (y < -1 || y > 1) return NaN;
  return ndtri((y + 1) / 2) / Math.SQRT2;
}

// ── log-gamma, gamma, beta ────────────────────────────────────────────
//
// Lanczos approximation — accurate to ~1e-15 for x > 0.5; for 0 < x < 0.5
// uses Euler reflection. Used by Beta/Gamma/Chi2/T/F distributions
// (post-v0.1). Pre-shipped here because it's small (~30 LOC) and the
// reflection formula benefits from being co-located.

const _LG_G = 7;
const _LG_C = [
   0.99999999999980993,
   676.5203681218851,
  -1259.1392167224028,
   771.32342877765313,
  -176.61502916214059,
   12.507343278686905,
  -0.13857109526572012,
   9.9843695780195716e-6,
   1.5056327351493116e-7,
];

export function lgamma(x) {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = _LG_C[0];
  const t = x + _LG_G + 0.5;
  for (let i = 1; i < _LG_C.length; i++) a += _LG_C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

export function gamma(x) {
  return Math.exp(lgamma(x));
}

export function lbeta(a, b) {
  return lgamma(a) + lgamma(b) - lgamma(a + b);
}
