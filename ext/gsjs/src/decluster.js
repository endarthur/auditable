// @gcu/gsjs — cell declustering (GSLIB `declus`). Spatial sampling is rarely
// representative: high-grade zones get drilled out densely, so a NAIVE mean over the
// samples over-weights them. Cell declustering lays a regular grid of cells over the
// data and down-weights samples sharing a cell — a sample in a crowded cell counts
// less. The weights then de-bias any global statistic (mean, histogram, variance).
//
// Algorithm (Deutsch & Journel, GSLIB declus): for a cell size, assign each sample to
// a cell; a sample's weight ∝ 1/(samples in its cell), normalized so Σw = n. The
// declustered mean is then the average of the per-cell mean grades. The grid ORIGIN
// matters at coarse cell sizes (a sample near a boundary lands in different cells
// under different origins), so we AVERAGE the weights over `nOffsets`³ origin shifts.
// A SWEEP over cell sizes traces the declustered mean vs cell size; the representative
// size is the curve's extremum (min for high-grade-clustered data — the usual case).
//
// Zero imports — cell assignment is O(n) integer bucketing, no kd-tree. Inputs are
// the same [x,y,z,value] rows krige() takes (extra columns ignored).

// Bounding box of the data coords.
function _bbox(data) {
  let xmn = Infinity, ymn = Infinity, zmn = Infinity, xmx = -Infinity, ymx = -Infinity, zmx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const x = data[i][0], y = data[i][1], z = data[i][2];
    if (x < xmn) xmn = x; if (x > xmx) xmx = x;
    if (y < ymn) ymn = y; if (y > ymx) ymx = y;
    if (z < zmn) zmn = z; if (z > zmx) zmx = z;
  }
  return { xmn, ymn, zmn, xmx, ymx, zmx };
}

// Resolve a cell-size argument to [dx, dy, dz]. A number is isotropic × anisotropy
// ratios [ay, az]; an array is taken verbatim. A zero dim means "no cells on this
// axis" → collapsed to one slab (handles 2D / single-bench data).
function _cellDims(cellSize, anisotropy) {
  if (Array.isArray(cellSize)) return [cellSize[0], cellSize[1], cellSize[2] != null ? cellSize[2] : cellSize[0]];
  const ay = anisotropy && anisotropy[0] != null ? anisotropy[0] : 1;
  const az = anisotropy && anisotropy[1] != null ? anisotropy[1] : 1;
  return [cellSize, cellSize * ay, cellSize * az];
}

