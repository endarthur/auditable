// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/regula — 2D drafting curve-operations for the GCU geometry stack — the Roman straightedge, sibling to groma's surveyor's cross. Operates on the @gcu/dxf bulge-primitive (line and arc are one curve), keeping geometry canonical through every op: a transform leaves arcs as arcs, offset-of-an-arc is an arc (not a chord fan). v0.1 ships the transform tier (translate/rotate/scale/mirror, bulge-correct, zero-dep); intersection, trim/extend, fillet/chamfer, and offset follow, on @gcu/groma's exact predicates with a coordinate-relative tolerance. Written from the geometry literature.

// ── src/transform.js ──

// @gcu/regula transform — rigid + similarity transforms of the bulge-primitive.
//
// Operates on the @gcu/dxf geometry shape (polyline {kind,vertices,bulges,closed} /
// circle {kind,center,radius} / point {kind,position}) and returns a NEW geometry —
// never mutates the input. The correctness-critical subtlety is the bulge under each map:
//
//   translate / rotate / uniform-scale  → bulge UNCHANGED  (a similarity preserves arc shape)
//   mirror (reflection)                  → bulge NEGATED   (orientation reverses)
//
// Non-uniform scale would turn a circle into an ellipse — not representable as a bulge —
// so it is deliberately absent. These are exactly the transforms that keep the canonical
// model valid; anything that wouldn't is not offered rather than offered and lossy.
//
// Pure, zero-dep, node-testable. Frame-agnostic: points are LOCAL coordinates (the host
// owns world↔local). Z is carried through untouched (2D transforms, in plan).

// Apply a 2D point map `fn(x,y)->[x,y]` to any supported geometry, with bulge/radius
// handling, returning fresh geometry. `flipBulge` for reflections; `radiusScale` for scale.
function transformGeom(g, fn, { flipBulge = false, radiusScale = 1 } = {}) {
  if (!g || !g.kind) return g;
  if (g.kind === 'polyline') {
    const v = g.vertices, out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i += 3) { const p = fn(v[i], v[i + 1]); out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = v[i + 2]; }
    const bulges = g.bulges ? Float64Array.from(g.bulges, (b) => (flipBulge ? -b : b)) : null;
    return { kind: 'polyline', vertices: out, bulges, closed: g.closed };
  }
  if (g.kind === 'circle') { const c = fn(g.center[0], g.center[1]); return { kind: 'circle', center: [c[0], c[1], g.center[2] || 0], radius: g.radius * radiusScale }; }
  if (g.kind === 'point') { const p = fn(g.position[0], g.position[1]); return { kind: 'point', position: [p[0], p[1], g.position[2] || 0] }; }
  return g;   // face / insert etc. — untouched in v0 (no 2D-plan transform defined)
}

// Move by a displacement [dx, dy].
function translate(g, [dx, dy]) {
  return transformGeom(g, (x, y) => [x + dx, y + dy]);
}

// Rotate by `angle` (radians, CCW) about `pivot` (local). Bulge unchanged.
function rotate(g, angle, pivot = [0, 0]) {
  const c = Math.cos(angle), s = Math.sin(angle), px = pivot[0], py = pivot[1];
  return transformGeom(g, (x, y) => { const dx = x - px, dy = y - py; return [px + dx * c - dy * s, py + dx * s + dy * c]; });
}

// Uniform scale by `factor` about `pivot`. Radius scales by |factor|; a negative factor is
// a point-reflection (= 180° rotation), which preserves orientation, so bulge is unchanged.
function scale(g, factor, pivot = [0, 0]) {
  const px = pivot[0], py = pivot[1];
  return transformGeom(g, (x, y) => [px + (x - px) * factor, py + (y - py) * factor], { radiusScale: Math.abs(factor) });
}

// Reflect across the line through points `a` and `b` (local). Bulge negated.
function mirror(g, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const fn = (x, y) => {
    if (len2 === 0) return [x, y];                              // degenerate axis → identity
    const t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;       // param of the foot on the line
    const fx = a[0] + t * dx, fy = a[1] + t * dy;
    return [2 * fx - x, 2 * fy - y];                            // reflect through the foot
  };
  return transformGeom(g, fn, { flipBulge: true });
}

