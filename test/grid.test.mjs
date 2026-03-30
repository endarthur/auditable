import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  ijk, flatIndex, isValid, ijkBatch, flatIndexBatch,
  centroid, corners, centroids, centroidsSubset, locate, locateBatch,
  nBlocks, blockVolume, boundingBox, isCompatible, subgrid,
  maskToIndices, indicesToMask, union, intersection, difference, invert, maskCount, equal,
  scatter, gather, take, reindex,
  maskAboveValue, maskBelowValue, maskEqualTo, maskInRange, maskNotNaN, maskWhere,
  align, reduce, dilute, sum, mean, min, max, countPresent,
  unionIndices, intersectionIndices, differenceIndices, restrict,
  dominantDomain, domainFromCategorical,
  map, mapMasked, combine, stats, histogram, gradeTonnage, swathPlot,
  column, sliceI, sliceJ, sliceK, slicePlane,
  shellGrid, erodeGrid, dilateGrid,
  nearestPopulated, upscale, downscale, regrid,
} = await import('../ext/grid/index.js');

const g3x4x2 = { origin: [0, 0, 0], size: [10, 10, 10], count: [3, 4, 2] };

// ── geometry: index conversion ──

describe('grid: index conversion', () => {
  it('flatIndex and ijk roundtrip', () => {
    for (let k = 0; k < 2; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 3; i++) {
      const fi = flatIndex(g3x4x2, i, j, k);
      const [ri, rj, rk] = ijk(g3x4x2, fi);
      assert.strictEqual(ri, i);
      assert.strictEqual(rj, j);
      assert.strictEqual(rk, k);
    }
  });

  it('isValid rejects out of bounds', () => {
    assert.strictEqual(isValid(g3x4x2, 0, 0, 0), true);
    assert.strictEqual(isValid(g3x4x2, 2, 3, 1), true);
    assert.strictEqual(isValid(g3x4x2, 3, 0, 0), false);
    assert.strictEqual(isValid(g3x4x2, -1, 0, 0), false);
  });

  it('batch versions match scalar', () => {
    const indices = new Int32Array([0, 5, 10, 23]);
    const { is, js, ks } = ijkBatch(g3x4x2, indices);
    for (let p = 0; p < indices.length; p++) {
      const [ei, ej, ek] = ijk(g3x4x2, indices[p]);
      assert.strictEqual(is[p], ei);
      assert.strictEqual(js[p], ej);
      assert.strictEqual(ks[p], ek);
    }
    const back = flatIndexBatch(g3x4x2, is, js, ks);
    assert.deepStrictEqual([...back], [...indices]);
  });
});

// ── geometry: coordinates ──

describe('grid: coordinates', () => {
  it('centroid of block (0,0,0) is origin', () => {
    const c = centroid(g3x4x2, 0);
    assert.deepStrictEqual(c, [0, 0, 0]);
  });

  it('centroid of block (1,2,1)', () => {
    const fi = flatIndex(g3x4x2, 1, 2, 1);
    const c = centroid(g3x4x2, fi);
    assert.deepStrictEqual(c, [10, 20, 10]);
  });

  it('corners produces 8 vertices', () => {
    const c = corners(g3x4x2, 0);
    assert.strictEqual(c.length, 24);
    // check that corners span half the block size in each direction
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < 8; i++) { minX = Math.min(minX, c[i * 3]); maxX = Math.max(maxX, c[i * 3]); }
    assert.strictEqual(maxX - minX, 10);
  });

  it('centroids returns all blocks', () => {
    const { xs, ys, zs } = centroids(g3x4x2);
    assert.strictEqual(xs.length, 24);
    assert.strictEqual(xs[0], 0);
    assert.strictEqual(ys[0], 0);
    assert.strictEqual(zs[0], 0);
  });

  it('centroidsSubset matches centroids', () => {
    const indices = new Int32Array([0, 5, 10]);
    const sub = centroidsSubset(g3x4x2, indices);
    const all = centroids(g3x4x2);
    for (let p = 0; p < indices.length; p++) {
      assert.strictEqual(sub.xs[p], all.xs[indices[p]]);
      assert.strictEqual(sub.ys[p], all.ys[indices[p]]);
    }
  });

  it('locate inverts centroid', () => {
    for (let idx = 0; idx < nBlocks(g3x4x2); idx++) {
      const c = centroid(g3x4x2, idx);
      assert.strictEqual(locate(g3x4x2, c[0], c[1], c[2]), idx);
    }
  });

  it('locate returns -1 for outside', () => {
    assert.strictEqual(locate(g3x4x2, -100, 0, 0), -1);
  });

  it('locateBatch matches locate', () => {
    const xs = new Float64Array([0, 10, -100]);
    const ys = new Float64Array([0, 20, 0]);
    const zs = new Float64Array([0, 10, 0]);
    const result = locateBatch(g3x4x2, xs, ys, zs);
    assert.strictEqual(result[0], locate(g3x4x2, 0, 0, 0));
    assert.strictEqual(result[1], locate(g3x4x2, 10, 20, 10));
    assert.strictEqual(result[2], -1);
  });
});

