// @gcu/regula tolerance — the load-bearing decision (SPEC-curves §3): predicates are
// exact, constructions are not. A line·arc intersection or a fillet tangent is a
// constructed, generally irrational coordinate, so coincidence / on-curve / parallel
// tests need ONE explicit, documented tolerance policy — not scattered epsilons.
//
// Tolerance is COORDINATE-RELATIVE, scaled to the working extent — never a fixed absolute
// epsilon. At UTM magnitudes a fixed 1e-9 is meaningless (the same failure class as the
// silent-shift bug); regula always runs in the small local frame, but the tolerance still
// derives from the data's extent so it travels correctly. One Tolerance object threads
// through the API.

// Build a Tolerance for a working `extent` (e.g. the drawing bbox diagonal, in the working
// frame's units). `eps` is the distance below which two coordinates are "the same".
export function makeTolerance(extent, { rel = 1e-7 } = {}) {
  const e = Math.abs(extent) || 1;
  return { eps: rel * e, rel, extent: e };
}

// Coerce a tolerance argument to an eps distance: a Tolerance object, a bare number (eps),
// or — as a documented floor when a caller hasn't supplied one — a small relative default.
export function tolEps(tol) {
  if (typeof tol === 'number') return tol;
  if (tol && typeof tol.eps === 'number') return tol.eps;
  return 1e-7;   // drafting floor at local magnitudes; callers SHOULD pass makeTolerance(extent)
}
