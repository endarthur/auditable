// @gcu/lamina — column statistics: one forward scan over a column (optionally
// restricted to the current filter's `rows`), accumulating a summary. Numeric →
// count / nulls / min / max / mean / std (Welford, streaming) / sum + quantiles
// (collected + sorted, capped); categorical → count / nulls / distinct + top-N.
// Same scan shape as filter/sort — no new dependency.

import { parseNum } from './scan.js';

const HIST_BINS = 40;
// Bin nv values from `vals` into a {bins, min, max, log} histogram (linear, or log
// over [min,max] with min>0). Counts only; the renderer scales them.
function histify(vals, nv, lo, hi, nbins, log) {
  const bins = new Array(nbins).fill(0);
  const l0 = log ? Math.log(lo) : lo, span = (log ? Math.log(hi) : hi) - l0 || 1;
  for (let i = 0; i < nv; i++) {
    const v = vals[i];
    if (log && v <= 0) continue;
    let k = Math.floor(((log ? Math.log(v) : v) - l0) / span * nbins);
    if (k >= nbins) k = nbins - 1; if (k < 0) k = 0;
    bins[k]++;
  }
  return { bins, min: lo, max: hi, log: !!log };
}

/**
 * One forward scan over a column (optionally restricted to a filter's `rows`),
 * accumulating a summary. Iteration is delegated to source.eachRecord, so it works
 * on any backing. Numeric → count / nulls / min / max / mean / std (Welford) / sum
 * + quantiles (capped); categorical → count / nulls / distinct + top-N.
 * @param {object} source  a record cursor (cursor.js / a backing adapter)
 * @param {object} opts  { col, dataStart?, numeric?, rows?, max?, topN?, maxDistinct?, onProgress? }
 *   rows = ascending DISPLAY rows to restrict to (a filter's matches), or null = all
 * @returns {Promise<object>}  numeric or categorical summary (see fields below)
 */
