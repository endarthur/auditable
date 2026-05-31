// @gcu/sluice — online / streaming statistics nucleus
// Auto-generated from ext/sluice/src/ — do not edit directly

// -- accumulator.js --

// @gcu/sluice — the Accumulator protocol + simple value-accumulators.
//
// Accumulator<State, Out> = {
//   create()                      -> State          // fresh, allocation-light
//   push(state, value, weight=1)  -> void           // hot path: mutate in place
//   merge(a, b)                   -> State           // combine partial states (parallel/chunked)
//   result(state)                 -> Out             // finalize
// }
// State is plain, structuredClone-transferable data — that is the whole
// serialization story (worker transfer + cache write are free).
//
// Value-accumulators take *values* and are row-agnostic. The row-level fan-out
// (collect/groupBy/binned, see combinators.js) carries row->value extractors.

// Validate/normalize a custom accumulator so it's first-class.
function accumulator(spec) {
  for (const k of ['create', 'push', 'merge', 'result']) {
    if (typeof spec[k] !== 'function') {
      throw new Error(`sluice: accumulator needs a ${k}() function`);
    }
  }
  return { create: spec.create, push: spec.push, merge: spec.merge, result: spec.result };
}

// count() — number of items (weighted: sum of weights).
function count() {
  return {
    create: () => ({ n: 0 }),
    push: (s, _v, w = 1) => { s.n += w; },
    merge: (a, b) => ({ n: a.n + b.n }),
    result: (s) => s.n,
  };
}

// sum() — weighted sum of finite values, plus a plain count of contributing values.
function sum() {
  return {
    create: () => ({ n: 0, sum: 0 }),
    push: (s, v, w = 1) => { if (Number.isFinite(v)) { s.n += 1; s.sum += v * w; } },
    merge: (a, b) => ({ n: a.n + b.n, sum: a.sum + b.sum }),
    result: (s) => ({ count: s.n, sum: s.sum }),
  };
}

// extent() — min/max only (cheap, no moments).
function extent() {
  return {
    create: () => ({ n: 0, min: Infinity, max: -Infinity }),
    push: (s, v) => { if (Number.isFinite(v)) { s.n++; if (v < s.min) s.min = v; if (v > s.max) s.max = v; } },
    merge: (a, b) => ({ n: a.n + b.n, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }),
    result: (s) => ({ count: s.n, min: s.n ? s.min : null, max: s.n ? s.max : null }),
  };
}

// welford() — unweighted single-pass mean/variance/std + bias-corrected
// skewness/kurtosis (count/min/max/m1..m4). push() ignores weight (welford is
// unweighted; for weighted mean/variance use weightedStats()). merge() uses the
// Pébay (2008) parallel moment-combination formulas — NOT term-wise addition.
function welford() {
  return {
    create: () => ({ n: 0, min: Infinity, max: -Infinity, m1: 0, m2: 0, m3: 0, m4: 0, zeros: 0 }),
    push: (s, v) => {
      if (!Number.isFinite(v)) return;
      if (v === 0) s.zeros++;
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
      const n = ++s.n;
      const delta = v - s.m1;
      const delta_n = delta / n;
      const delta_n2 = delta_n * delta_n;
      const term1 = delta * delta_n * (n - 1);
      s.m4 += term1 * delta_n2 * (n * n - 3 * n + 3) + 6 * delta_n2 * s.m2 - 4 * delta_n * s.m3;
      s.m3 += term1 * delta_n * (n - 2) - 3 * delta_n * s.m2;
      s.m2 += term1;
      s.m1 += delta_n;
    },
    merge: combineMoments,
    result: (s) => {
      const n = s.n;
      const variance = n > 1 ? s.m2 / (n - 1) : null;
      const std = variance !== null ? Math.sqrt(variance) : null;
      let skewness = null;
      if (n > 2 && s.m2 > 0) {
        skewness = (Math.sqrt(n) * s.m3) / Math.pow(s.m2, 1.5);
        skewness *= Math.sqrt(n * (n - 1)) / (n - 2);
      }
      let kurtosis = null;
      if (n > 3 && s.m2 > 0) {
        kurtosis = (n * s.m4) / (s.m2 * s.m2) - 3;
        kurtosis = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * kurtosis + 6);
      }
      return {
        count: n, zeros: s.zeros,
        min: n > 0 ? s.min : null, max: n > 0 ? s.max : null,
        mean: n > 0 ? s.m1 : null, variance, std, skewness, kurtosis,
      };
    },
  };
}

