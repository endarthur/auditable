// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/winding — Generalized winding number solid containment for triangle meshes. CPU + WebGPU evaluators with BVH acceleration and optional Web Worker offload.

// ── src/bvh.js ──

// BVH (Bounding Volume Hierarchy) construction for triangle meshes
// Flat array layout for GPU-friendly traversal

// (superseded — see the 16-float layout above)
// [min_x, min_y, min_z, max_x, max_y, max_z, left_or_first, count_or_right]
// Leaf: count > 0, first = index into reordered tri_indices
// Internal: count = 0, left/right = child node indices

const NODE_SIZE = 16;
// Node layout (16 floats):
//   [0..5]  min/max bounds
//   [6..7]  data1/data2 (leaf: first/count; internal: left/-(right)-1)
//   [8..10] area-weighted centroid of the subtree's triangles
//   [11..13] vector area (Σ ½·e1×e2 — the far-field dipole strength)
//   [14]    conservative subtree radius (centroid → farthest bbox corner)
//   [15]    pad

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

    // Barill-style far-field data (Fast Winding Numbers, SIGGRAPH 2018):
    // the subtree's triangles as one dipole — area-weighted centroid, vector
    // area, and a conservative radius. Computed per node from its (contiguous,
    // already-partitioned) triangle range.
    {
      let aw = 1e-30, cxs = 0, cys = 0, czs = 0, nxs = 0, nys = 0, nzs = 0;
      for (let i = start; i < start + count; i++) {
        const ti = triIdx[i];
        const a = triangles[ti * 3] * 3, b = triangles[ti * 3 + 1] * 3, c = triangles[ti * 3 + 2] * 3;
        const e1x = vertices[b] - vertices[a], e1y = vertices[b + 1] - vertices[a + 1], e1z = vertices[b + 2] - vertices[a + 2];
        const e2x = vertices[c] - vertices[a], e2y = vertices[c + 1] - vertices[a + 1], e2z = vertices[c + 2] - vertices[a + 2];
        const vx = (e1y * e2z - e1z * e2y) / 2, vy = (e1z * e2x - e1x * e2z) / 2, vz = (e1x * e2y - e1y * e2x) / 2;
        const area = Math.sqrt(vx * vx + vy * vy + vz * vz);
        aw += area;
        cxs += area * (vertices[a] + vertices[b] + vertices[c]) / 3;
        cys += area * (vertices[a + 1] + vertices[b + 1] + vertices[c + 1]) / 3;
        czs += area * (vertices[a + 2] + vertices[b + 2] + vertices[c + 2]) / 3;
        nxs += vx; nys += vy; nzs += vz;
      }
      const ccx = cxs / aw, ccy = cys / aw, ccz = czs / aw;
      let r2 = 0;
      for (let ci = 0; ci < 8; ci++) {
        const px2 = bounds[(ci & 1) ? 3 : 0] - ccx;
        const py2 = bounds[(ci & 2) ? 4 : 1] - ccy;
        const pz2 = bounds[(ci & 4) ? 5 : 2] - ccz;
        const d2 = px2 * px2 + py2 * py2 + pz2 * pz2;
        if (d2 > r2) r2 = d2;
      }
      nodes[off + 8] = ccx; nodes[off + 9] = ccy; nodes[off + 10] = ccz;
      nodes[off + 11] = nxs; nodes[off + 12] = nys; nodes[off + 13] = nzs;
      nodes[off + 14] = Math.sqrt(r2);
      nodes[off + 15] = 0;
    }

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

// ── src/cpu.js ──

// CPU winding number evaluation
// Used for testing and as fallback when WebGPU is unavailable


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

// ── src/gpu.js ──

// WebGPU winding number evaluation

