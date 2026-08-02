// @gcu/groma — the robust-geometry base of the GCU stack.
//
// Named for the Roman surveyor's cross-staff, alongside regula (drafting
// geometry) and libella (elevation). What lives here is the geometry every
// other package kept re-implementing:
//
//   BVH        build + ray queries — one copy, instead of one per consumer
//   topology   CSR vertex->vertex and vertex->face adjacency for triangle meshes
//
// Consumers: @gcu/winding (generalized winding number ON groma), @gcu/facet
// (structural geology ON groma), micro. @gcu/peel still carries its own BVH;
// folding it in is the follow-up, once this API has two real consumers proving
// its shape rather than one speculative one.
//
// Zero dependencies. Everything is plain typed arrays — no classes to
// serialize, so a BVH or an adjacency crosses a worker boundary by transfer.

export { buildBVH, NODE_SIZE, triArea2 } from './bvh.js';
export { raycastBVH } from './ray.js';
export { buildAdjacency, neighbors, incidentFaces, degree, components } from './topology.js';
