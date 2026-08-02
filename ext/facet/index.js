// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/facet — Structural geology on a triangulated surface: plane fitting by PCA of vertex positions, geodesic brush and traces, fracture-network topology, painted-color set detection.

import { symmetricEigen3, conversions, statistics } from '@gcu/bearing';

// ── src/fit.js ──

// @gcu/facet — plane fitting by principal component analysis of vertex POSITIONS.
//
// This is a total-least-squares fit: the plane that minimizes the sum of squared
// perpendicular distances to a set of points. It is NOT an average of face
// normals, and the difference matters — averaging normals weights by however the
// mesh happens to be triangulated, while the position fit weights by where the
// rock actually is.
//
//     T = (1/n) Σ (xᵢ - x̄)(xᵢ - x̄)ᵀ        the covariance, mean-centered
//     [values, vectors] = symmetricEigen3(T)   descending
//     normal = vectors[2]                      the SMALLEST eigenvalue's axis
//
// The eigenvalues are the dispersion measure, and they come out in squared
// length units: e0 and e1 span the patch, e2 is the variance perpendicular to
// the fitted plane, so `sqrt(e2)` is the RMS distance from the plane. A patch
// that is genuinely planar has e2 ≈ 0, and the ratio e2/e1 is the quality
// number to filter on.
//
// ── The mean-centering is load-bearing, twice ──
//
// Mathematically: @gcu/bearing already has an `orientationTensor(dcos)` which
// does NOT mean-center, because it is built for unit direction cosines where the
// origin is meaningful. Feed positions to that one and the leading eigenvector
// comes back pointing at the centroid rather than along the plane — a fit that is
// wrong and looks entirely plausible. Hence the deliberately different name here.
//
// Numerically: outcrop coordinates are UTM, so x ≈ 5e5 and x² ≈ 2.5e11. Float64
// carries ~16 significant digits, so accumulating raw squares would spend six of
// them representing an offset we are about to subtract. Both passes below work
// in coordinates shifted to the first point, which keeps every accumulated
// quantity the size of the patch rather than the size of the projection.


/**
 * The one place a normal vector becomes a geological attitude.
 *
 * CAPIVARAS rolled this conversion by hand in four places out of a Y-up
 * spherical helper, plus a fifth that disagreed with the other four — the single
 * biggest source of silent wrongness in the original. There is exactly one copy
 * here, it delegates to @gcu/bearing, and it is round-trip tested.
 *
 * The input basis is **x = East, y = North, z = Up**, which is what micro's world
 * coordinates and bearing's direction cosines both already use, so the basis
 * change is the identity — stated once and verified, rather than assumed
 * everywhere. Either sign of the normal gives the same answer: `dcosToPlane`
 * folds the vector into the lower hemisphere itself.
 *
 * @param {ArrayLike<number>} normal  a plane normal (need not be unit length)
 * @returns {{dipDirection: number, dip: number}} degrees; dip ∈ [0, 90],
 *          dipDirection ∈ [0, 360). A horizontal plane has no meaningful dip
 *          direction — the value returned for one is arbitrary, not wrong.
 */
function attitude(normal) {
  const [dd, dip] = conversions.dcosToPlane(unit(normal));
  return { dipDirection: dd, dip };
}

/**
 * The inverse of `attitude` — the downward pole of a plane at this attitude.
 * Present so the round trip can be tested, and so a synthetic plane can be built
 * from an attitude a geologist wrote down.
 */
function normalOf(dipDirection, dip) {
  return conversions.planeToDcos(dipDirection, dip);
}

/**
 * Per-vertex weights proportional to the surface area each vertex represents:
 * a third of the area of every triangle touching it, which is the standard
 * barycentric lumped area.
 *
 * Pass these to `fitTensor`/`fitPlane` to make a fit **triangulation-independent**.
 * An unweighted vertex PCA counts vertices, not rock, so a corner that the mesher
 * happened to tessellate finely pulls the answer toward its own orientation —
 * a bias that is invisible on a perfectly flat patch (where every weighting gives
 * the same plane) and shows up exactly where it matters, on a patch with real
 * curvature. Weighting by area approximates integrating over the surface instead.
 *
 * The spec assigned this to face records in v2; it does not need them. Indexed
 * geometry and one pass over the triangles is enough.
 *
 * @param {ArrayLike<number>} positions  flat xyz
 * @param {ArrayLike<number>} triangles  flat vertex indices
 * @param {number} [vertexCount]         defaults to positions.length / 3
 * @returns {Float64Array} one weight per vertex; 0 for unreferenced vertices
 */