// Pébay parallel combination of two moment partitions (count/mean=m1/M2/M3/M4).
function combineMoments(a, b) {
  if (a.n === 0) return { ...b };
  if (b.n === 0) return { ...a };
  const nA = a.n, nB = b.n, n = nA + nB;
  const d = b.m1 - a.m1;       // mean difference
  const d2 = d * d, d3 = d2 * d, d4 = d2 * d2;
  const m1 = a.m1 + d * nB / n;
  const m2 = a.m2 + b.m2 + d2 * nA * nB / n;
  const m3 = a.m3 + b.m3
    + d3 * nA * nB * (nA - nB) / (n * n)
    + 3 * d * (nA * b.m2 - nB * a.m2) / n;
  const m4 = a.m4 + b.m4
    + d4 * nA * nB * (nA * nA - nA * nB + nB * nB) / (n * n * n)
    + 6 * d2 * (nA * nA * b.m2 + nB * nB * a.m2) / (n * n)
    + 4 * d * (nA * b.m3 - nB * a.m3) / n;
  return {
    n, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max),
    m1, m2, m3, m4, zeros: a.zeros + b.zeros,
  };
}

// weightedStats() — weighted count/mean/variance/std (no higher moments).
// For declustering, volume/density weighting, etc. Variance uses the
// frequency-weight convention (denominator wSum - 1; reduces to welford for w=1).
function weightedStats() {
  return {
    create: () => ({ n: 0, wSum: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity }),
    push: (s, v, w = 1) => {
      if (!Number.isFinite(v) || !(w > 0)) return;
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
      s.n++;
      const wSumOld = s.wSum;
      s.wSum += w;
      const meanOld = s.mean;
      s.mean = meanOld + (w / s.wSum) * (v - meanOld);
      s.m2 += w * (v - meanOld) * (v - s.mean);
      void wSumOld;
    },
    merge: (a, b) => {
      if (a.wSum === 0) return { ...b };
      if (b.wSum === 0) return { ...a };
      const wSum = a.wSum + b.wSum;
      const d = b.mean - a.mean;
      const mean = a.mean + d * b.wSum / wSum;
      const m2 = a.m2 + b.m2 + d * d * a.wSum * b.wSum / wSum;
      return { n: a.n + b.n, wSum, mean, m2, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
    },
    result: (s) => {
      const variance = s.wSum > 1 ? s.m2 / (s.wSum - 1) : null;
      return {
        count: s.n, weight: s.wSum,
        min: s.n ? s.min : null, max: s.n ? s.max : null,
        mean: s.n ? s.mean : null, variance, std: variance !== null ? Math.sqrt(variance) : null,
      };
    },
  };
}

// -- tdigest.js --

// @gcu/sluice — t-digest streaming approximate quantiles.
//
// Chosen over P² because it MERGES cleanly (the parallel-scan requirement).
// result() ships plain centroids; quantileFromCentroids() answers any p later
// — the "worker accumulates → ships centroids → client queries arbitrary p
// without re-scanning" pattern.

const DEFAULT_COMPRESSION = 100;
const BUFFER_SIZE = 2000;

// tdigest() accumulator. State: { centroids:[{mean,count}], buffer:[v…], totalCount, k }.
// push() ignores weight (weighted quantiles are out of scope for v1).
function tdigest({ compression = DEFAULT_COMPRESSION } = {}) {
  return {
    create: () => ({ centroids: [], buffer: [], totalCount: 0, k: compression }),
    push: (s, v) => {
      if (!Number.isFinite(v)) return;
      s.buffer.push(v);
      s.totalCount++;
      if (s.buffer.length >= BUFFER_SIZE) flush(s);
    },
    merge: (a, b) => {
      const k = a.k || b.k || DEFAULT_COMPRESSION;
      const entries = [
        ...a.centroids.map((c) => ({ mean: c.mean, count: c.count })),
        ...a.buffer.map((v) => ({ mean: v, count: 1 })),
        ...b.centroids.map((c) => ({ mean: c.mean, count: c.count })),
        ...b.buffer.map((v) => ({ mean: v, count: 1 })),
      ];
      entries.sort((x, y) => x.mean - y.mean);
      const total = a.totalCount + b.totalCount;
      return { centroids: compress(entries, total, k), buffer: [], totalCount: total, k };
    },
    result: (s) => {
      flush(s);
      return { count: s.totalCount, centroids: s.centroids.map((c) => [c.mean, c.count]) };
    },
  };
}

function flush(s) {
  if (s.buffer.length === 0) return;
  s.buffer.sort((a, b) => a - b);
  const merged = [];
  let bi = 0, ci = 0;
  while (bi < s.buffer.length || ci < s.centroids.length) {
    if (bi < s.buffer.length && (ci >= s.centroids.length || s.buffer[bi] <= s.centroids[ci].mean)) {
      merged.push({ mean: s.buffer[bi], count: 1 }); bi++;
    } else {
      merged.push({ mean: s.centroids[ci].mean, count: s.centroids[ci].count }); ci++;
    }
  }
  s.buffer = [];
  s.centroids = compress(merged, s.totalCount, s.k);
}

function compress(centroids, totalCount, k) {
  if (centroids.length <= 1) return centroids;
  const out = [{ mean: centroids[0].mean, count: centroids[0].count }];
  let cum = centroids[0].count;
  for (let i = 1; i < centroids.length; i++) {
    const c = centroids[i];
    const last = out[out.length - 1];
    const q = cum / totalCount;
    const maxSize = Math.max(1, Math.floor(4 * k * q * (1 - q)));
    if (last.count + c.count <= maxSize) {
      const nc = last.count + c.count;
      last.mean += (c.mean - last.mean) * c.count / nc;
      last.count = nc;
    } else {
      out.push({ mean: c.mean, count: c.count });
    }
    cum += c.count;
  }
  return out;
}

// Query a quantile from shipped/cached centroids ([[mean,count]…]) + total count.
function quantileFromCentroids(centroids, totalCount, q) {
  const n = centroids.length;
  if (n === 0 || totalCount === 0) return null;
  if (n === 1) return centroids[0][0];
  if (q <= 0) return centroids[0][0];
  if (q >= 1) return centroids[n - 1][0];
  const target = q * totalCount;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const cMean = centroids[i][0], cCount = centroids[i][1];
    const mid = cum + cCount / 2;
    if (target < mid) {
      if (i === 0) return cMean;
      const pMean = centroids[i - 1][0], pCount = centroids[i - 1][1];
      const prevMid = cum - pCount / 2;
      const t = (target - prevMid) / (mid - prevMid);
      return pMean + t * (cMean - pMean);
    }
    cum += cCount;
  }
  return centroids[n - 1][0];
}

