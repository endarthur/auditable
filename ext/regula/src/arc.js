// @gcu/regula arc — bulge ↔ arc derived accessors + the curve constructors the kernel
// operates on. Mirrors @gcu/dxf's arc.js verbatim (same fixed textbook formulas) so the
// two never disagree; if they ever need to diverge, extract a shared @gcu/arc. Keeping it
// here lets regula stay a zero-dep leaf rather than pulling the whole DXF reader for 30
// lines of trig.
//
// An arc span is endpoint + bulge (`bulge = tan(θ/4)`, θ signed swept angle, + = CCW);
// centre / radius / angles are DERIVED, never stored (SPEC-curves §1). A straight span is
// bulge 0 → line and arc are the same primitive. Angles in RADIANS.

export const TAU = Math.PI * 2;

// Curve constructors — the geometric primitives the intersection / nearest kernels take.
// `sweep` is the SIGNED swept angle (+ CCW). A segment/line/ray is two points.
export const segment = (a, b) => ({ kind: 'segment', a, b });
export const line = (a, b) => ({ kind: 'line', a, b });          // infinite, through a→b
export const ray = (a, b) => ({ kind: 'ray', a, b });            // half-infinite from a through b
export const circle = (c, r) => ({ kind: 'circle', c, r });
export const arc = (c, r, startAngle, sweep) => ({ kind: 'arc', c, r, startAngle, sweep });

// Endpoint + bulge → derived { center, radius, startAngle, endAngle, sweep, ccw }, or null
// for a straight / degenerate span (callers treat those as segments).
export function arcFromBulge(p0, p1, bulge) {
  if (!bulge) return null;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const c = Math.hypot(dx, dy);
  if (c === 0) return null;
  const theta = 4 * Math.atan(bulge);
  const half = c / 2;
  const r = half / Math.abs(Math.sin(theta / 2));
  const m = half / Math.tan(theta / 2);
  const nx = -dy / c, ny = dx / c;
  const cx = p0[0] + dx / 2 + nx * m, cy = p0[1] + dy / 2 + ny * m;
  return {
    center: [cx, cy], radius: r,
    startAngle: Math.atan2(p0[1] - cy, p0[0] - cx),
    endAngle: Math.atan2(p1[1] - cy, p1[0] - cx),
    sweep: theta, ccw: bulge > 0,
  };
}

// Center-form arc (CCW start→end, radians) → endpoint + bulge { start, end, bulge }.
export function bulgeFromArc(center, radius, startAngle, endAngle) {
  let theta = ((endAngle - startAngle) % TAU + TAU) % TAU;
  if (theta === 0) theta = TAU;
  const [cx, cy] = center;
  return {
    start: [cx + radius * Math.cos(startAngle), cy + radius * Math.sin(startAngle)],
    end: [cx + radius * Math.cos(endAngle), cy + radius * Math.sin(endAngle)],
    bulge: Math.tan(theta / 4),
  };
}

// A bulge span (p0, p1, bulge) → the kernel curve: an `arc` when curved, a `segment` when
// straight. The bridge from the stored polyline primitive to the intersection kernel.
export function spanCurve(p0, p1, bulge) {
  const a = arcFromBulge(p0, p1, bulge);
  return a ? arc(a.center, a.radius, a.startAngle, a.sweep) : segment(p0, p1);
}

// Is angle `theta` within the arc that starts at `startAngle` and sweeps `sweep`
// (signed)? Slack `epsAng` (radians) admits endpoints. Used to filter circle-support
// intersections down to the actual arc span.
export function angleInSweep(startAngle, sweep, theta, epsAng = 1e-9) {
  if (sweep >= 0) { let d = ((theta - startAngle) % TAU + TAU) % TAU; return d <= sweep + epsAng || d >= TAU - epsAng; }
  let d = ((theta - startAngle) % TAU - TAU) % TAU;   // into (-TAU, 0]
  return d >= sweep - epsAng || d <= -TAU + epsAng;
}

// The point at fraction `f` (0..1) along an arc's sweep.
export function arcPointAt(cv, f) {
  const a = cv.startAngle + cv.sweep * f;
  return [cv.c[0] + cv.r * Math.cos(a), cv.c[1] + cv.r * Math.sin(a)];
}
