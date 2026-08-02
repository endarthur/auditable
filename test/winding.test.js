import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Shim for modules that reference document
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

// --- Mesh generators ---

// Axis-aligned box as 12 triangles (outward-facing normals)
function boxMesh(x0, y0, z0, x1, y1, z1) {
  const vertices = new Float32Array([
    x0,y0,z0, x1,y0,z0, x1,y1,z0, x0,y1,z0, // bottom face (z0)
    x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1, // top face (z1)
  ]);
  // 6 faces, 2 triangles each = 12 triangles
  // Outward normals via right-hand rule
  const triangles = new Uint32Array([
    // bottom (-z): 0,2,1  0,3,2
    0,2,1, 0,3,2,
    // top (+z): 4,5,6  4,6,7
    4,5,6, 4,6,7,
    // front (-y): 0,1,5  0,5,4
    0,1,5, 0,5,4,
    // back (+y): 2,3,7  2,7,6
    2,3,7, 2,7,6,
    // left (-x): 0,4,7  0,7,3
    0,4,7, 0,7,3,
    // right (+x): 1,2,6  1,6,5
    1,2,6, 1,6,5,
  ]);
  return { vertices, triangles };
}

// Horizontal plane as 2 triangles at given z elevation
// Covers the rectangle [x0,y0] to [x1,y1]
function planeMesh(x0, y0, x1, y1, z) {
  const vertices = new Float32Array([
    x0, y0, z,
    x1, y0, z,
    x1, y1, z,
    x0, y1, z,
  ]);
  // Normals point +z (upward)
  const triangles = new Uint32Array([
    0, 1, 2,
    0, 2, 3,
  ]);
  return { vertices, triangles };
}

// Icosphere approximation (UV sphere for simplicity)
function sphereMesh(cx, cy, cz, r, slices, stacks) {
  slices = slices || 16;
  stacks = stacks || 8;
  const verts = [];
  const tris = [];

  // Generate vertices
  for (let j = 0; j <= stacks; j++) {
    const theta = Math.PI * j / stacks;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let i = 0; i <= slices; i++) {
      const phi = 2 * Math.PI * i / slices;
      verts.push(
        cx + r * sinT * Math.cos(phi),
        cy + r * sinT * Math.sin(phi),
        cz + r * cosT,
      );
    }
  }

  // Generate triangles
  for (let j = 0; j < stacks; j++) {
    for (let i = 0; i < slices; i++) {
      const a = j * (slices + 1) + i;
      const b = a + slices + 1;
      tris.push(a, b, a + 1);
      tris.push(a + 1, b, b + 1);
    }
  }

  return {
    vertices: new Float32Array(verts),
    triangles: new Uint32Array(tris),
  };
}

// --- Lazy imports (avoid top-level await) ---

let buildBVH, solidAngle, windingBrute, windingBVH, evaluateCPU;

async function loadModules() {
  if (buildBVH) return;
  const bvhMod = await import('../ext/groma/src/bvh.js');
  const cpuMod = await import('../ext/winding/src/cpu.js');
  buildBVH = bvhMod.buildBVH;
  solidAngle = cpuMod.solidAngle;
  windingBrute = cpuMod.windingBrute;
  windingBVH = cpuMod.windingBVH;
  evaluateCPU = cpuMod.evaluateCPU;
}

// --- Tests ---

describe('winding: solid angle', () => {
  it('point at center of large triangle sees ~2pi steradians', async () => {
    await loadModules();
    // Large triangle in the z=1 plane, point at origin
    // For a very large triangle overhead, solid angle approaches 2*pi
    const L = 1000;
    const omega = solidAngle(0, 0, 0,
      -L, -L, 1,
      L, -L, 1,
      0, L, 1);
    // Should be close to 2*pi (half sphere above)
    assert.ok(Math.abs(omega) > 5, `Expected ~2pi, got ${omega}`);
  });

  it('triangle far away subtends small angle', async () => {
    await loadModules();
    const omega = solidAngle(0, 0, 0,
      100, 100, 100,
      101, 100, 100,
      100, 101, 100);
    assert.ok(Math.abs(omega) < 0.001, `Expected ~0, got ${omega}`);
  });

  it('degenerate triangle subtends zero angle', async () => {
    await loadModules();
    // Collinear points
    const omega = solidAngle(0, 0, 0,
      1, 0, 0,
      2, 0, 0,
      3, 0, 0);
    assert.equal(omega, 0);
  });
});

