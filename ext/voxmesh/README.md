# @gcu/voxmesh

Greedy voxel meshing for block models and volumetric data. Binning, bucket aggregation, chunked meshing, convenience wrappers. Produces triangle meshes suitable for Three.js, WebGPU, or any renderer.

Part of [Auditable](https://github.com/gentropic/auditable). Designed to pair with [@gcu/grid](https://www.npmjs.com/package/@gcu/grid) (block model) and [@gcu/dee](https://www.npmjs.com/package/@gcu/dee) (Three.js scene).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/voxmesh
```

## Usage

```js
import { prepare, mesh } from '@gcu/voxmesh';

// grid: { origin, size, count }
// values: Float32Array of length nx*ny*nz
const bins = prepare(grid, values, { cutoff: 0.5 });
const { positions, normals, indices, colors } = mesh(grid, bins);
```

Sub-path imports: `@gcu/voxmesh/bin`, `@gcu/voxmesh/chunk`, `@gcu/voxmesh/bucket`, `@gcu/voxmesh/mesh`, `@gcu/voxmesh/convenience`.

## License

MIT.