const WGSL_SHADER = /* wgsl */`
struct Params {
  origin: vec3<f32>,
  block_size_x: f32,
  block_size: vec3<f32>,
  block_count_x: u32,
  block_count: vec3<u32>,
  resolution_x: u32,
  resolution: vec3<u32>,
  threshold: f32,
  z_block: u32,
  z_sub: u32,
  _pad: u32,
}

struct BVHNode {
  min: vec3<f32>,
  max: vec3<f32>,
  data1: f32,  // leaf: first, internal: left child
  data2: f32,  // leaf: count > 0, internal: -(right) - 1
}

@group(0) @binding(0) var<storage, read> vertices: array<f32>;
@group(0) @binding(1) var<storage, read> tri_indices_raw: array<u32>;
@group(0) @binding(2) var<storage, read> bvh_nodes: array<f32>;
@group(0) @binding(3) var<storage, read> bvh_tri_indices: array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> params: Params;

fn solid_angle(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>) -> f32 {
  let ap = a - p;
  let bp = b - p;
  let cp = c - p;
  let ra = length(ap);
  let rb = length(bp);
  let rc = length(cp);

  if (ra < 1e-10 || rb < 1e-10 || rc < 1e-10) { return 0.0; }

  let num = dot(ap, cross(bp, cp));
  let den = ra * rb * rc + dot(ap, bp) * rc + dot(bp, cp) * ra + dot(cp, ap) * rb;
  return 2.0 * atan2(num, den);
}

fn load_vertex(idx: u32) -> vec3<f32> {
  return vec3<f32>(vertices[idx * 3u], vertices[idx * 3u + 1u], vertices[idx * 3u + 2u]);
}

fn traverse_bvh(p: vec3<f32>) -> f32 {
  var winding: f32 = 0.0;
  var stack: array<u32, 64>;
  var sp: u32 = 0u;
  stack[0] = 0u;
  sp = 1u;

  while (sp > 0u) {
    sp -= 1u;
    let node_idx = stack[sp];
    let off = node_idx * 16u;   // NODE_SIZE (bvh.js) — extra fields are the CPU far-field dipoles

    let data2 = bvh_nodes[off + 7u];

    if (data2 > 0.0) {
      // Leaf: first = data1, count = data2
      let first = u32(bvh_nodes[off + 6u]);
      let count = u32(data2);
      for (var t = first; t < first + count; t++) {
        let ti = bvh_tri_indices[t];
        let a = load_vertex(tri_indices_raw[ti * 3u]);
        let b = load_vertex(tri_indices_raw[ti * 3u + 1u]);
        let c = load_vertex(tri_indices_raw[ti * 3u + 2u]);
        winding += solid_angle(p, a, b, c);
      }
    } else {
      // Internal: left = data1, right = -(data2) - 1
      let left = u32(bvh_nodes[off + 6u]);
      let right = u32(-(data2) - 1.0);
      if (sp < 62u) {
        stack[sp] = left; sp += 1u;
        stack[sp] = right; sp += 1u;
      }
    }
  }

  return winding;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let xi = gid.x;
  let yi = gid.y;

  let sx = params.resolution.x;
  let sy = params.resolution.y;

  let bi = xi / sx;
  let bj = yi / sy;
  if (bi >= params.block_count.x || bj >= params.block_count.y) { return; }

  let si = xi % sx;
  let sj = yi % sy;

  let px = params.origin.x + (f32(bi) + (f32(si) + 0.5) / f32(sx)) * params.block_size.x;
  let py = params.origin.y + (f32(bj) + (f32(sj) + 0.5) / f32(sy)) * params.block_size.y;
  let pz = params.origin.z + (f32(params.z_block) + (f32(params.z_sub) + 0.5) / f32(params.resolution.z)) * params.block_size.z;

  let w = traverse_bvh(vec3<f32>(px, py, pz));
  let threshold_scaled = params.threshold * 4.0 * 3.14159265;
  let inside = select(0u, 1u, w >= threshold_scaled);

  let block_idx = bi + bj * params.block_count.x + params.z_block * params.block_count.x * params.block_count.y;
  atomicAdd(&counters[block_idx], inside);
}
`;

const WGSL_FINALIZE = /* wgsl */`
@group(0) @binding(0) var<storage, read> counters: array<u32>;
@group(0) @binding(1) var<storage, read_write> proportions: array<f32>;
@group(0) @binding(2) var<uniform> sub_total: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= arrayLength(&proportions)) { return; }
  proportions[idx] = f32(counters[idx]) / f32(sub_total);
}
`;

async function createGPUEvaluator(device) {
  const mainModule = device.createShaderModule({ code: WGSL_SHADER });
  const finalizeModule = device.createShaderModule({ code: WGSL_FINALIZE });

  const mainPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: mainModule, entryPoint: 'main' },
  });

  const finalizePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: finalizeModule, entryPoint: 'main' },
  });

  return { device, mainPipeline, finalizePipeline };
}

