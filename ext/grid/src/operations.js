// @gcu/grid — variable operations: map, stats, histogram, grade-tonnage, swath plots

import { nBlocks, blockVolume, ijk } from './geometry.js';

// ── per-block operations ──

export function map(variable, fn) {
  const out = new variable.constructor(variable.length);
  for (let i = 0; i < variable.length; i++) out[i] = fn(variable[i], i);
  return out;
}

export function mapMasked(variable, mask, fn) {
  const out = new variable.constructor(variable.length);
  for (let i = 0; i < variable.length; i++) out[i] = mask[i] ? fn(variable[i], i) : variable[i];
  return out;
}

export function combine(a, b, fn) {
  const out = new a.constructor(a.length);
  for (let i = 0; i < a.length; i++) out[i] = fn(a[i], b[i], i);
  return out;
}

// ── statistics ──

export function stats(variable, opts) {
  const mask = opts?.mask;
  // collect valid values
  const vals = [];
  for (let i = 0; i < variable.length; i++) {
    if (mask && !mask[i]) continue;
    if (!isNaN(variable[i])) vals.push(variable[i]);
  }
  const n = vals.length;
  if (n === 0) return { count: 0, min: NaN, max: NaN, mean: NaN, variance: NaN, stddev: NaN, p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, sum: 0, nNaN: variable.length - n };
  vals.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += vals[i];
  const mn = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (vals[i] - mn) ** 2;
  v /= n;
  const nNaN = (mask ? _maskCount(mask) : variable.length) - n;
  return {
    count: n, min: vals[0], max: vals[n - 1], mean: mn,
    variance: v, stddev: Math.sqrt(v),
    p10: _percentile(vals, 0.10), p25: _percentile(vals, 0.25),
    p50: _percentile(vals, 0.50), p75: _percentile(vals, 0.75),
    p90: _percentile(vals, 0.90),
    sum, nNaN,
  };
}