// ── geometry: properties ──

describe('grid: properties', () => {
  it('nBlocks', () => {
    assert.strictEqual(nBlocks(g3x4x2), 24);
  });

  it('blockVolume', () => {
    assert.strictEqual(blockVolume(g3x4x2), 1000);
  });

  it('boundingBox', () => {
    const bb = boundingBox(g3x4x2);
    assert.strictEqual(bb.min[0], -5);
    assert.strictEqual(bb.max[0], 25);
  });

  it('isCompatible', () => {
    assert.strictEqual(isCompatible(g3x4x2, { ...g3x4x2 }), true);
    assert.strictEqual(isCompatible(g3x4x2, { ...g3x4x2, count: [3, 4, 3] }), false);
  });
});

// ── subgrid ──

describe('grid: subgrid', () => {
  it('extracts correct sub-range', () => {
    const result = subgrid(g3x4x2, { iRange: [1, 2], jRange: [1, 2], kRange: [0, 1] });
    assert.strictEqual(result.gridDef.count[0], 2);
    assert.strictEqual(result.gridDef.count[1], 2);
    assert.strictEqual(result.gridDef.count[2], 2);
    assert.strictEqual(result.parentIndices.length, 8);
    // parent index of child (0,0,0) should be flatIndex(g, 1, 1, 0)
    assert.strictEqual(result.parentIndices[0], flatIndex(g3x4x2, 1, 1, 0));
  });
});

// ── selection: masks ──

describe('grid: selection', () => {
  it('maskToIndices and indicesToMask roundtrip', () => {
    const mask = new Uint8Array([0, 1, 0, 1, 1, 0]);
    const indices = maskToIndices(mask);
    assert.deepStrictEqual([...indices], [1, 3, 4]);
    const back = indicesToMask(indices, 6);
    assert.deepStrictEqual([...back], [...mask]);
  });

  it('union, intersection, difference', () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([0, 1, 1, 0]);
    assert.deepStrictEqual([...union(a, b)], [1, 1, 1, 0]);
    assert.deepStrictEqual([...intersection(a, b)], [0, 1, 0, 0]);
    assert.deepStrictEqual([...difference(a, b)], [1, 0, 0, 0]);
  });

  it('invert', () => {
    assert.deepStrictEqual([...invert(new Uint8Array([1, 0, 1]))], [0, 1, 0]);
  });

  it('maskCount', () => {
    assert.strictEqual(maskCount(new Uint8Array([1, 0, 1, 1])), 3);
  });

  it('equal', () => {
    assert.strictEqual(equal(new Uint8Array([1, 0]), new Uint8Array([1, 0])), true);
    assert.strictEqual(equal(new Uint8Array([1, 0]), new Uint8Array([0, 1])), false);
  });
});

// ── scatter / gather ──

describe('grid: scatter/gather', () => {
  it('scatter and gather roundtrip', () => {
    const indices = new Int32Array([1, 3, 5]);
    const compact = new Float64Array([10, 20, 30]);
    const full = scatter(compact, indices, 6, NaN);
    assert.strictEqual(full[1], 10);
    assert.strictEqual(full[3], 20);
    assert.ok(isNaN(full[0]));
    const back = gather(full, indices);
    assert.deepStrictEqual([...back], [10, 20, 30]);
  });

  it('take subsets compact', () => {
    const compact = new Float64Array([10, 20, 30, 40]);
    const result = take(compact, new Int32Array([0, 3]));
    assert.deepStrictEqual([...result], [10, 40]);
  });

  it('reindex finds positions via binary search', () => {
    const active = new Int32Array([10, 20, 30, 40, 50]);
    const query = new Int32Array([20, 40, 99]);
    const result = reindex(query, active);
    assert.deepStrictEqual([...result], [1, 3, -1]);
  });
});

