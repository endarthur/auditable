// @gcu/regula offset — Tier-3, "the can of worms" (SPEC-curves §2/§7a). Offset a path by a
// signed distance (+ = left of the path direction). Bulge-native and analytic: a segment
// offsets to a parallel segment, an arc to a CONCENTRIC arc (radius r ∓ d, same angles, so
// the bulge is unchanged) — never a chord fan. The work is the JOINS: where consecutive
// offset spans meet, a convex corner GAPS (fill with a round arc of radius |d| about the
// original vertex) and a concave corner OVERLAPS (trim both spans to their support
// intersection). Open and closed paths.
//
// v0 deferral (documented, per §7a): no global self-intersection / loop pruning — if |d|
// exceeds the local feature size the naive offset can self-cross. That topological pass is
// clipper2 / straight-skeleton territory, a later slice. Pure; rides arc.js + intersect.js.

import { segment, line, circle, spanCurve, TAU } from './arc.js';
import { intersect } from './intersect.js';
import { tolEps } from './tolerance.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathSpans(path) {
  const pts = path.points, n = pts.length, nspan = path.closed ? n : n - 1, out = [];
  for (let i = 0; i < nspan; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n], b = path.bulges ? (path.bulges[i] || 0) : 0;
    out.push({ p0, p1, curve: spanCurve(p0, p1, b) });
  }
  return out;
}

// Offset one span to {a, b, bulge, arc?{center,r,startAngle,sweep}}.
function offsetSpan(sp, d) {
  const cv = sp.curve;
  if (cv.kind === 'segment') {
    const a = sp.p0, b = sp.p1, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * d, ny = dx / L * d;     // left normal · d
    return { a: [a[0] + nx, a[1] + ny], b: [b[0] + nx, b[1] + ny], bulge: 0 };
  }
  const r = cv.r - Math.sign(cv.sweep) * d;       // left side: toward centre for CCW, away for CW
  const sA = cv.startAngle, eA = cv.startAngle + cv.sweep, c = cv.c;
  return {
    a: [c[0] + r * Math.cos(sA), c[1] + r * Math.sin(sA)], b: [c[0] + r * Math.cos(eA), c[1] + r * Math.sin(eA)],
    bulge: Math.tan(cv.sweep / 4), arc: { center: c, r, startAngle: sA, sweep: cv.sweep },
  };
}

// Unit tangents at the end of one span / the start of the next (for the turn test).
function tangentEnd(sp) {
  const cv = sp.curve;
  if (cv.kind === 'segment') { const dx = sp.p1[0] - sp.p0[0], dy = sp.p1[1] - sp.p0[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; }
  const eA = cv.startAngle + cv.sweep, s = Math.sign(cv.sweep) || 1;
  return [-Math.sin(eA) * s, Math.cos(eA) * s];   // CCW tangent · sweep sign
}
function tangentStart(sp) {
  const cv = sp.curve;
  if (cv.kind === 'segment') { const dx = sp.p1[0] - sp.p0[0], dy = sp.p1[1] - sp.p0[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; }
  const s = Math.sign(cv.sweep) || 1;
  return [-Math.sin(cv.startAngle) * s, Math.cos(cv.startAngle) * s];
}

const supportOf = (o) => (o.arc ? circle(o.arc.center, o.arc.r) : line(o.a, o.b));
// signed angle from→to matching the sign of refSweep (so a trimmed arc keeps its direction)
function sameDir(from, to, refSweep) {
  let d = to - from;
  if (refSweep >= 0) d = ((d % TAU) + TAU) % TAU; else d = ((d % TAU) - TAU) % TAU;
  return d;
}
function setEnd(o, P) {
  o.b = [P[0], P[1]];
  if (o.arc) { const eA = Math.atan2(P[1] - o.arc.center[1], P[0] - o.arc.center[0]); o.arc.sweep = sameDir(o.arc.startAngle, eA, o.arc.sweep); o.bulge = Math.tan(o.arc.sweep / 4); }
}
function setStart(o, P) {
  o.a = [P[0], P[1]];
  if (o.arc) { const sA = Math.atan2(P[1] - o.arc.center[1], P[0] - o.arc.center[0]); const eA = o.arc.startAngle + o.arc.sweep; o.arc.startAngle = sA; o.arc.sweep = sameDir(sA, eA, o.arc.sweep); o.bulge = Math.tan(o.arc.sweep / 4); }
}

export function offset(path, d, tol) {
  const eps = tolEps(tol);
  const spans = pathSpans(path), n = spans.length;
  if (!n || d === 0) return { ok: false, reason: 'empty or zero offset' };
  const off = spans.map((sp) => offsetSpan(sp, d));
  if (off.some((o) => o.arc && o.arc.r <= eps)) return { ok: false, reason: 'offset exceeds an arc radius' };

  const nJoint = path.closed ? n : n - 1;
  const fills = new Array(n).fill(null);     // fills[i] = a fill-arc span to insert after off[i]
  for (let i = 0; i < nJoint; i++) {
    const k = (i + 1) % n, V = spans[i].p1;
    const turn = tangentEnd(spans[i])[0] * tangentStart(spans[k])[1] - tangentEnd(spans[i])[1] * tangentStart(spans[k])[0];
    if (Math.abs(turn) < 1e-9) continue;     // tangent / collinear → endpoints already coincide
    if (turn * Math.sign(d) < 0) {           // convex for the offset side → round fill of radius |d| about V
      const A = off[i].b, B = off[k].a;
      const aA = Math.atan2(A[1] - V[1], A[0] - V[0]), aB = Math.atan2(B[1] - V[1], B[0] - V[0]);
      let sweep = ((aB - aA + Math.PI) % TAU + TAU) % TAU - Math.PI;   // minor signed arc A→B
      fills[i] = { a: A, b: B, bulge: Math.tan(sweep / 4) };
    } else {                                 // concave → trim both to the nearest support crossing
      const cands = intersect(supportOf(off[i]), supportOf(off[k]), eps);
      if (!cands.length) continue;
      let P = cands[0]; for (const c of cands) if (dist(c, V) < dist(P, V)) P = c;
      setEnd(off[i], P); setStart(off[k], P);
    }
  }

  // emit: walk offset spans, inserting fills, into a points + bulges path
  const points = [off[0].a], bulges = [];
  for (let i = 0; i < n; i++) {
    bulges.push(off[i].bulge); points.push(off[i].b);
    if (fills[i]) { bulges.push(fills[i].bulge); points.push(fills[i].b); }
  }
  if (path.closed) {
    points.pop();                            // last point coincides with the first — drop it, ring closes
    return { ok: true, path: { points, bulges, closed: true } };
  }
  return { ok: true, path: { points, bulges: bulges.slice(0, points.length - 1), closed: false } };
}
