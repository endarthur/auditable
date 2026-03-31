// CPU depth peeling evaluation
// Moller-Trumbore ray-triangle intersection + BVH ray traversal + interval classification

import { NODE_SIZE } from './bvh.js';

// Axis configuration: maps axis name to ray direction, block axis index, and grid plane axes
const AXIS_MAP = {
  x: { dir: [1, 0, 0], blockAxis: 0, planeAxes: [1, 2] },
  y: { dir: [0, 1, 0], blockAxis: 1, planeAxes: [0, 2] },
  z: { dir: [0, 0, 1], blockAxis: 2, planeAxes: [0, 1] },
};

// Moller-Trumbore ray-triangle intersection
// Returns t > 0 on hit, -1 on miss
function rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  // h = d x e2
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det > -1e-8 && det < 1e-8) return -1; // parallel
  const f = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return -1;
  // q = s x e1
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return -1;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > 0 ? t : -1;
}

// Ray-AABB slab test (returns true if ray intersects box)
function rayAABB(ox, oy, oz, invDx, invDy, invDz, minX, minY, minZ, maxX, maxY, maxZ) {
  const t1x = (minX - ox) * invDx, t2x = (maxX - ox) * invDx;
  const t1y = (minY - oy) * invDy, t2y = (maxY - oy) * invDy;
  const t1z = (minZ - oz) * invDz, t2z = (maxZ - oz) * invDz;
  const tmin = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z));
  const tmax = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
  return tmax >= Math.max(tmin, 0);
}

// Insert depth into sorted array, maintaining order
// Deduplicates: skips if within epsilon of an existing depth (coplanar shared-edge triangles)
const DEPTH_EPS = 1e-6;

function insertDepth(depths, count, maxPeels, t) {
  // Check for duplicate (nearby existing depth)
  const n = Math.min(count, maxPeels);
  for (let i = 0; i < n; i++) {
    if (Math.abs(depths[i] - t) < DEPTH_EPS) return count; // skip duplicate
  }

  if (count < maxPeels) {
    let pos = count;
    while (pos > 0 && depths[pos - 1] > t) { depths[pos] = depths[pos - 1]; pos--; }
    depths[pos] = t;
    return count + 1;
  } else if (t < depths[maxPeels - 1]) {
    let pos = maxPeels - 1;
    while (pos > 0 && depths[pos - 1] > t) { depths[pos] = depths[pos - 1]; pos--; }
    depths[pos] = t;
    return count; // count stays at maxPeels (overflow)
  }
  return count;
}

// Cast a single ray through the BVH, collect intersection depths
function peelColumnBVH(ox, oy, oz, dx, dy, dz, vertices, triangles, bvhNodes, triIndices, maxPeels) {
  const depths = new Float32Array(maxPeels);
  depths.fill(Infinity);
  let count = 0;
  let overflow = false;

  const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
  const stack = [0];

  while (stack.length > 0) {
    const nodeIdx = stack.pop();
    const off = nodeIdx * NODE_SIZE;

    // Ray-AABB test
    if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
      bvhNodes[off], bvhNodes[off + 1], bvhNodes[off + 2],
      bvhNodes[off + 3], bvhNodes[off + 4], bvhNodes[off + 5])) {
      continue;
    }

    const data2 = bvhNodes[off + 7];

    if (data2 > 0) {
      // Leaf
      const first = bvhNodes[off + 6];
      const cnt = data2;
      for (let i = first; i < first + cnt; i++) {
        const ti = triIndices[i];
        const a = triangles[ti * 3], b = triangles[ti * 3 + 1], c = triangles[ti * 3 + 2];
        const t = rayTriangle(ox, oy, oz, dx, dy, dz,
          vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
          vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2],
          vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]);
        if (t > 0) {
          const prev = count;
          count = insertDepth(depths, count, maxPeels, t);
          if (prev >= maxPeels) overflow = true;
        }
      }
    } else {
      // Internal
      const left = bvhNodes[off + 6];
      const right = -(data2) - 1;
      stack.push(left);
      stack.push(right);
    }
  }

  return { depths, count: Math.min(count, maxPeels), overflow };
}

