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

import { angleInSweep } from './arc.js';
import { tolEps } from './tolerance.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

// Parameter of p's projection onto the infinite line a→b (0 at a, 1 at b).
function paramOnLine(a, b, p) {
  const d = sub(b, a), l2 = d[0] * d[0] + d[1] * d[1];
  return l2 ? dot(sub(p, a), d) / l2 : 0;
}

function support(cv) {
  if (cv.kind === 'circle' || cv.kind === 'arc') return { type: 'circle', c: cv.c, r: cv.r };
  return { type: 'line', a: cv.a, b: cv.b };
}

// Is a support point actually on this finite curve? (The point is already ON the support
// by construction, so this is purely the range/angle test, with eps slack.)
export function onCurve(cv, p, eps) {
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
  const d1 = sub(a1, a0), d2 = sub(b1, b0);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) <= 1e-12 * Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1])) return [];   // parallel (angular tol)
  const t = ((b0[0] - a0[0]) * d2[1] - (b0[1] - a0[1]) * d2[0]) / den;
  return [[a0[0] + t * d1[0], a0[1] + t * d1[1]]];
}

// Infinite line (through p0,p1) ∩ circle → 0, 1 (tangent) or 2 points.
function lineCircle(p0, p1, c, r, eps) {
  const d = sub(p1, p0), f = sub(p0, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
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
export function intersect(A, B, tol) {
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