// Convenience: quantile of a live tdigest state.
function quantile(state, q) {
  flush(state);
  return quantileFromCentroids(state.centroids.map((c) => [c.mean, c.count]), state.totalCount, q);
}

// -- categorical.js --

// @gcu/sluice — categorical accumulators: exact-with-cap value counts +
// cardinality. Mining domains are small (tens), so exact-with-cap beats
// probabilistic (HLL) here; the `overflow` flag signals when the cap was hit.

const DEFAULT_LIMIT = 500;

// topK() — value -> weighted count, distinct count, overflow flag.
// result().top(k) returns the k most frequent [value, count] pairs.
function topK({ limit = DEFAULT_LIMIT } = {}) {
  return {
    create: () => ({ counts: {}, distinct: 0, overflow: false, limit }),
    push: (s, v, w = 1) => {
      if (v === null || v === undefined || v === '') return;
      const key = String(v);
      if (Object.prototype.hasOwnProperty.call(s.counts, key)) {
        s.counts[key] += w;
      } else if (s.distinct < s.limit) {
        s.counts[key] = w;
        s.distinct++;
      } else {
        s.overflow = true;
      }
    },
    merge: (a, b) => mergeCounts(a, b),
    result: (s) => ({
      counts: s.counts,
      distinct: s.distinct,
      overflow: s.overflow,
      top: (k) => Object.entries(s.counts).sort((x, y) => y[1] - x[1]).slice(0, k),
    }),
  };
}