// Brute-force peel (no BVH) — for testing small meshes
function peelColumnBrute(ox, oy, oz, dx, dy, dz, vertices, triangles, triIndices, maxPeels) {
  const depths = new Float32Array(maxPeels);
  depths.fill(Infinity);
  let count = 0;
  let overflow = false;
  const n = triIndices ? triIndices.length : triangles.length / 3;

  for (let i = 0; i < n; i++) {
    const ti = triIndices ? triIndices[i] : i;
    const a = triangles[ti * 3], b = triangles[ti * 3 + 1], c = triangles[ti * 3 + 2];
    const t = rayTriangle(ox, oy, oz, dx, dy, dz,
      vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2],
      vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2],
      vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]);
    if (t > 0) {
      const prev = count;
      count = insertDepth(depths, count, maxPeels, t);
      if (prev >= maxPeels) overflow = true;
    }
  }

  return { depths, count: Math.min(count, maxPeels), overflow };
}

// Compute inside intervals from sorted depths
// closed: [d0,d1], [d2,d3], ... — paired in/out
// open: [d0, +Infinity] — below first intersection
function getIntervals(depths, count, surfaceType) {
  const intervals = [];
  if (count === 0) return intervals;

  if (surfaceType === 'open') {
    // Below the first intersection is "inside" (geological convention)
    intervals.push([-Infinity, depths[0]]);
  } else {
    // closed: pair depths
    for (let i = 0; i + 1 < count; i += 2) {
      intervals.push([depths[i], depths[i + 1]]);
    }
    // odd count: last unpaired extends to infinity
    if (count % 2 === 1) {
      intervals.push([depths[count - 1], Infinity]);
    }
  }
  return intervals;
}

// Compute overlap of inside intervals with a block extent [lo, hi]
function intervalOverlap(intervals, lo, hi) {
  let overlap = 0;
  for (let i = 0; i < intervals.length; i++) {
    const a = intervals[i][0], b = intervals[i][1];
    overlap += Math.max(0, Math.min(b, hi) - Math.max(a, lo));
  }
  return overlap;
}

