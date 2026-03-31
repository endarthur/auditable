// PEEL — Depth Peeling Surface Intersection Engine
// Auto-generated from ext/peel/src/ — do not edit directly

// -- bvh.js --

// BVH (Bounding Volume Hierarchy) construction for triangle meshes
// Flat array layout for GPU-friendly traversal

// Node layout (8 floats per node):
// [min_x, min_y, min_z, max_x, max_y, max_z, left_or_first, count_or_right]
// Leaf: count > 0, first = index into reordered tri_indices
// Internal: count = 0, left/right = child node indices

const NODE_SIZE = 8;

function triCentroid(vertices, triangles, triIdx, axis) {
  const i0 = triangles[triIdx * 3] * 3 + axis;
  const i1 = triangles[triIdx * 3 + 1] * 3 + axis;
  const i2 = triangles[triIdx * 3 + 2] * 3 + axis;
  return (vertices[i0] + vertices[i1] + vertices[i2]) / 3;
}

function triBounds(vertices, triangles, triIdx) {
  const a = triangles[triIdx * 3], b = triangles[triIdx * 3 + 1], c = triangles[triIdx * 3 + 2];
  const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
  const bx = vertices[b * 3], by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2];
  const cx = vertices[c * 3], cy = vertices[c * 3 + 1], cz = vertices[c * 3 + 2];
  return [
    Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.min(az, bz, cz),
    Math.max(ax, bx, cx), Math.max(ay, by, cy), Math.max(az, bz, cz),
  ];
}

function triArea2(vertices, triangles, triIdx) {
  // Returns 2x the squared area (avoids sqrt)
  const a = triangles[triIdx * 3], b = triangles[triIdx * 3 + 1], c = triangles[triIdx * 3 + 2];
  const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
  const bx = vertices[b * 3] - ax, by = vertices[b * 3 + 1] - ay, bz = vertices[b * 3 + 2] - az;
  const cx = vertices[c * 3] - ax, cy = vertices[c * 3 + 1] - ay, cz = vertices[c * 3 + 2] - az;
  // cross product magnitude squared
  const nx = by * cz - bz * cy;
  const ny = bz * cx - bx * cz;
  const nz = bx * cy - by * cx;
  return nx * nx + ny * ny + nz * nz;
}