// cardinality() — same machinery, result exposes just distinct/overflow.
function cardinality({ limit = DEFAULT_LIMIT } = {}) {
  const tk = topK({ limit });
  return {
    create: tk.create,
    push: tk.push,
    merge: tk.merge,
    result: (s) => ({ distinct: s.distinct, overflow: s.overflow }),
  };
}

function mergeCounts(a, b) {
  const limit = a.limit || b.limit || DEFAULT_LIMIT;
  const counts = { ...a.counts };
  let distinct = Object.keys(counts).length;
  let overflow = a.overflow || b.overflow;
  for (const key in b.counts) {
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      counts[key] += b.counts[key];
    } else if (distinct < limit) {
      counts[key] = b.counts[key];
      distinct++;
    } else {
      overflow = true;
    }
  }
  return { counts, distinct, overflow, limit };
}

// -- histogram.js --

// @gcu/sluice — fixed-bin weighted histogram (dense Float64Array counts).
// Bounded by construction. Float64Array state is structuredClone-transferable.

function histogram({ min, max, bins }) {
  if (!(bins > 0) || !(max > min)) {
    throw new Error('sluice: histogram needs bins > 0 and max > min');
  }
  const width = (max - min) / bins;
  return {
    create: () => ({ min, max, bins, width, counts: new Float64Array(bins), under: 0, over: 0, n: 0 }),
    push: (s, v, w = 1) => {
      if (!Number.isFinite(v)) return;
      s.n++;
      let idx = Math.floor((v - s.min) / s.width);
      if (idx < 0) { s.under += w; return; }
      if (idx >= s.bins) { s.over += w; return; }
      s.counts[idx] += w;
    },
    merge: (a, b) => {
      if (a.bins !== b.bins || a.min !== b.min || a.max !== b.max) {
        throw new Error('sluice: histogram merge needs matching {min,max,bins}');
      }
      const counts = new Float64Array(a.bins);
      for (let i = 0; i < a.bins; i++) counts[i] = a.counts[i] + b.counts[i];
      return { min: a.min, max: a.max, bins: a.bins, width: a.width, counts, under: a.under + b.under, over: a.over + b.over, n: a.n + b.n };
    },
    result: (s) => {
      const edges = new Array(s.bins + 1);
      for (let i = 0; i <= s.bins; i++) edges[i] = s.min + i * s.width;
      return { edges, counts: Array.from(s.counts), under: s.under, over: s.over, count: s.n };
    },
  };
}

// Cumulative-from-top: out[i] = sum_{j >= i} counts[j]. The grade-tonnage shape
// (tonnage at-or-above each cutoff). A small util; the GT *node* composes it.
function cumulativeFromTop(counts) {
  const n = counts.length;
  const out = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += counts[i]; out[i] = acc; }
  return out;
}

// -- combinators.js --

// @gcu/sluice — combinators: the row-level fan-out layer. Each returns an
// Accumulator (same protocol), so they nest freely. They carry row->value
// extractors; the value-accumulators they wrap stay row-agnostic.
//
// weight: a combinator-level { weight: row => w } option, applied to every
// sub-accumulator that uses it.

