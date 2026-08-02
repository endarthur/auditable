# @gcu/groma

**The robust-geometry base of the GCU stack.** Named for the Roman surveyor's
cross-staff, alongside `regula` (drafting geometry) and `libella` (elevation).

Zero dependencies. Everything is plain typed arrays — no classes to serialize,
so a BVH or an adjacency crosses a worker boundary by transfer.

```js
import { buildBVH, raycastBVH, buildAdjacency, neighbors, components } from '@gcu/groma';
```

## What lives here

**BVH** — `buildBVH(vertices, triangles, opts)` and `raycastBVH(mesh, origin, dir)`.
Möller–Trumbore, two-sided: geological wireframes are rarely consistently wound,
and a surface you can see from below is one you can click from below. The
returned normal is flipped toward the ray, matching the shading.

**Mesh topology** — `buildAdjacency(vertices, triangles)` returns two CSR graphs:

| | |
|---|---|
| `vvOffsets` / `vvNeighbors` | vertex → vertex (who is one edge away) |
| `vfOffsets` / `vfFaces` | vertex → face (which triangles touch me) |

Row `v` is `neighbors[offsets[v] … offsets[v+1]]`. **Offsets are exact** — no
padding, so no empty-slot sentinel and no index bias. Read a row with
`neighbors(adj, v)` / `incidentFaces(adj, v)`, which return subarray views
rather than copies.

`components(adj, subset)` labels connected components *within a subset* of
vertices — the operation that turns a painted patch into individual measurable
planes, since one component is one plane. Ids ascend with vertex order, so a
rerun cannot relabel.

Degenerate input is tolerated rather than rejected: a triangle referencing a
vertex out of range is skipped (and counted in `skipped`), and one with a
repeated corner contributes only its real edges. Field meshes are not clean.

## Why it exists

Four packages were carrying their own copy of "BVH + mesh topology". This is the
one copy. `@gcu/winding` is now the generalized winding number *on* groma;
`@gcu/facet` will be structural geology on it. `@gcu/peel` still has its own BVH
— folding it in is the follow-up, once this API has two real consumers proving
its shape rather than one speculative one.

## Build & test

```bash
node ext/groma/build.js      # -> index.js, self-contained ESM
node --test test/groma.test.mjs
```