// ── src/tolerance.js ──

// @gcu/regula tolerance — the load-bearing decision (SPEC-curves §3): predicates are
// exact, constructions are not. A line·arc intersection or a fillet tangent is a
// constructed, generally irrational coordinate, so coincidence / on-curve / parallel
// tests need ONE explicit, documented tolerance policy — not scattered epsilons.
//
// Tolerance is COORDINATE-RELATIVE, scaled to the working extent — never a fixed absolute
// epsilon. At UTM magnitudes a fixed 1e-9 is meaningless (the same failure class as the
// silent-shift bug); regula always runs in the small local frame, but the tolerance still
// derives from the data's extent so it travels correctly. One Tolerance object threads
// through the API.

// Build a Tolerance for a working `extent` (e.g. the drawing bbox diagonal, in the working
// frame's units). `eps` is the distance below which two coordinates are "the same".
function makeTolerance(extent, { rel = 1e-7 } = {}) {
  const e = Math.abs(extent) || 1;
  return { eps: rel * e, rel, extent: e };
}

// Coerce a tolerance argument to an eps distance: a Tolerance object, a bare number (eps),
// or — as a documented floor when a caller hasn't supplied one — a small relative default.
function tolEps(tol) {
  if (typeof tol === 'number') return tol;
  if (tol && typeof tol.eps === 'number') return tol.eps;
  return 1e-7;   // drafting floor at local magnitudes; callers SHOULD pass makeTolerance(extent)
}

// ── src/arc.js ──

// @gcu/regula arc — bulge ↔ arc derived accessors + the curve constructors the kernel
// operates on. Mirrors @gcu/dxf's arc.js verbatim (same fixed textbook formulas) so the
// two never disagree; if they ever need to diverge, extract a shared @gcu/arc. Keeping it
// here lets regula stay a zero-dep leaf rather than pulling the whole DXF reader for 30
// lines of trig.
//
// An arc span is endpoint + bulge (`bulge = tan(θ/4)`, θ signed swept angle, + = CCW);
// centre / radius / angles are DERIVED, never stored (SPEC-curves §1). A straight span is
// bulge 0 → line and arc are the same primitive. Angles in RADIANS.

const TAU = Math.PI * 2;

// Curve constructors — the geometric primitives the intersection / nearest kernels take.
// `sweep` is the SIGNED swept angle (+ CCW). A segment/line/ray is two points.
const segment = (a, b) => ({ kind: 'segment', a, b });
const line = (a, b) => ({ kind: 'line', a, b });          // infinite, through a→b
const ray = (a, b) => ({ kind: 'ray', a, b });            // half-infinite from a through b
const circle = (c, r) => ({ kind: 'circle', c, r });
const arc = (c, r, startAngle, sweep) => ({ kind: 'arc', c, r, startAngle, sweep });

