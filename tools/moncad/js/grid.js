// moncad grid — the reference grid: an adaptive ruled background drawn BEHIND the geometry
// (a GL pass, not the over-geometry overlay). Pure: no DOM/WebGL — it emits the renderer's
// line-instance format from the viewport, so it recomputes per view change (the spacing is
// zoom-dependent, so it can't be a static buffer).
//
// Spacing is "nice" (1 / 2 / 5 × 10ⁿ) chosen so minor lines sit ~targetPx apart on screen;
// every Nth line is a major line, and the local axes (x=0 / y=0 — the frame origin, a real
// UTM datum) are brighter still. Coordinates are LOCAL (like the geometry), so the grid
// aligns to the working origin.

// Round x up to a nice step (1, 2, 5 × 10ⁿ).
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const exp = Math.floor(Math.log10(x)), f = x / Math.pow(10, exp);
  const n = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return n * Math.pow(10, exp);
}

// → { lines: Float32Array (9 floats/segment, the renderer format), step } for the current
// view. `step` is the minor spacing in local units (also what grid-snap rounds to).
export function computeGrid(view, opts = {}) {
  const targetPx = opts.targetPx || 70;             // device px between minor lines
  const minor = niceStep(targetPx / view.scale);    // local units per minor cell
  const major = minor * (opts.majorEvery || 5);
  const COL_MINOR = opts.minor || [0.14, 0.14, 0.14, 1];
  const COL_MAJOR = opts.major || [0.20, 0.20, 0.21, 1];
  const COL_AXIS = opts.axis || [0.34, 0.34, 0.37, 1];

  const tl = view.toWorld([0, 0]), br = view.toWorld([view.width, view.height]);
  const x0 = Math.min(tl[0], br[0]), x1 = Math.max(tl[0], br[0]);
  const y0 = Math.min(tl[1], br[1]), y1 = Math.max(tl[1], br[1]);
  if ((x1 - x0) / minor > 4000 || (y1 - y0) / minor > 4000) return { lines: new Float32Array(0), step: minor };   // guard

  const L = [];
  const push = (ax, ay, bx, by, c) => L.push(ax, ay, bx, by, 1, c[0], c[1], c[2], c[3]);
  const colour = (v) => (Math.abs(v) < minor * 1e-6 ? COL_AXIS : Math.abs(v / major - Math.round(v / major)) < 1e-6 ? COL_MAJOR : COL_MINOR);
  for (let gx = Math.ceil(x0 / minor) * minor; gx <= x1; gx += minor) push(gx, y0, gx, y1, colour(gx));
  for (let gy = Math.ceil(y0 / minor) * minor; gy <= y1; gy += minor) push(x0, gy, x1, gy, colour(gy));
  return { lines: new Float32Array(L), step: minor };
}

// Nearest grid node to a local point, or null if beyond `tol` (local units).
export function snapToGrid(local, step, tol) {
  if (!(step > 0)) return null;
  const gx = Math.round(local[0] / step) * step, gy = Math.round(local[1] / step) * step;
  return Math.hypot(local[0] - gx, local[1] - gy) <= tol ? [gx, gy] : null;
}