// collect({ name: [acc, row => value], … }, { weight? }) — analyze many columns
// in one pass. State {name: subState}; result {name: subOut}.
function collect(spec, { weight } = {}) {
  const names = Object.keys(spec);
  return {
    create: () => {
      const st = {};
      for (const name of names) st[name] = spec[name][0].create();
      return st;
    },
    push: (st, row, w = 1) => {
      const ww = weight ? weight(row) : w;
      for (const name of names) {
        const [acc, extract] = spec[name];
        acc.push(st[name], extract(row), ww);
      }
    },
    merge: (a, b) => {
      const st = {};
      for (const name of names) st[name] = spec[name][0].merge(a[name], b[name]);
      return st;
    },
    result: (st) => {
      const out = {};
      for (const name of names) out[name] = spec[name][0].result(st[name]);
      return out;
    },
  };
}

// groupBy(row => key, () => acc, { maxGroups, weight }) — stratified accumulation.
// State { groups: {key: subState}, overflow }. result { groups: {key: subOut}, overflow }.
function groupBy(keyOf, accFactory, { maxGroups = 500, weight } = {}) {
  const acc = accFactory();
  return {
    create: () => ({ groups: {}, overflow: false }),
    push: (st, row, w = 1) => {
      const key = String(keyOf(row));
      let sub = st.groups[key];
      if (sub === undefined) {
        if (Object.keys(st.groups).length >= maxGroups) { st.overflow = true; return; }
        sub = acc.create();
        st.groups[key] = sub;
      }
      acc.push(sub, row, weight ? weight(row) : w);
    },
    merge: (a, b) => {
      const groups = {};
      for (const key in a.groups) groups[key] = a.groups[key];
      let overflow = a.overflow || b.overflow;
      for (const key in b.groups) {
        if (key in groups) {
          groups[key] = acc.merge(groups[key], b.groups[key]);
        } else if (Object.keys(groups).length < maxGroups) {
          groups[key] = b.groups[key];
        } else {
          overflow = true;
        }
      }
      return { groups, overflow };
    },
    result: (st) => {
      const out = {};
      for (const key in st.groups) out[key] = acc.result(st.groups[key]);
      return { groups: out, overflow: st.overflow };
    },
  };
}

// binned(row => coord, opts, () => acc) — accumulate a sub-accumulator per spatial
// bin. opts = { min, max, bins } (dense Float64-indexed) or { binWidth } (sparse).
// Swath plots, binned profiles. Each bin reports its center + the sub-result.
function binned(coordOf, opts, accFactory, { weight } = {}) {
  const acc = accFactory();
  const dense = opts.bins !== undefined && opts.min !== undefined && opts.max !== undefined;
  if (dense) {
    const { min, max, bins } = opts;
    const width = (max - min) / bins;
    return {
      create: () => ({ min, max, bins, width, cells: new Array(bins).fill(null), under: 0, over: 0 }),
      push: (st, row, w = 1) => {
        const c = coordOf(row);
        if (!Number.isFinite(c)) return;
        let idx = Math.floor((c - st.min) / st.width);
        if (idx < 0) { st.under++; return; }
        if (idx >= st.bins) { st.over++; return; }
        if (st.cells[idx] === null) st.cells[idx] = acc.create();
        acc.push(st.cells[idx], row, weight ? weight(row) : w);
      },
      merge: (a, b) => {
        const cells = new Array(a.bins).fill(null);
        for (let i = 0; i < a.bins; i++) {
          if (a.cells[i] && b.cells[i]) cells[i] = acc.merge(a.cells[i], b.cells[i]);
          else cells[i] = a.cells[i] || b.cells[i];
        }
        return { min: a.min, max: a.max, bins: a.bins, width: a.width, cells, under: a.under + b.under, over: a.over + b.over };
      },
      result: (st) => st.cells
        .map((sub, i) => sub === null ? null : { center: st.min + (i + 0.5) * st.width, value: acc.result(sub) })
        .filter((x) => x !== null),
    };
  }
  const binWidth = opts.binWidth;
  if (!(binWidth > 0)) throw new Error('sluice: binned needs {min,max,bins} or {binWidth>0}');
  return {
    create: () => ({ binWidth, bins: {} }),
    push: (st, row, w = 1) => {
      const c = coordOf(row);
      if (!Number.isFinite(c)) return;
      const idx = Math.floor(c / st.binWidth);
      if (st.bins[idx] === undefined) st.bins[idx] = acc.create();
      acc.push(st.bins[idx], row, weight ? weight(row) : w);
    },
    merge: (a, b) => {
      const bins = {};
      for (const k in a.bins) bins[k] = a.bins[k];
      for (const k in b.bins) bins[k] = (k in bins) ? acc.merge(bins[k], b.bins[k]) : b.bins[k];
      return { binWidth: a.binWidth, bins };
    },
    result: (st) => Object.keys(st.bins)
      .map(Number).sort((x, y) => x - y)
      .map((idx) => ({ center: (idx + 0.5) * st.binWidth, value: acc.result(st.bins[idx]) })),
  };
}