export async function scanColumnStats(source, { col, dataStart = 0, numeric = true, decimal = '.', rows = null, max = 5 * 1024 * 1024, topN = 12, maxDistinct = 100000, excludeZero = false, excludeNeg = false, onProgress, signal } = {}) {
  let count = 0, nulls = 0, bad = 0, excluded = 0;   // nulls = empty/missing; bad = present but not a number; excluded = a valid number dropped by excludeZero/excludeNeg
  const badSamples = numeric ? new Set() : null;   // first few DISTINCT non-numeric raw values (diagnostic: "what's not a number?")
  // numeric (online mean + M2 + M3 → std/CV/skew) + a capped value buffer for quantiles
  let min = Infinity, max_ = -Infinity, sum = 0, mean = 0, m2 = 0, m3 = 0, nNum = 0, zeros = 0;
  let vals = numeric ? new Float64Array(1024) : null, nv = 0, collecting = numeric;
  // categorical
  const freq = numeric ? null : new Map();
  let cappedDistinct = false;

  await source.eachRecord({ dataStart, rows, onProgress, signal }, (disp, fields) => {
    const raw = fields[col];
    count++;
    if (numeric) {
      if (raw == null || raw === '') { nulls++; return; }
      const x = parseNum(raw, decimal);
      if (Number.isNaN(x)) { bad++; if (badSamples.size < 12) badSamples.add(raw); return; }   // present but not a number → "non-numeric" (keep a few examples)
      if ((excludeZero && x === 0) || (excludeNeg && x < 0)) { excluded++; return; }   // a valid number, deliberately dropped (waste/sentinel) — counted, not silent
      nNum++;
      if (x === 0) zeros++;
      if (x < min) min = x;
      if (x > max_) max_ = x;
      sum += x;
      const n1 = nNum, delta = x - mean, dn = delta / n1, t1 = delta * dn * (n1 - 1);   // online M2 + M3 (Welford)
      mean += dn; m3 += t1 * dn * (n1 - 2) - 3 * dn * m2; m2 += t1;
      if (collecting) {
        if (nv === vals.length) {
          if (nv >= max) collecting = false;
          else { const a = new Float64Array(vals.length * 2); a.set(vals); vals = a; }
        }
        if (collecting) vals[nv++] = x;
      }
    } else {
      if (raw == null || raw === '') { nulls++; return; }
      const cur = freq.get(raw);
      if (cur !== undefined) freq.set(raw, cur + 1);
      else if (freq.size < maxDistinct) freq.set(raw, 1);
      else cappedDistinct = true;
    }
  });

  if (numeric) {
    const std = nNum > 1 ? Math.sqrt(m2 / (nNum - 1)) : 0;
    const cv = (nNum > 1 && mean !== 0) ? std / Math.abs(mean) : null;          // coefficient of variation
    const skew = (nNum > 2 && m2 > 0) ? (Math.sqrt(nNum) * m3) / Math.pow(m2, 1.5) : null;   // population skewness
    let quantiles = null, histogram = null, logHistogram = null;
    if (collecting && nv > 0) {
      const sl = vals.slice(0, nv).sort((a, b) => a - b);
      const q = (p) => sl[Math.min(nv - 1, Math.round(p * (nv - 1)))];
      quantiles = { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
      // full-resolution histograms for the column-profile popup (from the collected
      // value buffer, same basis as the quantiles → consistent; capped flag carries).
      histogram = histify(vals, nv, min, max_, HIST_BINS, false);
      const posMin = sl.find((v) => v > 0);
      if (posMin != null && max_ > posMin) logHistogram = histify(vals, nv, posMin, max_, HIST_BINS, true);
    }
    return { kind: 'number', count, nulls, bad, badSamples: [...badSamples], excluded, excludeZero, excludeNeg, zeros, cv, skew, n: nNum, min: nNum ? min : null, max: nNum ? max_ : null, mean: nNum ? mean : null, std, sum, quantiles, histogram, logHistogram, quantilesCapped: !collecting };
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([value, n]) => ({ value, n }));
  return { kind: 'string', count, nulls, distinct: freq.size, cappedDistinct, top };
}

// Quantiles interpolated from a histogram's bin counts over [min,max] — used by the
// bulk precompute (exact percentiles would need a per-column value buffer). Approximate.
function quantilesFromHist(bins, min, max) {
  const n = bins.length, total = bins.reduce((s, v) => s + v, 0); if (!total) return null;
  const w = (max - min) / n;
  const q = (p) => { const target = p * total; let cum = 0; for (let k = 0; k < n; k++) { if (cum + bins[k] >= target) return min + (k + (bins[k] ? (target - cum) / bins[k] : 0)) * w; cum += bins[k]; } return max; };
  return { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
}

/**
 * BMA-style bulk stats: TWO passes over the file (not 2×columns) computing exact
 * moments + an exact histogram for EVERY column at once, plus histogram-interpolated
 * (≈) quantiles. No per-column value buffers → bounded memory. Pass 1 = moments +
 * categorical freqs + bounds; pass 2 = histogram bins using pass-1 bounds. Each
 * returned st is "lite" (precomputed:true, quantilesApprox:true) and shape-compatible
 * with scanColumnStats so renderStats / the cache treat them the same.
 * @returns {Promise<Array<object|null>>}  per-column st (null for an all-empty column)
 */
export async function scanAllColumnStats(source, { schema, dataStart = 0, decimal = '.', rows = null, onProgress, signal } = {}) {
  const cols = schema.length;
  const acc = schema.map((s) => s.type === 'number'
    ? { num: true, count: 0, nulls: 0, bad: 0, zeros: 0, nNum: 0, min: Infinity, max: -Infinity, posMin: Infinity, sum: 0, mean: 0, m2: 0, m3: 0, badSamples: new Set(), lin: null, log: null }
    : { num: false, count: 0, nulls: 0, freq: new Map(), capped: false });
  // pass 1 — moments + bounds (+ categorical freqs)
  await source.eachRecord({ dataStart, rows, signal, onProgress: (b, n) => onProgress && onProgress(b, n * 2) }, (disp, fields) => {
    for (let i = 0; i < cols; i++) {
      const a = acc[i]; a.count++;
      const raw = fields[i];
      if (a.num) {
        if (raw == null || raw === '') { a.nulls++; continue; }
        const x = parseNum(raw, decimal);
        if (Number.isNaN(x)) { a.bad++; if (a.badSamples.size < 12) a.badSamples.add(raw); continue; }
        a.nNum++; if (x === 0) a.zeros++;
        if (x < a.min) a.min = x; if (x > a.max) a.max = x; if (x > 0 && x < a.posMin) a.posMin = x;
        a.sum += x;
        const n1 = a.nNum, delta = x - a.mean, dn = delta / n1, t1 = delta * dn * (n1 - 1);
        a.mean += dn; a.m3 += t1 * dn * (n1 - 2) - 3 * dn * a.m2; a.m2 += t1;
      } else {
        if (raw == null || raw === '') { a.nulls++; continue; }
        const cur = a.freq.get(raw);
        if (cur !== undefined) a.freq.set(raw, cur + 1);
        else if (a.freq.size < 200) a.freq.set(raw, 1);
        else a.capped = true;
      }
    }
  });
  // pass 2 — histogram bins for numeric columns that have a range
  const hcols = [];
  for (let i = 0; i < cols; i++) { const a = acc[i]; if (a.num && a.nNum && a.max > a.min) { a.lin = new Float64Array(HIST_BINS); a.log = (a.posMin > 0 && a.posMin < a.max) ? new Float64Array(HIST_BINS) : null; hcols.push(i); } }
  if (hcols.length) {
    await source.eachRecord({ dataStart, rows, signal, onProgress: (b, n) => onProgress && onProgress(n + b, n * 2) }, (disp, fields) => {
      for (let h = 0; h < hcols.length; h++) {
        const i = hcols[h], a = acc[i], raw = fields[i];
        if (raw == null || raw === '') continue;
        const x = parseNum(raw, decimal); if (Number.isNaN(x)) continue;
        const sp = (a.max - a.min) || 1; let k = Math.floor((x - a.min) / sp * HIST_BINS); if (k >= HIST_BINS) k = HIST_BINS - 1; if (k < 0) k = 0; a.lin[k]++;
        if (a.log && x > 0) { const l0 = Math.log(a.posMin), ls = (Math.log(a.max) - l0) || 1; let kk = Math.floor((Math.log(x) - l0) / ls * HIST_BINS); if (kk >= HIST_BINS) kk = HIST_BINS - 1; if (kk < 0) kk = 0; a.log[kk]++; }
      }
    });
  }
  return acc.map((a) => {
    if (!a.count) return null;
    if (a.num) {
      const std = a.nNum > 1 ? Math.sqrt(a.m2 / (a.nNum - 1)) : 0;
      const cv = (a.nNum > 1 && a.mean !== 0) ? std / Math.abs(a.mean) : null;
      const skew = (a.nNum > 2 && a.m2 > 0) ? (Math.sqrt(a.nNum) * a.m3) / Math.pow(a.m2, 1.5) : null;
      const histogram = a.lin ? { bins: Array.from(a.lin), min: a.min, max: a.max, log: false } : null;
      const logHistogram = a.log ? { bins: Array.from(a.log), min: a.posMin, max: a.max, log: true } : null;
      const quantiles = a.lin ? quantilesFromHist(a.lin, a.min, a.max) : null;
      return { kind: 'number', count: a.count, nulls: a.nulls, bad: a.bad, badSamples: [...a.badSamples], excluded: 0, excludeZero: false, excludeNeg: false, zeros: a.zeros, cv, skew, n: a.nNum, min: a.nNum ? a.min : null, max: a.nNum ? a.max : null, mean: a.nNum ? a.mean : null, std, sum: a.sum, quantiles, histogram, logHistogram, quantilesApprox: true, precomputed: true };
    }
    const tot = [...a.freq.values()].reduce((s, v) => s + v, 0) || 1;
    const top = [...a.freq.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([value, n]) => ({ value, n }));
    return { kind: 'string', count: a.count, nulls: a.nulls, distinct: a.freq.size, cappedDistinct: a.capped, top, precomputed: true };
  });
}
