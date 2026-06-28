// @gcu/regula fillet / chamfer — Tier-3 construction ops (SPEC-curves §2). Round (fillet)
// or bevel (chamfer) the corner between two line segments. Both reduce to the same corner
// setup: the segments' supports meet at C; the user's two picks choose which end of each
// to KEEP (nearest the pick); the kept rays define the corner angle. Fillet drops a
// tangent arc of radius r; chamfer drops a straight bevel at distance d along each.
//
// Bulge-native: the fillet inserts a TRUE tangent arc (a real bulge span), not a chord
// fan. v0 operates on straight segments (the common "fillet two lines"); a polyline-corner
// fillet rides the same math when the host extracts the two spans. Pure; rides intersect.js.

import { line, TAU } from './arc.js';
import { intersect } from './intersect.js';
import { tolEps } from './tolerance.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (v) => { const m = Math.hypot(v[0], v[1]); return m > 1e-12 ? [v[0] / m, v[1] / m] : null; };

// Shared corner: supports meet at C; the kept end of each segment is the one nearest its
// pick; u1/u2 are the unit rays from C toward the kept ends. Null if parallel/collinear/
// degenerate. seg = { a, b }.
function cornerSetup(s1, s2, pick1, pick2, eps) {
  const C = intersect(line(s1.a, s1.b), line(s2.a, s2.b), eps)[0];
  if (!C) return null;                                           // parallel
  const far1 = dist(pick1, s1.a) <= dist(pick1, s1.b) ? s1.a : s1.b;
  const far2 = dist(pick2, s2.a) <= dist(pick2, s2.b) ? s2.a : s2.b;
  const u1 = unit(sub(far1, C)), u2 = unit(sub(far2, C));
  if (!u1 || !u2) return null;                                   // a pick end sits on the corner
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-6 || theta > Math.PI - 1e-6) return null;       // collinear → no corner
  return { C, u1, u2, far1, far2, theta };
}

// The result path keeps each far end, meets the corner pieces at the tangent/bevel points.
const cornerPath = (far1, t1, t2, far2, bulge) => ({ points: [far1, t1, t2, far2], bulges: [0, bulge, 0], closed: false });

export function fillet(s1, s2, radius, pick1, pick2, tol) {
  const eps = tolEps(tol);
  const cs = cornerSetup(s1, s2, pick1, pick2, eps);
  if (!cs) return { ok: false, reason: 'no corner' };
  const dT = radius / Math.tan(cs.theta / 2);                    // tangent distance along each ray
  if (dT > dist(cs.C, cs.far1) + eps || dT > dist(cs.C, cs.far2) + eps) return { ok: false, reason: 'radius too large' };
  const t1 = add(cs.C, mul(cs.u1, dT)), t2 = add(cs.C, mul(cs.u2, dT));
  const center = add(cs.C, mul(unit(add(cs.u1, cs.u2)), radius / Math.sin(cs.theta / 2)));
  const startA = Math.atan2(t1[1] - center[1], t1[0] - center[0]);
  const endA = Math.atan2(t2[1] - center[1], t2[0] - center[0]);
  const ccw = ((endA - startA) % TAU + TAU) % TAU;
  const sweep = ccw <= Math.PI ? ccw : ccw - TAU;                // the minor arc (the fillet)
  return { ok: true, path: cornerPath(cs.far1, t1, t2, cs.far2, Math.tan(sweep / 4)), tangents: [t1, t2], center, radius };
}

export function chamfer(s1, s2, distance, pick1, pick2, tol) {
  const eps = tolEps(tol);
  const cs = cornerSetup(s1, s2, pick1, pick2, eps);
  if (!cs) return { ok: false, reason: 'no corner' };
  if (distance > dist(cs.C, cs.far1) + eps || distance > dist(cs.C, cs.far2) + eps) return { ok: false, reason: 'distance too large' };
  const t1 = add(cs.C, mul(cs.u1, distance)), t2 = add(cs.C, mul(cs.u2, distance));
  return { ok: true, path: cornerPath(cs.far1, t1, t2, cs.far2, 0), tangents: [t1, t2] };
}

// ── corner ops on a single polyline (round/bevel vertex `vi` in place) ────────────

// The corner at vertex vi: its two adjacent spans must be straight; returns the rays toward
// the neighbours (with wrap for a closed path). Null if vi is an open endpoint, a span is
// curved, or the corner is collinear/degenerate.
function polyCorner(path, vi) {
  const pts = path.points, n = pts.length;
  if (!path.closed && (vi <= 0 || vi >= n - 1)) return null;
  const pi = ((vi - 1) % n + n) % n, C = pts[vi], pv = pts[pi], nv = pts[(vi + 1) % n];
  const bPrev = path.bulges ? (path.bulges[pi] || 0) : 0, bNext = path.bulges ? (path.bulges[vi] || 0) : 0;
  if (bPrev || bNext) return null;
  const u1 = unit(sub(pv, C)), u2 = unit(sub(nv, C));
  if (!u1 || !u2) return null;
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-6 || theta > Math.PI - 1e-6) return null;
  return { C, pv, nv, u1, u2, theta };
}
// Replace vertex vi with [t1, t2], the new t1→t2 span carrying `bulge` (arc) or 0 (bevel).
function spliceCorner(path, vi, t1, t2, bulge) {
  const points = path.points.map((p) => p.slice());
  const bulges = path.bulges ? path.bulges.slice() : new Array(path.closed ? path.points.length : path.points.length - 1).fill(0);
  points.splice(vi, 1, t1, t2);
  bulges.splice(vi, 0, bulge);
  return { ...path, points, bulges };
}
export function filletCorner(path, vi, radius, tol) {
  const eps = tolEps(tol), cn = polyCorner(path, vi);
  if (!cn) return { ok: false, reason: 'not a straight corner' };
  const dT = radius / Math.tan(cn.theta / 2);
  if (dT > dist(cn.C, cn.pv) + eps || dT > dist(cn.C, cn.nv) + eps) return { ok: false, reason: 'radius too large' };
  const t1 = add(cn.C, mul(cn.u1, dT)), t2 = add(cn.C, mul(cn.u2, dT));
  const center = add(cn.C, mul(unit(add(cn.u1, cn.u2)), radius / Math.sin(cn.theta / 2)));
  const sA = Math.atan2(t1[1] - center[1], t1[0] - center[0]), eA = Math.atan2(t2[1] - center[1], t2[0] - center[0]);
  const ccw = ((eA - sA) % TAU + TAU) % TAU, sweep = ccw <= Math.PI ? ccw : ccw - TAU;
  return { ok: true, path: spliceCorner(path, vi, t1, t2, Math.tan(sweep / 4)), tangents: [t1, t2], center, radius };
}
export function chamferCorner(path, vi, distance, tol) {
  const eps = tolEps(tol), cn = polyCorner(path, vi);
  if (!cn) return { ok: false, reason: 'not a straight corner' };
  if (distance > dist(cn.C, cn.pv) + eps || distance > dist(cn.C, cn.nv) + eps) return { ok: false, reason: 'distance too large' };
  return { ok: true, path: spliceCorner(path, vi, add(cn.C, mul(cn.u1, distance)), add(cn.C, mul(cn.u2, distance)), 0) };
}