// Endpoint + bulge → derived { center, radius, startAngle, endAngle, sweep, ccw }, or null
// for a straight / degenerate span (callers treat those as segments).
function arcFromBulge(p0, p1, bulge) {
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
function bulgeFromArc(center, radius, startAngle, endAngle) {
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
function spanCurve(p0, p1, bulge) {
  const a = arcFromBulge(p0, p1, bulge);
  return a ? arc(a.center, a.radius, a.startAngle, a.sweep) : segment(p0, p1);
}

// Is angle `theta` within the arc that starts at `startAngle` and sweeps `sweep`
// (signed)? Slack `epsAng` (radians) admits endpoints. Used to filter circle-support
// intersections down to the actual arc span.
function angleInSweep(startAngle, sweep, theta, epsAng = 1e-9) {
  if (sweep >= 0) { let d = ((theta - startAngle) % TAU + TAU) % TAU; return d <= sweep + epsAng || d >= TAU - epsAng; }
  let d = ((theta - startAngle) % TAU - TAU) % TAU;   // into (-TAU, 0]
  return d >= sweep - epsAng || d <= -TAU + epsAng;
}

// The point at fraction `f` (0..1) along an arc's sweep.
function arcPointAt(cv, f) {
  const a = cv.startAngle + cv.sweep * f;
  return [cv.c[0] + cv.r * Math.cos(a), cv.c[1] + cv.r * Math.sin(a)];
}

// ── src/intersect.js ──

// @gcu/regula intersect — Tier-1, the foundation everything else reduces to (SPEC-curves
// §2). Pairwise intersection of the kernel curves (segment / line / ray / circle / arc).
//
// The trick that de-dups the whole pair-matrix: every curve has a SUPPORT (a line for
// segment/line/ray, a circle for circle/arc) and a MEMBERSHIP test (is a support point
// actually on this finite piece?). So we intersect the two supports (line·line,
// line·circle, circle·circle — three cases, not nine), then keep the points that lie on
// BOTH finite curves. Intersection coordinates are CONSTRUCTED (inexact, §3); the
// membership/parallel tests carry the tolerance.
//
// Pure, zero-dep. Angles via arc.js; tolerance via tolerance.js.


const sub$intersect = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot$intersect = (a, b) => a[0] * b[0] + a[1] * b[1];

// Parameter of p's projection onto the infinite line a→b (0 at a, 1 at b).
function paramOnLine(a, b, p) {
  const d = sub$intersect(b, a), l2 = d[0] * d[0] + d[1] * d[1];
  return l2 ? dot$intersect(sub$intersect(p, a), d) / l2 : 0;
}

function support(cv) {
  if (cv.kind === 'circle' || cv.kind === 'arc') return { type: 'circle', c: cv.c, r: cv.r };
  return { type: 'line', a: cv.a, b: cv.b };
}

// Is a support point actually on this finite curve? (The point is already ON the support
// by construction, so this is purely the range/angle test, with eps slack.)
function onCurve(cv, p, eps) {
  if (cv.kind === 'circle') return true;
  if (cv.kind === 'line') return true;
  if (cv.kind === 'arc') return angleInSweep(cv.startAngle, cv.sweep, Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]), eps / Math.max(cv.r, eps));
  const len = Math.hypot(cv.b[0] - cv.a[0], cv.b[1] - cv.a[1]) || 1;
  const t = paramOnLine(cv.a, cv.b, p), te = eps / len;
  if (cv.kind === 'ray') return t >= -te;
  return t >= -te && t <= 1 + te;     // segment
}

// ── support intersections (the three real cases) ─────────────────────────────────

// Two infinite lines (each through a pair) → 0 or 1 point. Parallel/collinear → [].
function lineLine(a0, a1, b0, b1) {
  const d1 = sub$intersect(a1, a0), d2 = sub$intersect(b1, b0);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) <= 1e-12 * Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1])) return [];   // parallel (angular tol)
  const t = ((b0[0] - a0[0]) * d2[1] - (b0[1] - a0[1]) * d2[0]) / den;
  return [[a0[0] + t * d1[0], a0[1] + t * d1[1]]];
}

// Infinite line (through p0,p1) ∩ circle → 0, 1 (tangent) or 2 points.
function lineCircle(p0, p1, c, r, eps) {
  const d = sub$intersect(p1, p0), f = sub$intersect(p0, c);
  const A = dot$intersect(d, d), B = 2 * dot$intersect(f, d), C = dot$intersect(f, f) - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < -eps * eps) return [];
  if (disc < 0) disc = 0;
  const sd = Math.sqrt(disc), t1 = (-B - sd) / (2 * A), t2 = (-B + sd) / (2 * A);
  const out = [[p0[0] + t1 * d[0], p0[1] + t1 * d[1]]];
  if (sd > eps) out.push([p0[0] + t2 * d[0], p0[1] + t2 * d[1]]);
  return out;
}

