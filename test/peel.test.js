import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Lazy imports (same pattern as winding tests)
let buildBVH, rayTriangle, rayAABB, peelColumnBrute, peelColumnBVH, evaluateCPU;

async function load() {
  if (buildBVH) return;
  ({ buildBVH } = await import('../ext/peel/src/bvh.js'));
  ({ rayTriangle, rayAABB, peelColumnBrute, peelColumnBVH, evaluateCPU } = await import('../ext/peel/src/cpu.js'));
}

// Test meshes
function boxMesh(x0, y0, z0, x1, y1, z1) {
  const v = new Float32Array([
    x0,y0,z0, x1,y0,z0, x1,y1,z0, x0,y1,z0,
    x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1,
  ]);
  const t = new Uint32Array([
    0,2,1, 0,3,2, 4,5,6, 4,6,7,
    0,1,5, 0,5,4, 2,3,7, 2,7,6,
    0,4,7, 0,7,3, 1,2,6, 1,6,5,
  ]);
  return { vertices: v, triangles: t };
}

function planeMeshZ(z) {
  // Horizontal plane at z, spanning [-10, 10] in x and y
  const v = new Float32Array([
    -10, -10, z,  10, -10, z,  10, 10, z,  -10, 10, z,
  ]);
  const t = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { vertices: v, triangles: t };
}

function sphereMesh(cx, cy, cz, r, slices, stacks) {
  const verts = [], tris = [];
  for (let j = 0; j <= stacks; j++) {
    const theta = Math.PI * j / stacks;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let i = 0; i <= slices; i++) {
      const phi = 2 * Math.PI * i / slices;
      verts.push(cx + r * sinT * Math.cos(phi), cy + r * sinT * Math.sin(phi), cz + r * cosT);
    }
  }
  for (let j = 0; j < stacks; j++) {
    for (let i = 0; i < slices; i++) {
      const a = j * (slices + 1) + i, b = a + slices + 1;
      tris.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { vertices: new Float32Array(verts), triangles: new Uint32Array(tris) };
}

describe('peel: ray-triangle intersection', () => {
  it('hits triangle along z', async () => {
    await load();
    // Triangle in z=5 plane
    const t = rayTriangle(0, 0, 0, 0, 0, 1, -1, -1, 5, 1, -1, 5, 0, 1, 5);
    assert.ok(Math.abs(t - 5) < 1e-6, `expected t=5, got ${t}`);
  });

  it('misses when ray is parallel', async () => {
    await load();
    // Ray along x, triangle in z=5 plane
    const t = rayTriangle(0, 0, 0, 1, 0, 0, -1, -1, 5, 1, -1, 5, 0, 1, 5);
    assert.equal(t, -1);
  });

  it('misses when outside triangle', async () => {
    await load();
    // Ray at (5, 5, 0) along z — outside small triangle
    const t = rayTriangle(5, 5, 0, 0, 0, 1, -1, -1, 5, 1, -1, 5, 0, 1, 5);
    assert.equal(t, -1);
  });

  it('returns -1 for negative t (behind ray)', async () => {
    await load();
    // Triangle behind origin
    const t = rayTriangle(0, 0, 10, 0, 0, 1, -1, -1, 5, 1, -1, 5, 0, 1, 5);
    assert.equal(t, -1);
  });
});

describe('peel: ray-AABB', () => {
  it('hits box along z', async () => {
    await load();
    // invD for dir (0,0,1) = (Inf, Inf, 1)
    assert.ok(rayAABB(0, 0, -5, Infinity, Infinity, 1, -1, -1, -1, 1, 1, 1));
  });

  it('misses box when ray points away', async () => {
    await load();
    // Ray origin above box, pointing up
    assert.ok(!rayAABB(0, 0, 5, Infinity, Infinity, 1, -1, -1, -1, 1, 1, 1));
  });

  it('misses box when ray is lateral', async () => {
    await load();
    // Ray at (5,5,0) along z — outside box
    assert.ok(!rayAABB(5, 5, 0, Infinity, Infinity, 1, -1, -1, -1, 1, 1, 1));
  });
});

describe('peel: column peeling', () => {
  it('one intersection through horizontal plane', async () => {
    await load();
    const { vertices, triangles } = planeMeshZ(5);
    const bvh = buildBVH(vertices, triangles);
    const col = peelColumnBVH(0, 0, 0, 0, 0, 1, vertices, triangles, bvh.nodes, bvh.triIndices, 16);
    assert.equal(col.count, 1);
    assert.ok(Math.abs(col.depths[0] - 5) < 1e-6);
  });

  it('two intersections through box', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    // Ray from (0, 0, -5) along z
    const col = peelColumnBVH(0, 0, -5, 0, 0, 1, vertices, triangles, bvh.nodes, bvh.triIndices, 16);
    assert.equal(col.count, 2);
    // Enter at z=-1 (t=4), exit at z=1 (t=6)
    assert.ok(Math.abs(col.depths[0] - 4) < 1e-6, `expected t=4, got ${col.depths[0]}`);
    assert.ok(Math.abs(col.depths[1] - 6) < 1e-6, `expected t=6, got ${col.depths[1]}`);
  });

  it('no intersection when ray misses box', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    const col = peelColumnBVH(5, 5, -5, 0, 0, 1, vertices, triangles, bvh.nodes, bvh.triIndices, 16);
    assert.equal(col.count, 0);
  });

  it('overflow detection', async () => {
    await load();
    // Stack two planes — 2 intersections with maxPeels=1
    const v = new Float32Array([
      -10, -10, 1, 10, -10, 1, 10, 10, 1, -10, 10, 1,
      -10, -10, 3, 10, -10, 3, 10, 10, 3, -10, 10, 3,
    ]);
    const t = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const bvh = buildBVH(v, t);
    const col = peelColumnBVH(0, 0, 0, 0, 0, 1, v, t, bvh.nodes, bvh.triIndices, 1);
    assert.equal(col.count, 1);
    assert.ok(col.overflow, 'should detect overflow');
  });

  it('brute force matches BVH', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    const brute = peelColumnBrute(0, 0, -5, 0, 0, 1, vertices, triangles, null, 16);
    const bvhCol = peelColumnBVH(0, 0, -5, 0, 0, 1, vertices, triangles, bvh.nodes, bvh.triIndices, 16);
    assert.equal(brute.count, bvhCol.count);
    for (let i = 0; i < brute.count; i++) {
      assert.ok(Math.abs(brute.depths[i] - bvhCol.depths[i]) < 1e-6);
    }
  });
});

