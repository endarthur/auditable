# peel

Depth peeling surface intersection engine for triangulated meshes against block models. Casts rays along a configurable axis, collects all intersection depths via depth peeling, and derives block classification from 1D interval arithmetic.

Complements [winding](../winding/) — where winding provides robust inside/outside classification via a scalar field (ideal for imperfect meshes), peel provides the actual intersection geometry and is significantly faster for clean meshes on regular grids.

```js
const { Peel } = await load("./ext/peel/index.js");

const p = await Peel.create({ worker: true, gpu: true });
p.setMesh(vertices, triangles);
const { proportions, flags, overflow } = await p.evaluate({
  origin: [-2.75, -2.75, -2.75],  // centroid of block (0,0,0)
  size: [0.5, 0.5, 0.5],
  count: [12, 12, 12],
}, { axis: 'z', surfaceType: 'closed', maxPeels: 16 });
```

---

## API

### `Peel.create(opts?)`

Create a Peel instance.

```js
const p = await Peel.create({ worker: true, gpu: true });  // worker with GPU (recommended)
const p = await Peel.create({ worker: true });              // worker CPU only
const p = await Peel.create({ device: gpuDevice });         // main-thread GPU
const p = await Peel.create();                              // main-thread CPU
```

| Option | Default | Description |
|--------|---------|-------------|
| `worker` | `false` | Run evaluation in a Web Worker (off main thread) |
| `gpu` | `false` | Let the worker request its own GPUDevice (requires `worker: true`) |
| `device` | — | Explicit `GPUDevice` for main-thread WebGPU |

Same priority and tradeoffs as winding. Worker+GPU is recommended for interactive use (paced dispatches). Main-thread GPU saturates fully for batch use.

### `p.setMesh(vertices, triangles, opts?)`

Load a triangle mesh. Builds a BVH on the main thread, copies data to worker if active.

- `vertices`: `Float32Array` — flat `[x0,y0,z0, x1,y1,z1, ...]`
- `triangles`: `Uint32Array` — flat `[a0,b0,c0, a1,b1,c1, ...]`

| Option | Default | Description |
|--------|---------|-------------|
| `name` | `'_default'` | Mesh name (for multi-surface workflows) |
| `maxLeafSize` | `4` | BVH leaf size |

**Returns** `{ nodeCount, triangleCount, degenerateCount }`.

### `p.evaluate(blockModel, opts?)`

Evaluate a single mesh against a block model.

- `blockModel`: `{ origin: [x,y,z], size: [dx,dy,dz], count: [nx,ny,nz] }`

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `'proportion'` | `'depths'`, `'flag'`, or `'proportion'` |
| `axis` | `'z'` | Peel axis: `'x'`, `'y'`, or `'z'` |
| `surfaceType` | `'closed'` | `'closed'` (pair depths as in/out intervals) or `'open'` (single intersection, classify below) |
| `maxPeels` | `16` | Max intersection depths per ray. Must be even for closed surfaces. WGSL shader is recompiled when this changes. |
| `resolution` | `[1,1]` | Sub-grid sampling on the grid plane `[su, sv]` |
| `mesh` | `'_default'` | Which loaded mesh to evaluate |
| `onProgress` | — | `(fraction) => void` — called per column row on all backends |

**Returns** depend on mode:

- **depths**: `{ depths: Float32Array, counts: Uint32Array, overflow: number }` — `maxPeels` values per column, unused slots = `+Infinity`
- **flag**: `{ flags: Uint8Array, overflow: number }`
- **proportion**: `{ proportions: Float32Array, flags: Uint8Array, overflow: number }`

`overflow` is the number of columns where intersections exceeded `maxPeels`. Non-zero overflow means some results may be incorrect — increase `maxPeels`.

Block index layout: `i + j * nx + k * nx * ny` (same as winding).

### `p.evaluateMultiple(blockModel, opts?)`

