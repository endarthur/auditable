// @gcu/recon — grid geometry inference (the scan-phase). A sluice-protocol
// accumulator collects per-axis coord material; inferGeometry interprets it into
// a spatial facet. computeGeometry logic harvested from BMA's worker.

const DEFAULT_CAP = 200000;
const round10 = (v) => Number(v.toPrecision(10));   // collapse float noise for spacing equality

// geometryAccumulator(coordCols) — a sluice-protocol accumulator over ROWS.
// coordCols: { x?, y?, z?, dx?, dy?, dz? } (column names). Collects, per axis:
// capped distinct coords, extent, ordering transitions, sample count; plus
// distinct dim values for dX/dY/dZ. State is structuredClone-transferable.
export function geometryAccumulator(coordCols, { cap = DEFAULT_CAP } = {}) {
  const axes = ['x', 'y', 'z'].filter((a) => coordCols[a]);
  const dims = ['dx', 'dy', 'dz'].filter((a) => coordCols[a]);
  const newAxis = () => ({ distinct: {}, dn: 0, overflow: false, min: Infinity, max: -Infinity, prev: null, transitions: 0, count: 0 });
  return {
    create: () => ({
      coordCols, cap,
      axes: Object.fromEntries(axes.map((a) => [a, newAxis()])),
      dims: Object.fromEntries(dims.map((a) => [a, { distinct: {}, overflow: false }])),
    }),
    push: (s, row) => {
      for (const a of axes) {
        const v = row[coordCols[a]];
        if (!Number.isFinite(v)) continue;
        const ax = s.axes[a];
        ax.count++;
        if (v < ax.min) ax.min = v;
        if (v > ax.max) ax.max = v;
        if (ax.prev !== null && v !== ax.prev) ax.transitions++;
        ax.prev = v;
        if (!ax.overflow) {
          const k = String(round10(v));
          if (!(k in ax.distinct)) { if (ax.dn >= s.cap) ax.overflow = true; else { ax.distinct[k] = 1; ax.dn++; } }
        }
      }
      for (const a of dims) {
        const v = row[coordCols[a]];
        if (!Number.isFinite(v) || v <= 0) continue;
        const dm = s.dims[a];
        if (!dm.overflow) { const k = String(round10(v)); if (!(k in dm.distinct)) { if (Object.keys(dm.distinct).length >= s.cap) dm.overflow = true; else dm.distinct[k] = 1; } }
      }
    },
    merge: (a, b) => {
      const out = { coordCols: a.coordCols, cap: a.cap, axes: {}, dims: {} };
      for (const ax in a.axes) {
        const x = a.axes[ax], y = b.axes[ax] || newAxis();
        const distinct = { ...x.distinct };
        let dn = x.dn, overflow = x.overflow || y.overflow;
        for (const k in y.distinct) { if (!(k in distinct)) { if (dn >= a.cap) overflow = true; else { distinct[k] = 1; dn++; } } }
        out.axes[ax] = { distinct, dn, overflow, min: Math.min(x.min, y.min), max: Math.max(x.max, y.max), prev: null, transitions: x.transitions + y.transitions, count: x.count + y.count };
      }
      for (const d in a.dims) {
        const distinct = { ...a.dims[d].distinct };
        for (const k in (b.dims[d] || { distinct: {} }).distinct) distinct[k] = 1;
        out.dims[d] = { distinct, overflow: a.dims[d].overflow || (b.dims[d] && b.dims[d].overflow) };
      }
      return out;
    },
    result: (s) => {
      const axes = {};
      for (const a in s.axes) {
        const ax = s.axes[a];
        axes[a] = { values: Object.keys(ax.distinct).map(Number).sort((p, q) => p - q), min: ax.min, max: ax.max, transitions: ax.transitions, count: ax.count, overflow: ax.overflow };
      }
      const dims = {};
      for (const d in s.dims) dims[d] = Object.keys(s.dims[d].distinct).map(Number).sort((p, q) => p - q);
      return { axes, dims };
    },
  };
}

