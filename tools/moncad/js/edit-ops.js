// moncad edit-ops — the affine edit tools (move / copy / rotate / mirror), built as TOOLS
// so they ride the exact same drive loop as the draw tools (snapped clicks, the command
// line, the rubber-band). An edit tool transforms the SELECTION instead of creating
// geometry, and its rubber-band is a live GHOST of the selection at the in-progress
// transform (SPEC §10 step 6 — the affine slice of the edit long-tail).
//
// Dependency-injected so it stays pure and node-testable: the regula transforms come in as
// `xform`, and `toLocalSegments(geometryWorld) → [[a,b],…]` (the scene tessellation) for
// the ghost. The host (app.js) supplies them; tests inject regula's src directly.
//
// Geometry is WORLD-canonical; picked points are LOCAL. translate's delta is
// frame-invariant (used directly); rotate's pivot and mirror's axis are lifted to world.

export function makeEditTool(deps) {
  const { kind, frame, selectedGeoms, xform, toLocalSegments, onResolve, onDone } = deps;
  const o = frame.origin;
  const toW = (lp) => [lp[0] + o[0], lp[1] + o[1]];
  const pts = [];            // local points collected
  let typedAngle = null;     // rotate: a typed angle (radians) short-circuits the angle pick
  let typedFactor = null;    // scale: a typed factor

  // Resolve transform params from the collected points + an optional cursor (preview).
  function paramsFor(cursor) {
    if (kind === 'move' || kind === 'copy') {
      const base = pts[0], to = cursor || pts[1];
      return base && to ? { op: 'translate', delta: [to[0] - base[0], to[1] - base[1]] } : null;
    }
    if (kind === 'mirror') {
      const a = pts[0], b = cursor || pts[1];
      return a && b ? { op: 'mirror', a: toW(a), b: toW(b) } : null;
    }
    if (kind === 'rotate') {
      const pivot = pts[0]; if (!pivot) return null;
      let ang = typedAngle;
      if (ang == null) { const c = cursor || pts[1]; if (!c) return null; ang = Math.atan2(c[1] - pivot[1], c[0] - pivot[0]); }
      return { op: 'rotate', pivot: toW(pivot), angle: ang };
    }
    if (kind === 'scale') {
      const pivot = pts[0]; if (!pivot || typedFactor == null) return null;   // scale needs a typed factor
      return { op: 'scale', pivot: toW(pivot), factor: typedFactor };
    }
    return null;
  }
  function applyTo(g, p) {
    if (p.op === 'translate') return xform.translate(g, p.delta);
    if (p.op === 'rotate') return xform.rotate(g, p.angle, p.pivot);
    if (p.op === 'mirror') return xform.mirror(g, p.a, p.b);
    if (p.op === 'scale') return xform.scale(g, p.factor, p.pivot);
    return g;
  }
  function commit() {
    const p = paramsFor(null);
    if (!p) { onDone(); return; }
    const built = selectedGeoms.map(({ i, feature }) => ({ i, feature: { ...feature, geometry: applyTo(feature.geometry, p) } }));
    onResolve(kind === 'copy' ? { copy: built.map((b) => b.feature) } : { edit: built });
    onDone();
  }

  const tool = {
    name: kind,
    get prompt() {
      if (kind === 'rotate') return pts.length === 0 ? 'Rotate — pivot point:' : 'Rotation angle (pick a point or type degrees):';
      if (kind === 'scale') return pts.length === 0 ? 'Scale — base point:' : 'Scale factor (type a number):';
      if (kind === 'mirror') return pts.length === 0 ? 'Mirror axis — first point:' : 'Mirror axis — second point:';
      return pts.length === 0 ? `${kind[0].toUpperCase() + kind.slice(1)} — base point:` : 'Destination (point or @dx,dy):';
    },
    point(local) {
      pts.push([local[0], local[1]]);
      if (pts.length === 2) commit();        // move/copy/mirror/rotate-by-point all complete on the 2nd point
    },
    text(raw) {                              // rotate: typed degrees · scale: typed factor
      const n = Number(String(raw).trim());
      if (kind === 'rotate' && pts.length === 1 && Number.isFinite(n)) { typedAngle = n * Math.PI / 180; commit(); return true; }
      if (kind === 'scale' && pts.length === 1 && Number.isFinite(n) && n > 0) { typedFactor = n; commit(); return true; }
      return false;
    },
    preview(cursor) {
      const p = paramsFor(cursor);
      if (!p) return { lines: [], points: pts.slice() };
      const lines = [];
      for (const { feature } of selectedGeoms) for (const s of toLocalSegments(applyTo(feature.geometry, p))) lines.push(s);
      if (pts[0] && cursor) lines.push([pts[0], cursor]);   // the reference leg
      return { lines, points: pts.slice() };
    },
    keyword() { return false; },
    finish() { onDone(); },   // Enter / right-click on an incomplete edit abandons it
    cancel() { onDone(); },
    last() { return pts.length ? pts[pts.length - 1] : null; },
    count() { return pts.length; },
  };
  return tool;
}
