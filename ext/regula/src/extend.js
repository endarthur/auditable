// @gcu/regula extend — Tier-2's other half (SPEC-curves §2). Lengthen an open path's end
// until it meets a boundary: take the end SPAN's support line, find where it crosses the
// boundaries beyond the free end, and move the end vertex to the nearest such crossing.
//
// v0 extends a STRAIGHT end span (the common case — a line or a polyline's straight tail);
// extending an arc end (growing its sweep) is deferred (returns unchanged). Pure; rides
// intersect.js. Works on the bulge-native path; returns the same shape.

import { line } from './arc.js';
import { intersect } from './intersect.js';
import { tolEps } from './tolerance.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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
  if (endBulge) return { path, extended: false };          // arc-end extend deferred

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
