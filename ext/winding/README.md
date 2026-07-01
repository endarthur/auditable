# winding

Generalized winding number evaluation for triangulated surfaces against block models. Based on [Jacobson et al., SIGGRAPH 2013](https://igl.ethz.ch/projects/winding-number/). Works correctly on closed solids, open surfaces, and imperfect meshes with holes or flipped normals.

```js
const { Winding } = await load("./ext/winding/index.js");

const w = await Winding.create({ worker: true, gpu: true });
w.setMesh(vertices, triangles);  // Float32Array + Uint32Array
const { proportions, flags } = await w.evaluate({
  origin: [-3, -3, -3],
  size: [0.5, 0.5, 0.5],
  count: [12, 12, 12],
}, { resolution: [4, 4, 4], threshold: 0.5 });
```

~750 lines of source across 5 modules. Bundles to a single `index.js` (~31 KB).

---

## API

### `Winding.create(opts?)`

Create a Winding instance.

```js
const w = await Winding.create({ worker: true, gpu: true });  // worker with GPU (recommended)
const w = await Winding.create({ worker: true });              // worker CPU only
const w = await Winding.create({ device: gpuDevice });         // main-thread GPU
const w = await Winding.create();                              // main-thread CPU
```

| Option | Default | Description |
|--------|---------|-------------|
| `worker` | `false` | Run evaluation in a Web Worker (off main thread) |
| `gpu` | `false` | Let the worker request its own GPUDevice (requires `worker: true`) |
| `device` | — | Explicit `GPUDevice` for main-thread WebGPU |

**Priority**: worker > main-thread GPU > main-thread CPU. When `worker` is active, all evaluation runs off the main thread — the worker uses its own GPU if available, otherwise CPU.

**Choosing a mode:**

- `{ worker: true, gpu: true }` — recommended for interactive apps. Keeps the main thread free. The worker acquires its own GPU device; GPU dispatches are paced with `onSubmittedWorkDone()` so rendering on the main thread stays responsive. Falls back to worker CPU if WebGPU isn't available in the worker context.
- `{ device: gpuDevice }` — main-thread GPU with no pacing. Saturates the GPU fully, so fastest for batch/non-interactive use. Also useful when WebGPU isn't available in workers (e.g. Firefox) or when sharing a device with other GPU code.
- `{ worker: true }` — worker CPU only. Good fallback when WebGPU isn't available at all.
- `{}` or no args — main-thread CPU. Blocks the UI between per-z-layer yields. Fine for small grids or non-interactive use.

### `w.setMesh(vertices, triangles, opts?)`

Load a triangle mesh. Builds a BVH on the main thread (fast), copies data to worker if active.

- `vertices`: `Float32Array` — flat `[x0,y0,z0, x1,y1,z1, ...]`
- `triangles`: `Uint32Array` — flat `[a0,b0,c0, a1,b1,c1, ...]`

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

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `'proportion'` | `'flag'` (binary in/out) or `'proportion'` (volumetric fraction) |
| `resolution` | `[4,4,4]` | Sub-samples per block per axis (proportion mode) |
| `threshold` | `0.5` | Winding number threshold. Use `0.5` for closed solids, `0` for open surfaces |
| `mesh` | `'_default'` | Which loaded mesh to evaluate |
| `onProgress` | — | `(fraction) => void` — called per z-layer on all backends |

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

Boolean — `true` if any GPU path is active (main-thread or worker).

### `w.hasWorker`

Boolean — `true` if a Web Worker is active.

### `w.terminate()`

Terminate the worker (if any). The instance remains usable — falls back to main-thread GPU or CPU.

### `buildBVH(vertices, triangles, opts?)`

Low-level: build a BVH directly (used internally by `setMesh`). Returns `{ nodes: Float32Array, triIndices: Uint32Array, nodeCount, degenerateCount }`.

---

## Frame-aware coordinates (`@gcu/frame`)

Geological meshes live at projected magnitudes (UTM northing ~7.7×10⁶), where the
`Float32Array`/WGSL `f32` path resolves to ~0.5–1 m — the BVH slab tests and solid-angle
math degrade. Pass an [`@gcu/frame`](../frame/) to `setMesh` and `evaluate` and the engine
rebases world → a small-magnitude local origin **at full f64, before the f32 downcast**:

```js
import { makeFrame } from '@gcu/frame';
const frame = makeFrame({ origin: [600000, 7700000, 400], crs: 'EPSG:31983', units: 'm' });

w.setMesh(worldVertsF64, tris, { name: 'lens', frame });       // verts rebased before the BVH build
const { flags } = await w.evaluate(
  { origin: [600000, 7700000, 400], size: [10,10,10], count: [nx,ny,nz] },
  { frame, threshold: 0.5 },                                   // block origin rebased too
);
```

- Results (winding numbers/`flags`, per block index) are **translation-invariant** — only the
  geometry inputs are rebased; nothing maps back.
- Pass world verts as `Float64Array` on the frame path (the whole point is the f64 subtract);
  omit the frame for **verbatim legacy behaviour** (`Float32Array` world in, no rebase).
- `evaluate`/`evaluateMultiple` **require the block model and every surface share one frame** —
  a missing or mismatched frame throws (frame rebases, it never reprojects; CRS/units must match).

---

## Architecture

```
src/
  bvh.js      — BVH construction (median-split, flat array layout)
  cpu.js      — CPU evaluation (Van Oosterom–Strackee solid angle)
  gpu.js      — WebGPU compute (WGSL shaders, atomic counters, paced dispatches)
  worker.js   — Web Worker (inlines CPU+GPU code via Function.toString())
  main.js     — Winding class (high-level API, backend routing)
build.js      — bundles src/ into index.js
index.js      — BUILD OUTPUT
```

**BVH node layout** (8 floats per node):

| Field | Leaf | Internal |
|-------|------|----------|
| `[0–2]` | AABB min | AABB min |
| `[3–5]` | AABB max | AABB max |
| `[6]` | first tri index | left child |
| `[7]` | count (> 0) | −(right child) − 1 |

**WebGPU path**: dispatches per z-block × z-sub-layer. Each workgroup (8×8) covers a tile of blocks × sub-samples in the XY plane. Atomic counters accumulate inside counts; a finalization pass converts to proportions. GPU work is paced per z-block via `device.queue.onSubmittedWorkDone()` to avoid starving concurrent rendering on the same physical GPU.

**Worker blob**: constructed at runtime by serializing CPU and GPU evaluation functions via `Function.toString()` + `JSON.stringify()` into a blob URL. The worker tries `navigator.gpu.requestAdapter()` on init if `gpu: true` was requested; falls back to CPU if unavailable. Message protocol: `init` → `setMesh` → `evaluate` (with progress) → `result`.

---

## Roadmap

- **Far-field BVH approximation** — skip distant BVH nodes by approximating their solid angle contribution from the bounding box, reducing O(n) to O(log n) per query point.
- **Streaming results** — return partial results as z-layers complete, allowing progressive rendering.
