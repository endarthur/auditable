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

/**
 * Group-by: ONE windowed pass → per-group aggregates over one or more value columns
 * (optionally weighted by a weight column → wmean). Bounded memory (distinct groups
 * capped at maxGroups; sets truncated). Group key = the group column's value as a
 * string ('' → '(blank)'). Each value column gets count/sum/min/max/mean/std + wmean.
 * @returns {Promise<{groups:Array<{key,count,vars:Array}>, total:{count,vars:Array}, truncated:boolean, weighted:boolean}>}
 */
export async function scanGroupBy(source, { groupCol, valueCols, weightCol = null, dataStart = 0, decimal = '.', rows = null, maxGroups = 1000, onProgress, signal } = {}) {
  const nv = valueCols.length;
  const mkVar = () => ({ n: 0, sum: 0, min: Infinity, max: -Infinity, mean: 0, m2: 0, wsum: 0, wtot: 0 });
  const mkAcc = () => ({ count: 0, vars: Array.from({ length: nv }, mkVar) });
  const upd = (v, x, w) => {
    v.n++; v.sum += x; if (x < v.min) v.min = x; if (x > v.max) v.max = x;
    const d = x - v.mean; v.mean += d / v.n; v.m2 += d * (x - v.mean);   // Welford
    if (w != null && Number.isFinite(w)) { v.wsum += w * x; v.wtot += w; }
  };
  const groups = new Map(), total = mkAcc();
  let truncated = false;
  await source.eachRecord({ dataStart, rows, signal, onProgress }, (disp, fields) => {
    const graw = fields[groupCol];
    const key = (graw == null || graw === '') ? '(blank)' : String(graw);
    let acc = groups.get(key);
    if (!acc) { if (groups.size >= maxGroups) truncated = true; else { acc = mkAcc(); groups.set(key, acc); } }
    const wv = weightCol != null ? (() => { const w = parseNum(fields[weightCol], decimal); return Number.isNaN(w) ? null : w; })() : 1;
    total.count++; if (acc) acc.count++;
    for (let i = 0; i < nv; i++) {
      const raw = fields[valueCols[i]]; if (raw == null || raw === '') continue;
      const x = parseNum(raw, decimal); if (Number.isNaN(x)) continue;
      upd(total.vars[i], x, wv); if (acc) upd(acc.vars[i], x, wv);
    }
  });
  const finVar = (v) => ({ n: v.n, sum: v.sum, mean: v.n ? v.mean : null, std: v.n > 1 ? Math.sqrt(v.m2 / (v.n - 1)) : 0, wmean: v.wtot ? v.wsum / v.wtot : null, min: v.n ? v.min : null, max: v.n ? v.max : null });
  const fin = (acc) => ({ count: acc.count, vars: acc.vars.map(finVar) });
  return { groups: [...groups.entries()].map(([key, acc]) => ({ key, ...fin(acc) })), total: fin(total), truncated, weighted: weightCol != null };
}

/**
 * Grade-tonnage: ONE windowed pass → per-group tonnes + tonnage-weighted grades.
 * The weight (tonnes) of each block = volume × density × proportion, where each factor
 * is a column ({col:idx}) or a constant ({const:number}). Per group:
 *   tonnes = Σ(w);  grade_i = Σ(w·g_i)/Σ(w over blocks with a valid g_i);  metal_i = Σ(w·g_i).
 * groupCol = null → a single whole-deposit total (no per-group rows). Blocks with a
 * non-finite/≤0 weight are skipped (no mass). Bounded memory (maxGroups → truncated).
 * Each grade also carries its observed gmin/gmax (over blocks with mass) — the
 * extents that seed a cutoff-curve second pass without an extra extent scan.
 * @returns {Promise<{groups:Array<{key,count,tonnes,grades:Array<{grade,metal,gmin,gmax}>}>, total, truncated:boolean, grouped:boolean}>}
 */