// ── mask from variable ──

describe('grid: mask from variable', () => {
  it('maskAboveValue', () => {
    const v = new Float64Array([1, 5, 3, 7, 2]);
    assert.deepStrictEqual([...maskAboveValue(v, 4)], [0, 1, 0, 1, 0]);
  });

  it('maskNotNaN', () => {
    const v = new Float64Array([1, NaN, 3, NaN]);
    assert.deepStrictEqual([...maskNotNaN(v)], [1, 0, 1, 0]);
  });

  it('maskWhere with predicate', () => {
    const v = new Float64Array([1, 2, 3, 4]);
    assert.deepStrictEqual([...maskWhere(v, x => x % 2 === 0)], [0, 1, 0, 1]);
  });
});

// ── compact variables ──

describe('grid: compact variables', () => {
  it('align merges different index sets', () => {
    const a = { values: new Float64Array([10, 20]), indices: new Int32Array([0, 2]) };
    const b = { values: new Float64Array([30, 40]), indices: new Int32Array([1, 2]) };
    const result = align([a, b]);
    assert.deepStrictEqual([...result.indices], [0, 1, 2]);
    assert.strictEqual(result.aligned[0][2], 20); // a at index 2
    assert.strictEqual(result.aligned[1][2], 40); // b at index 2
    assert.ok(isNaN(result.aligned[0][1])); // a missing at index 1
    assert.ok(isNaN(result.aligned[1][0])); // b missing at index 0
  });

  it('reduce across compact vars', () => {
    const a = { values: new Float64Array([10, 20]), indices: new Int32Array([0, 1]) };
    const b = { values: new Float64Array([5, 15]), indices: new Int32Array([0, 1]) };
    const result = reduce([a, b], (vals) => vals[0] + vals[1]);
    assert.deepStrictEqual([...result.values], [15, 35]);
  });

  it('sum across compact vars', () => {
    const a = { values: new Float64Array([1, 2]), indices: new Int32Array([0, 1]) };
    const b = { values: new Float64Array([3, 4]), indices: new Int32Array([1, 2]) };
    const result = sum([a, b]);
    assert.strictEqual(result.values[0], 1); // only a at index 0
    assert.strictEqual(result.values[1], 5); // a + b at index 1
    assert.strictEqual(result.values[2], 4); // only b at index 2
  });

  it('mean skips NaN', () => {
    const a = { values: new Float64Array([10]), indices: new Int32Array([0]) };
    const b = { values: new Float64Array([30]), indices: new Int32Array([0]) };
    const result = mean([a, b]);
    assert.strictEqual(result.values[0], 20);
  });

  it('unionIndices / intersectionIndices / differenceIndices', () => {
    const a = new Int32Array([1, 3, 5]);
    const b = new Int32Array([3, 5, 7]);
    assert.deepStrictEqual([...unionIndices(a, b)], [1, 3, 5, 7]);
    assert.deepStrictEqual([...intersectionIndices(a, b)], [3, 5]);
    assert.deepStrictEqual([...differenceIndices(a, b)], [1]);
  });

  it('restrict filters compact var', () => {
    const cv = { values: new Float64Array([10, 20, 30]), indices: new Int32Array([1, 3, 5]) };
    const result = restrict(cv, new Int32Array([3, 5]));
    assert.deepStrictEqual([...result.indices], [3, 5]);
    assert.deepStrictEqual([...result.values], [20, 30]);
  });
});

// ── domain operations ──

describe('grid: domain operations', () => {
  it('dominantDomain picks highest proportion', () => {
    const d1 = { indices: new Int32Array([0, 1]), proportions: new Float64Array([0.7, 0.3]) };
    const d2 = { indices: new Int32Array([0, 1]), proportions: new Float64Array([0.3, 0.7]) };
    const result = dominantDomain([d1, d2], [1, 2]);
    assert.strictEqual(result.values[0], 1);
    assert.strictEqual(result.values[1], 2);
  });

  it('domainFromCategorical extracts indices', () => {
    const cat = { values: new Int32Array([1, 2, 1, 3, 2]), indices: new Int32Array([0, 1, 2, 3, 4]) };
    const result = domainFromCategorical(cat, 2);
    assert.deepStrictEqual([...result], [1, 4]);
  });
});