function vertexAreaWeights(positions, triangles, vertexCount) {
  const nv = vertexCount != null ? vertexCount : Math.floor(positions.length / 3);
  const w = new Float64Array(nv);
  const nt = Math.floor(triangles.length / 3);
  for (let f = 0; f < nt; f++) {
    const a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2];
    if (a >= nv || b >= nv || c >= nv) continue;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const third = Math.hypot(cx, cy, cz) / 6;          // ‖u×v‖/2 is the area; /3 each
    w[a] += third; w[b] += third; w[c] += third;
  }
  return w;
}

/**
 * The mean-centered covariance of a set of points.
 *
 * @param {ArrayLike<number>} positions  flat xyz, length 3·nv
 * @param {ArrayLike<number>} [indices]  which vertices to include; all if omitted
 * @param {object} [opts]
 * @param {ArrayLike<number>} [opts.weights]  per-VERTEX weights, indexed the same
 *        way as `positions` (not parallel to `indices`) — normally from
 *        `vertexAreaWeights`. Without them every point counts equally.
 * @returns {{tensor: Float64Array, centroid: number[], n: number, weight: number}}
 *          `tensor` is row-major 3×3 (symmetric), ready for `symmetricEigen3`.
 *          `n` is the point count; `weight` their total weight.
 */
function fitTensor(positions, indices, { weights } = {}) {
  const n = indices ? indices.length : Math.floor(positions.length / 3);
  const centroid = [0, 0, 0];
  const tensor = new Float64Array(9);
  if (n <= 0) return { tensor, centroid, n: 0, weight: 0 };

  const at = (k) => (indices ? indices[k] : k) * 3;
  const wt = weights ? (k) => weights[indices ? indices[k] : k] : () => 1;

  // pass 1 — the centroid, accumulated relative to the first point so that the
  // sum stays patch-sized even when the coordinates are UTM
  const o = at(0);
  const ox = positions[o], oy = positions[o + 1], oz = positions[o + 2];
  let sx = 0, sy = 0, sz = 0, sw = 0;
  for (let k = 0; k < n; k++) {
    const i = at(k), w = wt(k);
    sx += (positions[i] - ox) * w;
    sy += (positions[i + 1] - oy) * w;
    sz += (positions[i + 2] - oz) * w;
    sw += w;
  }
  // a patch of zero total weight (every vertex unreferenced by any triangle)
  // still has a well-defined centroid — fall back to counting points
  if (!(sw > 0)) return fitTensor(positions, indices);
  centroid[0] = ox + sx / sw;
  centroid[1] = oy + sy / sw;
  centroid[2] = oz + sz / sw;

  // pass 2 — the covariance of the centered points
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let k = 0; k < n; k++) {
    const i = at(k), w = wt(k);
    const dx = positions[i] - centroid[0];
    const dy = positions[i + 1] - centroid[1];
    const dz = positions[i + 2] - centroid[2];
    xx += w * dx * dx; xy += w * dx * dy; xz += w * dx * dz;
    yy += w * dy * dy; yz += w * dy * dz; zz += w * dz * dz;
  }
  const inv = 1 / sw;
  tensor[0] = xx * inv; tensor[1] = xy * inv; tensor[2] = xz * inv;
  tensor[3] = xy * inv; tensor[4] = yy * inv; tensor[5] = yz * inv;
  tensor[6] = xz * inv; tensor[7] = yz * inv; tensor[8] = zz * inv;
  return { tensor, centroid, n, weight: sw };
}

