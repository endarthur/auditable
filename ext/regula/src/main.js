// @gcu/regula — module manifest. The 2D drafting curve-ops layer of the GCU geometry
// stack (the Roman straightedge, sibling to groma's surveyor's cross). It operates on the
// @gcu/dxf bulge-primitive: line + arc are one curve (bulge = 0 is straight), kept
// canonical through every op (offset-of-an-arc is an arc, not a chord fan).
//
// v0.1 ships the `transform` tier (similarity + reflection — zero-dep). The curve-ops
// tiers (intersection → trim/extend → fillet/chamfer → offset), and the @gcu/groma exact
// `orient2d` floor + the threaded `Tolerance` object they need, land as edit work pulls
// them — designed against moncad as the real consumer. See spec_inbox/CAD/SPEC-curves.md.

export * from './transform.js';
export * from './tolerance.js';
export * from './arc.js';
export * from './intersect.js';
export * from './nearest.js';
export * from './trim.js';
export * from './extend.js';
export * from './fillet.js';