// inferGeometry(accResult) → spatial facet (gridded | scattered).
export function inferGeometry(accResult, { rotation } = {}) {
  const { axes, dims } = accResult;
  const present = ['x', 'y', 'z'].filter((a) => axes[a] && axes[a].count > 0);
  if (present.length < 3) {
    return { kind: 'scattered', coordCols: present };
  }
  const per = {};
  let anySub = false;
  for (const a of present) {
    const dimKey = a === 'x' ? 'dx' : a === 'y' ? 'dy' : 'dz';
    per[a] = computeAxis(axes[a], dims[dimKey]);
    if (per[a].isSubBlocked) anySub = true;
    if (per[a].size == null) return { kind: 'scattered', coordCols: present };
  }
  // ordering: most transitions = fastest-varying = innermost
  const order = present.slice().sort((p, q) => axes[q].transitions - axes[p].transitions).map((a) => a.toUpperCase());
  return {
    kind: 'gridded',
    origin: [per.x.origin, per.y.origin, per.z.origin],
    size: [per.x.size, per.y.size, per.z.size],
    count: [per.x.count, per.y.count, per.z.count],
    rotation: rotation || [1, 0, 0, 0, 1, 0, 0, 0, 1],
    order: { fastest: order[0], middle: order[1], slowest: order[2] },
    subBlocked: anySub,
    subBlocks: anySub ? Object.fromEntries(present.map((a) => [a, per[a].subBlockSizes])) : null,
  };
}

// Per-axis grid inference from collected distinct coords (+ optional dim values).
function computeAxis(axisData, dimValues) {
  const sorted = axisData.values;
  const min = axisData.min, max = axisData.max;
  if (sorted.length <= 1) return { origin: min, max, size: null, count: 1, isSubBlocked: false, subBlockSizes: [] };

  // spacing-frequency histogram
  const spacingCounts = {};
  for (let i = 1; i < sorted.length; i++) {
    const d = round10(sorted[i] - sorted[i - 1]);
    if (d > 0) spacingCounts[d] = (spacingCounts[d] || 0) + 1;
  }
  const spacings = Object.entries(spacingCounts).map(([s, c]) => ({ size: Number(s), count: c })).sort((a, b) => b.count - a.count);

  let parentSize = null, subBlockSizes = [], isSubBlocked = false;
  if (spacings.length === 1) {
    parentSize = spacings[0].size;
  } else if (spacings.length > 1) {
    const total = spacings.reduce((s, x) => s + x.count, 0);
    const significant = spacings.filter((s) => s.count / total > 0.02);
    if (significant.length === 1) {
      parentSize = significant[0].size;
    } else {
      const bySize = significant.slice().sort((a, b) => b.size - a.size);
      const candidate = bySize[0].size;
      const subs = [];
      for (const s of bySize.slice(1)) {
        const ratio = candidate / s.size, r = Math.round(ratio);
        if (r >= 2 && Math.abs(ratio - r) < 0.05) subs.push({ size: s.size, ratio: r, count: s.count });
      }
      if (subs.length > 0) { parentSize = candidate; subBlockSizes = subs; isSubBlocked = true; }
      else parentSize = spacings[0].size;
    }
  }

  // explicit dim column overrides spacing inference
  if (dimValues && dimValues.length > 0) {
    const uniq = dimValues;
    const maxDim = uniq[uniq.length - 1];
    if (uniq.length === 1) { parentSize = uniq[0]; isSubBlocked = false; subBlockSizes = []; }
    else { parentSize = maxDim; isSubBlocked = true; subBlockSizes = uniq.slice(0, -1).map((d) => ({ size: d, ratio: Math.round(maxDim / d) })); }
  }

  const count = parentSize ? Math.round((max - min) / parentSize) + 1 : sorted.length;
  return { origin: min, max, size: parentSize, count, isSubBlocked, subBlockSizes };
}