// ── variable operations ──

describe('grid: variable operations', () => {
  it('map applies function', () => {
    const v = new Float64Array([1, 2, 3]);
    const result = map(v, x => x * 2);
    assert.deepStrictEqual([...result], [2, 4, 6]);
  });

  it('mapMasked only applies where mask=1', () => {
    const v = new Float64Array([1, 2, 3]);
    const mask = new Uint8Array([1, 0, 1]);
    const result = mapMasked(v, mask, x => x * 10);
    assert.deepStrictEqual([...result], [10, 2, 30]);
  });

  it('combine two variables', () => {
    const a = new Float64Array([1, 2, 3]);
    const b = new Float64Array([10, 20, 30]);
    const result = combine(a, b, (x, y) => x + y);
    assert.deepStrictEqual([...result], [11, 22, 33]);
  });

  it('stats computes correctly', () => {
    const v = new Float64Array([3, 1, 4, 1, 5, 9, 2, 6]);
    const s = stats(v);
    assert.strictEqual(s.count, 8);
    assert.strictEqual(s.min, 1);
    assert.strictEqual(s.max, 9);
    assert.ok(Math.abs(s.mean - 3.875) < 0.001);
    assert.strictEqual(s.sum, 31);
  });

  it('histogram bins data', () => {
    const v = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const h = histogram(v, { nBins: 5 });
    assert.strictEqual(h.edges.length, 6);
    assert.strictEqual(h.counts.length, 5);
    let total = 0;
    for (let i = 0; i < h.counts.length; i++) total += h.counts[i];
    assert.strictEqual(total, 10);
  });
});

// ── grade-tonnage ──

describe('grid: grade-tonnage', () => {
  it('computes GT curve', () => {
    const g = { origin: [0, 0, 0], size: [1, 1, 1], count: [10, 1, 1] };
    const grade = new Float64Array(10);
    for (let i = 0; i < 10; i++) grade[i] = i * 0.5; // 0, 0.5, 1.0, ..., 4.5
    const gt = gradeTonnage(grade, 2.7, { gridDef: g, nCutoffs: 5 });
    assert.strictEqual(gt.cutoffs.length, 5);
    // at cutoff 0, all 10 blocks are above
    assert.strictEqual(gt.nBlocks[0], 10);
    // at highest cutoff, fewer blocks
    assert.ok(gt.nBlocks[gt.nBlocks.length - 1] <= 10);
    // tonnage should decrease with increasing cutoff
    for (let i = 1; i < gt.cutoffs.length; i++) {
      assert.ok(gt.tonnes[i] <= gt.tonnes[i - 1]);
    }
  });
});

// ── swath plot ──

describe('grid: swath plot', () => {
  it('computes mean per slice', () => {
    const g = { origin: [0, 0, 0], size: [1, 1, 1], count: [3, 1, 1] };
    const v = new Float64Array([10, 20, 30]);
    const sp = swathPlot(v, g, { axis: 'x' });
    assert.strictEqual(sp.positions.length, 3);
    assert.strictEqual(sp.values[0], 10);
    assert.strictEqual(sp.values[1], 20);
    assert.strictEqual(sp.values[2], 30);
  });
});

// ── spatial: slices ──

describe('grid: spatial queries', () => {
  it('column extracts all Z for given i,j', () => {
    const col = column(g3x4x2, 1, 2);
    assert.strictEqual(col.length, 2);
    assert.strictEqual(col[0], flatIndex(g3x4x2, 1, 2, 0));
    assert.strictEqual(col[1], flatIndex(g3x4x2, 1, 2, 1));
  });

  it('sliceK extracts plan view', () => {
    const s = sliceK(g3x4x2, 0);
    assert.strictEqual(s.length, 12); // 3 * 4
    assert.strictEqual(s[0], 0);
  });

  it('sliceI and sliceJ have correct sizes', () => {
    assert.strictEqual(sliceI(g3x4x2, 0).length, 8); // 4 * 2
    assert.strictEqual(sliceJ(g3x4x2, 0).length, 6); // 3 * 2
  });

  it('slicePlane finds blocks near axis-aligned plane', () => {
    const s = slicePlane(g3x4x2, { point: [0, 15, 0], normal: [0, 1, 0] });
    // should find blocks at j=1 (y=10) and j=2 (y=20) since block size is 10
    assert.ok(s.length > 0);
  });
});