/**
 * Fit a plane to a set of mesh vertices.
 *
 * @param {ArrayLike<number>} positions  flat xyz, length 3·nv
 * @param {ArrayLike<number>} [indices]  which vertices; all if omitted
 * @param {object} [opts]
 * @param {ArrayLike<number>} [opts.normals]  flat per-vertex normals, same
 *        indexing as `positions`. When given, two things change: the fitted
 *        normal is oriented to agree with the patch's mean surface normal (so it
 *        points out of the outcrop rather than at an arbitrary hemisphere), and
 *        Fisher statistics over the vertex normals are returned.
 * @param {ArrayLike<number>} [opts.weights]  per-vertex weights, normally from
 *        `vertexAreaWeights` — see there for why this matters. The Fisher
 *        statistics stay unweighted, since they describe the scatter of the
 *        normals themselves rather than the surface they sit on.
 * @param {number} [opts.collinearTol=1e-9]  e1/e0 below this means the points are
 *        collinear and the plane is not determined.
 * @returns {null | {
 *   normal: number[], centroid: number[], eig: number[], axes: number[][],
 *   n: number, radius: number, rms: number, eigRatio21: number, eigRatio20: number,
 *   dipDirection: number, dip: number, degenerate: null|'collinear',
 *   fisher?: {n,R,Rbar,mean,kappa,alpha95}
 * }}  `null` when fewer than 3 points are given — three is the minimum that
 *     determines a plane, and returning a confident-looking answer for two would
 *     be exactly the kind of plausible wrongness this package exists to avoid.
 */
function fitPlane(positions, indices, opts = {}) {
  const { normals, weights, collinearTol = 1e-9 } = opts;
  const { tensor, centroid, n } = fitTensor(positions, indices, { weights });
  if (n < 3) return null;

  const { values, vectors } = symmetricEigen3(tensor);
  let normal = unit(vectors[2]);                    // smallest eigenvalue → the pole

  // Orient it. With surface normals available the fit should agree with the rock
  // face; without them, fall back to bearing's convention of a downward pole.
  // Neither choice can change the attitude — `dcosToPlane` folds hemispheres —
  // but it does decide which way the reported vector points.
  let fisher;
  if (normals) {
    const mean = meanNormal(normals, indices, n);
    if (mean) {
      if (dot(normal, mean) < 0) normal = [-normal[0], -normal[1], -normal[2]];
      fisher = fisherOf(normals, indices, n, normal);
    }
  }
  if (!normals && normal[2] > 0) normal = [-normal[0], -normal[1], -normal[2]];

  // radius: how far the patch reaches from its center. Reported by CAPIVARAS and
  // worth keeping — it is the honest scale of the measurement, and a 4 cm plane
  // and a 4 m plane are not the same observation even at identical eigenvalues.
  let far = 0;
  const at = (k) => (indices ? indices[k] : k) * 3;
  for (let k = 0; k < n; k++) {
    const i = at(k);
    const dx = positions[i] - centroid[0];
    const dy = positions[i + 1] - centroid[1];
    const dz = positions[i + 2] - centroid[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > far) far = d2;
  }

  const [e0, e1, e2] = values;
  const { dipDirection, dip } = attitude(normal);
  return {
    normal,
    centroid,
    eig: [e0, e1, e2],
    axes: [unit(vectors[0]), unit(vectors[1]), normal],
    n,
    radius: Math.sqrt(far),
    rms: Math.sqrt(Math.max(0, e2)),               // RMS distance to the plane
    eigRatio21: e1 > 0 ? e2 / e1 : 0,              // the quality number to filter on
    eigRatio20: e0 > 0 ? e2 / e0 : 0,
    dipDirection,
    dip,
    degenerate: e0 > 0 && e1 / e0 < collinearTol ? 'collinear' : null,
    ...(fisher ? { fisher } : {}),
  };
}

// ── internals ──

function unit(v) {
  const L = Math.hypot(v[0], v[1], v[2]);
  return L > 0 ? [v[0] / L, v[1] / L, v[2] / L] : [0, 0, -1];
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function meanNormal(normals, indices, n) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const i = (indices ? indices[k] : k) * 3;
    x += normals[i]; y += normals[i + 1]; z += normals[i + 2];
  }
  return Math.hypot(x, y, z) > 1e-12 ? [x, y, z] : null;
}

// Fisher statistics over the vertex normals, which is the ingredient CAPIVARAS
// exported (‖R̄‖) but never turned into a concentration. bearing finishes it.
//
// The normals are hemisphere-aligned to the fitted pole first. Mesh normals of a
// single patch normally agree already, but a patch spanning a sharp edge or a
// two-sided sheet would otherwise cancel to R̄ ≈ 0 and report a fictitious
// dispersion — an artifact of the sign convention, not of the rock.
function fisherOf(normals, indices, n, pole) {
  const dcos = new Array(n);
  for (let k = 0; k < n; k++) {
    const i = (indices ? indices[k] : k) * 3;
    const v = unit([normals[i], normals[i + 1], normals[i + 2]]);
    dcos[k] = dot(v, pole) < 0 ? [-v[0], -v[1], -v[2]] : v;
  }
  return statistics.fisherStats(dcos);
}

