// Optional acceleration backends.
//
// scitra is zero-deps by default. When natra is loaded (which brings
// alpack-compiled BLAS via Wasm SIMD), specific hot paths can dispatch
// through it for a 5-10× speedup on large matmuls. The user opts in
// either explicitly via `setBackend({ natra: <natra-instance> })` or
// implicitly by registering the natra instance on globalThis under
// `__scitraBackend__` (which auditable's natra extension can do at
// init time so notebooks "just work").
//
// All public scitra functions stay synchronous; backend lookups happen
// lazily at the call site, so this module never blocks the bundle.

let _backend = { natra: undefined };

export function setBackend(b) {
  if (b && typeof b === 'object') {
    Object.assign(_backend, b);
  }
}

export function clearBackend() {
  _backend = { natra: undefined };
}

// Returns the configured natra instance (must have .scope/.array/.toTypedArray)
// or null if no backend is available. Probes globalThis.__scitraBackend__ on
// first call so notebooks don't need explicit setup.
export function getNatra() {
  if (_backend.natra !== undefined) return _backend.natra;
  if (typeof globalThis !== 'undefined' && globalThis.__scitraBackend__) {
    const candidate = globalThis.__scitraBackend__.natra;
    if (candidate && typeof candidate.scope === 'function'
        && typeof candidate.array === 'function'
        && typeof candidate.toTypedArray === 'function') {
      _backend.natra = candidate;
      return candidate;
    }
  }
  _backend.natra = null;
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