describe('winding: BVH construction', () => {
  it('builds BVH for box mesh', async () => {
    await loadModules();
    const { vertices, triangles } = boxMesh(0, 0, 0, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);
    assert.ok(bvh.nodeCount > 0, 'Should have nodes');
    assert.equal(bvh.triIndices.length, 12, 'Box has 12 triangles');
    assert.equal(bvh.degenerateCount, 0, 'No degenerate triangles');
  });

  it('filters degenerate triangles', async () => {
    await loadModules();
    // Add a degenerate triangle (3 coincident points)
    const vertices = new Float32Array([
      0,0,0, 1,0,0, 0,1,0, // normal triangle
      5,5,5, 5,5,5, 5,5,5, // degenerate
    ]);
    const triangles = new Uint32Array([0,1,2, 3,4,5]);
    const bvh = buildBVH(vertices, triangles);
    assert.equal(bvh.degenerateCount, 1);
    assert.equal(bvh.triIndices.length, 1, 'Only 1 valid triangle');
  });

  it('handles empty mesh', async () => {
    await loadModules();
    const bvh = buildBVH(new Float32Array(0), new Uint32Array(0));
    assert.equal(bvh.triIndices.length, 0);
  });
});

describe('winding: brute-force winding number', () => {
  it('point inside box has winding number ~1', async () => {
    await loadModules();
    const { vertices, triangles } = boxMesh(0, 0, 0, 2, 2, 2);
    const w = windingBrute(1, 1, 1, vertices, triangles);
    assert.ok(Math.abs(w - 1) < 0.01, `Expected ~1, got ${w}`);
  });

  it('point outside box has winding number ~0', async () => {
    await loadModules();
    const { vertices, triangles } = boxMesh(0, 0, 0, 2, 2, 2);
    const w = windingBrute(5, 5, 5, vertices, triangles);
    assert.ok(Math.abs(w) < 0.01, `Expected ~0, got ${w}`);
  });

  it('point below horizontal plane has winding number ~0.5', async () => {
    await loadModules();
    // Large plane at z=5, point below at z=0
    const { vertices, triangles } = planeMesh(-100, -100, 100, 100, 5);
    const w = windingBrute(0, 0, 0, vertices, triangles);
    // Open surface: winding number should be ~0.5 for points below
    assert.ok(Math.abs(w - 0.5) < 0.05, `Expected ~0.5, got ${w}`);
  });

  it('point above horizontal plane has winding number ~-0.5', async () => {
    await loadModules();
    // Plane with normals pointing +z: below = +0.5, above = -0.5
    // (open surface winding numbers are +/-0.5, not 0.5/0)
    const { vertices, triangles } = planeMesh(-100, -100, 100, 100, 5);
    const w = windingBrute(0, 0, 10, vertices, triangles);
    assert.ok(Math.abs(w + 0.5) < 0.05, `Expected ~-0.5, got ${w}`);
  });
});

describe('winding: BVH-accelerated winding number', () => {
  it('matches brute-force for box', async () => {
    await loadModules();
    const { vertices, triangles } = boxMesh(0, 0, 0, 2, 2, 2);
    const bvh = buildBVH(vertices, triangles);

    const points = [
      [1, 1, 1],     // inside
      [5, 5, 5],     // outside
      [0, 0, 0],     // on corner
      [1, 1, 3],     // outside (above)
    ];

    for (const [px, py, pz] of points) {
      const brute = windingBrute(px, py, pz, vertices, triangles);
      const bvhW = windingBVH(px, py, pz, vertices, triangles, bvh.nodes, bvh.triIndices);
      assert.ok(Math.abs(brute - bvhW) < 1e-6,
        `Mismatch at (${px},${py},${pz}): brute=${brute}, bvh=${bvhW}`);
    }
  });

  it('matches brute-force for sphere', async () => {
    await loadModules();
    const { vertices, triangles } = sphereMesh(0, 0, 0, 5, 32, 16);
    const bvh = buildBVH(vertices, triangles);

    const points = [
      [0, 0, 0],    // center
      [2, 0, 0],    // inside
      [10, 0, 0],   // outside
    ];

    // the BVH path carries Barill order-1 far-field dipoles (beta = 3):
    // points deep inside/outside see well under 1% approximation error,
    // never enough to cross the 0.5 classification threshold (near-surface
    // queries stay on the exact path — nearby nodes fail the far-field test)
    for (const [px, py, pz] of points) {
      const brute = windingBrute(px, py, pz, vertices, triangles);
      const bvhW = windingBVH(px, py, pz, vertices, triangles, bvh.nodes, bvh.triIndices);
      assert.ok(Math.abs(brute - bvhW) < 0.02,
        `Mismatch at (${px},${py},${pz}): brute=${brute}, bvh=${bvhW}`);
      assert.equal(brute >= 0.5, bvhW >= 0.5, `classification flip at (${px},${py},${pz})`);
    }
  });
});

