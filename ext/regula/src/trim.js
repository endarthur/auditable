// @gcu/regula trim — Tier-2 (SPEC-curves §2). Trim = intersection (Tier-1) + parameter
// classification: cut the target where cutters cross it, then drop the one interval the
// pick falls in. The rest reassembles into one or two paths (a middle cut splits an open
// path in two; trimming a ring opens it).
//
// Works on the bulge-native path { points:[[x,y],…], bulges:[…]|null, closed } and emits
// the same shape — arcs stay arcs (a trimmed arc span gets a recomputed bulge, never a
// chord fan). Pure; rides arc.js / intersect.js / nearest.js. A whole-polyline parametrise
// (span index + local fraction) is the global coordinate everything sorts by.

import { spanCurve } from './arc.js';
import { intersect } from './intersect.js';
import { closestPointOn } from './nearest.js';
import { tolEps } from './tolerance.js';

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
export function trim(path, cutters, pickPoint, tol) {
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
    return { kept, removed: true, removedPath: subPath(spans, lo, hi) };
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
  return { kept: [subPath(spans, hi, lo + nspan)], removed: true, removedPath: subPath(spans, lo, hi) };
}
