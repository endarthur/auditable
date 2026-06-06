// @gcu/dimensions — the dimension algebra at the heart of dimensional analysis.
//
// A dimension is a sparse object `{ axis: integerExponent }`. Dimensions form a
// free abelian group under multiplication (componentwise exponent add); the
// identity is `{}` (scalar / dimensionless) and the inverse is negation. That's the
// whole model — small, total, and exact (integer exponents, no floats).
//
// This is the zero-dependency core shared across GCU: ep's @gcu/numbat does full
// unit resolution + conversion on top of it; auditable's @gcu/over uses it for
// compile-time grade-math checking (with a domain unit table where, deliberately,
// %/g·t⁻¹/ppm are DISTINCT axes — mining grades must not silently mix even though a
// physics engine would call them all dimensionless). The axis KEYS are the caller's
// vocabulary: numbat uses 'length'/'mass'/'time'/…; a domain layer can mint its own.

// Equal iff every axis has the same exponent (missing = 0, so key order and stored
// zeros don't matter).
export const dimEq = (a, b) => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] || 0) !== (b[k] || 0)) return false;
  }
  return true;
};

// Product: add exponents componentwise, dropping any that cancel to zero.
export const dimMul = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) + (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

// Quotient: subtract exponents componentwise, dropping zeros.
export const dimDiv = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) - (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

// Raise to an integer power: scale every exponent, dropping zeros.
export const dimPow = (d, n) => {
  const r = {};
  for (const k in d) {
    const e = d[k] * n;
    if (e) r[k] = e;
  }
  return r;
};

// Reciprocal dimension (negate all exponents).
export const dimInv = (d) => dimPow(d, -1);

// True for the scalar / dimensionless dimension only. (Checks Object.keys, so a
// stored `{length: 0}` reads as non-empty — but the arithmetic above never produces
// stored zeros, so that case doesn't arise in practice.)
export const dimEmpty = (d) => Object.keys(d).length === 0;

// Human-readable form: `mass·length^-3`, or `-` for dimensionless.
export const dimFormat = (d) => {
  const parts = Object.entries(d).map(([k, v]) => (v === 1 ? k : `${k}^${v}`));
  return parts.join('·') || '-';
};

// DimRegistry — a name → dim-vector table. Base dimensions allocate a fresh axis
// named after themselves (lowercased); derived dimensions store a precomputed vector
// (built via the arithmetic above). Re-defining with the same shape is idempotent
// (so a vendored module's `dimension Length` won't conflict with a host's pre-seed);
// re-defining with a different shape throws.
export class DimRegistry {
  constructor() {
    this._dims = new Map();
  }

  defineBase(name) {
    const axis = name.toLowerCase();
    this._define(name, { [axis]: 1 });
  }

  defineDerived(name, dim) {
    this._define(name, dim);
  }

  _define(name, dim) {
    if (this._dims.has(name)) {
      if (dimEq(this._dims.get(name), dim)) return;
      throw new Error(`dimension already defined with different shape: ${name}`);
    }
    this._dims.set(name, dim);
  }

  resolve(name) { return this._dims.get(name) ?? null; }
  has(name) { return this._dims.has(name); }
  list() { return [...this._dims.entries()].map(([name, dim]) => ({ name, dim })); }
}