function buildBVH(vertices, triangles, { maxLeafSize = 4, degenerateEpsilon = 1e-6 } = {}) {
  const nTris = triangles.length / 3;
  if (nTris === 0) return { nodes: new Float32Array(0), triIndices: new Uint32Array(0), degenerateCount: 0 };

  // Compute mesh bounding box diagonal for degenerate threshold
  let mx0 = Infinity, my0 = Infinity, mz0 = Infinity;
  let mx1 = -Infinity, my1 = -Infinity, mz1 = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    mx0 = Math.min(mx0, vertices[i]); my0 = Math.min(my0, vertices[i + 1]); mz0 = Math.min(mz0, vertices[i + 2]);
    mx1 = Math.max(mx1, vertices[i]); my1 = Math.max(my1, vertices[i + 1]); mz1 = Math.max(mz1, vertices[i + 2]);
  }
  const diag = Math.sqrt((mx1 - mx0) ** 2 + (my1 - my0) ** 2 + (mz1 - mz0) ** 2);
  const areaThresh = (degenerateEpsilon * diag) ** 2;

  // Filter out degenerate triangles
  const validIndices = [];
  let degenerateCount = 0;
  for (let i = 0; i < nTris; i++) {
    if (triArea2(vertices, triangles, i) < areaThresh) {
      degenerateCount++;
    } else {
      validIndices.push(i);
    }
  }

  const n = validIndices.length;
  if (n === 0) return { nodes: new Float32Array(NODE_SIZE), triIndices: new Uint32Array(0), degenerateCount };

  // Working array of triangle indices (will be reordered by BVH build)
  const triIdx = new Uint32Array(validIndices);

  // Pre-allocate nodes (worst case: 2n-1 nodes for n leaves)
  const maxNodes = Math.max(2 * n, 1);
  const nodes = new Float32Array(maxNodes * NODE_SIZE);
  let nodeCount = 0;

  function allocNode() {
    return nodeCount++;
  }

  function computeBounds(start, count) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start; i < start + count; i++) {
      const b = triBounds(vertices, triangles, triIdx[i]);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]);
      x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); z1 = Math.max(z1, b[5]);
    }
    return [x0, y0, z0, x1, y1, z1];
  }

  function buildNode(start, count) {
    const idx = allocNode();
    const off = idx * NODE_SIZE;
    const bounds = computeBounds(start, count);
    nodes[off] = bounds[0]; nodes[off + 1] = bounds[1]; nodes[off + 2] = bounds[2];
    nodes[off + 3] = bounds[3]; nodes[off + 4] = bounds[4]; nodes[off + 5] = bounds[5];

    if (count <= maxLeafSize) {
      // Leaf node
      nodes[off + 6] = start;  // first
      nodes[off + 7] = count;  // count > 0 means leaf
      return idx;
    }

    // Split along longest axis
    const dx = bounds[3] - bounds[0];
    const dy = bounds[4] - bounds[1];
    const dz = bounds[5] - bounds[2];
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;

    // Median split: partition triIdx[start..start+count) by centroid
    const mid = start + (count >> 1);
    // Partial sort: nth_element approximation via simple partitioning
    partialSort(vertices, triangles, triIdx, start, start + count, mid, axis);

    const leftChild = buildNode(start, mid - start);
    const rightChild = buildNode(mid, start + count - mid);

    // Internal node
    nodes[off + 6] = leftChild;
    nodes[off + 7] = rightChild;
    // count = 0 means internal (already 0 from Float32Array init, but be explicit)
    // Wait — we used off+7 for right child. We need a way to distinguish leaf vs internal.
    // Convention: encode count in a separate way. Let's use:
    // off+6: for leaf = first_tri_index, for internal = left_child (as float, reinterpreted as int)
    // off+7: for leaf = count (> 0), for internal = right_child (reinterpreted, count=0 not possible since we store right)
    // Problem: right_child could be 0. Let's use negative count trick:
    // Actually, let's use a simpler approach: store count separately.
    // Revised layout: [minx, miny, minz, maxx, maxy, maxz, data1, data2]
    // Leaf: data1 = first, data2 = count (> 0)
    // Internal: data1 = left, data2 = -(right) - 1 (negative = internal flag)
    // Or even simpler: use the sign of data2. Positive = leaf count, negative = encode right child.

    // Use negative data2 to indicate internal node:
    // data2 < 0: internal, left = data1, right = -(data2) - 1
    // data2 > 0: leaf, first = data1, count = data2
    nodes[off + 6] = leftChild;
    nodes[off + 7] = -(rightChild) - 1;

    return idx;
  }

  buildNode(0, n);

  return {
    nodes: nodes.slice(0, nodeCount * NODE_SIZE),
    triIndices: triIdx,
    degenerateCount,
    nodeCount,
  };
}

function partialSort(vertices, triangles, indices, lo, hi, mid, axis) {
  // Simple quickselect to partition around median
  if (hi - lo <= 1) return;

  let left = lo, right = hi - 1;
  const pivotIdx = lo + ((hi - lo) >> 1);
  const pivotVal = triCentroid(vertices, triangles, indices[pivotIdx], axis);

  // Move pivot to end
  const tmp0 = indices[pivotIdx]; indices[pivotIdx] = indices[right]; indices[right] = tmp0;

  let store = lo;
  for (let i = lo; i < right; i++) {
    if (triCentroid(vertices, triangles, indices[i], axis) < pivotVal) {
      const t = indices[store]; indices[store] = indices[i]; indices[i] = t;
      store++;
    }
  }
  const t = indices[store]; indices[store] = indices[right]; indices[right] = t;

  if (store < mid) partialSort(vertices, triangles, indices, store + 1, hi, mid, axis);
  else if (store > mid) partialSort(vertices, triangles, indices, lo, store, mid, axis);
}

// -- cpu.js --

// CPU depth peeling evaluation
// Moller-Trumbore ray-triangle intersection + BVH ray traversal + interval classification


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

// -- gpu.js --

// WebGPU depth peeling evaluation

