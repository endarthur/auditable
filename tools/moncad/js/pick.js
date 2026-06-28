// moncad pick — entity hit-testing for selection. Pure: no DOM/WebGL.
//
// Picking is a spatial query, like snapping (SPEC §6) — but over entity BODIES, not snap
// points. v0 is a brute-force scan over features (fine at drafting sizes); the snap grid
// can accelerate it later. Operates in WORLD coordinates (features are world-canonical);
// the host converts the local cursor → world and passes a world tolerance. Arc spans are
// hit-tested by their chord here — close enough for an 8px aperture; the analytic arc
// distance can sharpen it when regula's curve kernel lands.

import { placeInstance } from './scene.js';

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance from world point p to a feature's geometry (Infinity if not hittable). For an
// INSERT, resolve its block (via `blocks`) and measure the nearest placed sub-entity — so an
// instance picks anywhere on its body, as one unit. Falls to the insertion point if unresolved.
export function featureDist(f, p, blocks) {
  const g = f.geometry; if (!g) return Infinity;
  if (g.kind === 'insert') {
    const blk = blocks && blocks[g.block];
    if (!blk) return Math.hypot(p[0] - g.transform.position[0], p[1] - g.transform.position[1]);
    let d = Infinity;
    for (const bf of blk.features) d = Math.min(d, featureDist({ geometry: placeInstance(bf.geometry, g.transform, blk.base) }, p, blocks));
    return d;
  }
  if (g.kind === 'polyline') {
    const v = g.vertices, n = v.length / 3;
    if (n < 1) return Infinity;
    if (n === 1) return Math.hypot(p[0] - v[0], p[1] - v[1]);
    let d = Infinity;
    const spans = g.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) { const a = i, b = (i + 1) % n; d = Math.min(d, segDist(p[0], p[1], v[a * 3], v[a * 3 + 1], v[b * 3], v[b * 3 + 1])); }
    return d;
  }
  if (g.kind === 'circle') return Math.abs(Math.hypot(p[0] - g.center[0], p[1] - g.center[1]) - g.radius);
  if (g.kind === 'point' || g.kind === 'text' || g.kind === 'attdef') return Math.hypot(p[0] - g.position[0], p[1] - g.position[1]);
  return Infinity;
}

// Nearest feature index to world point p within tol, or -1. `skip(feature)` (optional)
// excludes features — used to make hidden-layer geometry unpickable.
export function pickFeature(features, p, tol, skip, blocks) {
  let best = -1, bd = tol;
  for (let i = 0; i < features.length; i++) { if (skip && skip(features[i])) continue; const d = featureDist(features[i], p, blocks); if (d <= bd) { bd = d; best = i; } }
  return best;
}

// World bounding box of a feature [minx,miny,maxx,maxy], or null.
export function featureBounds(f, blocks) {
  const g = f.geometry; if (!g) return null;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const ext = (x, y) => { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; };
  if (g.kind === 'polyline') { const v = g.vertices; for (let i = 0; i < v.length; i += 3) ext(v[i], v[i + 1]); }
  else if (g.kind === 'circle') { ext(g.center[0] - g.radius, g.center[1] - g.radius); ext(g.center[0] + g.radius, g.center[1] + g.radius); }
  else if (g.kind === 'point' || g.kind === 'text' || g.kind === 'attdef') ext(g.position[0], g.position[1]);
  else if (g.kind === 'insert') {
    const blk = blocks && blocks[g.block]; if (!blk) { ext(g.transform.position[0], g.transform.position[1]); return [minx, miny, maxx, maxy]; }
    for (const bf of blk.features) { const bb = featureBounds({ geometry: placeInstance(bf.geometry, g.transform, blk.base) }, blocks); if (bb) { ext(bb[0], bb[1]); ext(bb[2], bb[3]); } }
  }
  else return null;
  return minx === Infinity ? null : [minx, miny, maxx, maxy];
}

// Does a segment intersect the axis-aligned box (endpoints-inside counts)? Liang-Barsky.
function segHitsBox(x0, y0, x1, y1, box) {
  let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
  const clip = (p, q) => { if (p === 0) return q >= 0; const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; };
  return clip(-dx, x0 - box[0]) && clip(dx, box[2] - x0) && clip(-dy, y0 - box[1]) && clip(dy, box[3] - y0) && t0 <= t1;
}
// Does the feature's ACTUAL geometry intersect the box (for crossing select)? Distinct from
// bbox overlap — a box sitting inside a big rectangle's interior touches no edge → false.
function featureCrossesBox(f, box, blocks) {
  const g = f.geometry; if (!g) return false;
  if (g.kind === 'polyline') {
    const v = g.vertices, n = v.length / 3, spans = g.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) { const j = (i + 1) % n; if (segHitsBox(v[i * 3], v[i * 3 + 1], v[j * 3], v[j * 3 + 1], box)) return true; }
    return false;
  }
  if (g.kind === 'circle') {                                  // ring passes through the box: nearest box point ≤ r ≤ farthest box corner
    const cx = g.center[0], cy = g.center[1], r = g.radius;
    const nx = Math.max(box[0], Math.min(cx, box[2])), ny = Math.max(box[1], Math.min(cy, box[3]));
    const dNear = Math.hypot(cx - nx, cy - ny);
    const dFar = Math.max(Math.hypot(cx - box[0], cy - box[1]), Math.hypot(cx - box[2], cy - box[1]), Math.hypot(cx - box[2], cy - box[3]), Math.hypot(cx - box[0], cy - box[3]));
    return dNear <= r && r <= dFar;
  }
  if (g.kind === 'point' || g.kind === 'text' || g.kind === 'attdef') { const p = g.position; return p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3]; }
  if (g.kind === 'insert') {
    const blk = blocks && blocks[g.block]; if (!blk) { const p = g.transform.position; return p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3]; }
    for (const bf of blk.features) if (featureCrossesBox({ geometry: placeInstance(bf.geometry, g.transform, blk.base) }, box, blocks)) return true;
    return false;
  }
  return false;
}
// Box-select over the world box [minx,miny,maxx,maxy]. `crossing` (drag right→left) selects
// anything the box ENCLOSES or its geometry TOUCHES; otherwise (window, drag left→right) only
// fully-enclosed features. Enclosure uses the bbox (inside the box ⇒ the whole feature is).
export function pickWindow(features, box, blocks, skip, crossing) {
  const out = [];
  for (let i = 0; i < features.length; i++) {
    if (skip && skip(features[i])) continue;
    const bb = featureBounds(features[i], blocks); if (!bb) continue;
    const enclosed = bb[0] >= box[0] && bb[2] <= box[2] && bb[1] >= box[1] && bb[3] <= box[3];
    if (enclosed || (crossing && featureCrossesBox(features[i], box, blocks))) out.push(i);
  }
  return out;
}