// Two circles → 0, 1 (tangent) or 2 points. Concentric / separate / contained → [].
function circleCircle(c0, r0, c1, r1, eps) {
  const dx = c1[0] - c0[0], dy = c1[1] - c0[1], d = Math.hypot(dx, dy);
  if (d <= eps) return [];
  if (d > r0 + r1 + eps || d < Math.abs(r0 - r1) - eps) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  let h2 = r0 * r0 - a * a; if (h2 < 0) h2 = 0;
  const h = Math.sqrt(h2);
  const xm = c0[0] + a * dx / d, ym = c0[1] + a * dy / d;
  if (h <= eps) return [[xm, ym]];
  const ox = -dy / d * h, oy = dx / d * h;
  return [[xm + ox, ym + oy], [xm - ox, ym - oy]];
}

function supportIntersect(sa, sb, eps) {
  if (sa.type === 'line' && sb.type === 'line') return lineLine(sa.a, sa.b, sb.a, sb.b);
  if (sa.type === 'line' && sb.type === 'circle') return lineCircle(sa.a, sa.b, sb.c, sb.r, eps);
  if (sa.type === 'circle' && sb.type === 'line') return lineCircle(sb.a, sb.b, sa.c, sa.r, eps);
  return circleCircle(sa.c, sa.r, sb.c, sb.r, eps);
}

// Pairwise intersection of two kernel curves → array of points (0, 1 or 2). Points are
// filtered to lie on both finite pieces and de-duplicated within eps (tangencies).
function intersect(A, B, tol) {
  const eps = tolEps(tol);
  const cands = supportIntersect(support(A), support(B), eps);
  const out = [];
  for (const p of cands) {
    if (!onCurve(A, p, eps) || !onCurve(B, p, eps)) continue;
    if (out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= eps)) continue;
    out.push(p);
  }
  return out;
}

// ── src/nearest.js ──

// @gcu/regula nearest — closest point on a curve to a query point (SPEC-curves §2). The
// companion to intersection: trim picks the interval to keep by the param of the click,
// snapping wants the nearest point on a curve, extend measures to a boundary. Returns
// { point, dist, param } where param is 0..1 along the curve (the arc fraction of sweep,
// the segment fraction; unclamped for an infinite line).
//
// Pure, zero-dep.


const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const dist$nearest = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function onCircle(c, r, p) {
  const dx = p[0] - c[0], dy = p[1] - c[1], m = Math.hypot(dx, dy) || 1;
  return [c[0] + r * dx / m, c[1] + r * dy / m];
}

function closestPointOn(cv, p) {
  if (cv.kind === 'circle') { const pt = onCircle(cv.c, cv.r, p); return { point: pt, dist: dist$nearest(pt, p), param: ((Math.atan2(pt[1] - cv.c[1], pt[0] - cv.c[0])) ) }; }
  if (cv.kind === 'arc') {
    const ang = Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]);
    if (angleInSweep(cv.startAngle, cv.sweep, ang)) {
      const pt = onCircle(cv.c, cv.r, p);
      let f = (ang - cv.startAngle) / cv.sweep;            // fraction of sweep
      f = clamp01(f);
      return { point: pt, dist: dist$nearest(pt, p), param: f };
    }
    const e0 = arcPointAt(cv, 0), e1 = arcPointAt(cv, 1);   // outside the sweep → nearer endpoint
    return dist$nearest(e0, p) <= dist$nearest(e1, p) ? { point: e0, dist: dist$nearest(e0, p), param: 0 } : { point: e1, dist: dist$nearest(e1, p), param: 1 };
  }
  // linear (segment / line / ray)
  const a = cv.a, b = cv.b, d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] * d[0] + d[1] * d[1];
  let t = l2 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2 : 0;
  if (cv.kind === 'segment') t = clamp01(t);
  else if (cv.kind === 'ray') t = t < 0 ? 0 : t;
  const pt = [a[0] + t * d[0], a[1] + t * d[1]];
  return { point: pt, dist: dist$nearest(pt, p), param: t };
}

// ── src/trim.js ──