// ── src/brush.js ──

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
function brush(seed, ray, radius, adj, positions, opts = {}) {
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
function distanceToRay(point, ray) {
  const [ox, oy, oz] = ray.origin;
  let [dx, dy, dz] = ray.direction;
  const L = Math.hypot(dx, dy, dz);
  if (!(L > 0)) return Math.hypot(point[0] - ox, point[1] - oy, point[2] - oz);
  dx /= L; dy /= L; dz /= L;
  const wx = point[0] - ox, wy = point[1] - oy, wz = point[2] - oz;
  const t = wx * dx + wy * dy + wz * dz;
  return Math.hypot(wx - t * dx, wy - t * dy, wz - t * dz);
}

// ── src/geodesic.js ──

// @gcu/facet — shortest paths ALONG a surface.
//
// Distance here is measured through the mesh, not through the air: the cost of
// an edge is its Euclidean length, and a path may only follow edges. That is
// what makes a digitized trace follow the outcrop over a bulge instead of
// cutting through it, and what makes a brush stop at a gap instead of leaking
// onto the far wall of a fracture that happens to be nearby in space.
//
// Dijkstra over a binary heap. The original walked a plain array and spliced out
// the minimum each pop, which is O(n) per pop and O(n²) overall — fine on the
// toy meshes it was demoed with, quadratic on a real photogrammetry model. The
// heap here is two flat typed arrays, so a search allocates once and never
// touches the garbage collector in its inner loop.

/** A min-heap of (distance, vertex) pairs over flat typed arrays. */
class MinHeap {
  constructor(capacity = 1024) {
    this.key = new Float64Array(capacity);
    this.val = new Uint32Array(capacity);
    this.size = 0;
  }

  push(key, val) {
    if (this.size === this.key.length) this._grow();
    let i = this.size++;
    this.key[i] = key; this.val[i] = val;
    while (i > 0) {                                  // sift up
      const p = (i - 1) >> 1;
      if (this.key[p] <= this.key[i]) break;
      this._swap(p, i);
      i = p;
    }
  }

  pop() {
    const topKey = this.key[0], topVal = this.val[0];
    const last = --this.size;
    this.key[0] = this.key[last]; this.val[0] = this.val[last];
    let i = 0;
    for (;;) {                                       // sift down
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.size && this.key[l] < this.key[m]) m = l;
      if (r < this.size && this.key[r] < this.key[m]) m = r;
      if (m === i) break;
      this._swap(m, i);
      i = m;
    }
    return { key: topKey, val: topVal };
  }

  _swap(a, b) {
    const k = this.key[a]; this.key[a] = this.key[b]; this.key[b] = k;
    const v = this.val[a]; this.val[a] = this.val[b]; this.val[b] = v;
  }

  _grow() {
    const k = new Float64Array(this.key.length * 2); k.set(this.key); this.key = k;
    const v = new Uint32Array(this.val.length * 2); v.set(this.val); this.val = v;
  }
}

/**
 * Dijkstra from one or more seeds over the vertex→vertex graph.
 *
 * Lazy deletion: a vertex may be pushed more than once, and a pop whose key no
 * longer matches the recorded distance is a stale entry and is skipped. That is
 * cheaper than a decrease-key and needs no index-into-heap bookkeeping.
 *
 * @param {number|ArrayLike<number>} seeds  a vertex, or several (all at distance 0)
 * @param {object} adj                      from groma's buildAdjacency
 * @param {ArrayLike<number>} positions     flat xyz
 * @param {object} [opts]
 * @param {number} [opts.maxDist=Infinity]  stop expanding past this surface distance
 * @param {number} [opts.target=-1]         stop as soon as this vertex is settled
 * @param {Uint8Array} [opts.mask]          if given, only vertices with mask[v] are walkable
 * @returns {{dist: Float64Array, prev: Int32Array, settled: number}}
 *          `dist` is Infinity for unreached vertices; `prev` is -1 at a seed or
 *          where unreached.
 */
