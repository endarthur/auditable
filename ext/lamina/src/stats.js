// @gcu/lamina — column statistics: one forward scan over a column (optionally
// restricted to the current filter's `rows`), accumulating a summary. Numeric →
// count / nulls / min / max / mean / std (Welford, streaming) / sum + quantiles
// (collected + sorted, capped); categorical → count / nulls / distinct + top-N.
// Same scan shape as filter/sort — no new dependency.

import { splitRecordsPos, parseFields } from './scan.js';

const DEC = new TextDecoder();

/**
 * @param {object} source  block index + readRange (source.js)
 * @param {object} opts  { col, dataStart?, numeric?, rows?, max?, topN?, maxDistinct?, onProgress? }
 *   rows = ascending DISPLAY rows to restrict to (a filter's matches), or null = all
 * @returns {Promise<object>}  numeric or categorical summary (see fields below)
 */
export async function scanColumnStats(source, { col, dataStart = 0, numeric = true, rows = null, max = 5 * 1024 * 1024, topN = 12, maxDistinct = 100000, onProgress } = {}) {
  const K = source.blockSize;
  const nBlocks = source.blockOffsets.length;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  const subset = rows;
  let sp = 0;

  let count = 0, nulls = 0, bad = 0;   // nulls = empty/missing; bad = present but not a number
  // numeric (Welford) + a capped value buffer for quantiles
  let min = Infinity, max_ = -Infinity, sum = 0, mean = 0, m2 = 0, nNum = 0;
  let vals = numeric ? new Float64Array(1024) : null, nv = 0, collecting = numeric;
  // categorical
  const freq = numeric ? null : new Map();
  let cappedDistinct = false;

  for (let b = 0; b < nBlocks; b++) {
    const s = source.blockOffsets[b];
    const e = b + 1 < nBlocks ? source.blockOffsets[b + 1] : source.totalBytes;
    const bytes = await source.readRange(s, e - s);
    const pos = splitRecordsPos(bytes, { kind: source.kind, quote: qByte });
    for (let i = 0; i < pos.length; i++) {
      const srcRow = b * K + i;
      if (srcRow >= source.rowCount) break;
      const disp = srcRow - dataStart;
      if (disp < 0) continue;
      if (subset) {
        while (sp < subset.length && subset[sp] < disp) sp++;
        if (sp >= subset.length || subset[sp] !== disp) continue;
        sp++;
      }
      const rec = bytes.subarray(pos[i].start, pos[i].end);
      const fields = delimited ? parseFields(rec, { delimiter: source.delimiter, quote: source.quote }) : [DEC.decode(rec)];
      const raw = fields[col];
      count++;
      if (numeric) {
        if (raw == null || raw === '') { nulls++; continue; }
        const x = Number(raw);
        if (Number.isNaN(x)) { bad++; continue; }       // present but not a number → "non-numeric"
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
        if (raw == null || raw === '') { nulls++; continue; }
        const cur = freq.get(raw);
        if (cur !== undefined) freq.set(raw, cur + 1);
        else if (freq.size < maxDistinct) freq.set(raw, 1);
        else cappedDistinct = true;
      }
    }
    if (onProgress) onProgress(b + 1, nBlocks);
    if (subset && sp >= subset.length) break;
  }

  if (numeric) {
    const std = nNum > 1 ? Math.sqrt(m2 / (nNum - 1)) : 0;
    let quantiles = null;
    if (collecting && nv > 0) {
      const sl = vals.slice(0, nv).sort((a, b) => a - b);
      const q = (p) => sl[Math.min(nv - 1, Math.round(p * (nv - 1)))];
      quantiles = { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
    }
    return { kind: 'number', count, nulls, bad, n: nNum, min: nNum ? min : null, max: nNum ? max_ : null, mean: nNum ? mean : null, std, sum, quantiles, quantilesCapped: !collecting };
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([value, n]) => ({ value, n }));
  return { kind: 'string', count, nulls, distinct: freq.size, cappedDistinct, top };
}