// @gcu/regula trim — Tier-2 (SPEC-curves §2). Trim = intersection (Tier-1) + parameter
// classification: cut the target where cutters cross it, then drop the one interval the
// pick falls in. The rest reassembles into one or two paths (a middle cut splits an open
// path in two; trimming a ring opens it).
//
// Works on the bulge-native path { points:[[x,y],…], bulges:[…]|null, closed } and emits
// the same shape — arcs stay arcs (a trimmed arc span gets a recomputed bulge, never a
// chord fan). Pure; rides arc.js / intersect.js / nearest.js. A whole-polyline parametrise
// (span index + local fraction) is the global coordinate everything sorts by.


function pathSpans(path) {
  const pts = path.points, n = pts.length, nspan = path.closed ? n : n - 1, spans = [];
  for (let i = 0; i < nspan; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n], b = path.bulges ? (path.bulges[i] || 0) : 0;
    spans.push({ p0, p1, sweep: 0, curve: spanCurve(p0, p1, b) });
    if (spans[i].curve.kind === 'arc') spans[i].sweep = spans[i].curve.sweep;
  }
  return spans;
}
function pointAt(span, t) {
  if (span.curve.kind === 'segment') return [span.p0[0] + (span.p1[0] - span.p0[0]) * t, span.p0[1] + (span.p1[1] - span.p0[1]) * t];
  const cv = span.curve, a = cv.startAngle + cv.sweep * t;
  return [cv.c[0] + cv.r * Math.cos(a), cv.c[1] + cv.r * Math.sin(a)];
}
const subBulge = (span, t0, t1) => (span.curve.kind === 'segment' ? 0 : Math.tan(span.sweep * (t1 - t0) / 4));

// Global param (spanIndex + localFraction) of the point on the path nearest to p.
function globalParam(spans, p) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < spans.length; i++) { const r = closestPointOn(spans[i].curve, p); if (r.dist < bd) { bd = r.dist; best = i + r.param; } }
  return best;
}

// Build the sub-path covering [lo, hi] in global param. Walks span by span (mod n, so a
// closed-path complement wraps), splitting the first/last spans, recomputing arc bulges.
function subPath(spans, lo, hi) {
  const n = spans.length, out = { points: [], bulges: [], closed: false };
  const s0 = Math.floor(lo + 1e-9), t0 = lo - s0;
  out.points.push(pointAt(spans[s0 % n], t0));
  let s = s0;
  while (s < hi - 1e-9) {
    const a = s === s0 ? t0 : 0, b = Math.min(1, hi - s);
    out.bulges.push(subBulge(spans[s % n], a, b));
    out.points.push(pointAt(spans[s % n], b));
    s += 1;
  }
  return out;
}

// Trim `path` against `cutters` (kernel curves), dropping the interval the world point
// `pickPoint` lies in. Returns { kept:[path,…], removed:bool }. No crossing cut → unchanged.
function trim(path, cutters, pickPoint, tol) {
  const eps = tolEps(tol);
  const spans = pathSpans(path), nspan = spans.length;
  if (!nspan) return { kept: [path], removed: false };

  const cuts = [];
  for (let i = 0; i < nspan; i++) for (const c of cutters) for (const pt of intersect(spans[i].curve, c, eps)) {
    const g = i + Math.min(1, Math.max(0, closestPointOn(spans[i].curve, pt).param));
    if (g > 1e-9 && g < nspan - 1e-9) cuts.push(g);   // interior cuts only
  }
  cuts.sort((a, b) => a - b);
  const cs = cuts.filter((g, i) => i === 0 || g - cuts[i - 1] > 1e-9);
  if (!cs.length || (path.closed && cs.length < 2)) return { kept: [path], removed: false };

  const pick = globalParam(spans, pickPoint);

  if (!path.closed) {
    const bounds = [0, ...cs, nspan];
    let k = 0;
    for (let i = 0; i < bounds.length - 1; i++) if (pick >= bounds[i] - 1e-9 && pick <= bounds[i + 1] + 1e-9) { k = i; break; }
    const lo = bounds[k], hi = bounds[k + 1], kept = [];
    if (lo > 1e-9) kept.push(subPath(spans, 0, lo));
    if (hi < nspan - 1e-9) kept.push(subPath(spans, hi, nspan));
    return { kept, removed: true };
  }

  // closed: the cuts divide the ring; remove the interval (lo→hi) holding the pick, keep
  // the complement (hi→lo+nspan), now an open path.
  let lo, hi;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = i + 1 < cs.length ? cs[i + 1] : cs[0] + nspan;
    const pk = (i + 1 >= cs.length && pick < a) ? pick + nspan : pick;
    if (pk >= a - 1e-9 && pk <= b + 1e-9) { lo = a; hi = b; break; }
  }
  if (lo === undefined) return { kept: [path], removed: false };
  return { kept: [subPath(spans, hi, lo + nspan)], removed: true };
}

