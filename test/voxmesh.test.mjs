import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  binBreaks, binQuantiles, discretize,
  chunk, chunkId, chunkRange,
  bucket, addGhosts,
  meshChunk, meshAll, meshSection,
  prepare, rebin,
} = await import('../ext/voxmesh/index.js');

const g = { origin: [0, 0, 0], size: [1, 1, 1], count: [4, 4, 4] };

// ── binning ──

describe('voxmesh: binning', () => {
  it('binBreaks evenly spaced', () => {
    const values = new Float64Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const breaks = binBreaks(values, { count: 5 });
    assert.strictEqual(breaks.length, 4);
    // breaks at 1.8, 3.6, 5.4, 7.2
    assert.ok(breaks[0] > 1 && breaks[0] < 3);
    assert.ok(breaks[1] > 3 && breaks[1] < 5);
  });

  it('binQuantiles at quantile boundaries', () => {
    const values = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const breaks = binQuantiles(values, { count: 4 });
    assert.strictEqual(breaks.length, 3);
  });

  it('discretize maps to bins', () => {
    const values = new Float64Array([0.5, 1.5, 2.5, 3.5]);
    const breaks = new Float64Array([1, 2, 3]);
    const bins = discretize(values, breaks);
    assert.strictEqual(bins[0], 0); // below first break
    assert.strictEqual(bins[1], 1);
    assert.strictEqual(bins[2], 2);
    assert.strictEqual(bins[3], 3); // above last break
  });

  it('discretize NaN → 255', () => {
    const bins = discretize(new Float64Array([NaN]), new Float64Array([1]));
    assert.strictEqual(bins[0], 255);
  });
});

// ── chunking ──

describe('voxmesh: chunking', () => {
  it('chunk dimensions and counts', () => {
    const c = chunk(g, { hint: 2 });
    assert.deepStrictEqual(c.chunkDims, [2, 2, 2]);
    assert.deepStrictEqual(c.chunkCount, [2, 2, 2]);
    assert.strictEqual(c.nChunks, 8);
  });

  it('chunkId maps ijk to chunk', () => {
    const c = chunk(g, { hint: 2 });
    assert.strictEqual(chunkId(c, 0, 0, 0), 0);
    assert.strictEqual(chunkId(c, 2, 0, 0), 1); // second chunk along X
    assert.strictEqual(chunkId(c, 0, 2, 0), 2); // second chunk along Y
  });

  it('chunkRange returns bounds', () => {
    const c = chunk(g, { hint: 2 });
    const r = chunkRange(c, 0);
    assert.strictEqual(r.i0, 0); assert.strictEqual(r.i1, 2);
    assert.strictEqual(r.j0, 0); assert.strictEqual(r.j1, 2);
    assert.strictEqual(r.k0, 0); assert.strictEqual(r.k1, 2);
  });

  it('hint clamped to grid size', () => {
    const small = { origin: [0, 0, 0], size: [1, 1, 1], count: [3, 2, 1] };
    const c = chunk(small, { hint: 32 });
    assert.deepStrictEqual(c.chunkDims, [3, 2, 1]);
    assert.strictEqual(c.nChunks, 1);
  });
});

// ── bucketing ──