// -- spec.js --

// @gcu/sluice — serializable accumulator specs.
//
// A spec is plain JSON describing an accumulator tree; accumulatorFromSpec(spec)
// builds the live accumulator. This is the cross-realm op contract (§7a "ops
// must be serializable, not closures"): a worker receives a SPEC and rebuilds the
// accumulator locally — no closure crosses the boundary. Also how a pipeline node
// persists its analysis config. Column extractors are by NAME (r => r[column]);
// arbitrary per-row calc is a future AIR-compiled extractor, not a closure here.
//
// Grammar:
//   leaf:    { kind: 'count'|'sum'|'extent'|'welford'|'weightedStats' }
//            { kind: 'tdigest', compression? } | { kind: 'topK'|'cardinality', limit? }
//            { kind: 'histogram', min, max, bins }
//   collect: { kind: 'collect', fields: { name: { column?, of: <spec> } }, weight? }
//              — a field with `column` feeds its sub-accumulator r[column]; without
//                `column` it feeds the whole row (for a nested combinator).
//   groupBy: { kind: 'groupBy', column, of: <spec>, maxGroups?, weight? }
//   binned:  { kind: 'binned', column, bins: {min,max,bins}|{binWidth}, of: <spec>, weight? }






function accumulatorFromSpec(spec) {
  if (!spec || typeof spec.kind !== 'string') throw new Error('sluice: accumulator spec needs a `kind`');
  switch (spec.kind) {
    case 'count': return count();
    case 'sum': return sum();
    case 'extent': return extent();
    case 'welford': return welford();
    case 'weightedStats': return weightedStats();
    case 'tdigest': return tdigest({ compression: spec.compression });
    case 'topK': return topK({ limit: spec.limit });
    case 'cardinality': return cardinality({ limit: spec.limit });
    case 'histogram': return histogram({ min: spec.min, max: spec.max, bins: spec.bins });
    case 'collect': {
      const fields = {};
      for (const name of Object.keys(spec.fields || {})) {
        const f = spec.fields[name];
        const sub = accumulatorFromSpec(f.of || f);
        fields[name] = [sub, f.column !== undefined ? col(f.column) : identity];
      }
      return collect(fields, weightOpt(spec));
    }
    case 'groupBy':
      return groupBy(col(spec.column), () => accumulatorFromSpec(spec.of), { maxGroups: spec.maxGroups, ...weightOpt(spec) });
    case 'binned':
      return binned(col(spec.column), spec.bins, () => accumulatorFromSpec(spec.of), weightOpt(spec));
    default:
      throw new Error(`sluice: unknown accumulator spec kind "${spec.kind}"`);
  }
}

const identity = (r) => r;
function col(column) {
  if (column === undefined || column === null) throw new Error('sluice: accumulator spec needs a `column`');
  return (r) => r[column];
}
function weightOpt(spec) {
  return spec.weight ? { weight: col(spec.weight) } : {};
}

// -- runner.js --