// ── src/extend.js ──

// @gcu/regula extend — Tier-2's other half (SPEC-curves §2). Lengthen an open path's end
// until it meets a boundary: take the end SPAN's support line, find where it crosses the
// boundaries beyond the free end, and move the end vertex to the nearest such crossing.
//
// v0 extends a STRAIGHT end span (the common case — a line or a polyline's straight tail);
// extending an arc end (growing its sweep) is deferred (returns unchanged). Pure; rides
// intersect.js. Works on the bulge-native path; returns the same shape.


const sub$extend = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot$extend = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist$extend = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Extend `path` to the nearest forward crossing with any of `boundaries` (kernel curves),
// choosing the end nearest `pickPoint`. Returns { path, extended:bool }.
function extend(path, boundaries, pickPoint, tol) {
  const eps = tolEps(tol);
  const pts = path.points, n = pts.length;
  if (path.closed || n < 2) return { path, extended: false };

  const atEnd = dist$extend(pickPoint, pts[n - 1]) <= dist$extend(pickPoint, pts[0]);
  const a = atEnd ? pts[n - 2] : pts[1];   // interior neighbour
  const b = atEnd ? pts[n - 1] : pts[0];   // the free end being moved
  const endBulge = path.bulges ? (atEnd ? path.bulges[n - 2] : path.bulges[0]) : 0;
  if (endBulge) return { path, extended: false };          // arc-end extend deferred

  const d = sub$extend(b, a), l2 = dot$extend(d, d);
  if (l2 === 0) return { path, extended: false };
  const te = eps / Math.sqrt(l2);
  let best = null, bestT = Infinity;
  for (const bd of boundaries) for (const ip of intersect(line(a, b), bd, eps)) {
    const t = dot$extend(sub$extend(ip, a), d) / l2;
    if (t > 1 + te && t < bestT) { bestT = t; best = ip; }   // strictly beyond the free end, nearest
  }
  if (!best) return { path, extended: false };

  const points = pts.map((p) => p.slice());
  points[atEnd ? n - 1 : 0] = [best[0], best[1]];
  return { path: { ...path, points }, extended: true };
}

// ── src/fillet.js ──

// @gcu/regula fillet / chamfer — Tier-3 construction ops (SPEC-curves §2). Round (fillet)
// or bevel (chamfer) the corner between two line segments. Both reduce to the same corner
// setup: the segments' supports meet at C; the user's two picks choose which end of each
// to KEEP (nearest the pick); the kept rays define the corner angle. Fillet drops a
// tangent arc of radius r; chamfer drops a straight bevel at distance d along each.
//
// Bulge-native: the fillet inserts a TRUE tangent arc (a real bulge span), not a chord
// fan. v0 operates on straight segments (the common "fillet two lines"); a polyline-corner
// fillet rides the same math when the host extracts the two spans. Pure; rides intersect.js.


const sub$fillet = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot$fillet = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist$fillet = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (v) => { const m = Math.hypot(v[0], v[1]); return m > 1e-12 ? [v[0] / m, v[1] / m] : null; };