function geodesicField(seeds, adj, positions, opts = {}) {
  const { maxDist = Infinity, target = -1, mask } = opts;
  const nv = adj.vertexCount;
  const dist = new Float64Array(nv).fill(Infinity);
  const prev = new Int32Array(nv).fill(-1);
  const done = new Uint8Array(nv);
  const heap = new MinHeap(Math.min(nv, 1024) || 1);

  const seedList = typeof seeds === 'number' ? [seeds] : seeds;
  for (const s of seedList) {
    if (s >= 0 && s < nv && !(mask && !mask[s])) { dist[s] = 0; heap.push(0, s); }
  }

  let settled = 0;
  while (heap.size > 0) {
    const { key, val: v } = heap.pop();
    if (done[v] || key > dist[v]) continue;          // stale entry
    done[v] = 1;
    settled++;
    if (v === target) break;

    const vx = positions[v * 3], vy = positions[v * 3 + 1], vz = positions[v * 3 + 2];
    for (let i = adj.vvOffsets[v], e = adj.vvOffsets[v + 1]; i < e; i++) {
      const w = adj.vvNeighbors[i];
      if (done[w] || (mask && !mask[w])) continue;
      const d = key + Math.hypot(
        positions[w * 3] - vx, positions[w * 3 + 1] - vy, positions[w * 3 + 2] - vz,
      );
      if (d < dist[w] && d <= maxDist) { dist[w] = d; prev[w] = v; heap.push(d, w); }
    }
  }
  return { dist, prev, settled };
}

/**
 * The shortest path along the surface from `a` to `b`.
 *
 * @returns {null | {path: Uint32Array, length: number}}  `null` when `b` is not
 *          reachable from `a` — which on a real mesh usually means the two
 *          points are on genuinely disconnected shells, and is information the
 *          caller wants rather than an error.
 */
function geodesic(a, b, adj, positions, opts = {}) {
  if (a === b) return { path: Uint32Array.of(a), length: 0 };
  const { dist, prev } = geodesicField(a, adj, positions, { ...opts, target: b });
  if (!isFinite(dist[b])) return null;

  let n = 1;
  for (let v = b; v !== a; v = prev[v]) n++;
  const path = new Uint32Array(n);
  let k = n;
  for (let v = b; ; v = prev[v]) { path[--k] = v; if (v === a) break; }
  return { path, length: dist[b] };
}

/**
 * Every vertex within `maxDist` of the seed, measured along the surface — the
 * "grow the selection" operation.
 *
 * @returns {Uint32Array} vertex indices, ascending
 */
function geodesicBall(seed, maxDist, adj, positions, opts = {}) {
  const { dist } = geodesicField(seed, adj, positions, { ...opts, maxDist });
  const out = [];
  for (let v = 0; v < dist.length; v++) if (dist[v] <= maxDist) out.push(v);
  return Uint32Array.from(out);
}

// ── src/network.js ──

// @gcu/facet — fracture-network topology, the Sanderson & Nixon I/Y/X scheme.
//
// Once traces are digitized, the network's connectivity is read off the nodes
// where traces meet, classified by how many branches arrive:
//
//   I   degree 1   a free end — the trace stops in intact rock
//   Y   degree 3   an abutment — one trace terminates against another
//   X   degree 4   a crossing — two traces cut through each other
//
// Degree 2 is not a node at all, just a point along a trace, and is excluded.
// Degrees of 5 and above are geometrically possible but usually mean two nodes
// digitized on top of each other; they are counted and reported rather than
// quietly folded into X, because a silent reclassification would move the
// connectivity numbers without saying so.
//
// CAPIVARAS stopped at the classification — `updateTopology()` literally returned
// the set, and status.txt recorded that the real analysis "tá no jupyter", in a
// notebook outside the repo that never came home. The derived quantities below
// are the rest of it, and they are four lines of arithmetic:
//
//   Sanderson, D.J. & Nixon, C.W. (2015), "The use of topology in fracture
//   network characterization", Journal of Structural Geology 72, 55-66.

/**
 * Classify the nodes of a trace network and derive its connectivity.
 *
 * Nodes are identified by vertex index, so two traces meet only where they share
 * an actual mesh vertex. Snapping nearby endpoints together is the host's job,
 * not this function's — proximity is a display-scale decision and does not belong
 * buried in the topology.
 *
 * @param {Array<ArrayLike<number>>} traces  each a polyline of vertex indices
 * @returns {{
 *   nodes: Array<{vertex: number, degree: number, kind: 'I'|'Y'|'X'|'other'}>,
 *   counts: {I: number, Y: number, X: number, other: number},
 *   branches: number, lines: number,
 *   connectivityPerBranch: number, connectivityPerLine: number
 * }}
 */
