# @gcu/grid

Regular block-model grid utilities: geometry (index/flat conversion, centroids, rotation), selections (masks, boolean ops, classification), compacting, operations (map, reduce, histogram, grade-tonnage, swath plots), spatial queries (slices, shells, regridding).

Part of [Auditable](https://github.com/gentropic/auditable). Used with [@gcu/voxmesh](https://www.npmjs.com/package/@gcu/voxmesh) and [@gcu/dee](https://www.npmjs.com/package/@gcu/dee) for 3D visualization.

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/grid
```

## Usage

```js
import { ijk, flatIndex, centroid, maskAboveValue, gradeTonnage } from '@gcu/grid';

const g = { origin: [0, 0, 0], size: [10, 10, 5], count: [100, 100, 20] };

flatIndex(g, 5, 7, 2);         // flat array index for (i=5, j=7, k=2)
centroid(g, 5, 7, 2);          // world-space centroid of that block

const grade = new Float32Array(/* ... */);
const ore = maskAboveValue(grade, 0.5);
gradeTonnage(grade, { density: 2.7, cutoffs: [0.1, 0.3, 0.5, 0.7] });
```

Sub-path imports: `@gcu/grid/geometry`, `@gcu/grid/selection`, `@gcu/grid/compact`, `@gcu/grid/operations`, `@gcu/grid/spatial`.

## License

MIT.