// ── morphology ──

describe('grid: morphology', () => {
  const g5 = { origin: [0, 0, 0], size: [1, 1, 1], count: [5, 5, 1] };

  it('dilateGrid expands mask by 1', () => {
    const mask = new Uint8Array(25);
    mask[flatIndex(g5, 2, 2, 0)] = 1; // center block
    const result = dilateGrid(g5, mask, 1);
    // center + 4 neighbors (no Z neighbors in 1-layer grid)
    assert.strictEqual(result[flatIndex(g5, 2, 2, 0)], 1);
    assert.strictEqual(result[flatIndex(g5, 1, 2, 0)], 1);
    assert.strictEqual(result[flatIndex(g5, 3, 2, 0)], 1);
    assert.strictEqual(result[flatIndex(g5, 2, 1, 0)], 1);
    assert.strictEqual(result[flatIndex(g5, 2, 3, 0)], 1);
    assert.strictEqual(result[flatIndex(g5, 0, 0, 0)], 0); // far corner
  });

  it('erodeGrid shrinks mask', () => {
    // 5x5x3 grid, fill a 3x3x3 block in center
    const g5z = { origin: [0, 0, 0], size: [1, 1, 1], count: [5, 5, 3] };
    const mask = new Uint8Array(75);
    for (let k = 0; k < 3; k++) for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) mask[flatIndex(g5z, i, j, k)] = 1;
    const result = erodeGrid(g5z, mask, 1);
    // center block (2,2,1) should survive — all 6 neighbors are in the mask
    assert.strictEqual(result[flatIndex(g5z, 2, 2, 1)], 1);
    // corner of 3x3x3 at (1,1,0) eroded — z=0 is boundary
    assert.strictEqual(result[flatIndex(g5z, 1, 1, 0)], 0);
  });
});

// ── reblocking ──

describe('grid: reblocking', () => {
  it('upscale 2x2x1 mean', () => {
    const g = { origin: [0, 0, 0], size: [1, 1, 1], count: [4, 4, 1] };
    const v = new Float64Array(16);
    for (let i = 0; i < 16; i++) v[i] = i;
    const result = upscale(g, v, { factor: [2, 2, 1], method: 'mean' });
    assert.strictEqual(result.gridDef.count[0], 2);
    assert.strictEqual(result.gridDef.count[1], 2);
    assert.strictEqual(result.support[0], 4);
    // mean of blocks 0,1,4,5 = (0+1+4+5)/4 = 2.5
    assert.strictEqual(result.variable[0], 2.5);
  });

  it('downscale 2x2x1', () => {
    const g = { origin: [0, 0, 0], size: [2, 2, 2], count: [2, 2, 1] };
    const v = new Float64Array([10, 20, 30, 40]);
    const result = downscale(g, v, { factor: [2, 2, 1] });
    assert.strictEqual(result.gridDef.count[0], 4);
    assert.strictEqual(result.gridDef.count[1], 4);
    assert.strictEqual(result.variable.length, 16);
    // all 4 fine blocks from coarse block 0 should have value 10
    assert.strictEqual(result.variable[0], 10);
    assert.strictEqual(result.variable[1], 10);
  });

  it('regrid nearest', () => {
    const srcG = { origin: [0, 0, 0], size: [10, 10, 10], count: [3, 3, 1] };
    const srcV = new Float64Array(9);
    for (let i = 0; i < 9; i++) srcV[i] = (i + 1) * 100;
    const tgtG = { origin: [5, 5, 0], size: [10, 10, 10], count: [2, 2, 1] };
    const result = regrid(srcG, srcV, tgtG);
    // target block (0,0,0) at world (5,5,0) → nearest source is (1,1,0) = index 4 → value 500
    // actually locate(src, 5, 5, 0) rounds to i=1, j=1
    assert.strictEqual(result[0], srcV[flatIndex(srcG, 1, 1, 0)]);
  });
});