Evaluate multiple named surfaces against the same block model.

```js
p.setMesh(topoVerts, topoTris, { name: 'topo' });
p.setMesh(wxVerts, wxTris, { name: 'weathering' });
const results = await p.evaluateMultiple(blockModel, {
  surfaces: ['topo', 'weathering'],
  axis: 'z',
  surfaceType: 'open',
});
// results.topo.proportions, results.weathering.proportions
```

### `p.getBVH(name?)`

Get pre-built BVH data for sharing with other modules (e.g. winding). Returns `{ nodes: Float32Array, triIndices: Uint32Array }` or `null`.

### `p.hasGPU` / `p.hasWorker`

Booleans — same semantics as winding.

### `p.terminate()`

Terminate the worker. Falls back to main-thread GPU or CPU.

### `buildBVH(vertices, triangles, opts?)`

Low-level BVH construction. Same format and function as winding's `buildBVH` — the two modules share an identical BVH layout and can exchange pre-built trees.

---

## Architecture

```
src/
  bvh.js      — BVH construction (identical to winding)
  cpu.js      — CPU ray-triangle intersection + depth peeling evaluation
  gpu.js      — WebGPU compute (WGSL ray traversal, dynamic maxPeels compilation)
  worker.js   — Web Worker (inlines CPU+GPU via Function.toString())
  main.js     — Peel class (high-level API)
build.js      — bundles src/ into index.js
index.js      — BUILD OUTPUT
```

**Ray-triangle intersection**: Moller-Trumbore algorithm. Each ray collects up to `maxPeels` intersection depths via insertion sort into a fixed-size array.

**BVH ray traversal**: stack-based iterative traversal with ray-AABB slab test for culling. Same flat node layout as winding (8 floats per node).

**Interval classification**: for closed surfaces, depths are paired as in/out intervals. For open surfaces, single intersection divides ray into above/below. Proportion computation is exact 1D interval overlap — no sampling along the ray axis, only lateral sub-sampling on the grid plane.

**GPU dispatch**: 1D, one thread per ray. Shader is recompiled when `maxPeels` changes (WGSL requires compile-time array sizes). Proportion accumulation uses atomic u32 counters with scale factor, same pattern as winding.

---

## PEEL vs WINDING

| | PEEL | WINDING |
|---|---|---|
| Mesh quality | Clean (closed or single-sheet open) | Tolerant (holes, flipped normals) |
| Speed on regular grids | Very fast — O(columns) | Slower — O(blocks x sub-grid) |
| Output | Intersection geometry + classification | Scalar field + classification |
| Open surfaces | Natural | Natural |
| Failure mode | Column-wide misclassification | Local, graceful degradation |
| Arbitrary query points | No (grid-aligned rays) | Yes |

Use PEEL for production meshes (clean, validated geometry). Use WINDING as a safety net for uncertain mesh quality.

---

## Known issue: triangle edge artifacts

When a ray hits exactly on a shared edge between two triangles, floating-point precision determines whether it intersects triangle A, B, both, or neither. With regular surface and block grids, certain columns systematically align with edges, producing grid-pattern artifacts in proportions.

**Mitigation:** use `resolution: [2, 2]` — sub-rays at offset positions mostly avoid edges, and averaging gives correct proportions.

## Roadmap

- **Watertight ray-triangle intersection** — implement per Woop, Benthin, Wald (2013), "Watertight Ray/Triangle Intersection" (JCGT). Guarantees rays on shared edges hit exactly one adjacent triangle. Eliminates edge artifacts without resolution oversampling. Change is in `src/bvh.js` ray-triangle test (Moller-Trumbore → watertight).
- **Arbitrary ray direction** — non-axis-aligned rays for oblique cross-sections and dipping geology
- **Section mode** — cutting plane intersection returning polyline segments
- **Drillhole intersection** — polyline rays, not grid-aligned
- **Horizontal slab processing** — for block models exceeding GPU memory
