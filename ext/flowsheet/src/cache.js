// @gcu/flowsheet — the content-addressed result cache.
//
// Dumb store keyed by lineage hash: { has, get, set }. Eviction is always safe
// — every entry is recomputable, so eviction only costs time, never correctness
// (§6). v1 is in-memory with optional LRU; a VFS-backed cache (archive blobs) is
// a drop-in implementing the same three methods.

export function createMemoryCache({ max = Infinity } = {}) {
  const store = new Map();   // hash -> { value, last }
  let tick = 0;
  function evict() {
    while (store.size > max) {
      let lruKey = null, lruAt = Infinity;
      for (const [k, e] of store) { if (e.last < lruAt) { lruAt = e.last; lruKey = k; } }
      if (lruKey === null) break;
      store.delete(lruKey);
    }
  }
  return {
    has: (h) => store.has(h),
    get: (h) => { const e = store.get(h); if (!e) return undefined; e.last = ++tick; return e.value; },
    set: (h, v) => { store.set(h, { value: v, last: ++tick }); evict(); },
    delete: (h) => store.delete(h),
    clear: () => store.clear(),
    size: () => store.size,
    keys: () => [...store.keys()],
  };
}

// A no-op cache (always misses) — for measuring uncached cost or forcing recompute.
export function createNullCache() {
  return { has: () => false, get: () => undefined, set: () => {}, delete: () => {}, clear: () => {}, size: () => 0, keys: () => [] };
}