// @gcu/sluice — the cold-recipe scan runner.
//
// A Source is a thunk returning a FRESH stream each call (cold; never shared —
// sharing across consumers is the cache's job, not a live tee). A recipe is
// { source, ops } — ops are pure transforms over the row stream. scan() opens
// the source fresh, pipes the ops, pumps an accumulator, returns its result.
// Fusion is free: recipe(src, ...a.ops, ...b.ops) — adjacent ops run in one pass.
//
// Division of labour: sluice does the *mechanical* streaming + parse-given-config
// + accumulate. *Inferring* delimiter/types/geometry is the importer's job — it
// produces the config sluice consumes.

// The mining-software null vocabulary (harvested from BMA). Numeric fields
// matching these become NaN rather than a stolen real value.
const NULL_SENTINELS = new Set([
  '', 'NA', 'NaN', 'na', 'nan', 'N/A', 'n/a', 'null', 'NULL', '*', '-',
  '-999', '-99', '#N/A', 'VOID', 'void', '-1.0e+32', '-1e+32', '1e+31', '-9999', '-99999',
]);

// ── Sources ───────────────────────────────────────────────────────────
function source(thunk) {
  if (typeof thunk !== 'function') throw new Error('sluice: source(thunk) needs a function');
  return thunk;
}
function fromText(str) {
  return () => new ReadableStream({ start(c) { c.enqueue(str); c.close(); } });
}
function fromBytes(u8) {
  return () => new ReadableStream({ start(c) { c.enqueue(u8); c.close(); } });
}
function fromBlob(blob) { return () => blob.stream(); }
function fromFile(file) { return () => file.stream(); }

// ── Lines ─────────────────────────────────────────────────────────────
// Decode bytes incrementally with TextDecoder (portable; avoids TextDecoderStream).
// Strips trailing \r, skips comment lines. Yields every other line (blanks too;
// parseCsv skips blanks after the header).
export async function* lines(src, { comment = '#' } = {}) {
  const reader = src().getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += typeof value === 'string' ? value : dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const raw of parts) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (comment && line.startsWith(comment)) continue;
        yield line;
      }
    }
    buf += dec.decode();
    if (buf.length) {
      const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
      if (!(comment && line.startsWith(comment))) yield line;
    }
  } finally {
    if (reader.releaseLock) reader.releaseLock();
  }
}

// First n non-comment lines — feeds the importer's inference.
async function sample(src, n, opts) {
  const out = [];
  for await (const line of lines(src, opts)) { out.push(line); if (out.length >= n) break; }
  return out;
}