async function evaluateGPU(gpu, vertices, triangles, bvhNodes, triIndices, blockModel, opts = {}) {
  const { device, mainPipeline, finalizePipeline } = gpu;
  const { mode = 'proportion', resolution = [4, 4, 4], threshold = 0.5, onProgress } = opts;
  const { origin, size, count } = blockModel;
  const [nx, ny, nz] = count;
  const [sx, sy, sz] = resolution;
  const total = nx * ny * nz;
  const subTotal = sx * sy * sz;

  // Create GPU buffers
  const vertBuf = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const triBuf = device.createBuffer({ size: triangles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhBuf = device.createBuffer({ size: bvhNodes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bvhTriBuf = device.createBuffer({ size: triIndices.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const counterBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const propBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  // Params: 16 floats (64 bytes), padded to 16-byte alignment
  // origin(3) + pad + block_size(3) + block_count_x + block_count(3) + resolution_x
  // + resolution(3) + threshold + z_block + z_sub + pad
  const paramData = new ArrayBuffer(80);
  const paramF = new Float32Array(paramData);
  const paramU = new Uint32Array(paramData);
  paramF[0] = origin[0]; paramF[1] = origin[1]; paramF[2] = origin[2]; paramF[3] = 0;
  paramF[4] = size[0]; paramF[5] = size[1]; paramF[6] = size[2]; paramU[7] = nx;
  paramU[8] = nx; paramU[9] = ny; paramU[10] = nz; paramU[11] = sx;
  paramU[12] = sx; paramU[13] = sy; paramU[14] = sz; paramF[15] = threshold;
  // z_block and z_sub set per dispatch

  const paramBuf = device.createBuffer({ size: paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // Upload static data
  device.queue.writeBuffer(vertBuf, 0, vertices);
  device.queue.writeBuffer(triBuf, 0, triangles);
  device.queue.writeBuffer(bvhBuf, 0, bvhNodes);
  device.queue.writeBuffer(bvhTriBuf, 0, triIndices);

  const mainBindGroup = device.createBindGroup({
    layout: mainPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: vertBuf } },
      { binding: 1, resource: { buffer: triBuf } },
      { binding: 2, resource: { buffer: bvhBuf } },
      { binding: 3, resource: { buffer: bvhTriBuf } },
      { binding: 4, resource: { buffer: counterBuf } },
      { binding: 5, resource: { buffer: paramBuf } },
    ],
  });

  // Dispatch: for each z-block and z-sub-layer
  // Each z-layer gets its own submit so writeBuffer is visible to the dispatch
  const dispatchX = Math.ceil((nx * sx) / 8);
  const dispatchY = Math.ceil((ny * sy) / 8);

  // Clear counters to zero
  {
    const enc = device.createCommandEncoder();
    enc.clearBuffer(counterBuf);
    device.queue.submit([enc.finish()]);
  }

  for (let zb = 0; zb < nz; zb++) {
    for (let zs = 0; zs < sz; zs++) {
      paramU[16] = zb;
      paramU[17] = zs;
      device.queue.writeBuffer(paramBuf, 0, paramData);

      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(mainPipeline);
      pass.setBindGroup(0, mainBindGroup);
      pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
      pass.end();
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    if (onProgress) onProgress((zb + 1) / nz);
  }

  if (mode === 'proportion') {
    // Finalize: convert counters to proportions
    const subTotalBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(subTotalBuf, 0, new Uint32Array([subTotal]));

    const finalizeBindGroup = device.createBindGroup({
      layout: finalizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: counterBuf } },
        { binding: 1, resource: { buffer: propBuf } },
        { binding: 2, resource: { buffer: subTotalBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(finalizePipeline);
    pass.setBindGroup(0, finalizeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(total / 64), 1, 1);
    pass.end();

    enc.copyBufferToBuffer(propBuf, 0, readBuf, 0, total * 4);
    device.queue.submit([enc.finish()]);

    await readBuf.mapAsync(GPUMapMode.READ);
    const proportions = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();

    const flags = new Uint8Array(total);
    for (let i = 0; i < total; i++) flags[i] = proportions[i] >= threshold ? 1 : 0;

    // Cleanup
    vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
    counterBuf.destroy(); propBuf.destroy(); readBuf.destroy(); paramBuf.destroy();
    subTotalBuf.destroy();

    return { proportions, flags };
  }

  // Flag mode: read counters (each is 0 or 1 for centroid-only)
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(counterBuf, 0, readBuf, 0, total * 4);
    device.queue.submit([enc.finish()]);
  }

  await readBuf.mapAsync(GPUMapMode.READ);
  const rawCounters = new Uint32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  const flags = new Uint8Array(total);
  for (let i = 0; i < total; i++) flags[i] = rawCounters[i] > 0 ? 1 : 0;

  vertBuf.destroy(); triBuf.destroy(); bvhBuf.destroy(); bvhTriBuf.destroy();
  counterBuf.destroy(); propBuf.destroy(); readBuf.destroy(); paramBuf.destroy();

  return { flags };
}

// ── src/worker.js ──

// Web Worker for off-main-thread winding number evaluation (CPU and GPU paths)
// Worker blob inlines all evaluation code via Function.toString() + JSON.stringify()


function createWindingWorker(opts = {}) {
  const source = `
const NODE_SIZE = ${NODE_SIZE};
const WINDING_BETA2 = ${WINDING_BETA2};
const PI4 = 4 * Math.PI;

// -- CPU path --
${solidAngle.toString()}
${windingBrute.toString()}
${windingBVH.toString()}
${evaluateCPU.toString()}

// -- GPU path --
const WGSL_SHADER = ${JSON.stringify(WGSL_SHADER)};
const WGSL_FINALIZE = ${JSON.stringify(WGSL_FINALIZE)};
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
    const { name, blockModel, mode, resolution, threshold } = e.data;
    const mesh = _meshes.get(name);
    if (!mesh) {
      self.postMessage({ type: 'error', message: 'Mesh not found: ' + name });
      return;
    }
    const opts = {
      mode: mode || 'proportion',
      resolution: resolution || [4, 4, 4],
      threshold: threshold != null ? threshold : 0.5,
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
      transfer.push(result.flags.buffer);
      self.postMessage({
        type: 'result',
        proportions: result.proportions || null,
        flags: result.flags,
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

  // Send init message — caller awaits 'ready' response
  worker.postMessage({ type: 'init', gpu: !!opts.gpu });
  return worker;
}

// Wait for worker init to complete, returns { worker, hasGPU }
async function initWindingWorker(opts = {}) {
  const worker = createWindingWorker(opts);
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
      resolution: opts.resolution,
      threshold: opts.threshold,
    });
  });
}

// ── ../frame/src/frame.js ──

// @gcu/frame — the coordinate-frame contract for the whole GCU geometry stack.
//
// Geological work lives at projected-coordinate magnitudes (UTM easting ~5e5,
// northing ~7.7e6, RL ~1e3). Two failures follow and share one cause — doing math
// and rendering directly in those large numbers:
//   • the float32 wall — at northing 7.7e6 a 32-bit float resolves to ~1 m, so any
//     GPU/Float32Array path jitters and z-fights;
//   • catastrophic cancellation — derived quantities (lengths, cross products,
//     intersection params) lose relative precision, and a fixed ε like 1e-9 is
//     meaningless against operands of magnitude 1e6.
// The fix is to work in a small-magnitude LOCAL frame and keep the offset to WORLD
// as explicit, inspectable metadata. This module is that contract — a tiny value
// type plus pure functions, zero-dependency, that every coordinate-bearing package
// can speak.
//
// A Frame has two faculties with different reach:
//   1. numerical framing — the world↔local offset (`origin`), for the precision path
//      (dee/voxmesh/groma/regula/dxf/moncad compute in it; it gates every F32 downcast);
//   2. coordinate identity — the `crs` descriptor + `units`, universal provenance so
//      "what do these world numbers mean" is never silent.
//
// HARD BOUNDARY: frame NAMES a CRS, it never CHANGES one. Reprojection (datum shifts,
// projection changes) is a geodetic operation that lives elsewhere (spinifex/proj4
// today, a future @gcu/proj if it ever becomes a stack primitive). Crossing CRS here
// throws — see `delta`. A working offset is a translation for numerical convenience,
// not a reprojection.
//
// Points and origins are ARRAYS — [x, y] or [x, y, z] — matching the rest of the tree
// (dee.origin, grid.origin, flat Float64/Float32 vertex buffers), not the {x,y,z}
// objects the prose spec sketches. The frame is pure translation: rotation/scale are
// deliberately out of scope (a block model's own dip/rake orientation is intrinsic
// model geometry, a separate concern from the local frame — never conflated).

// A Frame value. `origin` is the WORLD coordinate of the local origin, so
// `local = world − origin`. `crs` is an optional projection descriptor (e.g. an EPSG
// code) — null means "unstated", which opts out of cross-frame CRS checking. `units`
// defaults to metres.
function makeFrame({ origin, crs = null, units = 'm' } = {}) {
  const o = origin ? Array.from(origin, Number) : [0, 0, 0];
  while (o.length < 3) o.push(0);
  return { origin: o.slice(0, 3), crs, units };
}

// The identity frame: origin at world zero. World == local. Useful as a default and
// as the "already in world coordinates" marker.
const WORLD = makeFrame({ origin: [0, 0, 0] });

// Normalise a CRS code for IDENTITY comparison: uppercase + strip a leading `EPSG:`, so
// `'EPSG:31983'`, `'epsg:31983'`, and `'31983'` all compare equal. It lives HERE, not in a
// geo/reprojection layer: frame is zero-dep and sits *under* any such layer, so importing a
// helper from geo would invert the dependency. A reprojection layer's richer code resolution
// is a superset built on this. Comparison only — the stored `crs` keeps its original spelling.
function canonCrs(code) {
  return code == null ? null : String(code).trim().toUpperCase().replace(/^EPSG:/, '');
}

// Two frames describe the same projection iff their (canonicalised) CRS agree (a null CRS on
// either side is a wildcard — you can't assert a mismatch you never declared) and their units
// match. This is the gate that keeps a frame shift from masquerading as a reprojection.
function sameProjection(a, b) {
  const ca = canonCrs(a.crs), cb = canonCrs(b.crs);
  if (ca != null && cb != null && ca !== cb) return false;
  return (a.units ?? 'm') === (b.units ?? 'm');
}

// Full structural equality: same origin, (canonicalised) CRS, and units.
function frameEq(a, b) {
  return canonCrs(a.crs) === canonCrs(b.crs) && (a.units ?? 'm') === (b.units ?? 'm') &&
    a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.origin[2] === b.origin[2];
}

// ── Point transforms (single [x,y] or [x,y,z]) ──────────────────────────────────

// World → local: subtract the origin component-wise. Round-trips losslessly with
// `toWorld` at f64 (invariant 3) — exact when the origin is chosen near the data, the
// intended use.
function toLocal(worldPt, frame) {
  const o = frame.origin, r = new Array(worldPt.length);
  for (let i = 0; i < worldPt.length; i++) r[i] = worldPt[i] - (o[i] || 0);
  return r;
}

// Local → world: add the origin back. The inverse of `toLocal`.
function toWorld(localPt, frame) {
  const o = frame.origin, r = new Array(localPt.length);
  for (let i = 0; i < localPt.length; i++) r[i] = localPt[i] + (o[i] || 0);
  return r;
}

// ── Bulk buffer transforms (flat x,y,z,x,y,z,… arrays) ──────────────────────────
// These consolidate the hand-rolled F64-recentre loops currently duplicated in the
// dee importers (lfm/msh adapters): subtract the origin at full f64 precision and hand
// the small local magnitudes to the F32/GPU downcast. The one hard rule of §5 —
// anything bound for a Float32Array passes through the local frame FIRST — is this
// call. Returns a NEW Float64Array; input is never mutated.

function toLocalCoords(coords, frame, { stride = 3 } = {}) {
  const o = frame.origin, out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += stride)
    for (let j = 0; j < stride; j++) out[i + j] = coords[i + j] - (o[j] || 0);
  return out;
}

function toWorldCoords(coords, frame, { stride = 3 } = {}) {
  const o = frame.origin, out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += stride)
    for (let j = 0; j < stride; j++) out[i + j] = coords[i + j] + (o[j] || 0);
  return out;
}

// ── Choosing an origin ──────────────────────────────────────────────────────────

// Pick a sticky origin from world-coordinate bounds. Default strategy 'centroid'
// (bbox centre); 'floor' keeps locals strictly positive (handy across tiled exports).
// The result is rounded to `round` so the anchor reads as a "nice" number in logs and
// diffs rather than an arbitrary fractional point. bounds = { min:[…], max:[…] }.
// The origin is chosen ONCE per document/session and is sticky — recomputing it
// per-operation drifts the frame and invalidates cached geometry (§4).
function originFromBounds(bounds, { round = 1, strategy = 'centroid' } = {}) {
  const { min, max } = bounds, n = Math.min(min.length, max.length), o = [];
  for (let i = 0; i < n; i++) {
    const c = strategy === 'floor' ? min[i] : (min[i] + max[i]) / 2;
    o.push(round ? Math.round(c / round) * round : c);
  }
  while (o.length < 3) o.push(0);
  return o.slice(0, 3);
}

// Convenience: a Frame straight from bounds (origin via `originFromBounds`, carrying
// the given CRS/units).
function frameFromBounds(bounds, opts = {}) {
  return makeFrame({
    origin: originFromBounds(bounds, opts),
    crs: opts.crs ?? null,
    units: opts.units ?? 'm',
  });
}

// ── Frame-relative tolerance ────────────────────────────────────────────────────

// A tolerance scaled to the working extent, so coincidence / parallel / on-curve tests
// stay meaningful at any magnitude — a fixed absolute 1e-9 is meaningless against UTM
// operands, the same failure class as the original silent-shift bug. `extent` is the
// working span (e.g. the local bbox diagonal); `rel` is the relative floor. Feeds the
// @gcu/regula tolerance model. Note exact sign/orientation tests stay EXACT (groma
// predicates) — this ε is only for constructed quantities.
function extentTolerance(frame, extent, { rel = 1e-9 } = {}) {
  const e = Math.abs(extent) || 1;
  return { eps: rel * e, rel, extent: e, units: frame.units };
}

// ── Frame ↔ frame ───────────────────────────────────────────────────────────────

// The translation to add to a point expressed local-in `from` to re-express it
// local-in `to`:  localTo = localFrom + (fromOrigin − toOrigin). Throws if the frames
// describe different projections — moving between those is a reprojection, which frame
// does not perform (the hard boundary).
function delta(from, to) {
  if (!sameProjection(from, to)) {
    throw new Error(
      `frame.delta: frames differ in CRS/units (${from.crs}/${from.units} → ${to.crs}/${to.units}); ` +
      'that is a reprojection, which @gcu/frame does not perform',
    );
  }
  return [
    from.origin[0] - to.origin[0],
    from.origin[1] - to.origin[1],
    from.origin[2] - to.origin[2],
  ];
}

// Declare an artifact's frame WITHOUT moving its coordinates (invariant 2: a coordinate
// expressed in a local frame always carries an inspectable origin). Shallow, pure —
// returns a copy with `.frame` stamped. Re-EXPRESSING coordinates into a different
// frame is `rebaseCoords`, a separate and logged transform.
function withFrame(artifact, frame) {
  return { ...artifact, frame };
}

// Re-express a flat coordinate buffer from one frame into another. Returns BOTH the new
// Float64Array and a provenance record — rebasing is an explicit, accountable transform
// (invariants 4/5), so you cannot get the moved coordinates without the record of what
// moved them (the same "numbers plus an account of what I did to them" discipline as
// the DXF contract). Throws via `delta` on a CRS/units mismatch. Pure; input untouched.
function rebaseCoords(coords, from, to, { stride = 3 } = {}) {
  const d = delta(from, to);
  const out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += stride)
    for (let j = 0; j < stride; j++) out[i + j] = coords[i + j] + (d[j] || 0);
  return { coords: out, record: rebaseRecord(from, to, d) };
}

// A provenance entry for a rebase — what the caller pushes onto its frame log.
function rebaseRecord(from, to, d) {
  return {
    op: 'rebase',
    from: { origin: [...from.origin], crs: from.crs, units: from.units },
    to: { origin: [...to.origin], crs: to.crs, units: to.units },
    delta: d,
  };
}

// ── src/ray.js ──

// Ray → mesh, over the BVH this package already builds.
//
// The GPU ID-buffer answers WHICH layer is under the cursor; it cannot answer
// which TRIANGLE (WebGL2 has no gl_PrimitiveID, and un-indexing a mesh just to
// carry a per-vertex triangle id would triple its vertex memory). So the CPU
// answers it — against the same BVH the solid queries use, so a mesh that has
// been interrogated once picks for free.
//
// Möller–Trumbore, TWO-SIDED: geological wireframes are rarely consistently
// wound, and a surface you can see from below is a surface you can click from
// below. The returned normal is flipped to face the ray, matching the shading.


/**
 * Nearest hit of a ray against a BVH-accelerated triangle mesh.
 *
 * @param {object} mesh   { vertices, triangles, nodes, triIndices } — the shape
 *                        micro caches per mesh layer (bvh fields flattened in).
 * @param {number[]} origin  ray origin, same space as `vertices`
 * @param {number[]} dir     ray direction (need not be normalised)
 * @param {object} [opts]  { maxT } — ignore hits beyond this distance
 * @returns {?{tri:number, t:number, point:number[], normal:number[], bary:number[]}}
 */
function raycastBVH(mesh, origin, dir, { maxT = Infinity } = {}) {
  const { vertices, triangles, nodes, triIndices } = mesh;
  if (!nodes || !nodes.length || !triIndices || !triIndices.length) return null;

  const [ox, oy, oz] = origin;
  let [dx, dy, dz] = dir;
  const dl = Math.hypot(dx, dy, dz);
  if (!(dl > 0)) return null;
  dx /= dl; dy /= dl; dz /= dl;                            // unit ray → t IS a distance
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;             // ±Infinity is fine: the slab test handles it

  let best = maxT, bestTri = -1, bu = 0, bv = 0;
  const stack = [0];

  while (stack.length) {
    const off = stack.pop() * NODE_SIZE;

    // slab test against the node's bounds — miss, or entirely behind our best hit
    const t1x = (nodes[off] - ox) * ix, t2x = (nodes[off + 3] - ox) * ix;
    const t1y = (nodes[off + 1] - oy) * iy, t2y = (nodes[off + 4] - oy) * iy;
    const t1z = (nodes[off + 2] - oz) * iz, t2z = (nodes[off + 5] - oz) * iz;
    const tNear = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z), 0);
    const tFar = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
    if (!(tNear <= tFar) || tNear >= best) continue;

    const data2 = nodes[off + 7];
    if (data2 > 0) {                                       // leaf: data1 = first, data2 = count
      const first = nodes[off + 6];
      for (let i = first; i < first + data2; i++) {
        const ti = triIndices[i];
        const a = triangles[ti * 3] * 3, b = triangles[ti * 3 + 1] * 3, c = triangles[ti * 3 + 2] * 3;
        const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
        const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
        const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
        // p = d × e2;  det = e1 · p   (det ≈ 0 → ray parallel to the triangle)
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;               // two-sided: only PARALLEL is rejected
        const inv = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-7 && t < best) { best = t; bestTri = ti; bu = u; bv = v; }
      }
    } else {                                               // internal: data1 = left, data2 = -(right)-1
      stack.push(nodes[off + 6]);
      stack.push(-data2 - 1);
    }
  }

  if (bestTri < 0) return null;

  const a = triangles[bestTri * 3] * 3, b = triangles[bestTri * 3 + 1] * 3, c = triangles[bestTri * 3 + 2] * 3;
  const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
  const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
  const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }   // face the viewer, like the shading

  return {
    tri: bestTri,
    t: best,
    point: [ox + dx * best, oy + dy * best, oz + dz * best],
    normal: [nx, ny, nz],
    bary: [1 - bu - bv, bu, bv],
    verts: [triangles[bestTri * 3], triangles[bestTri * 3 + 1], triangles[bestTri * 3 + 2]],
  };
}

// ── src/main.js ──

// WINDING — Generalized Winding Number Block Model Evaluator
// Main API: Winding.create({ device?, worker?, gpu? }), setMesh(), evaluate()


// ── Frame-awareness (@gcu/frame) ────────────────────────────────────────────────
// Geological meshes live at projected magnitudes (UTM northing ~7.7e6). Handing
// those straight to a Float32Array/WGSL f32 kernel hits the float32 wall — ~1 m
// resolution at 7.7e6, so the BVH slab tests and solid-angle math degrade. A frame
// rebases world → a small-magnitude local origin at full f64 BEFORE the f32 downcast.
// Pass an @gcu/frame to setMesh() and evaluate(); omit it for verbatim legacy behaviour.
// Results (winding numbers/flags, per block index) are translation-invariant — only
// the geometry inputs are rebased, nothing to map back.

// World verts (f64-worthy) → local-frame Float32Array. The one hard rule of frame §5:
// anything bound for a Float32Array passes through the local frame first.
function frameLocalVerts(vertices, frame) {
  return frame ? Float32Array.from(toLocalCoords(vertices, frame, { stride: 3 })) : vertices;
}

// Rebase a block model's world origin into the mesh's local frame, guarding that the
// block frame and the mesh frame are the SAME frame — frame rebases, never reprojects.
function frameBlockModel(blockModel, evalFrame, meshFrame, meshName) {
  if (!meshFrame && !evalFrame) return blockModel;                       // legacy path, verbatim
  if (meshFrame && !evalFrame)
    throw new Error(`winding: mesh '${meshName}' was framed; evaluate needs the same frame`);
  if (!meshFrame && evalFrame)
    throw new Error(`winding: evaluate given a frame but mesh '${meshName}' is unframed`);
  if (!frameEq(evalFrame, meshFrame))
    throw new Error(`winding: block-model frame ≠ mesh '${meshName}' frame (frame rebases, never reprojects)`);
  return { ...blockModel, origin: toLocal(blockModel.origin, evalFrame) };
}

class Winding {
  constructor() {
    this._gpu = null;       // main-thread GPU evaluator
    this._worker = null;    // Worker instance
    this._workerGPU = false; // whether worker has GPU
    this._meshes = new Map();
    this._defaultMesh = null;
  }

  // Create a Winding instance
  // opts.device: GPUDevice for main-thread WebGPU (e.g. Firefox, or shared with three.js)
  // opts.worker: true to run evaluation in a Web Worker
  // opts.gpu: true to let the worker request its own GPUDevice (requires worker: true)
  static async create(opts = {}) {
    const { device, worker, gpu } = opts;
    const w = new Winding();

    if (device) {
      w._gpu = await createGPUEvaluator(device);
    }

    if (worker) {
      const result = await initWindingWorker({ gpu: !!gpu });
      w._worker = result.worker;
      w._workerGPU = result.hasGPU;
    }

    return w;
  }

  // Load a mesh. Builds BVH on main thread, sends to worker if active.
  setMesh(vertices, triangles, opts = {}) {
    const name = opts.name || '_default';
    const frame = opts.frame || null;
    const verts = frameLocalVerts(vertices, frame);            // world → local f32 (frame-aware)
    const bvh = buildBVH(verts, triangles, {
      maxLeafSize: opts.maxLeafSize || 4,
    });
    const mesh = { vertices: verts, triangles, bvh, frame };
    this._meshes.set(name, mesh);
    if (name === '_default' || this._meshes.size === 1) {
      this._defaultMesh = mesh;
    }

    if (this._worker) {
      this._worker.postMessage({
        type: 'setMesh',
        name,
        vertices: new Float32Array(verts),
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

  // Evaluate a single mesh against a block model
  // Priority: worker (GPU or CPU) > main-thread GPU > main-thread CPU
  async evaluate(blockModel, opts = {}) {
    const meshName = opts.mesh || '_default';
    const mesh = this._meshes.get(meshName) || this._defaultMesh;
    if (!mesh) throw new Error('No mesh loaded. Call setMesh() first.');

    const { frame: evalFrame = null, ...restOpts } = opts;
    const bm = frameBlockModel(blockModel, evalFrame, mesh.frame, meshName);

    if (this._worker) {
      return evaluateWorker(this._worker, meshName, bm, restOpts);
    }

    const { vertices, triangles, bvh } = mesh;

    if (this._gpu) {
      return evaluateGPU(this._gpu, vertices, triangles,
        bvh.nodes, bvh.triIndices, bm, restOpts);
    }

    return evaluateCPU(vertices, triangles,
      bvh.nodes, bvh.triIndices, bm, restOpts);
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

// CPU math helpers — part of the curated public surface (matches the old footer).
// Ray → mesh over the same BVH: the CPU half of mesh picking (the GPU ID-buffer
// says WHICH mesh; this says which triangle, where, and which way it faces).

export {
  Winding,
  buildBVH,
  evaluateCPU,
  solidAngle,
  windingBrute,
  windingBVH,
  raycastBVH,
};
