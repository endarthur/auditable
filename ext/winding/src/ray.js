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

import { NODE_SIZE } from './bvh.js';

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
export function raycastBVH(mesh, origin, dir, { maxT = Infinity } = {}) {
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
