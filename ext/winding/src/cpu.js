// CPU winding number evaluation
// Used for testing and as fallback when WebGPU is unavailable

import { NODE_SIZE } from './bvh.js';

const PI4 = 4 * Math.PI;

// Van Oosterom-Strackee solid angle formula
// Returns the signed solid angle subtended by triangle (a,b,c) at point p
function solidAngle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const apx = ax - px, apy = ay - py, apz = az - pz;
  const bpx = bx - px, bpy = by - py, bpz = bz - pz;
  const cpx = cx - px, cpy = cy - py, cpz = cz - pz;

  const ra = Math.sqrt(apx * apx + apy * apy + apz * apz);
  const rb = Math.sqrt(bpx * bpx + bpy * bpy + bpz * bpz);
  const rc = Math.sqrt(cpx * cpx + cpy * cpy + cpz * cpz);

  if (ra < 1e-10 || rb < 1e-10 || rc < 1e-10) return 0; // point on vertex

  // numerator = a' . (b' x c')
  const crossX = bpy * cpz - bpz * cpy;
  const crossY = bpz * cpx - bpx * cpz;
  const crossZ = bpx * cpy - bpy * cpx;
  const num = apx * crossX + apy * crossY + apz * crossZ;

  // denominator = ra*rb*rc + (a'.b')*rc + (b'.c')*ra + (c'.a')*rb
  const ab = apx * bpx + apy * bpy + apz * bpz;
  const bc = bpx * cpx + bpy * cpy + bpz * cpz;
  const ca = cpx * apx + cpy * apy + cpz * apz;
  const den = ra * rb * rc + ab * rc + bc * ra + ca * rb;

  return 2 * Math.atan2(num, den);
}

// Brute-force winding number (no BVH) — for testing small meshes
function windingBrute(px, py, pz, vertices, triangles, triIndices) {
  let sum = 0;
  const n = triIndices ? triIndices.length : triangles.length / 3;
  for (let i = 0; i < n; i++) {
    const ti = triIndices ? triIndices[i] : i;
    const a = triangles[ti * 3], b = triangles[ti * 3 + 1], c = triangles[ti * 3 + 2];
    sum += solidAngle(px, py, pz,
      vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
      vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2],
      vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]);
  }
  return sum / PI4;
}

// BVH-accelerated winding number with Barill far-field dipoles (Fast Winding
// Numbers for Soups and Clouds, SIGGRAPH 2018, order 1): a node whose whole
// subtree is far away (dist > BETA × subtree radius) contributes as a single
// dipole — Ω ≈ N·(c−p)/d³ — instead of an exact per-triangle descent. Turns
// per-query cost from O(triangles) into ~O(log triangles).
const WINDING_BETA2 = 9;                                   // β = 3 — order-1 dipole stays within ~0.5% of exact
function windingBVH(px, py, pz, vertices, triangles, bvhNodes, triIndices) {
  let sum = 0;
  const stack = [0]; // start at root

  while (stack.length > 0) {
    const nodeIdx = stack.pop();
    const off = nodeIdx * NODE_SIZE;

    // far field: the subtree as one dipole
    const qx = bvhNodes[off + 8] - px, qy = bvhNodes[off + 9] - py, qz = bvhNodes[off + 10] - pz;
    const d2 = qx * qx + qy * qy + qz * qz;
    const r = bvhNodes[off + 14];
    if (d2 > WINDING_BETA2 * r * r) {
      sum += (bvhNodes[off + 11] * qx + bvhNodes[off + 12] * qy + bvhNodes[off + 13] * qz) / (d2 * Math.sqrt(d2));
      continue;
    }

    const data2 = bvhNodes[off + 7];

    if (data2 > 0) {
      // Leaf node: data1 = first, data2 = count
      const first = bvhNodes[off + 6];
      const count = data2;
      for (let i = first; i < first + count; i++) {
        const ti = triIndices[i];
        const a = triangles[ti * 3], b = triangles[ti * 3 + 1], c = triangles[ti * 3 + 2];
        sum += solidAngle(px, py, pz,
          vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
          vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2],
          vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]);
      }
    } else {
      // Internal node: data1 = left, data2 = -(right) - 1
      const left = bvhNodes[off + 6];
      const right = -(data2) - 1;
      stack.push(left);
      stack.push(right);
    }
  }

  return sum / PI4;
}

// Evaluate block model on CPU
// opts.onProgress: async (fraction) => void — called per z-layer, yields to UI
async function evaluateCPU(vertices, triangles, bvhNodes, triIndices, blockModel, opts = {}) {
  const { mode = 'proportion', resolution = [4, 4, 4], threshold = 0.5, onProgress } = opts;
  const { origin, size, count } = blockModel;
  const [nx, ny, nz] = count;
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = size;
  const [sx, sy, sz] = resolution;
  const total = nx * ny * nz;

  const useBVH = bvhNodes && bvhNodes.length > 0;

  function winding(px, py, pz) {
    if (useBVH) return windingBVH(px, py, pz, vertices, triangles, bvhNodes, triIndices);
    return windingBrute(px, py, pz, vertices, triangles, triIndices);
  }

  // yield to main thread so UI can update
  const yield_ = onProgress
    ? () => new Promise(r => setTimeout(r, 0))
    : null;

  if (mode === 'flag') {
    const flags = new Uint8Array(total);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const px = ox + (i + 0.5) * dx;
          const py = oy + (j + 0.5) * dy;
          const pz = oz + (k + 0.5) * dz;
          const w = winding(px, py, pz);
          flags[i + j * nx + k * nx * ny] = w >= threshold ? 1 : 0;
        }
      }
      if (onProgress) {
        onProgress((k + 1) / nz);
        await yield_();
      }
    }
    return { flags };
  }

  // Proportion mode
  const proportions = new Float32Array(total);
  const flags = new Uint8Array(total);
  const subTotal = sx * sy * sz;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let inside = 0;
        for (let sk = 0; sk < sz; sk++) {
          for (let sj = 0; sj < sy; sj++) {
            for (let si = 0; si < sx; si++) {
              const px = ox + (i + (si + 0.5) / sx) * dx;
              const py = oy + (j + (sj + 0.5) / sy) * dy;
              const pz = oz + (k + (sk + 0.5) / sz) * dz;
              const w = winding(px, py, pz);
              if (w >= threshold) inside++;
            }
          }
        }
        const idx = i + j * nx + k * nx * ny;
        proportions[idx] = inside / subTotal;
        flags[idx] = proportions[idx] >= threshold ? 1 : 0;
      }
    }
    if (onProgress) {
      onProgress((k + 1) / nz);
      await yield_();
    }
  }

  return { proportions, flags };
}

export { solidAngle, windingBrute, windingBVH, evaluateCPU, WINDING_BETA2 };
