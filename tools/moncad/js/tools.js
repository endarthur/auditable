// moncad tools — drawing tools as small state machines (SPEC §10 step 5).
//
// A tool collects LOCAL points (from snapped clicks now; typed precision input in the next
// slice), reports a rubber-band PREVIEW for the overlay, and on completion builds a
// WORLD-canonical @gcu/dxf feature and hands it to the model. The tool never touches the
// DOM, the renderer, or the model directly — the app feeds it points and a cursor and
// receives { commit, done } callbacks. That keeps tools pure and node-testable, and means
// every tool is identical from the app's point of view (one drive loop, many tools).
//
// Tool contract (what the app calls):
//   prompt              → guided-prompt string for the command line / status
//   point(local)        → a point was picked (already snapped by the app)
//   preview(cursorLocal)→ { lines:[[a,b],…], points:[p,…] } in LOCAL coords (rubber-band)
//   keyword(word)       → a typed/keyed keyword (close/undo/…); true if consumed
//   text?(raw)          → a tool-specific typed scalar (e.g. circle radius); true if consumed
//   finish()            → complete the tool (Enter / double-click)
//   cancel()            → abandon it (Esc)
//   last()              → the last placed local point (for relative precision input)
//
// The app supplies { frame, onCommit(feature), onDone() } at construction.
//
// Dependency-free (the scene.js convention): the trivial local→world offset is inlined
// rather than importing @gcu/frame's toWorld — same as scene.js inlines the inverse — so
// tools.js stays pure and node-testable. The browser bootstrap (app.js) owns the @gcu
// imports.

// LOCAL polyline points + per-span bulges → a WORLD-canonical @gcu/dxf polyline feature.
// bulges[i] is the span from vertex i to i+1; null when every span is straight.
function polylineFeature(localPts, bulges, closed, frame) {
  const o = frame.origin, n = localPts.length;
  const vertices = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    vertices[i * 3] = localPts[i][0] + o[0]; vertices[i * 3 + 1] = localPts[i][1] + o[1]; vertices[i * 3 + 2] = o[2] || 0;
  }
  const bul = bulges && bulges.some((b) => b) ? Float64Array.from(bulges) : null;
  return { type: 'polyline', geometry: { kind: 'polyline', vertices, bulges: bul, closed }, properties: { layer: '0' } };
}