describe('voxmesh: bucketing', () => {
  it('bucket groups blocks into chunks', () => {
    // 2x2x1 grid, all populated
    const small = { origin: [0, 0, 0], size: [1, 1, 1], count: [2, 2, 1] };
    const values = new Float64Array([1, 2, 3, 4]);
    const indices = new Int32Array([0, 1, 2, 3]);
    const bins = new Uint8Array([0, 0, 1, 1]);
    const c = chunk(small, { hint: 2 });
    const b = bucket(c, { values, indices }, bins);
    assert.strictEqual(b.size, 1); // all in one chunk
    const firstBucket = b.values().next().value;
    assert.strictEqual(firstBucket.n, 4);
  });

  it('bucket skips NaN (binId 255)', () => {
    const small = { origin: [0, 0, 0], size: [1, 1, 1], count: [2, 1, 1] };
    const values = new Float64Array([1, 2]);
    const indices = new Int32Array([0, 1]);
    const bins = new Uint8Array([0, 255]);
    const c = chunk(small, { hint: 32 });
    const b = bucket(c, { values, indices }, bins);
    const firstBucket = b.values().next().value;
    assert.strictEqual(firstBucket.n, 1);
  });

  it('addGhosts adds neighbor data', () => {
    // 4x1x1 grid, 2 chunks of size 2
    const g4 = { origin: [0, 0, 0], size: [1, 1, 1], count: [4, 1, 1] };
    const values = new Float64Array([1, 2, 3, 4]);
    const indices = new Int32Array([0, 1, 2, 3]);
    const bins = new Uint8Array([0, 0, 1, 1]);
    const c = chunk(g4, { hint: 2 });
    const b = bucket(c, { values, indices }, bins);
    addGhosts(c, b);
    // chunk 0 (blocks 0,1) should have ghost from block 2 (chunk 1)
    const chunk0 = b.get(0);
    assert.ok(chunk0.ghostBinIds.length > 0);
  });
});

// ── meshing ──

describe('voxmesh: meshing', () => {
  it('single block produces 6 faces (12 triangles)', () => {
    const g1 = { origin: [0, 0, 0], size: [1, 1, 1], count: [1, 1, 1] };
    const c = chunk(g1, { hint: 32 });
    const b = bucket(c, { values: new Float64Array([5]), indices: new Int32Array([0]) }, new Uint8Array([0]));
    addGhosts(c, b);
    const mesh = meshChunk(b.values().next().value, c, g1);
    assert.strictEqual(mesh.indices.length, 36); // 6 faces × 2 triangles × 3 indices
    assert.strictEqual(mesh.positions.length, 72); // 6 faces × 4 verts × 3 coords
    assert.strictEqual(mesh.binIds.length, 12); // 12 triangles
  });

  it('two adjacent same-bin blocks share internal face (culled)', () => {
    const g2 = { origin: [0, 0, 0], size: [1, 1, 1], count: [2, 1, 1] };
    const c = chunk(g2, { hint: 32 });
    const b = bucket(c, { values: new Float64Array([1, 1]), indices: new Int32Array([0, 1]) }, new Uint8Array([0, 0]));
    addGhosts(c, b);
    const mesh = meshChunk(b.values().next().value, c, g2);
    // 2 blocks, same bin: 10 external faces (2 cubes minus 2 shared internal faces)
    // plus greedy merging may merge some faces
    assert.ok(mesh.indices.length < 72); // less than 2 × 36 (two isolated cubes)
    assert.ok(mesh.indices.length > 0);
  });

  it('two adjacent different-bin blocks cull shared internal face', () => {
    const g2 = { origin: [0, 0, 0], size: [1, 1, 1], count: [2, 1, 1] };
    const c = chunk(g2, { hint: 32 });
    const b = bucket(c, { values: new Float64Array([1, 5]), indices: new Int32Array([0, 1]) }, new Uint8Array([0, 1]));
    addGhosts(c, b);
    const mesh = meshChunk(b.values().next().value, c, g2);
    // same as same-bin: shared internal face culled regardless of bin
    assert.ok(mesh.indices.length < 72, `expected culled: got ${mesh.indices.length}`);
  });

  it('meshAll produces one mesh per chunk', () => {
    const c = chunk(g, { hint: 2 });
    const n = 64;
    const values = new Float64Array(n).fill(1);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const bins = new Uint8Array(n).fill(0);
    const b = bucket(c, { values, indices }, bins);
    addGhosts(c, b);
    const meshes = meshAll(b, c, g);
    assert.ok(meshes.size > 0);
    for (const [_, mesh] of meshes) {
      assert.ok(mesh.positions.length > 0);
      assert.ok(mesh.indices.length > 0);
    }
  });

  it('greedy merging reduces triangle count', () => {
    // 4x4x1 all same bin — should merge into fewer quads than 16 individual faces
    const gFlat = { origin: [0, 0, 0], size: [1, 1, 1], count: [4, 4, 1] };
    const n = 16;
    const values = new Float64Array(n).fill(1);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const bins = new Uint8Array(n).fill(0);
    const c = chunk(gFlat, { hint: 32 });
    const b = bucket(c, { values, indices }, bins);
    addGhosts(c, b);
    const mesh = meshChunk(b.values().next().value, c, gFlat);
    // 16 blocks in a flat 4x4 layer: top face should merge to 1 quad (2 tris),
    // bottom face also 1 quad, edges should be merged too
    // total should be much less than 16 × 12 = 192 indices (unmerged)
    assert.ok(mesh.indices.length < 192, `expected merged: got ${mesh.indices.length}`);
  });

  it('mesh output has correct typed arrays', () => {
    const g1 = { origin: [5, 10, 15], size: [2, 3, 4], count: [1, 1, 1] };
    const c = chunk(g1, { hint: 32 });
    const b = bucket(c, { values: new Float64Array([1]), indices: new Int32Array([0]) }, new Uint8Array([0]));
    addGhosts(c, b);
    const mesh = meshChunk(b.values().next().value, c, g1);
    assert.ok(mesh.positions instanceof Float32Array);
    assert.ok(mesh.normals instanceof Float32Array);
    assert.ok(mesh.indices instanceof Uint32Array);
    assert.ok(mesh.binIds instanceof Uint8Array);
    assert.strictEqual(mesh.positions.length, mesh.normals.length);
  });
});