// nearest-rank percentile
function _percentile(sorted, p) {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function _maskCount(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

export function histogram(variable, opts) {
  const mask = opts?.mask;
  const vals = [];
  for (let i = 0; i < variable.length; i++) {
    if (mask && !mask[i]) continue;
    if (!isNaN(variable[i])) vals.push(variable[i]);
  }
  const n = vals.length;
  let lo = opts?.min, hi = opts?.max;
  if (lo === undefined) { lo = Infinity; for (const v of vals) if (v < lo) lo = v; }
  if (hi === undefined) { hi = -Infinity; for (const v of vals) if (v > hi) hi = v; }
  let nBins = opts?.nBins;
  if (opts?.binWidth) nBins = Math.ceil((hi - lo) / opts.binWidth);
  if (!nBins) nBins = Math.max(1, Math.ceil(Math.sqrt(n)));
  const w = (hi - lo) / nBins;
  const edges = new Float64Array(nBins + 1);
  for (let i = 0; i <= nBins; i++) edges[i] = lo + i * w;
  const counts = new Int32Array(nBins);
  for (const v of vals) {
    let bin = Math.floor((v - lo) / w);
    if (bin >= nBins) bin = nBins - 1;
    if (bin < 0) bin = 0;
    counts[bin]++;
  }
  const frequencies = new Float64Array(nBins);
  if (n > 0) for (let i = 0; i < nBins; i++) frequencies[i] = counts[i] / n;
  return { edges, counts, frequencies };
}

export function weightedStats(variable, weights, opts) {
  const mask = opts?.mask;
  let sumW = 0, sumWV = 0, mn = 0;
  const vals = [], ws = [];
  for (let i = 0; i < variable.length; i++) {
    if (mask && !mask[i]) continue;
    if (isNaN(variable[i])) continue;
    vals.push(variable[i]);
    ws.push(weights[i]);
    sumW += weights[i];
    sumWV += weights[i] * variable[i];
  }
  const n = vals.length;
  if (n === 0 || sumW === 0) return { count: 0, min: NaN, max: NaN, mean: NaN, variance: NaN, stddev: NaN, sum: 0 };
  mn = sumWV / sumW;
  let v = 0;
  for (let i = 0; i < n; i++) v += ws[i] * (vals[i] - mn) ** 2;
  v /= sumW;
  let lo = Infinity, hi = -Infinity;
  for (const x of vals) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return { count: n, min: lo, max: hi, mean: mn, variance: v, stddev: Math.sqrt(v), sum: sumWV };
}

// ── grade-tonnage ──

export function gradeTonnage(grade, density, opts) {
  const mask = opts?.mask;
  const g = opts?.gridDef;
  const vol = g ? blockVolume(g) : 1;

  // determine cutoffs
  let cutoffs = opts?.cutoffs;
  if (!cutoffs) {
    const nc = opts?.nCutoffs || 50;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < grade.length; i++) {
      if (mask && !mask[i]) continue;
      const v = grade[i];
      if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    cutoffs = new Float64Array(nc);
    for (let i = 0; i < nc; i++) cutoffs[i] = lo + (hi - lo) * i / (nc - 1);
  }
  const nc = cutoffs.length;

  // collect valid blocks
  const grades = [], tons = [];
  const isUniform = typeof density === 'number';
  for (let i = 0; i < grade.length; i++) {
    if (mask && !mask[i]) continue;
    if (isNaN(grade[i])) continue;
    grades.push(grade[i]);
    tons.push((isUniform ? density : density[i]) * vol);
  }

  // sort by grade descending for cumulative-from-top
  const idx = Array.from({ length: grades.length }, (_, i) => i);
  idx.sort((a, b) => grades[b] - grades[a]);

  const tonnes = new Float64Array(nc);
  const avgGrade = new Float64Array(nc);
  const metal = new Float64Array(nc);
  const volume = new Float64Array(nc);
  const nBlocksArr = new Int32Array(nc);

  for (let c = 0; c < nc; c++) {
    const co = cutoffs[c];
    let tSum = 0, mSum = 0, count = 0;
    for (let p = 0; p < idx.length; p++) {
      const j = idx[p];
      if (grades[j] < co) break; // sorted descending, done once below cutoff
      tSum += tons[j];
      mSum += tons[j] * grades[j];
      count++;
    }
    tonnes[c] = tSum;
    avgGrade[c] = tSum > 0 ? mSum / tSum : 0;
    metal[c] = mSum;
    volume[c] = count * vol;
    nBlocksArr[c] = count;
  }

  return { cutoffs, tonnes, grade: avgGrade, metal, volume, nBlocks: nBlocksArr };
}

// ── swath plots ──

export function swathPlot(variable, gridDef, opts) {
  const axis = opts?.axis || 'z';
  const mask = opts?.mask;
  const statFn = opts?.stat || 'mean';
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const nSlices = gridDef.count[ai];
  const nx = gridDef.count[0], ny = gridDef.count[1], nz = gridDef.count[2];
  const nxy = nx * ny;

  const positions = new Float64Array(nSlices);
  for (let s = 0; s < nSlices; s++) positions[s] = gridDef.origin[ai] + s * gridDef.size[ai];

  const sums = new Float64Array(nSlices);
  const counts = new Int32Array(nSlices);
  const sliceVals = Array.from({ length: nSlices }, () => []);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + k * nxy;
        if (mask && !mask[idx]) continue;
        if (isNaN(variable[idx])) continue;
        const s = ai === 0 ? i : ai === 1 ? j : k;
        sums[s] += variable[idx];
        counts[s]++;
        if (typeof statFn === 'function' || statFn === 'p50' || statFn === 'variance') {
          sliceVals[s].push(variable[idx]);
        }
      }
    }
  }

  const values = new Float64Array(nSlices);
  for (let s = 0; s < nSlices; s++) {
    if (counts[s] === 0) { values[s] = NaN; continue; }
    if (statFn === 'mean') { values[s] = sums[s] / counts[s]; }
    else if (statFn === 'count') { values[s] = counts[s]; }
    else if (statFn === 'p50') {
      sliceVals[s].sort((a, b) => a - b);
      values[s] = _percentile(sliceVals[s], 0.5);
    } else if (statFn === 'variance') {
      const mn = sums[s] / counts[s];
      let v = 0;
      for (const x of sliceVals[s]) v += (x - mn) ** 2;
      values[s] = v / counts[s];
    } else if (typeof statFn === 'function') {
      values[s] = statFn(sliceVals[s]);
    }
  }

  return { positions, values, counts };
}
