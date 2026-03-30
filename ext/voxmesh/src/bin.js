// @gcu/voxmesh — binning: discretize continuous values into bin IDs

export function binBreaks(values, opts) {
  const count = opts?.count || 10;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNaN(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) return new Float64Array(0);
  const breaks = new Float64Array(count - 1);
  for (let i = 0; i < count - 1; i++) breaks[i] = lo + (hi - lo) * (i + 1) / count;
  return breaks;
}

export function binQuantiles(values, opts) {
  const count = opts?.count || 10;
  const sorted = [];
  for (let i = 0; i < values.length; i++) if (!isNaN(values[i])) sorted.push(values[i]);
  sorted.sort((a, b) => a - b);
  if (sorted.length === 0) return new Float64Array(0);
  const breaks = new Float64Array(count - 1);
  for (let i = 0; i < count - 1; i++) {
    const p = (i + 1) / count;
    const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
    breaks[i] = sorted[idx];
  }
  return breaks;
}

export function discretize(values, breaks) {
  const n = values.length;
  const out = new Uint8Array(n);
  const nb = breaks.length;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (isNaN(v)) { out[i] = 255; continue; }
    // binary search
    let lo = 0, hi = nb;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v > breaks[mid]) lo = mid + 1;
      else hi = mid;
    }
    out[i] = lo;
  }
  return out;
}