describe('peel: CPU evaluation — flag mode', () => {
  it('closed box: interior blocks flagged', async () => {
    await load();
    const { vertices, triangles } = boxMesh(1, 1, 1, 3, 3, 3);
    const bvh = buildBVH(vertices, triangles);
    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [0, 0, 0], size: [1, 1, 1], count: [4, 4, 4],
    }, { mode: 'flag', axis: 'z', surfaceType: 'closed' });

    // Block (2,2,2) centroid (2.5, 2.5, 2.5) inside box
    assert.equal(result.flags[2 + 2 * 4 + 2 * 16], 1);
    // Block (0,0,0) centroid (0.5, 0.5, 0.5) outside box
    assert.equal(result.flags[0], 0);
  });

  it('open plane: blocks below flagged', async () => {
    await load();
    const { vertices, triangles } = planeMeshZ(1.5);
    const bvh = buildBVH(vertices, triangles);
    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [0, 0, 0], size: [1, 1, 1], count: [3, 3, 3],
    }, { mode: 'flag', axis: 'z', surfaceType: 'open' });

    // Block at k=0 (z=0..1): centroid at z=0.5, below plane at z=1.5 → inside
    assert.equal(result.flags[1 + 1 * 3 + 0 * 9], 1);
    // Block at k=2 (z=2..3): centroid at z=2.5, above plane at z=1.5 → outside
    assert.equal(result.flags[1 + 1 * 3 + 2 * 9], 0);
  });
});

