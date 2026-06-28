// @gcu/regula nearest — closest point on a curve to a query point (SPEC-curves §2). The
// companion to intersection: trim picks the interval to keep by the param of the click,
// snapping wants the nearest point on a curve, extend measures to a boundary. Returns
// { point, dist, param } where param is 0..1 along the curve (the arc fraction of sweep,
// the segment fraction; unclamped for an infinite line).
//
// Pure, zero-dep.

import { angleInSweep, arcPointAt } from './arc.js';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function onCircle(c, r, p) {
  const dx = p[0] - c[0], dy = p[1] - c[1], m = Math.hypot(dx, dy) || 1;
  return [c[0] + r * dx / m, c[1] + r * dy / m];
}

export function closestPointOn(cv, p) {
  if (cv.kind === 'circle') { const pt = onCircle(cv.c, cv.r, p); return { point: pt, dist: dist(pt, p), param: ((Math.atan2(pt[1] - cv.c[1], pt[0] - cv.c[0])) ) }; }
  if (cv.kind === 'arc') {
    const ang = Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]);
    if (angleInSweep(cv.startAngle, cv.sweep, ang)) {
      const pt = onCircle(cv.c, cv.r, p);
      let f = (ang - cv.startAngle) / cv.sweep;            // fraction of sweep
      f = clamp01(f);
      return { point: pt, dist: dist(pt, p), param: f };
    }
    const e0 = arcPointAt(cv, 0), e1 = arcPointAt(cv, 1);   // outside the sweep → nearer endpoint
    return dist(e0, p) <= dist(e1, p) ? { point: e0, dist: dist(e0, p), param: 0 } : { point: e1, dist: dist(e1, p), param: 1 };
  }
  // linear (segment / line / ray)
  const a = cv.a, b = cv.b, d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] * d[0] + d[1] * d[1];
  let t = l2 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2 : 0;
  if (cv.kind === 'segment') t = clamp01(t);
  else if (cv.kind === 'ray') t = t < 0 ? 0 : t;
  const pt = [a[0] + t * d[0], a[1] + t * d[1]];
  return { point: pt, dist: dist(pt, p), param: t };
}
