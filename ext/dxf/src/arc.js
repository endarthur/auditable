// Bulge ↔ arc conversions — the heart of the one-curve-type throughline.
//
// An arc span is stored as endpoint + bulge: `bulge = tan(θ/4)`, where θ is the signed
// swept angle (+ = CCW). center / radius / angles are DERIVED here, never stored — a
// gentle arc has a huge, far-flung center, which would drag the large-coordinate problem
// (@gcu/frame) back in, and stored endpoints are what let adjacent spans meet watertight
// (SPEC-curves §1). A straight span is just `bulge = 0`, so lines and arcs are the same
// primitive. All angles here are RADIANS; the DXF degree boundary converts in read/write.

export const TAU = Math.PI * 2;

// Endpoint + bulge → derived { center, radius, startAngle, endAngle, sweep, ccw }.
// Returns null for a straight (bulge 0) or degenerate (coincident endpoints) span —
// callers treat those as line segments.
export function arcFromBulge(p0, p1, bulge) {
  if (!bulge) return null;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const c = Math.hypot(dx, dy);
  if (c === 0) return null;
  const theta = 4 * Math.atan(bulge);              // signed swept angle
  const half = c / 2;
  const r = half / Math.abs(Math.sin(theta / 2));
  const m = half / Math.tan(theta / 2);            // signed offset from chord-mid along left normal
  const nx = -dy / c, ny = dx / c;                 // unit left normal of p0→p1
  const cx = p0[0] + dx / 2 + nx * m;
  const cy = p0[1] + dy / 2 + ny * m;
  return {
    center: [cx, cy],
    radius: r,
    startAngle: Math.atan2(p0[1] - cy, p0[0] - cx),
    endAngle: Math.atan2(p1[1] - cy, p1[0] - cx),
    sweep: theta,
    ccw: bulge > 0,
  };
}

// Center-form arc (a DXF ARC: CCW from start to end, angles in RADIANS) → endpoint +
// bulge canonical form `{ start, end, bulge }`. The inverse of `arcFromBulge` for a CCW
// arc — this is how an ARC entity enters the bulge-native model losslessly.
export function bulgeFromArc(center, radius, startAngle, endAngle) {
  let theta = ((endAngle - startAngle) % TAU + TAU) % TAU;   // normalize CCW sweep into (0, TAU]
  if (theta === 0) theta = TAU;
  const [cx, cy] = center;
  return {
    start: [cx + radius * Math.cos(startAngle), cy + radius * Math.sin(startAngle)],
    end: [cx + radius * Math.cos(endAngle), cy + radius * Math.sin(endAngle)],
    bulge: Math.tan(theta / 4),
  };
}

// The point at the middle of an arc span — on the arc, not on the chord (snapping,
// labels, midpoint object snap). Falls back to the chord midpoint for a straight span.
export function arcMidpoint(p0, p1, bulge) {
  const a = arcFromBulge(p0, p1, bulge);
  if (!a) return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const mid = a.startAngle + a.sweep / 2;
  return [a.center[0] + a.radius * Math.cos(mid), a.center[1] + a.radius * Math.sin(mid)];
}