function generatePeelShader(maxPeels) {
  return /* wgsl */`
const MAX_PEELS: u32 = ${maxPeels}u;
const DEPTH_EPS: f32 = 1e-6;

struct Params {
  origin: vec3<f32>,
  _pad0: f32,
  block_size: vec3<f32>,
  _pad1: f32,
  block_count: vec3<u32>,
  axis: u32,          // 0=x, 1=y, 2=z
  sub_uv: vec2<u32>,  // su, sv
  grid_uv: vec2<u32>, // gridU, gridV
  mode: u32,          // 0=depths, 1=flag, 2=proportion
  surface_type: u32,  // 0=closed, 1=open
  scale: u32,         // proportion scale factor
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> vertices: array<f32>;
@group(0) @binding(1) var<storage, read> tri_indices: array<u32>;
@group(0) @binding(2) var<storage, read> bvh_nodes: array<f32>;
@group(0) @binding(3) var<storage, read> bvh_tri_indices: array<u32>;
@group(0) @binding(4) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> counts_out: array<atomic<u32>>;
@group(0) @binding(6) var<uniform> params: Params;

fn load_vertex(idx: u32) -> vec3<f32> {
  return vec3<f32>(vertices[idx * 3u], vertices[idx * 3u + 1u], vertices[idx * 3u + 2u]);
}

fn ray_triangle(o: vec3<f32>, d: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> f32 {
  let e1 = b - a;
  let e2 = c - a;
  let h = cross(d, e2);
  let det = dot(e1, h);
  if (abs(det) < 1e-8) { return -1.0; }
  let f = 1.0 / det;
  let s = o - a;
  let u = f * dot(s, h);
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let q = cross(s, e1);
  let v = f * dot(d, q);
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  let t = f * dot(e2, q);
  if (t > 0.0) { return t; }
  return -1.0;
}

fn ray_aabb(o: vec3<f32>, inv_d: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>) -> bool {
  let t1 = (bmin - o) * inv_d;
  let t2 = (bmax - o) * inv_d;
  let tmin = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
  let tmax = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
  return tmax >= max(tmin, 0.0);
}

fn insert_depth(depths: ptr<function, array<f32, MAX_PEELS>>, count: ptr<function, u32>, t: f32) -> bool {
  let n = min(*count, MAX_PEELS);
  for (var i = 0u; i < n; i++) {
    if (abs((*depths)[i] - t) < DEPTH_EPS) { return false; }
  }
  if (*count < MAX_PEELS) {
    var pos = *count;
    while (pos > 0u && (*depths)[pos - 1u] > t) {
      (*depths)[pos] = (*depths)[pos - 1u];
      pos -= 1u;
    }
    (*depths)[pos] = t;
    *count += 1u;
    return false;
  } else if (t < (*depths)[MAX_PEELS - 1u]) {
    var pos = MAX_PEELS - 1u;
    while (pos > 0u && (*depths)[pos - 1u] > t) {
      (*depths)[pos] = (*depths)[pos - 1u];
      pos -= 1u;
    }
    (*depths)[pos] = t;
    return true; // overflow
  }
  return false;
}

// Get axis component from vec3
fn axis_val(v: vec3<f32>, a: u32) -> f32 {
  return select(select(v.x, v.y, a == 1u), v.z, a == 2u);
}

fn axis_valu(v: vec3<u32>, a: u32) -> u32 {
  return select(select(v.x, v.y, a == 1u), v.z, a == 2u);
}

// Plane axes for given block axis
fn plane_axis_0(a: u32) -> u32 { return select(select(1u, 0u, a == 1u), 0u, a == 2u); }
fn plane_axis_1(a: u32) -> u32 { return select(select(2u, 2u, a == 1u), 1u, a == 2u); }

fn set_axis(v: ptr<function, vec3<f32>>, a: u32, val: f32) {
  if (a == 0u) { (*v).x = val; }
  else if (a == 1u) { (*v).y = val; }
  else { (*v).z = val; }
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ray_idx = gid.x;
  let total_u = params.grid_uv.x * params.sub_uv.x;
  let total_v = params.grid_uv.y * params.sub_uv.y;
  let total_rays = total_u * total_v;
  if (ray_idx >= total_rays) { return; }

  let ui = ray_idx % total_u;
  let vi = ray_idx / total_u;
  let col_u = ui / params.sub_uv.x;
  let col_v = vi / params.sub_uv.y;
  let sub_u = ui % params.sub_uv.x;
  let sub_v = vi % params.sub_uv.y;

  let ba = params.axis;
  let pa0 = plane_axis_0(ba);
  let pa1 = plane_axis_1(ba);

  // Ray origin
  var ray_origin = vec3<f32>(0.0, 0.0, 0.0);
  let u_pos = axis_val(params.origin, pa0) + (f32(col_u) + (f32(sub_u) + 0.5) / f32(params.sub_uv.x)) * axis_val(params.block_size, pa0);
  let v_pos = axis_val(params.origin, pa1) + (f32(col_v) + (f32(sub_v) + 0.5) / f32(params.sub_uv.y)) * axis_val(params.block_size, pa1);
  let ray_start = axis_val(params.origin, ba) - 1.0;
  set_axis(&ray_origin, pa0, u_pos);
  set_axis(&ray_origin, pa1, v_pos);
  set_axis(&ray_origin, ba, ray_start);

  // Ray direction (unit along axis)
  var ray_dir = vec3<f32>(0.0, 0.0, 0.0);
  set_axis(&ray_dir, ba, 1.0);
  let inv_d = 1.0 / ray_dir; // will have Inf for non-axis components

  // BVH traversal
  var depths: array<f32, MAX_PEELS>;
  for (var i = 0u; i < MAX_PEELS; i++) { depths[i] = 1e30; }
  var count: u32 = 0u;
  var overflow: bool = false;

  var stack: array<u32, 64>;
  var sp: u32 = 1u;
  stack[0] = 0u;

  while (sp > 0u) {
    sp -= 1u;
    let node_idx = stack[sp];
    let off = node_idx * 8u;
    let bmin = vec3<f32>(bvh_nodes[off], bvh_nodes[off + 1u], bvh_nodes[off + 2u]);
    let bmax = vec3<f32>(bvh_nodes[off + 3u], bvh_nodes[off + 4u], bvh_nodes[off + 5u]);

    if (!ray_aabb(ray_origin, inv_d, bmin, bmax)) { continue; }

    let data2 = bvh_nodes[off + 7u];
    if (data2 > 0.0) {
      let first = u32(bvh_nodes[off + 6u]);
      let cnt = u32(data2);
      for (var ti = first; ti < first + cnt; ti++) {
        let tri = bvh_tri_indices[ti];
        let a = load_vertex(tri_indices[tri * 3u]);
        let b = load_vertex(tri_indices[tri * 3u + 1u]);
        let c = load_vertex(tri_indices[tri * 3u + 2u]);
        let t = ray_triangle(ray_origin, ray_dir, a, b, c);
        if (t > 0.0) {
          let did_overflow = insert_depth(&depths, &count, t);
          overflow = overflow || did_overflow;
        }
      }
    } else {
      let left = u32(bvh_nodes[off + 6u]);
      let right = u32(-(data2) - 1.0);
      if (sp < 62u) {
        stack[sp] = left; sp += 1u;
        stack[sp] = right; sp += 1u;
      }
    }
  }

  let n = min(count, MAX_PEELS);
  let col_idx = col_u + col_v * params.grid_uv.x;

  // Overflow tracking (first slot of counts_out is used for per-column count,
  // overflow is tracked by atomicAdd on a separate counter at end of counts_out)
  if (overflow) {
    atomicAdd(&counts_out[params.grid_uv.x * params.grid_uv.y], 1u);
  }

  if (params.mode == 0u) {
    // Depths mode: write depths and count
    // Store depths as f32 bits in atomic u32 output
    for (var i = 0u; i < MAX_PEELS; i++) {
      atomicStore(&output[col_idx * MAX_PEELS + i], bitcast<u32>(depths[i]));
    }
    atomicStore(&counts_out[col_idx], n);
    return;
  }

  // Proportion/flag mode: compute interval overlaps
  let n_blocks = axis_valu(params.block_count, ba);
  let block_step = axis_val(params.block_size, ba);
  let block_origin = axis_val(params.origin, ba);

  // Build intervals based on surface type
  // For closed: [d0,d1], [d2,d3], ...
  // For open: [-inf, d0] (below first intersection)
  for (var bk = 0u; bk < n_blocks; bk++) {
    let lo = block_origin + f32(bk) * block_step;
    let hi = lo + block_step;
    var overlap: f32 = 0.0;

    if (params.surface_type == 1u) {
      // Open: inside is [-inf, first_intersection]
      if (n > 0u) {
        let abs_d = ray_start + depths[0];
        overlap = max(0.0, min(abs_d, hi) - lo);
        overlap = max(overlap, 0.0);
      }
    } else {
      // Closed: paired intervals
      for (var p = 0u; p + 1u < n; p += 2u) {
        let abs_a = ray_start + depths[p];
        let abs_b = ray_start + depths[p + 1u];
        overlap += max(0.0, min(abs_b, hi) - max(abs_a, lo));
      }
      // Odd count: last unpaired extends to +inf
      if (n % 2u == 1u) {
        let abs_a = ray_start + depths[n - 1u];
        overlap += max(0.0, hi - max(abs_a, lo));
      }
    }

    let proportion = overlap / block_step;
    let scaled = u32(proportion * f32(params.scale) + 0.5);

    // Map (col_u, col_v, bk) to block index i + j*nx + k*nx*ny
    var ijk = vec3<u32>(0u, 0u, 0u);
    if (ba == 0u) { ijk = vec3<u32>(bk, col_u, col_v); }
    else if (ba == 1u) { ijk = vec3<u32>(col_u, bk, col_v); }
    else { ijk = vec3<u32>(col_u, col_v, bk); }
    let block_idx = ijk.x + ijk.y * params.block_count.x + ijk.z * params.block_count.x * params.block_count.y;

    atomicAdd(&output[block_idx], scaled);
  }
}
`;
}

