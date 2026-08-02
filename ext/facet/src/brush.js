// @gcu/facet — the painting brush.
//
// A brush stroke is the intersection of two conditions:
//
//   geometric    the vertex lies within `radius` of the line through the cursor
//   topological  the vertex is reachable from the seed WITHOUT leaving that
//                cylinder — a breadth-first walk of the surface, not a range query
//
// The second condition is the one that does the real work. A pure radius query
// would paint through a fracture onto the opposing wall, or across the gap
// between two beds that happen to pass close in space; requiring connectivity
// keeps a stroke on the surface the geologist is actually looking at. It is also
// what makes the brush behave the way a brush should — paint spreads from where
// you touched, and stops at an edge.
//
// The cylinder is built on the view ray rather than a sphere at the hit point
// because that is what the cursor means on screen: everything under this circle,
// at whatever depth. Depth along the ray is deliberately unbounded — the BFS,
// not a near/far clip, decides how far the paint travels.

/**
 * Paint outward from a seed vertex along the surface, bounded by a cylinder
 * around the view ray.
 *
 * @param {number} seed                  vertex the cursor picked
 * @param {{origin: ArrayLike<number>, direction: ArrayLike<number>}} ray
 *        the view ray; `direction` need not be unit length
 * @param {number} radius                cylinder radius, in world units
 * @param {object} adj                   from groma's buildAdjacency
 * @param {ArrayLike<number>} positions  flat xyz
 * @param {object} [opts]
 * @param {Uint8Array} [opts.exclude]    vertices already painted into another set;
 *                                       the walk will not cross them
 * @param {number} [opts.limit=Infinity] stop after this many vertices. There is no
 *        default cap: a stroke across a 20-million-vertex model is a legitimate
 *        thing to want, and an invisible ceiling that silently truncates a
 *        measurement is worse than a slow one.
 * @returns {Uint32Array} painted vertex indices, ascending. Always contains the
 *          seed, even if the seed itself sits outside the cylinder — the user
 *          clicked there, so they meant it.
 */
export function brush(seed, ray, radius, adj, positions, opts = {}) {
  const { exclude, limit = Infinity } = opts;
  const nv = adj.vertexCount;
  if (seed < 0 || seed >= nv) return new Uint32Array(0);

  const [ox, oy, oz] = ray.origin;
  let [dx, dy, dz] = ray.direction;
  const L = Math.hypot(dx, dy, dz);
  if (!(L > 0)) return Uint32Array.of(seed);
  dx /= L; dy /= L; dz /= L;
  const r2 = radius * radius;

  // squared distance from a vertex to the ray's infinite line
  const offLine = (v) => {
    const wx = positions[v * 3] - ox;
    const wy = positions[v * 3 + 1] - oy;
    const wz = positions[v * 3 + 2] - oz;
    const t = wx * dx + wy * dy + wz * dz;
    const px = wx - t * dx, py = wy - t * dy, pz = wz - t * dz;
    return px * px + py * py + pz * pz;
  };

  const seen = new Uint8Array(nv);
  const out = [];
  const queue = new Uint32Array(nv);
  let head = 0, tail = 0;

  seen[seed] = 1;
  queue[tail++] = seed;
  out.push(seed);

  while (head < tail && out.length < limit) {
    const v = queue[head++];
    for (let i = adj.vvOffsets[v], e = adj.vvOffsets[v + 1]; i < e; i++) {
      const w = adj.vvNeighbors[i];
      if (seen[w]) continue;
      seen[w] = 1;                                   // mark on discovery, not on accept:
                                                     // a rejected vertex must not be
                                                     // re-tested from every neighbor
      if (exclude && exclude[w]) continue;
      if (offLine(w) > r2) continue;
      queue[tail++] = w;
      out.push(w);
      if (out.length >= limit) break;
    }
  }

  out.sort((a, b) => a - b);
  return Uint32Array.from(out);
}

/**
 * Distance from a point to a ray's infinite line — exposed because the host needs
 * the same predicate to preview a stroke before committing it.
 */
export function distanceToRay(point, ray) {
  const [ox, oy, oz] = ray.origin;
  let [dx, dy, dz] = ray.direction;
  const L = Math.hypot(dx, dy, dz);
  if (!(L > 0)) return Math.hypot(point[0] - ox, point[1] - oy, point[2] - oz);
  dx /= L; dy /= L; dz /= L;
  const wx = point[0] - ox, wy = point[1] - oy, wz = point[2] - oz;
  const t = wx * dx + wy * dy + wz * dz;
  return Math.hypot(wx - t * dx, wy - t * dy, wz - t * dz);
}
