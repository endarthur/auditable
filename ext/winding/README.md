# winding

Generalized winding number evaluation for triangulated surfaces against block models. Based on [Jacobson et al., SIGGRAPH 2013](https://igl.ethz.ch/projects/winding-number/). Works correctly on closed solids, open surfaces, and imperfect meshes with holes or flipped normals.

```js
const { Winding } = await load("./ext/winding/index.js");

const w = await Winding.create();       // CPU-only (pass GPUDevice for WebGPU)
w.setMesh(vertices, triangles);          // Float32Array + Uint32Array
const { proportions, flags } = await w.evaluate({
  origin: [-3, -3, -3],
  size: [0.5, 0.5, 0.5],
  count: [12, 12, 12],
}, { resolution: [4, 4, 4], threshold: 0.5 });
```

~620 lines of source across 4 modules. Bundles to a single `index.js` (~25 KB).

---

## API

### `Winding.create(device?)`

Create a Winding instance. Pass a `GPUDevice` for WebGPU acceleration, or omit for CPU-only mode.

```js
const w = await Winding.create();           // CPU
const w = await Winding.create(gpuDevice);  // WebGPU
```

### `w.setMesh(vertices, triangles, opts?)`

Load a triangle mesh. Builds a BVH internally for accelerated queries.

- `vertices`: `Float32Array` — flat `[x0,y0,z0, x1,y1,z1, ...]`
- `triangles`: `Uint32Array` — flat `[a0,b0,c0, a1,b1,c1, ...]`

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `name` | `'_default'` | Mesh name (for multi-surface workflows) |
| `maxLeafSize` | `4` | BVH leaf size |

**Returns** `{ nodeCount, triangleCount, degenerateCount }`.

### `w.evaluate(blockModel, opts?)`

Evaluate a single mesh against a block model.

- `blockModel`: `{ origin: [x,y,z], size: [dx,dy,dz], count: [nx,ny,nz] }`
  - `origin` — corner of block (0,0,0)
  - `size` — dimensions of each block
  - `count` — number of blocks per axis

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `'proportion'` | `'flag'` (binary in/out) or `'proportion'` (volumetric fraction) |
| `resolution` | `[4,4,4]` | Sub-samples per block per axis (proportion mode) |
| `threshold` | `0.5` | Winding number threshold. Use `0.5` for closed solids, `0` for open surfaces |
| `mesh` | `'_default'` | Which loaded mesh to evaluate |
| `onProgress` | — | `async (fraction) => void` — called per z-layer, yields to UI |

**Returns** `{ proportions?: Float32Array, flags: Uint8Array }`.

- `proportions[i]` — fraction of sub-samples inside (0.0–1.0), only in proportion mode
- `flags[i]` — 1 if block is inside, 0 otherwise

Block index layout: `i + j * nx + k * nx * ny`.

### `w.evaluateMultiple(blockModel, opts?)`

Evaluate multiple named surfaces against the same block model.

```js
w.setMesh(hangingWall, hangingTris, { name: 'hw' });
w.setMesh(footWall, footTris, { name: 'fw' });
const results = await w.evaluateMultiple(blockModel, {
  surfaces: ['hw', 'fw'],
  resolution: [4, 4, 4],
});
// results.hw.proportions, results.fw.proportions
```

### `w.hasGPU`

Boolean — `true` if WebGPU acceleration is available.

### `buildBVH(vertices, triangles, opts?)`

Low-level: build a BVH directly (used internally by `setMesh`). Returns `{ nodes: Float32Array, triIndices: Uint32Array, nodeCount, degenerateCount }`.

---

## Architecture

```
src/
  bvh.js    — BVH construction (median-split, flat array layout)
  cpu.js    — CPU winding number evaluation (Van Oosterom–Strackee solid angle)
  gpu.js    — WebGPU compute path (WGSL shaders, atomic counters)
  main.js   — Winding class (high-level API)
build.js    — bundles src/ into index.js
index.js    — BUILD OUTPUT
```

**BVH node layout** (8 floats per node):

| Field | Leaf | Internal |
|-------|------|----------|
| `[0–2]` | AABB min | AABB min |
| `[3–5]` | AABB max | AABB max |
| `[6]` | first tri index | left child |
| `[7]` | count (> 0) | −(right child) − 1 |

**WebGPU path**: dispatches per z-block × z-sub-layer. Each workgroup (8×8) covers a tile of blocks × sub-samples in the XY plane. Atomic counters accumulate inside counts; a finalization pass converts to proportions.

---

## Roadmap

- **Web Worker support** — move CPU evaluation off the main thread. Currently `evaluateCPU` is async with per-z-layer yields (via `setTimeout(0)`) for UI responsiveness, but the actual computation still blocks between yields. A dedicated worker would fully unblock the main thread for large grids.
- **Far-field BVH approximation** — skip distant BVH nodes by approximating their solid angle contribution from the bounding box, reducing O(n) to O(log n) per query point.
- **Streaming results** — return partial results as z-layers complete, allowing progressive rendering.
