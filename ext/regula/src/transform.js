// @gcu/regula transform — rigid + similarity transforms of the bulge-primitive.
//
// Operates on the @gcu/dxf geometry shape (polyline {kind,vertices,bulges,closed} /
// circle {kind,center,radius} / point {kind,position}) and returns a NEW geometry —
// never mutates the input. The correctness-critical subtlety is the bulge under each map:
//
//   translate / rotate / uniform-scale  → bulge UNCHANGED  (a similarity preserves arc shape)
//   mirror (reflection)                  → bulge NEGATED   (orientation reverses)
//
// Non-uniform scale would turn a circle into an ellipse — not representable as a bulge —
// so it is deliberately absent. These are exactly the transforms that keep the canonical
// model valid; anything that wouldn't is not offered rather than offered and lossy.
//
// Pure, zero-dep, node-testable. Frame-agnostic: points are LOCAL coordinates (the host
// owns world↔local). Z is carried through untouched (2D transforms, in plan).

// Apply a 2D point map `fn(x,y)->[x,y]` to any supported geometry, with bulge/radius
// handling, returning fresh geometry. `flipBulge` for reflections; `radiusScale` for scale.
function transformGeom(g, fn, { flipBulge = false, radiusScale = 1 } = {}) {
  if (!g || !g.kind) return g;
  if (g.kind === 'polyline') {
    const v = g.vertices, out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i += 3) { const p = fn(v[i], v[i + 1]); out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = v[i + 2]; }
    const bulges = g.bulges ? Float64Array.from(g.bulges, (b) => (flipBulge ? -b : b)) : null;
    return { kind: 'polyline', vertices: out, bulges, closed: g.closed };
  }
  if (g.kind === 'circle') { const c = fn(g.center[0], g.center[1]); return { kind: 'circle', center: [c[0], c[1], g.center[2] || 0], radius: g.radius * radiusScale }; }
  if (g.kind === 'point') { const p = fn(g.position[0], g.position[1]); return { kind: 'point', position: [p[0], p[1], g.position[2] || 0] }; }
  if (g.kind === 'text') { const p = fn(g.position[0], g.position[1]); return { ...g, position: [p[0], p[1], g.position[2] || 0] }; }   // moves the insertion point (stays upright in v0)
  return g;   // face / insert etc. — untouched in v0 (no 2D-plan transform defined)
}

// Move by a displacement [dx, dy].
export function translate(g, [dx, dy]) {
  return transformGeom(g, (x, y) => [x + dx, y + dy]);
}

// Rotate by `angle` (radians, CCW) about `pivot` (local). Bulge unchanged.
export function rotate(g, angle, pivot = [0, 0]) {
  const c = Math.cos(angle), s = Math.sin(angle), px = pivot[0], py = pivot[1];
  return transformGeom(g, (x, y) => { const dx = x - px, dy = y - py; return [px + dx * c - dy * s, py + dx * s + dy * c]; });
}

// Uniform scale by `factor` about `pivot`. Radius scales by |factor|; a negative factor is
// a point-reflection (= 180° rotation), which preserves orientation, so bulge is unchanged.
export function scale(g, factor, pivot = [0, 0]) {
  const px = pivot[0], py = pivot[1];
  return transformGeom(g, (x, y) => [px + (x - px) * factor, py + (y - py) * factor], { radiusScale: Math.abs(factor) });
}

// Reflect across the line through points `a` and `b` (local). Bulge negated.
export function mirror(g, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const fn = (x, y) => {
    if (len2 === 0) return [x, y];                              // degenerate axis → identity
    const t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;       // param of the foot on the line
    const fx = a[0] + t * dx, fy = a[1] + t * dy;
    return [2 * fx - x, 2 * fy - y];                            // reflect through the foot
  };
  return transformGeom(g, fn, { flipBulge: true });
}
