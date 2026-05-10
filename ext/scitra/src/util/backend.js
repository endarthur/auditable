// Optional acceleration backends.
//
// scitra is zero-deps by default. When natra is loaded (which brings
// alpack-compiled BLAS via Wasm SIMD), specific hot paths can dispatch
// through it for a 5-10× speedup on large matmuls. Discovery uses the
// shared @gcu/registry protocol — see ext/gcu-registry/SPEC.md for the
// full convention. Summary:
//
//   • Provider (natra) self-registers at the end of its factory:
//       globalThis.__gcu__.providers.natra = instance
//   • Consumer (scitra, here) does a lazy lookup at the call site,
//       falling through to its inline path if the registry is empty.
//   • Tests and node scripts can override via setBackend({ natra }),
//       which wins over the registry.
//
// All public scitra functions stay synchronous; backend lookups happen
// lazily at the call site, so this module never blocks the bundle.

let _explicit = { natra: undefined };

export function setBackend(b) {
  if (b && typeof b === 'object') {
    Object.assign(_explicit, b);
  }
}

export function clearBackend() {
  _explicit = { natra: undefined };
}

// Returns a configured natra instance — must expose .scope/.array/.toTypedArray.
// Resolution order:
//   1. Explicit setBackend({ natra }) — wins over everything.
//   2. globalThis.__gcu__.providers.natra (registry, version 1).
//   3. null (no backend; consumers fall back to inline).
export function getNatra() {
  if (_explicit.natra !== undefined) return _explicit.natra;
  const root = globalThis.__gcu__;
  if (!root || root.version !== 1) return null;
  const candidate = root.providers?.natra;
  if (candidate
      && typeof candidate.scope === 'function'
      && typeof candidate.array === 'function'
      && typeof candidate.toTypedArray === 'function') {
    return candidate;
  }
  return null;
}

// Threshold tuned via test/scitra-cdist-bench.mjs. Below n*m = 250k,
// the gemm trick's wasm FFI overhead can match or even slightly beat
// its SIMD win (at small d, ~0.97× speedup at 200×200 d=3). At and
// above 250k we see consistent 1.34× to 4.84× wins, scaling with d:
//
//   |   size     | d  | inline (ms) | gemm (ms) | speedup |
//   |------------|----|-------------|-----------|---------|
//   |  500×500   |  3 |    1.41     |   1.05    | 1.34×   |
//   | 1000×1000  |  3 |    6.26     |   3.64    | 1.72×   |
//   |  500×500   | 10 |    2.86     |   1.17    | 2.45×   |
//   | 1000×1000  | 10 |   11.49     |   4.17    | 2.76×   |
//   |  500×500   | 50 |   12.93     |   2.67    | 4.84×   |
export const GEMM_NM_THRESHOLD = 250_000;