// ── Ops (line/row transforms; each is iter -> iter) ──────────────────────
const unquote = (s) => s.replace(/^["']|["']$/g, '');

// parseCsv — text lines -> row objects, GIVEN config.
//   delimiter: field separator (default ',')
//   header: true (consume first line as names) | string[] (explicit names)
//   columns: [{ name, type }] — type 'numeric' coerces (NULL_SENTINELS -> NaN);
//            absent -> auto (number if it parses, else string), mirroring BMA.
function parseCsv({ delimiter = ',', header = true, columns = null } = {}) {
  const typeOf = columns ? Object.fromEntries(columns.map((c) => [c.name, c.type])) : null;
  return async function* (lineIter) {
    let names = Array.isArray(header) ? header : null;
    for await (const line of lineIter) {
      if (line === '') continue;
      const fields = line.split(delimiter);
      if (names === null) { names = fields.map((h) => unquote(h.trim())); continue; }
      const row = {};
      for (let i = 0; i < names.length; i++) {
        const raw = unquote((fields[i] ?? '').trim());
        const t = typeOf ? typeOf[names[i]] : null;
        if (t === 'numeric') {
          row[names[i]] = NULL_SENTINELS.has(raw) ? NaN : Number(raw);
        } else if (t && t !== 'numeric') {
          row[names[i]] = raw;
        } else {
          row[names[i]] = NULL_SENTINELS.has(raw) ? NaN : (raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw);
        }
      }
      yield row;
    }
  };
}

function filter(pred) {
  return async function* (it) { for await (const r of it) if (pred(r)) yield r; };
}
function map(fn) {
  return async function* (it) { for await (const r of it) yield fn(r); };
}
function select(cols) {
  return async function* (it) {
    for await (const r of it) { const o = {}; for (const c of cols) o[c] = r[c]; yield o; }
  };
}

// ── Recipe + scan ────────────────────────────────────────────────────
function recipe(src, ...ops) { return { source: src, ops, comment: '#' }; }

// scanState — run the recipe, return the raw accumulator STATE (mergeable,
// transferable). This is what the parallel fan-out uses:
//   const states = await Promise.all(sources.map(s => scanState(recipe(s, ...ops), acc)));
//   const merged = states.reduce(acc.merge);
//   const out = acc.result(merged);
async function scanState(rec, acc) {
  let iter = lines(rec.source, { comment: rec.comment });
  for (const op of (rec.ops || [])) iter = op(iter);
  const state = acc.create();
  for await (const item of iter) acc.push(state, item);
  return state;
}

// scan — run the recipe and finalize to the accumulator's result.
async function scan(rec, acc) {
  return acc.result(await scanState(rec, acc));
}

// ── Boundary-aware chunking (sluice owns it — it has the line logic) ────
// Splits a sliceable Blob/File into n sub-sources at line boundaries, with the
// header stripped from all of them and returned separately, so every chunk
// parses identically: parseCsv({ header: result.header }). Enables parallel
// scan-then-merge (states are mergeable; the engine fans out to workers).
async function chunks(file, n, { comment = '#' } = {}) {
  const size = file.size;
  if (!(size > 0) || !(n >= 1)) return { header: [], sources: [] };
  const dataStart = await findNewline(file, 0);          // after the header line
  const headerLine = await readLine(file, 0, dataStart);
  const header = headerLine.split(detectFieldSep(headerLine)).map((h) => unquote(h.trim()));

  const bounds = [dataStart];
  for (let k = 1; k < n; k++) {
    const nominal = dataStart + Math.floor((size - dataStart) * k / n);
    const b = await findNewline(file, nominal);
    if (b > bounds[bounds.length - 1] && b < size) bounds.push(b);
  }
  bounds.push(size);

  const sources = [];
  const blobs = [];   // the raw Blob slices — pass these by-reference to a worker
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end > start) { const slice = file.slice(start, end); blobs.push(slice); sources.push(fromBlob(slice)); }
  }
  void comment;
  return { header, sources, blobs };
}

async function findNewline(file, pos) {
  const WIN = 65536, size = file.size;
  let off = pos;
  while (off < size) {
    const buf = new Uint8Array(await file.slice(off, Math.min(off + WIN, size)).arrayBuffer());
    const i = buf.indexOf(10); // '\n'
    if (i >= 0) return off + i + 1;
    off += WIN;
  }
  return size;
}

async function readLine(file, start, end) {
  const buf = await file.slice(start, end).arrayBuffer();
  let s = new TextDecoder().decode(buf);
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s.endsWith('\r')) s = s.slice(0, -1);
  return s;
}

// Lightweight separator sniff for the header line only (delimiter inference
// proper lives in the importer; this just splits the header into names).
function detectFieldSep(line) {
  let best = ',', bestN = line.split(',').length;
  for (const d of ['\t', ';', '|']) {
    const c = line.split(d).length;
    if (c > bestN) { best = d; bestN = c; }
  }
  return best;
}

export {
  NULL_SENTINELS,
  accumulator,
  accumulatorFromSpec,
  binned,
  cardinality,
  chunks,
  collect,
  count,
  cumulativeFromTop,
  extent,
  filter,
  fromBlob,
  fromBytes,
  fromFile,
  fromText,
  groupBy,
  histogram,
  map,
  parseCsv,
  quantile,
  quantileFromCentroids,
  recipe,
  sample,
  scan,
  scanState,
  select,
  source,
  sum,
  tdigest,
  topK,
  weightedStats,
  welford,
};