export async function scanGradeTonnage(source, { groupCol = null, gradeCols = [], volume = { const: 1 }, density = { const: 1 }, proportion = { const: 1 }, dataStart = 0, decimal = '.', rows = null, maxGroups = 1000, onProgress, signal } = {}) {
  const ng = gradeCols.length;
  // each factor: {fn:(fields)=>num} (a compiled expr) | {col:idx} | {const:num}
  const factor = (spec, fields) => (spec && spec.fn ? spec.fn(fields) : (spec && spec.col != null ? parseNum(fields[spec.col], decimal) : (spec ? spec.const : 1)));
  const mkAcc = () => ({ count: 0, tonnes: 0, grades: Array.from({ length: ng }, () => ({ msum: 0, wt: 0, gmin: Infinity, gmax: -Infinity })) });
  const groups = new Map(), total = mkAcc();
  let truncated = false;
  await source.eachRecord({ dataStart, rows, signal, onProgress }, (disp, fields) => {
    const w = factor(volume, fields) * factor(density, fields) * factor(proportion, fields);
    if (!Number.isFinite(w) || w <= 0) return;                       // no mass → skip
    let acc = null;
    if (groupCol != null) {
      const graw = fields[groupCol];
      const key = (graw == null || graw === '') ? '(blank)' : String(graw);
      acc = groups.get(key);
      if (!acc) { if (groups.size >= maxGroups) truncated = true; else { acc = mkAcc(); groups.set(key, acc); } }
    }
    const bump = (a) => {
      a.count++; a.tonnes += w;
      for (let i = 0; i < ng; i++) {
        const g = parseNum(fields[gradeCols[i]], decimal);
        if (Number.isNaN(g)) continue;
        const gr = a.grades[i];
        gr.msum += w * g; gr.wt += w;
        if (g < gr.gmin) gr.gmin = g; if (g > gr.gmax) gr.gmax = g;   // extents (seed a cutoff-curve pass)
      }
    };
    if (acc) bump(acc);
    bump(total);
  });
  const fin = (a) => ({ count: a.count, tonnes: a.tonnes, grades: a.grades.map((g) => ({ grade: g.wt ? g.msum / g.wt : null, metal: g.msum, gmin: g.wt ? g.gmin : null, gmax: g.wt ? g.gmax : null })) });
  const groupList = groupCol == null ? [] : [...groups.entries()].map(([key, a]) => ({ key, ...fin(a) }));
  return { groups: groupList, total: fin(total), truncated, grouped: groupCol != null };
}

// Data-quality scan: one pass (sampled or filtered subset) inspecting RAW field
// strings per column for quiet bugs — leading-zeros-lost, non-numeric in a numeric
// column, missing-value sentinels (-9/-99/-999/-9999), thousands separators,
// whitespace padding, all-blank, constant, high-blank, dates-as-text. Returns a flat,
// severity-sorted findings list. Needs raw strings (numeric parsing discards them),
// so it can't piggyback the moment scans.
const DQ_SENTINELS = new Set([-9, -99, -999, -9999, -99999]);
const DQ_DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
export async function scanDataQuality(source, { schema, dataStart = 0, decimal = '.', rows = null, limit = Infinity, onProgress, signal } = {}) {
  const cols = schema.length;
  const acc = schema.map((s) => ({ num: s.type === 'number', n: 0, nulls: 0, nonNum: 0, ex: new Set(), distinct: new Set(), lead: 0, pad: 0, thou: 0, dateLike: 0, min: Infinity, minCount: 0 }));
  await source.eachRecord({ dataStart, rows, limit, signal, onProgress }, (disp, fields) => {
    for (let i = 0; i < cols; i++) {
      const a = acc[i]; a.n++;
      const raw = fields[i];
      if (raw == null || raw === '') { a.nulls++; continue; }
      const s = String(raw), t = s.trim();
      if (s !== t) a.pad++;
      if (a.distinct.size < 50) a.distinct.add(t);
      const x = parseNum(t, decimal);
      if (Number.isNaN(x)) { a.nonNum++; if (a.ex.size < 6) a.ex.add(t); if (DQ_DATE_RE.test(t)) a.dateLike++; }
      else {
        if (x < a.min) { a.min = x; a.minCount = 1; } else if (x === a.min) a.minCount++;
        if (a.num) { if (/^0[0-9]/.test(t)) a.lead++; if (decimal === '.' && /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) a.thou++; }
      }
    }
  });
  const out = [];
  for (let i = 0; i < cols; i++) {
    const a = acc[i], name = schema[i].name, present = a.n - a.nulls;
    const add = (severity, issue, detail) => out.push({ col: i, name, severity, issue, detail });
    if (a.n === 0) continue;
    if (a.nulls === a.n) { add('high', 'all blank', 'no values in the sample'); continue; }
    if (a.distinct.size === 1) add('info', 'constant', `every value is "${[...a.distinct][0]}"`);
    if (a.num && a.lead > 0) add('high', 'leading zeros lost', `${a.lead} value(s) like "007" read as numbers — leading zeros dropped (looks like a code, not a number)`);
    if (a.num && a.nonNum > 0) add('warn', 'non-numeric values', `${a.nonNum} present-but-not-a-number${a.ex.size ? ` (e.g. ${[...a.ex].slice(0, 4).join(', ')})` : ''}`);
    if (a.thou > 0) add('warn', 'thousands separators', `${a.thou} value(s) like "1,234" — check the decimal setting`);
    if (a.pad > 0) add('warn', 'whitespace padding', `${a.pad} value(s) have leading/trailing spaces (can break filters/joins)`);
    if (a.num && DQ_SENTINELS.has(a.min) && a.minCount >= 2) add('warn', 'possible sentinel', `min ${a.min} appears ${a.minCount}× — likely a missing-value code, not a real number`);
    if (!a.num && present && a.dateLike / present >= 0.8) add('info', 'dates stored as text', 'values look like dates (lamina has no date type yet — sorts/filters as text)');
    if (a.nulls > 0 && a.nulls / a.n >= 0.5) add('info', 'high blank rate', `${Math.round(100 * a.nulls / a.n)}% blank`);
  }
  const rank = { high: 0, warn: 1, info: 2 };
  out.sort((x, y) => rank[x.severity] - rank[y.severity] || x.col - y.col);
  return out;
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