describe('winding: CPU block model evaluation', () => {
  it('flag mode: box inside block model', async () => {
    await loadModules();
    const { vertices, triangles } = boxMesh(1, 1, 1, 3, 3, 3);
    const bvh = buildBVH(vertices, triangles);

    const blockModel = {
      origin: [0, 0, 0],
      size: [1, 1, 1],
      count: [4, 4, 4],
    };

    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, blockModel, {
      mode: 'flag',
    });

    assert.equal(result.flags.length, 64);

    // Block (2,2,2) centroid is at (2.5, 2.5, 2.5) — inside the box
    assert.equal(result.flags[2 + 2 * 4 + 2 * 16], 1, 'Block inside should be flagged');

    // Block (0,0,0) centroid is at (0.5, 0.5, 0.5) — outside the box
    assert.equal(result.flags[0], 0, 'Block outside should not be flagged');
  });

  it('proportion mode: horizontal plane', async () => {
    await loadModules();
    // Plane at z=1.5, block model from z=0 to z=3 (3 layers of height 1)
    // Open surface: winding = +0.5 below, -0.5 above. Threshold 0 separates them.
    const { vertices, triangles } = planeMesh(-100, -100, 100, 100, 1.5);
    const bvh = buildBVH(vertices, triangles);

    const blockModel = {
      origin: [0, 0, 0],
      size: [1, 1, 1],
      count: [1, 1, 3],
    };

    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, blockModel, {
      mode: 'proportion',
      resolution: [1, 1, 4],
      threshold: 0, // open surface: below = w > 0
    });

    // Block k=0 (z=0 to z=1): fully below plane -> proportion ~1.0
    assert.ok(result.proportions[0] > 0.9, `Block 0 should be ~1.0, got ${result.proportions[0]}`);

    // Block k=1 (z=1 to z=2): plane at z=1.5, so ~0.5 proportion
    assert.ok(Math.abs(result.proportions[1] - 0.5) < 0.3, `Block 1 should be ~0.5, got ${result.proportions[1]}`);

    // Block k=2 (z=2 to z=3): fully above plane -> proportion ~0.0
    assert.ok(result.proportions[2] < 0.1, `Block 2 should be ~0.0, got ${result.proportions[2]}`);
  });

  it('proportion mode: box volume converges', async () => {
    await loadModules();
    // Unit box, block model perfectly enclosing it with 1x1x1 blocks
    const { vertices, triangles } = boxMesh(0, 0, 0, 1, 1, 1);
    const bvh = buildBVH(vertices, triangles);

    const blockModel = {
      origin: [-0.5, -0.5, -0.5],
      size: [1, 1, 1],
      count: [2, 2, 2],
    };

    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, blockModel, {
      mode: 'proportion',
      resolution: [4, 4, 4],
    });

    // Total volume should approximate the box volume (1.0)
    let totalVol = 0;
    for (let i = 0; i < result.proportions.length; i++) {
      totalVol += result.proportions[i]; // each block is 1x1x1, so proportion = volume
    }
    assert.ok(Math.abs(totalVol - 1.0) < 0.2, `Total volume should be ~1.0, got ${totalVol}`);
  });

  it('sphere volume approximation', async () => {
    await loadModules();
    const r = 2;
    const { vertices, triangles } = sphereMesh(0, 0, 0, r, 32, 16);
    const bvh = buildBVH(vertices, triangles);
    const expectedVol = (4 / 3) * Math.PI * r * r * r;

    const blockModel = {
      origin: [-3, -3, -3],
      size: [1, 1, 1],
      count: [6, 6, 6],
    };

    const result = await evaluateCPU(vertices, triangles, bvh.nodes, bvh.triIndices, blockModel, {
      mode: 'proportion',
      resolution: [2, 2, 2],
    });

    let totalVol = 0;
    for (let i = 0; i < result.proportions.length; i++) {
      totalVol += result.proportions[i];
    }
    // Coarse grid, so allow 20% error
    const error = Math.abs(totalVol - expectedVol) / expectedVol;
    assert.ok(error < 0.2, `Sphere volume error ${(error * 100).toFixed(1)}% (got ${totalVol.toFixed(2)}, expected ${expectedVol.toFixed(2)})`);
  });
});

describe('winding: robustness', () => {
  it('flipped triangles degrade gracefully', async () => {
    await loadModules();
    const { vertices, triangles } = boxMesh(0, 0, 0, 2, 2, 2);

    // Flip 2 of 12 triangles (swap first two vertex indices)
    const flipped = new Uint32Array(triangles);
    for (let i = 0; i < 2; i++) {
      const tmp = flipped[i * 3];
      flipped[i * 3] = flipped[i * 3 + 1];
      flipped[i * 3 + 1] = tmp;
    }

    const wClean = windingBrute(1, 1, 1, vertices, triangles);
    const wFlipped = windingBrute(1, 1, 1, vertices, flipped);

    // Should still be close to 1 (graceful degradation)
    assert.ok(wFlipped > 0.5, `Flipped mesh should still classify inside: ${wFlipped}`);
    // But not identical
    assert.ok(Math.abs(wClean - 1) < Math.abs(wFlipped - 1) + 0.01,
      'Clean mesh should be closer to 1 than flipped');
  });
});
