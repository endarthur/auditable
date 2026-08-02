# @gcu/facet

Structural geology on a triangulated surface.

Given a photogrammetry mesh of an outcrop, facet turns what a geologist points at
into measured attitudes: paint a patch of a joint face, fit a plane to it, read
its dip and dip direction, digitize fracture traces along the surface, and
classify the network they form.

Pure, zero-runtime-dependency ESM, typed arrays throughout, Node-tested. It does
no rendering and no picking — the host supplies a seed vertex and a view ray, and
gets back vertex indices and numbers.

```js
import {
  buildAdjacency, brush, components, fitPlane, geodesic, nodeClasses,
} from '@gcu/facet';

const adj = buildAdjacency(positions, triangles);        // once per mesh

// the user drags the cursor across a joint face
const painted = brush(seedVertex, viewRay, 0.25, adj, positions);

// one painted blob may cover several separate faces — split them
const { labels, count } = components(adj, painted);
for (let c = 0; c < count; c++) {
  const idx = painted.filter((v) => labels[v] === c);
  const plane = fitPlane(positions, idx, { normals });
  console.log(`${plane.dip.toFixed(0)}/${plane.dipDirection.toFixed(0)}`,
              `n=${plane.n} misfit=${plane.rms.toFixed(3)} m`);
}
```

## Coordinates

**x = East, y = North, z = Up**, in metres. That is micro's world basis and
`@gcu/bearing`'s direction-cosine basis, so the conversion between a normal vector
and a geological attitude is the identity basis change — but it happens in exactly
one function, `attitude()`, and it is round-trip tested. A plane built at 35°/120°
comes back at 35°/120°, and flipping the sign of the normal cannot change that.

This is not incidental tidiness. The predecessor this package replaces hand-rolled
that conversion in four places out of a Y-up helper, plus a fifth that disagreed
with the other four, and it was the single largest source of quietly wrong
measurements in the tool.

## The plane fit

`fitPlane` is a total-least-squares fit to vertex **positions** — the plane
minimizing the sum of squared perpendicular distances — computed as the
eigen-decomposition of the mean-centered covariance. It is *not* an average of
face normals, which would weight the answer by how the mesh happened to be
triangulated rather than by where the rock is.

The eigenvalues are the dispersion measure, in squared metres: `eig[0]` and
`eig[1]` span the patch, `eig[2]` is the variance perpendicular to the fitted
plane. So `rms = sqrt(eig[2])` is the RMS misfit in metres, and the ratio
`eigRatio21 = eig[2]/eig[1]` is the scale-free quality number — filter a table of
measurements on `eigRatio21 < 0.1` to keep only well-determined planes.

Pass `normals` and you also get Fisher statistics (`R̄`, `κ`, `α95`) over the
vertex normals of the patch, hemisphere-aligned to the fitted pole first so that a
patch spanning a sharp edge does not report a fictitious dispersion.

Two deliberate refusals: fewer than three points returns `null` rather than a
confident-looking guess, and a collinear patch is flagged `degenerate:
'collinear'` rather than given an arbitrary normal from the degenerate eigenspace.

### Area weighting — measure rock, not vertices

An unweighted vertex PCA counts vertices, so a region the mesher happened to
tessellate finely pulls the fit toward its own orientation. Pass
`weights: vertexAreaWeights(positions, triangles)` and each vertex counts for the
surface area it represents instead, which makes the fit **independent of how the
mesh was built**.

How much this matters, from `test/facet.test.mjs`: take one surface — a symmetric
valley whose two limbs have equal area — and mesh it two ways that differ only in
which limb got refined.

| | fine west limb | fine east limb |
|---|---|---|
| unweighted | 13.10° toward 090° | 13.10° toward **270°** |
| area-weighted | 0.82° | 0.82° |

The unweighted fit reports a 13° plane dipping *east* or *west* — opposite
answers for the same rock — decided entirely by the mesh. The weighted fit gives
the same answer either way, and that answer is the honest one.

This is cheap and it does not need face records: indexed geometry and one pass
over the triangles is enough. `vertexAreaWeights` assigns each vertex a third of
every incident triangle's area, so the weights sum to the total surface area.

### Why the name is `fitTensor` and not `orientationTensor`

`@gcu/bearing` already exports `orientationTensor(dcos)`, which does **not**
mean-center, because it is built for unit direction cosines where the origin is
meaningful. Feeding positions to that one returns the direction to the centroid
instead of the plane normal — an answer that is wrong and looks entirely
plausible. Two functions with the same name and different mathematics is a trap,
so this one is named differently.

## The brush

A stroke is the intersection of a geometric and a topological condition: within
`radius` of the line through the cursor, **and** reachable from the seed without
leaving that cylinder. The connectivity requirement is what does the real work — a
plain radius query paints through a fracture onto the opposing wall, or across the
gap between two beds that happen to pass close in space. Requiring a walk of the
surface keeps a stroke on the face the geologist is looking at, and makes paint
behave like paint: it spreads from where you touched, and it stops at an edge.

There is no default size cap. A stroke across a twenty-million-vertex model is a
legitimate thing to want, and an invisible ceiling that silently truncates a
measurement is worse than a slow one. `limit` is available when a host wants one.

## Geodesics

`geodesic(a, b, adj, positions)` is Dijkstra over the vertex graph with Euclidean
edge costs, so distance is measured *along* the surface. That is what makes a
digitized trace follow the outcrop over a bulge instead of cutting through it. The
queue is a binary heap over two flat typed arrays; the predecessor walked a plain
array and spliced out the minimum each pop, which is quadratic and was fine only
on the toy meshes it was demoed with.

`geodesicField` exposes the whole distance field, and `geodesicBall` grows a
selection outward by surface distance.

## Fracture networks

`nodeClasses(traces)` classifies the nodes where traces meet by degree — 1 = **I**
(free end), 3 = **Y** (abutment), 4 = **X** (crossing) — and derives the
Sanderson & Nixon connectivity numbers: branch and line counts, connections per
branch, connections per line. Degree 2 is a point along a trace, not a node.
Degrees of 5 and above are counted as `other` and reported rather than folded into
X, because a silent reclassification would move the connectivity numbers without
saying so.

> Sanderson, D.J. & Nixon, C.W. (2015). The use of topology in fracture network
> characterization. *Journal of Structural Geology* 72, 55–66.

## Reading painted meshes

`detectSets(colors)` recovers plane sets from vertex colors painted in MeshLab —
the established ply2atti workflow. A vertex counts as painted when every channel
is exactly 0 or 1 and the color is neither black nor white; photographic colors
are essentially never saturated, so there is no threshold to tune.

## What is not here

Mesh topology. `buildAdjacency`, `neighbors`, `incidentFaces`, `degree` and
`components` are re-exported from **`@gcu/groma`** so that a consumer needs one
import instead of two, but there is exactly one implementation and it lives in
groma. The eigensolver and the attitude conversion are **`@gcu/bearing`**'s for
the same reason.

## Build

```
node ext/facet/build.js
```

groma's topology is inlined, so the bundle stands alone. `@gcu/bearing` stays a
bare specifier — it is 128 KB of vendored stereonet library that hosts need in
their own right, and one copy resolved through an import map beats two.

Tests: `test/facet.test.mjs`, run by `npm test`.