function nodeClasses(traces) {
  // degree = number of DISTINCT neighbors, so a segment digitized twice over the
  // same pair of vertices counts once. Retracing a trace should not invent a node.
  const adj = new Map();
  const touch = (a, b) => {
    let s = adj.get(a);
    if (!s) adj.set(a, (s = new Set()));
    s.add(b);
  };
  for (const t of traces) {
    if (t.length === 1) touch(t[0], -1);             // a lone pinned point is a free end
    for (let i = 1; i < t.length; i++) {
      const u = t[i - 1], v = t[i];
      if (u === v) continue;                         // a repeated click is not a segment
      touch(u, v);
      touch(v, u);
    }
  }

  const nodes = [];
  const counts = { I: 0, Y: 0, X: 0, other: 0 };
  for (const [vertex, set] of adj) {
    const degree = set.has(-1) ? 1 : set.size;
    if (degree === 2) continue;                      // interior point, not a node
    const kind = degree === 1 ? 'I' : degree === 3 ? 'Y' : degree === 4 ? 'X' : 'other';
    counts[kind]++;
    nodes.push({ vertex, degree, kind });
  }
  nodes.sort((a, b) => a.vertex - b.vertex);         // deterministic across runs

  const { I, Y, X } = counts;
  const branches = (I + 3 * Y + 4 * X) / 2;
  const lines = (I + Y) / 2;
  return {
    nodes,
    counts,
    branches,
    lines,
    connectivityPerBranch: branches > 0 ? (3 * Y + 4 * X) / branches : 0,
    connectivityPerLine: lines > 0 ? 2 * (Y + X) / lines : 0,
  };
}

// ── src/sets.js ──

// @gcu/facet — reading plane sets back out of vertex colors (ply2atti compat).
//
// The established workflow this replaces is: paint the outcrop mesh in MeshLab
// with saturated primary colors, one color per joint set, export .ply, run
// ply2atti. Anyone with that habit has meshes already painted, and they should
// open here and just work.
//
// The rule is the original's: a vertex belongs to a set if every channel is
// exactly 0 or exactly 1 and the color is not black — that is, one of the seven
// saturated corners of the RGB cube. Photogrammetry texture colors are essentially
// never exactly saturated, so this cleanly separates "painted by a human" from
// "photographed", with no threshold to tune.
//
// "Exactly" is relaxed to a tolerance because the round trip through 8-bit .ply
// and back is exact but a round trip through some editors is not. The default is
// half a step of 8-bit quantization, which admits genuine paint and still
// excludes any real photographic color.

/**
 * Group vertices by painted color.
 *
 * @param {ArrayLike<number>} colors  flat rgb, length 3·nv. Values are read as
 *        0-255 if anything exceeds 1, otherwise as 0-1.
 * @param {object} [opts]
 * @param {number} [opts.tolerance=0.002]  in 0-1 units; how far from an exact 0 or
 *        1 a channel may sit and still count as painted
 * @param {boolean} [opts.includeWhite=false]  white is a saturated corner, but it
 *        is also the default color of an unpainted mesh, so it is excluded unless
 *        asked for
 * @returns {Array<{color: number[], key: string, vertices: Uint32Array}>}
 *          one entry per distinct color, ordered by key so the result is stable
 *          across runs. `color` is 0-1 rgb; `key` is like "100" for red.
 */
