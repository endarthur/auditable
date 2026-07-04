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

export { buildBVH, NODE_SIZE, triArea2 };