// Small arc helpers, inlined to keep tools.js zero-import (mirrors scene.js's arc math).
const _sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const _unit = (a) => { const m = Math.hypot(a[0], a[1]); return m > 1e-12 ? [a[0] / m, a[1] / m] : [1, 0]; };
const _rot = (v, ang) => { const c = Math.cos(ang), s = Math.sin(ang); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
const _signedAngle = (a, b) => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
// Tangent direction at the END of a span (line → its direction; arc → rotated by half the sweep).
const _spanTangent = (p0, p1, bulge) => { const ch = _unit(_sub(p1, p0)); return bulge ? _rot(ch, 4 * Math.atan(bulge) / 2) : ch; };
// Bulge of the arc tangent to direction T at P0 and ending at P1 (the AutoLISP PLINE-arc rule:
// the tangent makes half the swept angle with the chord, so bulge = tan(angle(T,chord)/2)).
const _tangentBulge = (T, P0, P1) => Math.tan(_signedAngle(T, _unit(_sub(P1, P0))) / 2);
// Sample an arc span into chord points after p0 (preview tessellation).
function _sampleArc(p0, p1, bulge, n = 28) {
  if (!bulge) return [p1];
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], c = Math.hypot(dx, dy);
  if (c === 0) return [p1];
  const theta = 4 * Math.atan(bulge), r = c / 2 / Math.abs(Math.sin(theta / 2));
  const m = c / 2 / Math.tan(theta / 2), nx = -dy / c, ny = dx / c;
  const cx = p0[0] + dx / 2 + nx * m, cy = p0[1] + dy / 2 + ny * m, sa = Math.atan2(p0[1] - cy, p0[0] - cx);
  const out = []; for (let i = 1; i <= n; i++) { const t = sa + theta * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}

// The polyline workhorse: click a start, then successive points. Arc/Line switch the mode
// (arc spans are tangent to the previous segment — the PLINE-arc gesture); Close rings it,
// Undo drops the last vertex, Enter commits (≥2 points). The bulge-native model means arcs
// and lines are the same polyline, no separate entity.
export function polylineTool({ frame, onCommit, onDone }) {
  const pts = [], bulges = [];   // bulges[i] = span i→i+1
  let mode = 'line';
  // the bulge for a span ending at `p` given the current mode (tangent-arc when in arc mode)
  const spanBulge = (p) => {
    if (mode !== 'arc' || pts.length < 1) return 0;
    const k = pts.length - 1, P0 = pts[k];
    const T = pts.length >= 2 ? _spanTangent(pts[k - 1], P0, bulges[k - 1] || 0) : _unit(_sub(p, P0));
    return _tangentBulge(T, P0, p);
  };
  const tool = {
    name: 'polyline',
    get prompt() {
      return pts.length === 0 ? 'Specify start point:'
        : `Next point or [Arc/Line/Close/Undo] — ${mode} (${pts.length} pt${pts.length > 1 ? 's' : ''}), Enter to finish:`;
    },
    point(local) {
      const p = [local[0], local[1]];
      if (pts.length > 0) bulges.push(spanBulge(p));
      pts.push(p);
    },
    preview(cursor) {
      const lines = [];
      const span = (p0, p1, b) => { if (b) { let f = p0; for (const q of _sampleArc(p0, p1, b)) { lines.push([f, q]); f = q; } } else lines.push([p0, p1]); };
      for (let i = 1; i < pts.length; i++) span(pts[i - 1], pts[i], bulges[i - 1] || 0);
      if (pts.length && cursor) span(pts[pts.length - 1], cursor, spanBulge(cursor));   // live leg (arc bends to the cursor)
      return { lines, points: pts.slice() };
    },
    keyword(word) {
      const w = String(word || '').trim().toLowerCase();
      if (w === 'a' || w === 'arc') { mode = 'arc'; return true; }
      if (w === 'l' || w === 'line') { mode = 'line'; return true; }
      if (w === 'c' || w === 'close') { tool.finish(true); return true; }
      if (w === 'u' || w === 'undo') { if (pts.length) { pts.pop(); bulges.pop(); } return true; }
      return false;
    },
    finish(closed = false) {
      if (pts.length >= 2) onCommit(polylineFeature(pts, bulges, closed, frame));
      onDone();
    },
    cancel() { onDone(); },
    last() { return pts.length ? pts[pts.length - 1] : null; },
    count() { return pts.length; },
  };
  return tool;
}

// 3-point arc: the bulge of the arc start→end that passes through `mid` (0 if collinear).
// Circumcentre, then pick the sweep direction that contains the middle point.
function _arc3Bulge(p0, mid, p2) {
  const ax = p0[0], ay = p0[1], bx = mid[0], by = mid[1], cx = p2[0], cy = p2[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return 0;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const TAU = Math.PI * 2;
  const sa = Math.atan2(ay - oy, ax - ox), ea = Math.atan2(cy - oy, cx - ox), ma = Math.atan2(by - oy, bx - ox);
  const ccw = ((ea - sa) % TAU + TAU) % TAU, mo = ((ma - sa) % TAU + TAU) % TAU;
  return Math.tan((mo < ccw ? ccw : ccw - TAU) / 4);   // the sweep that contains the mid point
}
function arcFeature(p0, p2, bulge, frame) {
  const o = frame.origin, z = o[2] || 0;
  const v = Float64Array.from([p0[0] + o[0], p0[1] + o[1], z, p2[0] + o[0], p2[1] + o[1], z]);
  return { type: 'arc', geometry: { kind: 'polyline', vertices: v, bulges: Float64Array.from([bulge]), closed: false }, properties: { layer: '0' } };
}

// Standalone 3-point arc (start, a point ON the arc, end). Emits a single ARC entity.
export function arcTool({ frame, onCommit, onDone }) {
  const pts = [];
  const PROMPTS = ['Specify start point:', 'Specify a point on the arc:', 'Specify end point:'];
  const tool = {
    name: 'arc',
    get prompt() { return PROMPTS[pts.length] || ''; },
    point(local) { pts.push([local[0], local[1]]); if (pts.length === 3) tool.finish(); },
    preview(cursor) {
      const lines = [];
      if (pts.length === 1 && cursor) lines.push([pts[0], cursor]);
      else if (pts.length === 2 && cursor) { let f = pts[0]; for (const q of _sampleArc(pts[0], cursor, _arc3Bulge(pts[0], pts[1], cursor))) { lines.push([f, q]); f = q; } }
      return { lines, points: pts.slice() };
    },
    keyword() { return false; },
    finish() { if (pts.length === 3) onCommit(arcFeature(pts[0], pts[2], _arc3Bulge(pts[0], pts[1], pts[2]), frame)); onDone(); },
    cancel() { onDone(); },
    last() { return pts.length ? pts[pts.length - 1] : null; },
    count() { return pts.length; },
  };
  return tool;
}

// LOCAL endpoints → a WORLD-canonical two-vertex LINE feature.
function lineFeature(a, b, frame) {
  const o = frame.origin, z = o[2] || 0;
  const v = Float64Array.from([a[0] + o[0], a[1] + o[1], z, b[0] + o[0], b[1] + o[1], z]);
  return { type: 'line', geometry: { kind: 'polyline', vertices: v, bulges: null, closed: false }, properties: { layer: '0' } };
}

// A chain of connected segments (CAD LINE): pick a start, then each click commits a
// segment from the previous point and keeps going, until Enter/Esc. Each segment is its
// own line entity (polyline makes them one entity instead). Relative input (`@d<a`) keys
// off the last point.
export function lineTool({ frame, onCommit, onDone }) {
  let prev = null;
  const tool = {
    name: 'line',
    get prompt() { return prev ? 'Next point (Enter to finish), or @dx,dy / @d<a:' : 'Specify start point:'; },
    point(local) {
      const p = [local[0], local[1]];
      if (prev) onCommit(lineFeature(prev, p, frame));   // commit prev→p as its own segment
      prev = p;
    },
    preview(cursor) { return { lines: prev && cursor ? [[prev, cursor]] : [], points: prev ? [prev] : [] }; },
    keyword() { return false; },
    finish() { onDone(); },
    cancel() { onDone(); },
    last() { return prev; },
    count() { return prev ? 1 : 0; },
  };
  return tool;
}

// LOCAL centre + radius → a WORLD-canonical CIRCLE feature (bulge-native model keeps it a
// true circle, not a chord fan — the tessellation is only the rubber-band/render view).
function circleFeature(center, r, frame) {
  const o = frame.origin;
  return { type: 'circle', geometry: { kind: 'circle', center: [center[0] + o[0], center[1] + o[1], o[2] || 0], radius: r }, properties: { layer: '0' } };
}
// Tessellate a provisional circle into local line segments for the overlay rubber-band.
function circleLines(center, r, n = 64) {
  const out = [];
  let prev = [center[0] + r, center[1]];
  for (let i = 1; i <= n; i++) { const t = 2 * Math.PI * i / n; const q = [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)]; out.push([prev, q]); prev = q; }
  return out;
}

// Centre, then a point on the circle (radius = distance) — or type a bare radius (text()).
export function circleTool({ frame, onCommit, onDone }) {
  let center = null;
  const tool = {
    name: 'circle',
    get prompt() { return center == null ? 'Specify centre point:' : 'Specify radius or point on circle:'; },
    point(local) {
      if (center == null) { center = [local[0], local[1]]; return; }
      const r = Math.hypot(local[0] - center[0], local[1] - center[1]);
      if (r > 0) onCommit(circleFeature(center, r, frame));
      onDone();
    },
    text(raw) {
      const n = Number(String(raw).trim());
      if (center != null && Number.isFinite(n) && n > 0) { onCommit(circleFeature(center, n, frame)); onDone(); return true; }
      return false;
    },
    preview(cursor) {
      if (center == null || !cursor) return { lines: [], points: center ? [center] : [] };
      const r = Math.hypot(cursor[0] - center[0], cursor[1] - center[1]);
      return { lines: r > 0 ? circleLines(center, r) : [], points: [center] };
    },
    keyword() { return false; },
    finish() { onDone(); },        // a circle needs both picks; an early finish abandons it
    cancel() { onDone(); },
    last() { return center; },
    count() { return center ? 1 : 0; },
  };
  return tool;
}

function pointFeature(local, frame) {
  const o = frame.origin;
  return { type: 'point', geometry: { kind: 'point', position: [local[0] + o[0], local[1] + o[1], o[2] || 0] }, properties: { layer: '0' } };
}

// Drop nodes, one per pick, until Esc/Enter. Each commit re-derives — the placed nodes
// become snap targets immediately.
export function pointTool({ frame, onCommit, onDone }) {
  const tool = {
    name: 'point',
    get prompt() { return 'Specify point (Esc/Enter to finish):'; },
    point(local) { onCommit(pointFeature(local, frame)); },
    preview(cursor) { return { lines: [], points: cursor ? [cursor] : [] }; },
    keyword() { return false; },
    finish() { onDone(); },
    cancel() { onDone(); },
    last() { return null; },
    count() { return 0; },
  };
  return tool;
}

// Registry of tool factories by name, so the app starts a tool by id (one command →
// one tool start) without a switch.
export const TOOLS = {
  polyline: polylineTool,
  line: lineTool,
  arc: arcTool,
  circle: circleTool,
  point: pointTool,
};
