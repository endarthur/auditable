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

// Registry of tool factories by id, so the app starts a tool by name (one command →
// one tool start) without a switch. Grows with line/circle/point in the next slice.
export const TOOLS = {
  polyline: polylineTool,
};
