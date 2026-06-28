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

// LOCAL polyline points → a WORLD-canonical @gcu/dxf polyline feature: re-add the frame
// origin (local→world) so the stored geometry is canonical. v0: straight spans (bulges
// null); arc spans join the polyline when the Arc keyword lands.
function polylineFeature(localPts, closed, frame) {
  const o = frame.origin, n = localPts.length;
  const vertices = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    vertices[i * 3] = localPts[i][0] + o[0]; vertices[i * 3 + 1] = localPts[i][1] + o[1]; vertices[i * 3 + 2] = o[2] || 0;
  }
  return { type: 'polyline', geometry: { kind: 'polyline', vertices, bulges: null, closed }, properties: { layer: '0' } };
}

// The polyline workhorse: click a start, then successive points; Close rings it, Undo
// drops the last vertex, Enter/finish commits (≥2 points). The line+arc-as-one-primitive
// dxf model means this same tool grows arc spans later without a separate Arc tool.
export function polylineTool({ frame, onCommit, onDone }) {
  const pts = [];   // local points placed so far
  const tool = {
    name: 'polyline',
    get prompt() {
      return pts.length === 0
        ? 'Specify start point:'
        : `Specify next point or [Close/Undo] (${pts.length} pt${pts.length > 1 ? 's' : ''}), Enter to finish:`;
    },
    point(local) { pts.push([local[0], local[1]]); },
    preview(cursor) {
      const lines = [];
      for (let i = 1; i < pts.length; i++) lines.push([pts[i - 1], pts[i]]);
      if (pts.length && cursor) lines.push([pts[pts.length - 1], cursor]);
      return { lines, points: pts.slice() };
    },
    keyword(word) {
      const w = String(word || '').trim().toLowerCase();
      if (w === 'c' || w === 'close') { tool.finish(true); return true; }
      if (w === 'u' || w === 'undo') { pts.pop(); return true; }
      return false;
    },
    finish(closed = false) {
      if (pts.length >= 2) onCommit(polylineFeature(pts, closed, frame));
      onDone();
    },
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

// A single segment: start, then end (auto-finishes). Polyline covers chains; line is the
// quick two-point primitive. Relative input (`@d<a`) keys off the start point.
export function lineTool({ frame, onCommit, onDone }) {
  const pts = [];
  const tool = {
    name: 'line',
    get prompt() { return pts.length === 0 ? 'Specify start point:' : 'Specify end point (or @dx,dy / @d<a):'; },
    point(local) { pts.push([local[0], local[1]]); if (pts.length === 2) tool.finish(); },
    preview(cursor) { return { lines: pts.length && cursor ? [[pts[0], cursor]] : [], points: pts.slice() }; },
    keyword() { return false; },
    finish() { if (pts.length === 2) onCommit(lineFeature(pts[0], pts[1], frame)); onDone(); },
    cancel() { onDone(); },
    last() { return pts.length ? pts[pts.length - 1] : null; },
    count() { return pts.length; },
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
  circle: circleTool,
  point: pointTool,
};
