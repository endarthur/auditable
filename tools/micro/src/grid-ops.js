// micro grid ops — the pure grid kernel: lattice cover/alignment, empty-grid /
// empty-block-model builders, mesh→grid rasterization, nodata fills, and the
// bilinear surface sampler. No DOM, no renderer — the app wires these to
// layers/dialogs; test/grid-join.test.mjs-style logic lives at this altitude.

// snap an axis to anchor's phase so it covers [lo, hi]; half = half-cell inset
export function alignAxis(anchor, lo, hi, step, half) {
  let o = anchor + Math.round((lo - anchor) / step) * step;   // in-phase, nearest lo
  while (o - half > lo + 1e-6) o -= step;                     // step out until it covers lo
  let n = 1;
  while (o + (n - 1) * step + half < hi - 1e-6) n++;          // grow until it covers hi
  return { min: o, n: Math.max(1, n) };
}
// origin + counts for a grid / block model covering bbox bb, optionally phased
// to d.ax/d.ay/d.az. Shared by the tally and the builder so they never drift.
export function coverGeometry(d, bb) {
  const isBM = d.type === 'block';
  const sx = d.dx, sy = isBM ? d.dy : d.dx, sz = d.dz;
  if (d.align) {
    const hx = isBM ? sx / 2 : 0, hy = isBM ? sy / 2 : 0, hz = sz / 2;
    const X = alignAxis(d.ax, bb[0], bb[3], sx, hx);
    const Y = alignAxis(d.ay, bb[1], bb[4], sy, hy);
    const nx = X.n, ny = Y.n;
    // grid rows descend from y0=top; the node set is the same either way, so
    // y0 = the highest in-phase node (Y.min + (ny−1)·sy)
    const x0 = X.min, y0 = isBM ? Y.min : Y.min + (ny - 1) * sy;
    if (isBM) { const Z = alignAxis(d.az, bb[2], bb[5], sz, hz); return { x0, y0, z0: Z.min, nx, ny, nz: Z.n }; }
    return { x0, y0, z0: 0, nx, ny, nz: 1 };
  }
  const nx = Math.max(1, Math.floor((bb[3] - bb[0]) / sx) + 1);
  const ny = Math.max(1, Math.floor((bb[4] - bb[1]) / sy) + 1);
  const nz = isBM ? Math.max(1, Math.floor((bb[5] - bb[2]) / sz) + 1) : 1;
  return { x0: isBM ? bb[0] + sx / 2 : bb[0], y0: isBM ? bb[1] + sy / 2 : bb[4], z0: bb[2] + sz / 2, nx, ny, nz };
}
export function buildEmptyGrid({ x0, y0, dx, nx, ny, fill = 0 }) {
  return { nx, ny, x0, y0, dx, dy: dx, data: new Float32Array(nx * ny).fill(fill), nodata: -9999, crs: null, form: 'empty' };
}
// an empty regular block model as a CSV blob (XC,YC,ZC + one constant column);
// x0/y0/z0 are the block-0 CENTRE. Chunked so a big lattice keeps the UI alive.
export async function buildEmptyBlockCsv({ x0, y0, z0, dx, dy, dz, nx, ny, nz, fill = 0, valName = 'VAL', onProgress = null }) {
  const parts = [`XC,YC,ZC,${valName}\n`];
  let buf = '';
  const total = nz;
  for (let k = 0; k < nz; k++) {
    const z = z0 + k * dz;
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * dy;
      for (let i = 0; i < nx; i++) buf += `${x0 + i * dx},${y},${z},${fill}\n`;
    }
    if (buf.length > (1 << 22)) { parts.push(buf); buf = ''; }
    if (onProgress && (k & 7) === 0) { onProgress((k + 1) / total); await new Promise((r) => setTimeout(r)); }
  }
  if (buf) parts.push(buf);
  return new Blob(parts, { type: 'text/csv' });
}
// rasterize a mesh onto a grid by PLAN projection: each triangle projects onto
// the grid's XY plane, and every node inside its 2D footprint takes the plane's
// barycentric-interpolated Z. Overlaps (overhangs) z-buffer — 'top' keeps the
// upper surface, 'bottom' the lower. O(Σ triangle footprints) ≈ O(nodes) for a
// surface; no BVH, no per-node ray. Yields periodically to keep the UI live.
export async function rasterizeMeshToGrid(V, T, { x0, y0, dx, dy, nx, ny, nodata = -9999, keep = 'top', onProgress = null } = {}) {
  const data = new Float32Array(nx * ny).fill(nodata);
  const better = keep === 'bottom' ? (cur, z) => z < cur : (cur, z) => z > cur;
  const nt = T.length / 3;
  for (let t = 0; t < T.length; t += 3) {
    const i0 = T[t] * 3, i1 = T[t + 1] * 3, i2 = T[t + 2] * 3;
    const az = V[i0 + 2], bz = V[i1 + 2], cz = V[i2 + 2];
    // world → fractional grid index (col = (x−x0)/dx, row = (y0−y)/dy)
    const acol = (V[i0] - x0) / dx, arow = (y0 - V[i0 + 1]) / dy;
    const bcol = (V[i1] - x0) / dx, brow = (y0 - V[i1 + 1]) / dy;
    const ccol = (V[i2] - x0) / dx, crow = (y0 - V[i2 + 1]) / dy;
    const den = (brow - crow) * (acol - ccol) + (ccol - bcol) * (arow - crow);
    if (den === 0) continue;                                // degenerate in plan
    const inv = 1 / den;
    const minc = Math.max(0, Math.floor(Math.min(acol, bcol, ccol)));
    const maxc = Math.min(nx - 1, Math.ceil(Math.max(acol, bcol, ccol)));
    const minr = Math.max(0, Math.floor(Math.min(arow, brow, crow)));
    const maxr = Math.min(ny - 1, Math.ceil(Math.max(arow, brow, crow)));
    for (let r = minr; r <= maxr; r++) {
      for (let c = minc; c <= maxc; c++) {
        const w1 = ((brow - crow) * (c - ccol) + (ccol - bcol) * (r - crow)) * inv;
        const w2 = ((crow - arow) * (c - ccol) + (acol - ccol) * (r - crow)) * inv;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
        const z = w1 * az + w2 * bz + w3 * cz;
        const idx = r * nx + c;
        if (data[idx] === nodata || better(data[idx], z)) data[idx] = z;
      }
    }
    if (onProgress && ((t / 3) & 0x3FFF) === 0) { onProgress((t / 3) / nt); await new Promise((res) => setTimeout(res)); }
  }
  return { nx, ny, data, x0, y0, dx, dy, nodata, crs: null, form: 'rasterized' };
}
// mark EXTERIOR nodata (reachable from the grid border through nodata) so
// "holes only" can leave beyond-the-edge unfilled. 4-connected BFS.
export function markGridExterior(data, nx, ny, isNodata) {
  const ext = new Uint8Array(nx * ny);
  const q = new Int32Array(nx * ny);
  let head = 0, tail = 0;
  const push = (i) => { if (!ext[i] && isNodata(data[i])) { ext[i] = 1; q[tail++] = i; } };
  for (let c = 0; c < nx; c++) { push(c); push((ny - 1) * nx + c); }
  for (let r = 0; r < ny; r++) { push(r * nx); push(r * nx + nx - 1); }
  while (head < tail) {
    const i = q[head++], r = (i / nx) | 0, c = i % nx;
    if (c > 0) push(i - 1); if (c < nx - 1) push(i + 1);
    if (r > 0) push(i - nx); if (r < ny - 1) push(i + nx);
  }
  return ext;
}
// NEAREST fill: multi-source BFS (grassfire) — each empty node inherits its
// nearest filled node's value (flat / Voronoi extension). target restricts.
export function fillGridNearest(grid, isNodata, target) {
  const { nx, ny, data } = grid, N = nx * ny;
  const src = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) if (!isNodata(data[i])) { src[i] = i; q[tail++] = i; }
  const want = (j) => src[j] < 0 && isNodata(data[j]) && (!target || target[j]);
  while (head < tail) {
    const i = q[head++], r = (i / nx) | 0, c = i % nx;
    if (c > 0 && want(i - 1)) { src[i - 1] = src[i]; q[tail++] = i - 1; }
    if (c < nx - 1 && want(i + 1)) { src[i + 1] = src[i]; q[tail++] = i + 1; }
    if (r > 0 && want(i - nx)) { src[i - nx] = src[i]; q[tail++] = i - nx; }
    if (r < ny - 1 && want(i + nx)) { src[i + nx] = src[i]; q[tail++] = i + nx; }
  }
  const out = Float32Array.from(data);
  for (let i = 0; i < N; i++) if (isNodata(data[i]) && src[i] >= 0) out[i] = data[src[i]];
  return out;
}
// PLANAR TREND fill: least-squares plane z = a·x + b·y + c through the filled
// nodes (LOCAL indices, well-conditioned), evaluated at the empties — continues
// the regional dip outward.
export function fillGridTrend(grid, isNodata, target) {
  const { nx, ny, data } = grid;
  let n = 0, Sx = 0, Sy = 0, Sz = 0, Sxx = 0, Sxy = 0, Syy = 0, Sxz = 0, Syz = 0;
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const v = data[r * nx + c]; if (isNodata(v)) continue;
    n++; Sx += c; Sy += r; Sz += v; Sxx += c * c; Sxy += c * r; Syy += r * r; Sxz += c * v; Syz += r * v;
  }
  if (n < 3) return data;
  const det = Sxx * (Syy * n - Sy * Sy) - Sxy * (Sxy * n - Sy * Sx) + Sx * (Sxy * Sy - Syy * Sx);
  if (Math.abs(det) < 1e-9) return data;
  const a = (Sxz * (Syy * n - Sy * Sy) - Sxy * (Syz * n - Sy * Sz) + Sx * (Syz * Sy - Syy * Sz)) / det;
  const b = (Sxx * (Syz * n - Sy * Sz) - Sxz * (Sxy * n - Sy * Sx) + Sx * (Sxy * Sz - Syz * Sx)) / det;
  const cc = (Sxx * (Syy * Sz - Syz * Sy) - Sxy * (Sxy * Sz - Syz * Sx) + Sxz * (Sxy * Sy - Syy * Sx)) / det;
  const out = Float32Array.from(data);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) { const i = r * nx + c; if (isNodata(data[i]) && (!target || target[i])) out[i] = a * c + b * r + cc; }
  return out;
}
export function applyGridExtend(grid, method, holesOnly) {
  if (!method || method === 'none') return grid;
  const { nx, ny, data, nodata } = grid;
  const isNodata = (v) => Number.isNaN(v) || v === nodata;
  let target = null;
  if (holesOnly) {
    const ext = markGridExterior(data, nx, ny, isNodata);
    target = new Uint8Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) target[i] = isNodata(data[i]) && !ext[i] ? 1 : 0;
  }
  grid.data = method === 'trend' ? fillGridTrend(grid, isNodata, target) : fillGridNearest(grid, isNodata, target);
  return grid;
}
// WORLD (x,y) → surface Z sampler over a gridDoc grid; NaN off-grid; bilinear,
// degrading to the mean of the valid corners at a nodata edge
export function surfaceFromGrid(g) {
  const nod = g.nodata;
  const isBad = (v) => Number.isNaN(v) || (nod != null && (nod >= 1.7e38 ? v >= 1.7014e38 : v === nod));
  const sampleZ = (x, y) => {
    const fc = (x - g.x0) / g.dx, fr = (g.y0 - y) / g.dy;
    if (fc < 0 || fr < 0 || fc > g.nx - 1 || fr > g.ny - 1) return NaN;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, g.nx - 1), r1 = Math.min(r0 + 1, g.ny - 1);
    const tx = fc - c0, ty = fr - r0;
    const v00 = g.data[r0 * g.nx + c0], v10 = g.data[r0 * g.nx + c1], v01 = g.data[r1 * g.nx + c0], v11 = g.data[r1 * g.nx + c1];
    if (isBad(v00) || isBad(v10) || isBad(v01) || isBad(v11)) {
      let sum = 0, k = 0;
      for (const v of [v00, v10, v01, v11]) if (!isBad(v)) { sum += v; k++; }
      return k ? sum / k : NaN;
    }
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  };
  return { grid: g, sampleZ };
}
// a BLOCK MODEL's regular lattice (origin/pitch/count per axis), when it has one
export function gridAxesOf(L) {
  const g = L && L.docs && L.docs.blockDoc && L.docs.blockDoc.header && L.docs.blockDoc.header.grid;
  if (!g || !g.x || g.x.pitch == null) return null;
  return { x: { origin: g.x.origin, pitch: g.x.pitch, count: g.x.count }, y: { origin: g.y.origin, pitch: g.y.pitch, count: g.y.count }, z: { origin: g.z.origin, pitch: g.z.pitch, count: g.z.count } };
}
