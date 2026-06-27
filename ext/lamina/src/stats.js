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
export async function scanColumnStats(source, { col, dataStart = 0, numeric = true, decimal = '.', rows = null, max = 5 * 1024 * 1024, topN = 12, maxDistinct = 100000, onProgress } = {}) {
  let count = 0, nulls = 0, bad = 0;   // nulls = empty/missing; bad = present but not a number
  const badSamples = numeric ? new Set() : null;   // first few DISTINCT non-numeric raw values (diagnostic: "what's not a number?")
  // numeric (Welford) + a capped value buffer for quantiles
  let min = Infinity, max_ = -Infinity, sum = 0, mean = 0, m2 = 0, nNum = 0;
  let vals = numeric ? new Float64Array(1024) : null, nv = 0, collecting = numeric;
  // categorical
  const freq = numeric ? null : new Map();
  let cappedDistinct = false;

  await source.eachRecord({ dataStart, rows, onProgress }, (disp, fields) => {
    const raw = fields[col];
    count++;
    if (numeric) {
      if (raw == null || raw === '') { nulls++; return; }
      const x = parseNum(raw, decimal);
      if (Number.isNaN(x)) { bad++; if (badSamples.size < 12) badSamples.add(raw); return; }   // present but not a number → "non-numeric" (keep a few examples)
      nNum++;
      if (x < min) min = x;
      if (x > max_) max_ = x;
      sum += x;
      const d = x - mean; mean += d / nNum; m2 += d * (x - mean);   // Welford
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
    return { kind: 'number', count, nulls, bad, badSamples: [...badSamples], n: nNum, min: nNum ? min : null, max: nNum ? max_ : null, mean: nNum ? mean : null, std, sum, quantiles, histogram, logHistogram, quantilesCapped: !collecting };
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([value, n]) => ({ value, n }));
  return { kind: 'string', count, nulls, distinct: freq.size, cappedDistinct, top };
}