const FINALIZE_SHADER = /* wgsl */`
@group(0) @binding(0) var<storage, read> counters: array<u32>;
@group(0) @binding(1) var<storage, read_write> proportions: array<f32>;
@group(0) @binding(2) var<uniform> divisor: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= arrayLength(&proportions)) { return; }
  proportions[idx] = f32(counters[idx]) / f32(divisor);
}
`;

async function createGPUEvaluator(device) {
  const finalizeModule = device.createShaderModule({ code: FINALIZE_SHADER });
  const finalizePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: finalizeModule, entryPoint: 'main' },
  });

  // Cache compiled pipelines by maxPeels
  const pipelineCache = new Map();

  function getPipeline(maxPeels) {
    if (pipelineCache.has(maxPeels)) return pipelineCache.get(maxPeels);
    const mod = device.createShaderModule({ code: generatePeelShader(maxPeels) });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: mod, entryPoint: 'main' },
    });
    pipelineCache.set(maxPeels, pipeline);
    return pipeline;
  }

  return { device, getPipeline, finalizePipeline };
}

async function evaluateGPU(gpu, vertices, triangles, bvhNodes, triIndices, blockModel, opts = {}) {
  const { device, getPipeline, finalizePipeline } = gpu;
  const {
    mode = 'proportion', axis = 'z', surfaceType = 'closed',
    maxPeels = 16, resolution = [1, 1], onProgress,
  } = opts;

  const { origin: _origin, size, count } = blockModel;
  // origin is block (0,0,0) centroid — convert to corner for internal math
  const origin = [_origin[0] - size[0] / 2, _origin[1] - size[1] / 2, _origin[2] - size[2] / 2];
  const [nx, ny, nz] = count;
  const total = nx * ny * nz;

  const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const planeAxes = axisIdx === 0 ? [1, 2] : axisIdx === 1 ? [0, 2] : [0, 1];
  const [su, sv] = resolution;
  const gridU = count[planeAxes[0]], gridV = count[planeAxes[1]];
  const nColumns = gridU * gridV;
  const totalRays = gridU * su * gridV * sv;

  const SCALE = 10000;
  const pipeline = getPipeline(maxPeels);

  // Output size depends on mode
  const outputSize = mode === 'depths' ? maxPeels * nColumns * 4 : total * 4;
  const countsSize = (nColumns + 1) * 4; // +1 for overflow counter

  // Create buffers
  const vertBuf = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const triBuf = device.createBuffer({ size: triangles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhBuf = device.createBuffer({ size: bvhNodes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhTriBuf = device.createBuffer({ size: triIndices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outputBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const countsBuf = device.createBuffer({ size: countsSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const countsReadBuf = device.createBuffer({ size: countsSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // Params: 80 bytes
  const paramData = new ArrayBuffer(80);
  const paramF = new Float32Array(paramData);
  const paramU = new Uint32Array(paramData);
  paramF[0] = origin[0]; paramF[1] = origin[1]; paramF[2] = origin[2]; paramF[3] = 0;
  paramF[4] = size[0]; paramF[5] = size[1]; paramF[6] = size[2]; paramF[7] = 0;
  paramU[8] = nx; paramU[9] = ny; paramU[10] = nz; paramU[11] = axisIdx;
  paramU[12] = su; paramU[13] = sv; paramU[14] = gridU; paramU[15] = gridV;
  paramU[16] = mode === 'depths' ? 0 : mode === 'flag' ? 1 : 2;
  paramU[17] = surfaceType === 'open' ? 1 : 0;
  paramU[18] = SCALE;
  paramU[19] = 0;

  const paramBuf = device.createBuffer({ size: paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Upload
  device.queue.writeBuffer(vertBuf, 0, vertices);
  device.queue.writeBuffer(triBuf, 0, triangles);
  device.queue.writeBuffer(bvhBuf, 0, bvhNodes);
  device.queue.writeBuffer(bvhTriBuf, 0, triIndices);
  device.queue.writeBuffer(paramBuf, 0, paramData);

  // Clear output and counts
  {
    const enc = device.createCommandEncoder();
    enc.clearBuffer(outputBuf);
    enc.clearBuffer(countsBuf);
    device.queue.submit([enc.finish()]);
  }

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: vertBuf } },
      { binding: 1, resource: { buffer: triBuf } },
      { binding: 2, resource: { buffer: bvhBuf } },
      { binding: 3, resource: { buffer: bvhTriBuf } },
      { binding: 4, resource: { buffer: outputBuf } },
      { binding: 5, resource: { buffer: countsBuf } },
      { binding: 6, resource: { buffer: paramBuf } },
    ],
  });

  // Dispatch in batches for pacing
  const BATCH = 65536;
  const nDispatches = Math.ceil(totalRays / 64);
  // For simplicity, dispatch all at once (rays are independent)
  {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(nDispatches, 1, 1);
    pass.end();
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  if (onProgress) onProgress(0.5);

  if (mode !== 'depths' && mode !== 'flag') {
    // Finalize: counters → proportions
    const divisor = su * sv * SCALE;
    const divisorBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(divisorBuf, 0, new Uint32Array([divisor]));

    const propBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const finalBindGroup = device.createBindGroup({
      layout: finalizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: outputBuf } },
        { binding: 1, resource: { buffer: propBuf } },
        { binding: 2, resource: { buffer: divisorBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(finalizePipeline);
    pass.setBindGroup(0, finalBindGroup);
    pass.dispatchWorkgroups(Math.ceil(total / 64), 1, 1);
    pass.end();

    enc.copyBufferToBuffer(propBuf, 0, readBuf, 0, total * 4);
    enc.copyBufferToBuffer(countsBuf, 0, countsReadBuf, 0, countsSize);
    device.queue.submit([enc.finish()]);

    await device.queue.onSubmittedWorkDone();
    if (onProgress) onProgress(1.0);

    await readBuf.mapAsync(GPUMapMode.READ);
    const proportions = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    await countsReadBuf.mapAsync(GPUMapMode.READ);
    const countsData = new Uint32Array(countsReadBuf.getMappedRange().slice(0));
    countsReadBuf.unmap();
    const overflow = countsData[nColumns]; // overflow counter

    const flags = new Uint8Array(total);
    for (let i = 0; i < total; i++) flags[i] = proportions[i] > 0 ? 1 : 0;

    // Cleanup
    vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
    outputBuf.destroy(); countsBuf.destroy(); readBuf.destroy(); countsReadBuf.destroy();
    paramBuf.destroy(); propBuf.destroy(); divisorBuf.destroy();

    return { proportions, flags, overflow };
  }

  // Depths or flag mode: read output directly
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(outputBuf, 0, readBuf, 0, outputSize);
    enc.copyBufferToBuffer(countsBuf, 0, countsReadBuf, 0, countsSize);
    device.queue.submit([enc.finish()]);
  }

  await device.queue.onSubmittedWorkDone();
  if (onProgress) onProgress(1.0);

  await readBuf.mapAsync(GPUMapMode.READ);
  const outputData = new Uint32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  await countsReadBuf.mapAsync(GPUMapMode.READ);
  const countsData = new Uint32Array(countsReadBuf.getMappedRange().slice(0));
  countsReadBuf.unmap();
  const overflow = countsData[nColumns];

  // Cleanup
  vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
  outputBuf.destroy(); countsBuf.destroy(); readBuf.destroy(); countsReadBuf.destroy();
  paramBuf.destroy();

  if (mode === 'depths') {
    // Reinterpret u32 bits as f32
    const depths = new Float32Array(outputData.buffer);
    const counts = new Uint32Array(nColumns);
    for (let i = 0; i < nColumns; i++) counts[i] = countsData[i];
    return { depths, counts, overflow };
  }

  // Flag mode: output contains scaled proportions, threshold at > 0
  const flags = new Uint8Array(total);
  for (let i = 0; i < total; i++) flags[i] = outputData[i] > 0 ? 1 : 0;
  return { flags, overflow };
}

// -- worker.js --

// Web Worker for off-main-thread depth peeling evaluation (CPU and GPU paths)
// Worker blob inlines all evaluation code via Function.toString() + JSON.stringify()




function createPeelWorker(opts = {}) {
  const source = `
const NODE_SIZE = ${NODE_SIZE};
const AXIS_MAP = ${JSON.stringify(AXIS_MAP)};
const DEPTH_EPS = 1e-6;

// -- CPU path --
${rayTriangle.toString()}
${rayAABB.toString()}

function insertDepth(depths, count, maxPeels, t) {
  const n = Math.min(count, maxPeels);
  for (let i = 0; i < n; i++) {
    if (Math.abs(depths[i] - t) < DEPTH_EPS) return count;
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
    return count;
  }
  return count;
}

${peelColumnBrute.toString()}
${peelColumnBVH.toString()}

function getIntervals(depths, count, surfaceType) {
  const intervals = [];
  if (count === 0) return intervals;
  if (surfaceType === 'open') {
    intervals.push([-Infinity, depths[0]]);
  } else {
    for (let i = 0; i + 1 < count; i += 2) {
      intervals.push([depths[i], depths[i + 1]]);
    }
    if (count % 2 === 1) {
      intervals.push([depths[count - 1], Infinity]);
    }
  }
  return intervals;
}

function intervalOverlap(intervals, lo, hi) {
  let overlap = 0;
  for (let i = 0; i < intervals.length; i++) {
    const a = intervals[i][0], b = intervals[i][1];
    overlap += Math.max(0, Math.min(b, hi) - Math.max(a, lo));
  }
  return overlap;
}

${evaluateCPU.toString()}

// -- GPU path --
const generatePeelShader = ${generatePeelShader.toString()};
const FINALIZE_SHADER = ${JSON.stringify(FINALIZE_SHADER)};
${createGPUEvaluator.toString()}
${evaluateGPU.toString()}

const _meshes = new Map();
let _gpu = null;

async function init(tryGPU) {
  if (tryGPU) {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        _gpu = await createGPUEvaluator(device);
      }
    } catch (e) {}
  }
  self.postMessage({ type: 'ready', hasGPU: !!_gpu });
}

self.onmessage = async function(e) {
  const { type } = e.data;

  if (type === 'init') {
    await init(e.data.gpu);

  } else if (type === 'setMesh') {
    const { name, vertices, triangles, bvhNodes, triIndices } = e.data;
    _meshes.set(name, { vertices, triangles, bvhNodes, triIndices });

  } else if (type === 'evaluate') {
    const { name, blockModel, mode, axis, surfaceType, maxPeels, resolution } = e.data;
    const mesh = _meshes.get(name);
    if (!mesh) {
      self.postMessage({ type: 'error', message: 'Mesh not found: ' + name });
      return;
    }
    const opts = {
      mode: mode || 'proportion',
      axis: axis || 'z',
      surfaceType: surfaceType || 'closed',
      maxPeels: maxPeels || 16,
      resolution: resolution || [1, 1],
      onProgress: (frac) => self.postMessage({ type: 'progress', fraction: frac }),
    };
    try {
      let result;
      if (_gpu) {
        result = await evaluateGPU(_gpu, mesh.vertices, mesh.triangles,
          mesh.bvhNodes, mesh.triIndices, blockModel, opts);
      } else {
        result = await evaluateCPU(mesh.vertices, mesh.triangles,
          mesh.bvhNodes, mesh.triIndices, blockModel, opts);
      }
      const transfer = [];
      if (result.proportions) transfer.push(result.proportions.buffer);
      if (result.flags) transfer.push(result.flags.buffer);
      if (result.depths) transfer.push(result.depths.buffer);
      if (result.counts) transfer.push(result.counts.buffer);
      self.postMessage({
        type: 'result',
        proportions: result.proportions || null,
        flags: result.flags || null,
        depths: result.depths || null,
        counts: result.counts || null,
        overflow: result.overflow || 0,
      }, transfer);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }

  } else if (type === 'terminate') {
    self.close();
  }
};
`;
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);

  worker.postMessage({ type: 'init', gpu: !!opts.gpu });
  return worker;
}

async function initPeelWorker(opts = {}) {
  const worker = createPeelWorker(opts);
  const hasGPU = await new Promise((resolve, reject) => {
    function handler(e) {
      if (e.data.type === 'ready') {
        worker.removeEventListener('message', handler);
        resolve(e.data.hasGPU);
      }
    }
    worker.addEventListener('message', handler);
    worker.addEventListener('error', reject, { once: true });
  });
  return { worker, hasGPU };
}

function evaluateWorker(worker, meshName, blockModel, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onProgress } = opts;

    function handler(e) {
      const { type } = e.data;
      if (type === 'progress') {
        if (onProgress) onProgress(e.data.fraction);
      } else if (type === 'result') {
        worker.removeEventListener('message', handler);
        resolve({
          proportions: e.data.proportions,
          flags: e.data.flags,
          depths: e.data.depths,
          counts: e.data.counts,
          overflow: e.data.overflow,
        });
      } else if (type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.message));
      }
    }

    worker.addEventListener('message', handler);
    worker.addEventListener('error', reject, { once: true });

    worker.postMessage({
      type: 'evaluate',
      name: meshName,
      blockModel,
      mode: opts.mode,
      axis: opts.axis,
      surfaceType: opts.surfaceType,
      maxPeels: opts.maxPeels,
      resolution: opts.resolution,
    });
  });
}

// -- main.js --

// PEEL — Depth Peeling Surface Intersection Engine
// Main API: Peel.create({ device?, worker?, gpu? }), setMesh(), evaluate()





class Peel {
  constructor() {
    this._gpu = null;       // main-thread GPU evaluator
    this._worker = null;    // Worker instance
    this._workerGPU = false; // whether worker has GPU
    this._meshes = new Map();
    this._defaultMesh = null;
  }

  // Create a Peel instance
  // opts.device: GPUDevice for main-thread WebGPU
  // opts.worker: true to run evaluation in a Web Worker
  // opts.gpu: true to let the worker request its own GPUDevice (requires worker: true)
  static async create(opts = {}) {
    const { device, worker, gpu } = opts;
    const p = new Peel();

    if (device) {
      p._gpu = await createGPUEvaluator(device);
    }

    if (worker) {
      const result = await initPeelWorker({ gpu: !!gpu });
      p._worker = result.worker;
      p._workerGPU = result.hasGPU;
    }

    return p;
  }

  // Load a mesh. Builds BVH on main thread, sends to worker if active.
  setMesh(vertices, triangles, opts = {}) {
    const name = opts.name || '_default';
    const bvh = buildBVH(vertices, triangles, {
      maxLeafSize: opts.maxLeafSize || 4,
    });
    const mesh = { vertices, triangles, bvh };
    this._meshes.set(name, mesh);
    if (name === '_default' || this._meshes.size === 1) {
      this._defaultMesh = mesh;
    }

    if (this._worker) {
      this._worker.postMessage({
        type: 'setMesh',
        name,
        vertices: new Float32Array(vertices),
        triangles: new Uint32Array(triangles),
        bvhNodes: new Float32Array(bvh.nodes),
        triIndices: new Uint32Array(bvh.triIndices),
      });
    }

    return {
      nodeCount: bvh.nodeCount,
      triangleCount: bvh.triIndices.length,
      degenerateCount: bvh.degenerateCount,
    };
  }

  // Get pre-built BVH data (for sharing with other modules)
  getBVH(name) {
    const mesh = this._meshes.get(name || '_default') || this._defaultMesh;
    if (!mesh) return null;
    return { nodes: mesh.bvh.nodes, triIndices: mesh.bvh.triIndices };
  }

  // Evaluate a single mesh against a block model
  // Priority: worker (GPU or CPU) > main-thread GPU > main-thread CPU
  async evaluate(blockModel, opts = {}) {
    const meshName = opts.mesh || '_default';
    const mesh = this._meshes.get(meshName) || this._defaultMesh;
    if (!mesh) throw new Error('No mesh loaded. Call setMesh() first.');

    if (this._worker) {
      return evaluateWorker(this._worker, meshName, blockModel, opts);
    }

    const { vertices, triangles, bvh } = mesh;

    if (this._gpu) {
      return evaluateGPU(this._gpu, vertices, triangles,
        bvh.nodes, bvh.triIndices, blockModel, opts);
    }

    return evaluateCPU(vertices, triangles,
      bvh.nodes, bvh.triIndices, blockModel, opts);
  }

  // Evaluate multiple named surfaces against the same block model
  async evaluateMultiple(blockModel, opts = {}) {
    const { surfaces = [], ...evalOpts } = opts;
    const results = {};
    for (const name of surfaces) {
      results[name] = await this.evaluate(blockModel, { ...evalOpts, mesh: name });
    }
    return results;
  }

  // true if any GPU path is active (main-thread or worker)
  get hasGPU() { return this._gpu !== null || this._workerGPU; }
  get hasWorker() { return this._worker !== null; }

  // Terminate worker. Falls back to main-thread GPU or CPU.
  terminate() {
    if (this._worker) {
      this._worker.postMessage({ type: 'terminate' });
      this._worker = null;
      this._workerGPU = false;
    }
  }
}
export { Peel, buildBVH, evaluateCPU, rayTriangle, rayAABB, peelColumnBrute, peelColumnBVH, AXIS_MAP };