// ── section meshing ──

describe('voxmesh: section', () => {
  it('meshSection produces faces on the plane', () => {
    const gSec = { origin: [0, 0, 0], size: [1, 1, 1], count: [4, 4, 4] };
    const n = 64;
    const values = new Float64Array(n).fill(1);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const bins = new Uint8Array(n).fill(0);
    const mesh = meshSection(gSec, { values, indices }, bins, {
      point: [0, 2, 0], normal: [0, 1, 0],
    });
    assert.ok(mesh.positions.length > 0);
    assert.ok(mesh.indices.length > 0);
    // all normals should be (0,1,0)
    for (let i = 0; i < mesh.normals.length; i += 3) {
      assert.ok(Math.abs(mesh.normals[i]) < 0.01);
      assert.ok(Math.abs(mesh.normals[i + 1] - 1) < 0.01);
      assert.ok(Math.abs(mesh.normals[i + 2]) < 0.01);
    }
  });
});

// ── convenience: prepare ──

describe('voxmesh: prepare', () => {
  it('full pipeline in one call', () => {
    const n = 64;
    const values = new Float64Array(n);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) { values[i] = Math.random() * 10; indices[i] = i; }
    const result = prepare(g, { values, indices }, { count: 4, hint: 2 });
    assert.ok(result.meshes.size > 0);
    assert.ok(result.breaks.length > 0);
    assert.strictEqual(result.binIds.length, n);
  });

  it('categorical mode (no breaks)', () => {
    const n = 64;
    const values = new Float64Array(n);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) { values[i] = i % 3; indices[i] = i; }
    const result = prepare(g, { values, indices }, { hint: 2 });
    assert.strictEqual(result.breaks.length, 0); // no breaks for categorical
    assert.ok(result.meshes.size > 0);
  });

  it('rebin changes bin IDs', () => {
    const n = 64;
    const values = new Float64Array(n);
    const indices = new Int32Array(n);
    for (let i = 0; i < n; i++) { values[i] = i * 0.1; indices[i] = i; }
    const prepared = prepare(g, { values, indices }, { count: 4, hint: 2 });
    const oldBreaks = [...prepared.breaks];
    const result = rebin(prepared, { count: 2 });
    assert.ok(result.breaks.length < oldBreaks.length);
    assert.ok(result.meshes.size > 0);
  });
});