// Main CPU evaluation
async function evaluateCPU(vertices, triangles, bvhNodes, triIndices, blockModel, opts = {}) {
  const {
    mode = 'proportion',
    axis = 'z',
    surfaceType = 'closed',
    maxPeels = 16,
    resolution = [1, 1],
    onProgress,
  } = opts;

  const { origin: _origin, size, count } = blockModel;
  // origin is block (0,0,0) centroid — convert to corner for internal math
  const origin = [_origin[0] - size[0] / 2, _origin[1] - size[1] / 2, _origin[2] - size[2] / 2];
  const [nx, ny, nz] = count;
  const total = nx * ny * nz;

  const cfg = AXIS_MAP[axis];
  if (!cfg) throw new Error(`Invalid axis: ${axis}`);
  const { dir, blockAxis, planeAxes } = cfg;
  const [dx, dy, dz] = dir;
  const [pu, pv] = planeAxes;
  const [su, sv] = resolution;

  // Grid dimensions on the peel plane
  const gridU = count[pu], gridV = count[pv];
  const nColumns = gridU * gridV;

  const useBVH = bvhNodes && bvhNodes.length > 0;
  const yield_ = onProgress ? () => new Promise(r => setTimeout(r, 0)) : null;

  function peel(ox, oy, oz) {
    if (useBVH) return peelColumnBVH(ox, oy, oz, dx, dy, dz, vertices, triangles, bvhNodes, triIndices, maxPeels);
    return peelColumnBrute(ox, oy, oz, dx, dy, dz, vertices, triangles, triIndices, maxPeels);
  }

  // Block index from (column_u, column_v, block_along_axis)
  // Always maps to i + j*nx + k*nx*ny
  function blockIndex(cu, cv, ba) {
    const ijk = [0, 0, 0];
    ijk[pu] = cu;
    ijk[pv] = cv;
    ijk[blockAxis] = ba;
    return ijk[0] + ijk[1] * nx + ijk[2] * nx * ny;
  }

  const nBlocksAlongAxis = count[blockAxis];
  let overflowCount = 0;

  if (mode === 'depths') {
    const allDepths = new Float32Array(maxPeels * nColumns);
    allDepths.fill(Infinity);
    const counts = new Uint32Array(nColumns);

    for (let cv = 0; cv < gridV; cv++) {
      for (let cu = 0; cu < gridU; cu++) {
        // Ray at column center
        const rayOrigin = [0, 0, 0];
        rayOrigin[pu] = origin[pu] + (cu + 0.5) * size[pu];
        rayOrigin[pv] = origin[pv] + (cv + 0.5) * size[pv];
        rayOrigin[blockAxis] = origin[blockAxis] - 1; // start before grid

        const col = peel(rayOrigin[0], rayOrigin[1], rayOrigin[2]);
        const colIdx = cu + cv * gridU;
        for (let d = 0; d < maxPeels; d++) allDepths[colIdx * maxPeels + d] = col.depths[d];
        counts[colIdx] = col.count;
        if (col.overflow) overflowCount++;
      }
      if (onProgress) { onProgress((cv + 1) / gridV); await yield_(); }
    }

    return { depths: allDepths, counts, overflow: overflowCount };
  }

  // Flag / proportion modes
  const proportions = mode === 'proportion' ? new Float32Array(total) : null;
  const flags = new Uint8Array(total);
  const subTotal = su * sv;

  for (let cv = 0; cv < gridV; cv++) {
    for (let cu = 0; cu < gridU; cu++) {
      // Accumulate across sub-rays
      const accum = new Float32Array(nBlocksAlongAxis);

      for (let svi = 0; svi < sv; svi++) {
        for (let sui = 0; sui < su; sui++) {
          const rayOrigin = [0, 0, 0];
          rayOrigin[pu] = origin[pu] + (cu + (sui + 0.5) / su) * size[pu];
          rayOrigin[pv] = origin[pv] + (cv + (svi + 0.5) / sv) * size[pv];
          rayOrigin[blockAxis] = origin[blockAxis] - 1;

          const col = peel(rayOrigin[0], rayOrigin[1], rayOrigin[2]);
          if (col.overflow) overflowCount++;

          // Convert depths (t values from ray origin) to positions along block axis
          const rayStart = rayOrigin[blockAxis];
          const intervals = getIntervals(col.depths, col.count, surfaceType);
          // Convert t-values to absolute positions along the block axis
          for (let iv = 0; iv < intervals.length; iv++) {
            intervals[iv][0] = isFinite(intervals[iv][0]) ? rayStart + intervals[iv][0] : intervals[iv][0];
            intervals[iv][1] = isFinite(intervals[iv][1]) ? rayStart + intervals[iv][1] : intervals[iv][1];
          }

          // Walk blocks along the ray axis
          for (let ba = 0; ba < nBlocksAlongAxis; ba++) {
            const lo = origin[blockAxis] + ba * size[blockAxis];
            const hi = lo + size[blockAxis];
            const overlap = intervalOverlap(intervals, lo, hi);
            accum[ba] += overlap / size[blockAxis];
          }
        }
      }

      // Write block results
      for (let ba = 0; ba < nBlocksAlongAxis; ba++) {
        const idx = blockIndex(cu, cv, ba);
        const p = accum[ba] / subTotal;
        if (proportions) proportions[idx] = p;
        flags[idx] = p > 0 ? 1 : 0;
      }
    }
    if (onProgress) { onProgress((cv + 1) / gridV); await yield_(); }
  }

  if (proportions) return { proportions, flags, overflow: overflowCount };
  return { flags, overflow: overflowCount };
}

export { rayTriangle, rayAABB, peelColumnBrute, peelColumnBVH, evaluateCPU, AXIS_MAP };