// Shared corner: supports meet at C; the kept end of each segment is the one nearest its
// pick; u1/u2 are the unit rays from C toward the kept ends. Null if parallel/collinear/
// degenerate. seg = { a, b }.
function cornerSetup(s1, s2, pick1, pick2, eps) {
  const C = intersect(line(s1.a, s1.b), line(s2.a, s2.b), eps)[0];
  if (!C) return null;                                           // parallel
  const far1 = dist$fillet(pick1, s1.a) <= dist$fillet(pick1, s1.b) ? s1.a : s1.b;
  const far2 = dist$fillet(pick2, s2.a) <= dist$fillet(pick2, s2.b) ? s2.a : s2.b;
  const u1 = unit(sub$fillet(far1, C)), u2 = unit(sub$fillet(far2, C));
  if (!u1 || !u2) return null;                                   // a pick end sits on the corner
  const theta = Math.acos(Math.max(-1, Math.min(1, dot$fillet(u1, u2))));
  if (theta < 1e-6 || theta > Math.PI - 1e-6) return null;       // collinear → no corner
  return { C, u1, u2, far1, far2, theta };
}

// The result path keeps each far end, meets the corner pieces at the tangent/bevel points.
const cornerPath = (far1, t1, t2, far2, bulge) => ({ points: [far1, t1, t2, far2], bulges: [0, bulge, 0], closed: false });

function fillet(s1, s2, radius, pick1, pick2, tol) {
  const eps = tolEps(tol);
  const cs = cornerSetup(s1, s2, pick1, pick2, eps);
  if (!cs) return { ok: false, reason: 'no corner' };
  const dT = radius / Math.tan(cs.theta / 2);                    // tangent distance along each ray
  if (dT > dist$fillet(cs.C, cs.far1) + eps || dT > dist$fillet(cs.C, cs.far2) + eps) return { ok: false, reason: 'radius too large' };
  const t1 = add(cs.C, mul(cs.u1, dT)), t2 = add(cs.C, mul(cs.u2, dT));
  const center = add(cs.C, mul(unit(add(cs.u1, cs.u2)), radius / Math.sin(cs.theta / 2)));
  const startA = Math.atan2(t1[1] - center[1], t1[0] - center[0]);
  const endA = Math.atan2(t2[1] - center[1], t2[0] - center[0]);
  const ccw = ((endA - startA) % TAU + TAU) % TAU;
  const sweep = ccw <= Math.PI ? ccw : ccw - TAU;                // the minor arc (the fillet)
  return { ok: true, path: cornerPath(cs.far1, t1, t2, cs.far2, Math.tan(sweep / 4)), tangents: [t1, t2], center, radius };
}

function chamfer(s1, s2, distance, pick1, pick2, tol) {
  const eps = tolEps(tol);
  const cs = cornerSetup(s1, s2, pick1, pick2, eps);
  if (!cs) return { ok: false, reason: 'no corner' };
  if (distance > dist$fillet(cs.C, cs.far1) + eps || distance > dist$fillet(cs.C, cs.far2) + eps) return { ok: false, reason: 'distance too large' };
  const t1 = add(cs.C, mul(cs.u1, distance)), t2 = add(cs.C, mul(cs.u2, distance));
  return { ok: true, path: cornerPath(cs.far1, t1, t2, cs.far2, 0), tangents: [t1, t2] };
}

// ── src/main.js ──

// @gcu/regula — module manifest. The 2D drafting curve-ops layer of the GCU geometry
// stack (the Roman straightedge, sibling to groma's surveyor's cross). It operates on the
// @gcu/dxf bulge-primitive: line + arc are one curve (bulge = 0 is straight), kept
// canonical through every op (offset-of-an-arc is an arc, not a chord fan).
//
// v0.1 ships the `transform` tier (similarity + reflection — zero-dep). The curve-ops
// tiers (intersection → trim/extend → fillet/chamfer → offset), and the @gcu/groma exact
// `orient2d` floor + the threaded `Tolerance` object they need, land as edit work pulls
// them — designed against moncad as the real consumer. See spec_inbox/CAD/SPEC-curves.md.

export {
  translate,
  rotate,
  scale,
  mirror,
  makeTolerance,
  tolEps,
  TAU,
  segment,
  line,
  ray,
  circle,
  arc,
  arcFromBulge,
  bulgeFromArc,
  spanCurve,
  angleInSweep,
  arcPointAt,
  onCurve,
  intersect,
  closestPointOn,
  trim,
  extend,
  fillet,
  chamfer,
};
