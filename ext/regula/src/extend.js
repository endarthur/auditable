// @gcu/regula extend — Tier-2's other half (SPEC-curves §2). Lengthen an open path's end
// until it meets a boundary: take the end SPAN's support line, find where it crosses the
// boundaries beyond the free end, and move the end vertex to the nearest such crossing.
//
// v0 extends a STRAIGHT end span (the common case — a line or a polyline's straight tail);
// extending an arc end (growing its sweep) is deferred (returns unchanged). Pure; rides
// intersect.js. Works on the bulge-native path; returns the same shape.

import { line, circle, arcFromBulge, TAU } from './arc.js';
import { intersect } from './intersect.js';
import { tolEps } from './tolerance.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Extend a CURVED end span: grow the arc's sweep until its moving end meets a boundary.
// The support circle ∩ boundaries gives candidate angles; keep the nearest one FORWARD of
// the moving end (in the grow direction), move that vertex there, recompute the bulge.
function extendArcEnd(path, boundaries, atEnd, eps) {
  const pts = path.points, n = pts.length;
  const i0 = atEnd ? n - 2 : 0, i1 = atEnd ? n - 1 : 1, mv = atEnd ? i1 : i0;   // span i0→i1; mv = moving vertex
  const arc = arcFromBulge(pts[i0], pts[i1], path.bulges[atEnd ? n - 2 : 0]);
  if (!arc) return { path, extended: false };
  const c = arc.center, r = arc.radius;
  const movingAngle = atEnd ? arc.endAngle : arc.startAngle;
  const grow = atEnd ? Math.sign(arc.sweep) : -Math.sign(arc.sweep);    // direction the moving end advances
  let best = null, bestD = Infinity;
  for (const bd of boundaries) for (const ip of intersect(circle(c, r), bd, eps)) {
    const theta = Math.atan2(ip[1] - c[1], ip[0] - c[0]);
    const d = (((theta - movingAngle) * grow) % TAU + TAU) % TAU;       // forward angular gap (0, 2π)
    if (d > eps / r && d < bestD) { bestD = d; best = ip; }
  }
  if (!best) return { path, extended: false };
  const newSweep = (Math.abs(arc.sweep) + bestD) * Math.sign(arc.sweep);
  const points = pts.map((p) => p.slice()), bulges = path.bulges.slice();
  const oldMv = points[mv].slice();
  points[mv] = [best[0], best[1]];
  bulges[atEnd ? n - 2 : 0] = Math.tan(newSweep / 4);
  return { path: { ...path, points, bulges }, extended: true, reach: [oldMv, best.slice()] };
}

// Extend `path` to the nearest forward crossing with any of `boundaries` (kernel curves),
// choosing the end nearest `pickPoint`. Returns { path, extended:bool }.
export function extend(path, boundaries, pickPoint, tol) {
  const eps = tolEps(tol);
  const pts = path.points, n = pts.length;
  if (path.closed || n < 2) return { path, extended: false };

  const atEnd = dist(pickPoint, pts[n - 1]) <= dist(pickPoint, pts[0]);
  const a = atEnd ? pts[n - 2] : pts[1];   // interior neighbour
  const b = atEnd ? pts[n - 1] : pts[0];   // the free end being moved
  const endBulge = path.bulges ? (atEnd ? path.bulges[n - 2] : path.bulges[0]) : 0;
  if (endBulge) return extendArcEnd(path, boundaries, atEnd, eps);   // curved end → grow the sweep

  const d = sub(b, a), l2 = dot(d, d);
  if (l2 === 0) return { path, extended: false };
  const te = eps / Math.sqrt(l2);
  let best = null, bestT = Infinity;
  for (const bd of boundaries) for (const ip of intersect(line(a, b), bd, eps)) {
    const t = dot(sub(ip, a), d) / l2;
    if (t > 1 + te && t < bestT) { bestT = t; best = ip; }   // strictly beyond the free end, nearest
  }
  if (!best) return { path, extended: false };

  const points = pts.map((p) => p.slice());
  points[atEnd ? n - 1 : 0] = [best[0], best[1]];
  return { path: { ...path, points }, extended: true, reach: [b.slice(), [best[0], best[1]]] };   // the added stretch (old end → boundary)
}