describe('peel: CPU evaluation — proportion mode', () => {
  it('horizontal plane: exact proportions', async () => {
    await load();
    // Plane at z=1.5, blocks [0,3] in z, each block size 1
    const { vertices, triangles } = planeMeshZ(1.5);
    const bvh = buildBVH(vertices, triangles);
    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [-1, -1, 0], size: [2, 2, 1], count: [1, 1, 3],
    }, { mode: 'proportion', axis: 'z', surfaceType: 'open' });

    // Block k=0 (z=0..1): fully below plane → 1.0
    assert.ok(Math.abs(result.proportions[0] - 1.0) < 1e-6, `k=0: ${result.proportions[0]}`);
    // Block k=1 (z=1..2): plane at z=1.5 splits it → 0.5
    assert.ok(Math.abs(result.proportions[1] - 0.5) < 1e-6, `k=1: ${result.proportions[1]}`);
    // Block k=2 (z=2..3): fully above plane → 0.0
    assert.ok(Math.abs(result.proportions[2] - 0.0) < 1e-6, `k=2: ${result.proportions[2]}`);
  });

  it('closed box: total volume correct', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    // Block model enclosing the box
    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [-2, -2, -2], size: [0.5, 0.5, 0.5], count: [8, 8, 8],
    }, { mode: 'proportion', axis: 'z', surfaceType: 'closed' });

    let volSum = 0;
    for (let i = 0; i < result.proportions.length; i++) volSum += result.proportions[i];
    const volume = volSum * (0.5 ** 3);
    // Box volume = 2x2x2 = 8
    assert.ok(Math.abs(volume - 8) < 0.1, `volume=${volume}, expected 8`);
  });

  it('sphere volume converges', async () => {
    await load();
    const { vertices, triangles } = sphereMesh(0, 0, 0, 2, 24, 12);
    const bvh = buildBVH(vertices, triangles);
    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [-3, -3, -3], size: [0.5, 0.5, 0.5], count: [12, 12, 12],
    }, { mode: 'proportion', axis: 'z', surfaceType: 'closed', resolution: [2, 2] });

    let volSum = 0;
    for (let i = 0; i < result.proportions.length; i++) volSum += result.proportions[i];
    const volume = volSum * (0.5 ** 3);
    const exact = (4 / 3) * Math.PI * 8;
    const errPct = Math.abs(volume - exact) / exact * 100;
    assert.ok(errPct < 10, `sphere volume error ${errPct.toFixed(1)}% (got ${volume.toFixed(2)}, exact ${exact.toFixed(2)})`);
  });
});

describe('peel: axis selection', () => {
  it('axis x gives consistent results for symmetric box', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    const bm = { origin: [-2, -2, -2], size: [1, 1, 1], count: [4, 4, 4] };

    const rZ = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, bm,
      { mode: 'proportion', axis: 'z', surfaceType: 'closed' });
    const rX = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, bm,
      { mode: 'proportion', axis: 'x', surfaceType: 'closed' });

    // Total volumes should match (symmetric box)
    let volZ = 0, volX = 0;
    for (let i = 0; i < rZ.proportions.length; i++) volZ += rZ.proportions[i];
    for (let i = 0; i < rX.proportions.length; i++) volX += rX.proportions[i];
    assert.ok(Math.abs(volZ - volX) < 0.01, `z=${volZ}, x=${volX}`);
  });
});

describe('peel: overflow reporting', () => {
  it('reports overflow when maxPeels too small', async () => {
    await load();
    // Two planes = 2 intersections per column, maxPeels=1
    const v = new Float32Array([
      -10, -10, 1, 10, -10, 1, 10, 10, 1, -10, 10, 1,
      -10, -10, 3, 10, -10, 3, 10, 10, 3, -10, 10, 3,
    ]);
    const t = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const bvh = buildBVH(v, t);
    const result = await evaluateCPU(v, t, bvh.nodes, bvh.triIndices, {
      origin: [-1, -1, 0], size: [2, 2, 1], count: [1, 1, 4],
    }, { mode: 'proportion', axis: 'z', surfaceType: 'closed', maxPeels: 1 });

    assert.ok(result.overflow > 0, `expected overflow, got ${result.overflow}`);
  });

  it('no overflow with sufficient maxPeels', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [-2, -2, -2], size: [1, 1, 1], count: [4, 4, 4],
    }, { mode: 'proportion', axis: 'z', surfaceType: 'closed', maxPeels: 16 });

    assert.equal(result.overflow, 0);
  });
});

describe('peel: progress callback', () => {
  it('calls onProgress', async () => {
    await load();
    const { vertices, triangles } = boxMesh(-1, -1, -1, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    const fracs = [];
    await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, {
      origin: [-2, -2, -2], size: [1, 1, 1], count: [4, 4, 4],
    }, { mode: 'flag', axis: 'z', surfaceType: 'closed', onProgress: f => fracs.push(f) });

    assert.ok(fracs.length > 0, 'should have progress callbacks');
    assert.ok(Math.abs(fracs[fracs.length - 1] - 1.0) < 1e-6, 'last progress should be 1.0');
  });
});