function detectSets(colors, opts = {}) {
  const { tolerance = 0.002, includeWhite = false } = opts;
  const nv = Math.floor(colors.length / 3);

  // decide the scale from the data: a byte array has values above 1
  let scale = 1;
  for (let i = 0; i < colors.length; i++) {
    if (colors[i] > 1.0000001) { scale = 1 / 255; break; }
  }

  const groups = new Map();
  for (let v = 0; v < nv; v++) {
    const r = colors[v * 3] * scale;
    const g = colors[v * 3 + 1] * scale;
    const b = colors[v * 3 + 2] * scale;
    const cr = saturate(r, tolerance);
    if (cr < 0) continue;
    const cg = saturate(g, tolerance);
    if (cg < 0) continue;
    const cb = saturate(b, tolerance);
    if (cb < 0) continue;
    if (cr + cg + cb === 0) continue;                          // black: unpainted
    if (!includeWhite && cr + cg + cb === 3) continue;         // white: unpainted
    const key = `${cr}${cg}${cb}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(v);
  }

  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, list]) => ({
      color: [+key[0], +key[1], +key[2]],
      key,
      vertices: Uint32Array.from(list),
    }));
}

// 0, 1, or -1 for "not saturated"
function saturate(x, tol) {
  if (Math.abs(x) <= tol) return 0;
  if (Math.abs(x - 1) <= tol) return 1;
  return -1;
}

// ── ../groma/src/topology.js ──

// @gcu/groma — mesh topology in CSR form.
//
// Two adjacency graphs, built once in linear time, that everything walking a
// surface needs: a geodesic brush, a flood fill, Dijkstra along the surface,
// rebuilding a selection's index buffer, closed/open detection.
//
//   vertex -> vertex   (who is one edge away)
//   vertex -> face     (which triangles touch me)
//
// Both are stored as compressed sparse rows: an offsets array of length n+1
// and a packed neighbor array, so row `v` is `neighbors[offsets[v] …
// offsets[v+1]]`. Offsets are EXACT — there is no padding and therefore no
// empty-slot sentinel.
//
// (CAPIVARAS stored neighbors as `v+1` so that 0 could mean "empty", and every
// consumer wrote `const w = nbr[i] - 1; if (w < 0) break;`. That is only needed
// when rows are fixed-stride and padded. Exact rows make the sentinel, the bias
// and the break condition all disappear — one less invariant for every caller
// to remember, and no wasted memory. This is a deliberate departure from the
// original; the geometry is identical.)
//
// Degenerate input is tolerated rather than rejected: a triangle referencing a
// vertex out of range is skipped, and a triangle with a repeated corner
// contributes its real edges only. Field meshes are not clean.

/**
 * Build the CSR adjacency graphs for an indexed triangle mesh.
 *
 * @param {ArrayLike<number>} vertices   flat xyz, length 3·nv (only its length is read)
 * @param {ArrayLike<number>} triangles  flat vertex indices, length 3·nt
 * @param {object} [opts]
 * @param {number} [opts.vertexCount]    override nv (when `vertices` is not flat xyz)
 * @returns {{
 *   vertexCount: number, faceCount: number,
 *   vvOffsets: Uint32Array, vvNeighbors: Uint32Array,
 *   vfOffsets: Uint32Array, vfFaces: Uint32Array,
 *   skipped: number
 * }}
 */
function buildAdjacency(vertices, triangles, { vertexCount } = {}) {
  const nv = vertexCount != null ? vertexCount : Math.floor(vertices.length / 3);
  const nt = Math.floor(triangles.length / 3);
  if (nv <= 0) {
    return {
      vertexCount: 0, faceCount: 0,
      vvOffsets: new Uint32Array(1), vvNeighbors: new Uint32Array(0),
      vfOffsets: new Uint32Array(1), vfFaces: new Uint32Array(0), skipped: nt,
    };
  }

  // ── vertex -> face. Exact by construction: every valid triangle contributes
  //    one entry to each of its three corners. ──
  const vfOffsets = new Uint32Array(nv + 1);
  let skipped = 0;
  const ok = new Uint8Array(nt);                           // remember which faces counted
  for (let f = 0; f < nt; f++) {
    const a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2];
    if (a >= nv || b >= nv || c >= nv || a < 0 || b < 0 || c < 0) { skipped++; continue; }
    ok[f] = 1;
    vfOffsets[a + 1]++; vfOffsets[b + 1]++; vfOffsets[c + 1]++;
  }
  for (let v = 0; v < nv; v++) vfOffsets[v + 1] += vfOffsets[v];
  const vfFaces = new Uint32Array(vfOffsets[nv]);
  {
    const cursor = vfOffsets.slice(0, nv);                 // a moving write head per row
    for (let f = 0; f < nt; f++) {
      if (!ok[f]) continue;
      const a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2];
      vfFaces[cursor[a]++] = f;
      vfFaces[cursor[b]++] = f;
      vfFaces[cursor[c]++] = f;
    }
  }

  // ── vertex -> vertex, derived from vertex -> face.
  //    A vertex's neighbors are the other two corners of each incident face,
  //    deduplicated: an interior edge is shared by two faces, so every neighbor
  //    would otherwise appear twice. Vertex degree is small (typically 4-8 on a
  //    triangulated surface), so a linear scan over the row-so-far is the right
  //    dedup — no Set per vertex, no allocation in the loop. ──
  const vvOffsets = new Uint32Array(nv + 1);
  let scratch = new Uint32Array(64);
  const gather = (v) => {                                  // unique neighbors of v -> scratch
    let k = 0;
    for (let i = vfOffsets[v], e = vfOffsets[v + 1]; i < e; i++) {
      const f = vfFaces[i] * 3;
      for (let j = 0; j < 3; j++) {
        const w = triangles[f + j];
        if (w === v) continue;                             // self, and a repeated corner
        let dup = false;
        for (let q = 0; q < k; q++) if (scratch[q] === w) { dup = true; break; }
        if (dup) continue;
        if (k === scratch.length) {                        // a pathological fan; grow once
          const bigger = new Uint32Array(scratch.length * 2);
          bigger.set(scratch);
          scratch = bigger;
        }
        scratch[k++] = w;
      }
    }
    return k;
  };

  for (let v = 0; v < nv; v++) vvOffsets[v + 1] = gather(v);
  for (let v = 0; v < nv; v++) vvOffsets[v + 1] += vvOffsets[v];
  const vvNeighbors = new Uint32Array(vvOffsets[nv]);
  for (let v = 0; v < nv; v++) {
    const k = gather(v);
    const at = vvOffsets[v];
    for (let q = 0; q < k; q++) vvNeighbors[at + q] = scratch[q];
  }

  return { vertexCount: nv, faceCount: nt, vvOffsets, vvNeighbors, vfOffsets, vfFaces, skipped };
}

/** Neighbors of vertex `v` as a subarray view (no copy). */
function neighbors(adj, v) {
  return adj.vvNeighbors.subarray(adj.vvOffsets[v], adj.vvOffsets[v + 1]);
}

/** Faces incident to vertex `v` as a subarray view (no copy). */
function incidentFaces(adj, v) {
  return adj.vfFaces.subarray(adj.vfOffsets[v], adj.vfOffsets[v + 1]);
}

/** Degree of vertex `v` in the vertex->vertex graph. */
function degree(adj, v) {
  return adj.vvOffsets[v + 1] - adj.vvOffsets[v];
}

/**
 * Connected components over a SUBSET of vertices — the operation that turns a
 * painted patch into individual measurable planes: one component is one plane.
 *
 * @param {object} adj        from buildAdjacency
 * @param {ArrayLike<number>|Set<number>} subset  vertices to consider
 * @returns {{ labels: Int32Array, count: number }}  labels[v] = component id, or
 *          -1 for vertices outside the subset. Ids are assigned in ascending
 *          vertex order, so the result is deterministic.
 */
function components(adj, subset) {
  const nv = adj.vertexCount;
  const inSet = new Uint8Array(nv);
  const members = [];
  for (const v of subset) {
    if (v >= 0 && v < nv && !inSet[v]) { inSet[v] = 1; members.push(v); }
  }
  members.sort((a, b) => a - b);                           // determinism, not correctness

  const labels = new Int32Array(nv).fill(-1);
  const stack = new Uint32Array(members.length);
  let count = 0;
  for (const seed of members) {
    if (labels[seed] !== -1) continue;
    let top = 0;
    stack[top++] = seed;
    labels[seed] = count;
    while (top > 0) {
      const v = stack[--top];
      for (let i = adj.vvOffsets[v], e = adj.vvOffsets[v + 1]; i < e; i++) {
        const w = adj.vvNeighbors[i];
        if (inSet[w] && labels[w] === -1) { labels[w] = count; stack[top++] = w; }
      }
    }
    count++;
  }
  return { labels, count };
}

// ── src/main.js ──

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


// re-exported from @gcu/groma — mesh topology has one home, and this is not it

export {
  attitude,
  normalOf,
  fitTensor,
  fitPlane,
  vertexAreaWeights,
  brush,
  distanceToRay,
  geodesic,
  geodesicField,
  geodesicBall,
  nodeClasses,
  detectSets,
  buildAdjacency,
  neighbors,
  incidentFaces,
  degree,
  components,
};