// Per-sample weights for ONE cell size, averaged over the origin offsets. Weights sum
// to n. Returns { weights, nOccupied } where nOccupied is the offset-averaged count of
// occupied cells (a clustering diagnostic). Degenerate dims (range 0, or dim ≤ 0) put
// every sample in one cell on that axis.
export function declusterWeights(data, cellSize, opts = {}) {
  const n = data.length;
  const anisotropy = opts.anisotropy;
  const nOff = opts.nOffsets != null ? opts.nOffsets : 4;
  if (!(nOff >= 1)) throw new Error('gsjs.decluster: nOffsets must be ≥ 1');
  const [dx, dy, dz] = _cellDims(cellSize, anisotropy);
  if (!(dx >= 0 && dy >= 0 && dz >= 0)) throw new Error('gsjs.decluster: cell dims must be ≥ 0');
  const bb = _bbox(data);

  // axes with a positive cell dim AND nonzero data range are gridded; others collapse
  const useX = dx > 0 && bb.xmx > bb.xmn, useY = dy > 0 && bb.ymx > bb.ymn, useZ = dz > 0 && bb.zmx > bb.zmn;
  const weights = new Float64Array(n);
  let nOccAcc = 0, nOffActual = 0;

  // sweep the grid origin across [-dim, 0) in nOff steps per active axis, so a sample
  // near a cell wall is binned both ways and the artifact averages out.
  const offXs = useX ? nOff : 1, offYs = useY ? nOff : 1, offZs = useZ ? nOff : 1;
  const counts = new Map();
  const keyOf = new Int32Array(n * 3);
  for (let ox = 0; ox < offXs; ox++) for (let oy = 0; oy < offYs; oy++) for (let oz = 0; oz < offZs; oz++) {
    const sx = useX ? bb.xmn - dx * (ox / nOff) : 0;
    const sy = useY ? bb.ymn - dy * (oy / nOff) : 0;
    const sz = useZ ? bb.zmn - dz * (oz / nOff) : 0;
    counts.clear();
    for (let i = 0; i < n; i++) {
      const cx = useX ? Math.floor((data[i][0] - sx) / dx) : 0;
      const cy = useY ? Math.floor((data[i][1] - sy) / dy) : 0;
      const cz = useZ ? Math.floor((data[i][2] - sz) / dz) : 0;
      keyOf[i * 3] = cx; keyOf[i * 3 + 1] = cy; keyOf[i * 3 + 2] = cz;
      const k = cx + ',' + cy + ',' + cz;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const nOcc = counts.size;
    nOccAcc += nOcc; nOffActual++;
    // weight ∝ 1/count, scaled so Σ = n: w_i = (n/nOcc)·(1/count_i)  [Σ 1/count = nOcc]
    const scale = n / nOcc;
    for (let i = 0; i < n; i++) {
      const k = keyOf[i * 3] + ',' + keyOf[i * 3 + 1] + ',' + keyOf[i * 3 + 2];
      weights[i] += scale / counts.get(k);
    }
  }
  for (let i = 0; i < n; i++) weights[i] /= nOffActual;   // average over offsets (already Σ=n each)
  return { weights, nOccupied: nOccAcc / nOffActual };
}

// Weighted mean / variance of the sample VALUES under given weights (the 4th column).
// Variance is the weight-frequency form Σw(z−μ)²/Σw.
function _weightedStats(data, weights) {
  let sw = 0, swz = 0;
  for (let i = 0; i < data.length; i++) { sw += weights[i]; swz += weights[i] * data[i][3]; }
  const mean = sw > 0 ? swz / sw : NaN;
  let swd = 0;
  for (let i = 0; i < data.length; i++) { const d = data[i][3] - mean; swd += weights[i] * d * d; }
  const variance = sw > 0 ? swd / sw : NaN;
  return { mean, variance, std: Math.sqrt(variance) };
}

// declusterCell({ data, cellSize, anisotropy?, nOffsets? }) — declustering at ONE cell
// size. Returns the weights (Σ = n) + the declustered vs naive statistics.
export function declusterCell(opts) {
  const data = opts.data;
  const { weights, nOccupied } = declusterWeights(data, opts.cellSize, opts);
  const dec = _weightedStats(data, weights);
  const naive = _weightedStats(data, new Float64Array(data.length).fill(1));
  return {
    weights, nOccupied,
    cellSize: opts.cellSize,
    mean: dec.mean, variance: dec.variance, std: dec.std,
    naiveMean: naive.mean, naiveVariance: naive.variance, naiveStd: naive.std,
  };
}

// declusterSweep({ data, sizes, anisotropy?, nOffsets?, pick? }) — sweep the cell size
// and trace the declustered mean. `pick`: 'min' (default — high-grade-clustered data,
// the usual mining case) | 'max' (low-grade-clustered). Returns the curve + the chosen
// `best` (its cell size, mean, and weights — ready to feed a weighted histogram).
export function declusterSweep(opts) {
  const data = opts.data;
  const sizes = opts.sizes;
  if (!Array.isArray(sizes) || !sizes.length) throw new Error('gsjs.declusterSweep: sizes[] required');
  const pick = opts.pick || 'min';
  if (pick !== 'min' && pick !== 'max') throw new Error("gsjs.declusterSweep: pick must be 'min' or 'max'");
  const naive = _weightedStats(data, new Float64Array(data.length).fill(1));

  const means = new Float64Array(sizes.length);
  const nOcc = new Float64Array(sizes.length);
  let bestI = -1;
  for (let s = 0; s < sizes.length; s++) {
    const { weights, nOccupied } = declusterWeights(data, sizes[s], opts);
    const m = _weightedStats(data, weights).mean;
    means[s] = m; nOcc[s] = nOccupied;
    if (bestI < 0 || (pick === 'min' ? m < means[bestI] : m > means[bestI])) bestI = s;
  }
  const best = declusterCell({ ...opts, cellSize: sizes[bestI] });
  return { sizes, means, nOccupied: nOcc, naiveMean: naive.mean, best: { size: sizes[bestI], mean: means[bestI], weights: best.weights } };
}
