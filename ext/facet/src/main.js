// @gcu/facet — structural geology on a triangulated surface.
//
// Given an outcrop mesh, facet turns what a geologist points at into measured
// attitudes: paint a patch, fit a plane to it, read its dip and dip direction,
// digitize traces along the surface, and classify the fracture network they form.
//
//   fit.js        plane fitting by PCA of vertex positions, and the ONE place a
//                 normal becomes a dip/dip-direction
//   brush.js      the painting brush — a view-ray cylinder intersected with a
//                 walk of the surface, so paint spreads and stops like paint
//   geodesic.js   shortest paths along the mesh (Dijkstra, binary heap)
//   network.js    I/Y/X node classification and fracture connectivity
//   sets.js       reading plane sets back out of painted vertex colors
//
// Mesh topology is NOT here. `buildAdjacency` and `components` are @gcu/groma's,
// re-exported below so a consumer needs one import rather than two, but there is
// exactly one implementation and it lives in groma. Attitude conversion and the
// eigensolver are @gcu/bearing's, for the same reason.
//
// Coordinates are **x = East, y = North, z = Up**, in metres — micro's world
// basis, and bearing's direction-cosine basis. Everything here assumes that one
// convention and converts at a single boundary (`attitude`), which is the fix for
// the original's five hand-rolled and mutually disagreeing conversions.

export { attitude, normalOf, fitTensor, fitPlane, vertexAreaWeights } from './fit.js';
export { brush, distanceToRay } from './brush.js';
export { geodesic, geodesicField, geodesicBall } from './geodesic.js';
export { nodeClasses } from './network.js';
export { detectSets } from './sets.js';

// re-exported from @gcu/groma — mesh topology has one home, and this is not it
export { buildAdjacency, neighbors, incidentFaces, degree, components } from '../../groma/src/topology.js';
