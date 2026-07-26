// @gcu/condenser — streaming-tier meshes (micro-layers §7, tier 2): TRIANGLE
// SOUP under the full chunk discipline. Photogrammetry-scale meshes (10⁷–10⁸
// tris) get what points get: batch-Morton on centroids, intra-chunk shuffle
// (any prefix = a uniform subsample — valid because triangle size
// anti-correlates with mesh size: a mesh is huge BECAUSE its triangles are
// pixel-scale, and pixel-scale triangles subsample like points), per-chunk u16
// quantization (~18 B/tri resident), budgeted progressive accumulation.
// Flat shading needs no stored normals (screen-space derivatives in-shader).
// Soup carries no records in v1 — context semantics at scale.
//
// Precision: streamed vertices are kept Float32 LOCAL to a provisional origin
// (the first vertex) — world-f32 at UTM magnitudes loses ~1 m, local-f32 keeps
// mm — and re-widened to world f64 on emit for the frame-local rebase.

import { mulberry32, shuffledIndices, shuffleInPlace } from './chunks.js';
import { mortonKeys, radixSortIndices } from './morton.js';

/**
 * Build one SoupChunk from columnar world-space corners + centroids.
 * raw = { ax..az, bx..bz, cx..cz (corners), x,y,z (centroids) }.
 * Corners are u16-quantized against the chunk bbox (the points trick ×3).
 */
export function buildSoupChunk(raw, frame, rnd, indices = null) {
  const n = indices ? indices.length : raw.x.length;
  const o = frame.origin;
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const C = [raw.ax, raw.ay, raw.az, raw.bx, raw.by, raw.bz, raw.cx, raw.cy, raw.cz];
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    for (let c = 0; c < 9; c++) {
      const a = c % 3, v = C[c][i] - o[a];
      if (v < bb[a]) bb[a] = v;
      if (v > bb[a + 3]) bb[a + 3] = v;
    }
  }
  const sx = bb[3] > bb[0] ? 65535 / (bb[3] - bb[0]) : 0;
  const sy = bb[4] > bb[1] ? 65535 / (bb[4] - bb[1]) : 0;
  const sz = bb[5] > bb[2] ? 65535 / (bb[5] - bb[2]) : 0;
  const S = [sx, sy, sz];
  const tri = new Uint16Array(9 * n);
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    for (let c = 0; c < 9; c++) {
      const a = c % 3;
      tri[k * 9 + c] = ((C[c][i] - o[a] - bb[a]) * S[a] + 0.5) | 0;
    }
  }
  return { kind: 'soup', count: n, tri, bboxLocal: Float64Array.from(bb) };
}

// Exact centroid of element k, frame-local (tests).
export function soupLocalCentroid(chunk, k) {
  const b = chunk.bboxLocal, t = chunk.tri;
  const d = (v, a) => (b[a + 3] > b[a] ? b[a] + (v / 65535) * (b[a + 3] - b[a]) : b[a]);
  const out = [0, 0, 0];
  for (let c = 0; c < 9; c++) out[c % 3] += d(t[k * 9 + c], c % 3) / 3;
  return out;
}

/**
 * SoupChunkBuilder — the sticks builder's shape over triangle RawChunks
 * ({ count, ax..cz, x,y,z }). Batch-Morton on centroids, sliced, shuffled.
 */
export function createSoupChunkBuilder({ frame, chunkSize = 1 << 17, batchSize = 0, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  const batchN = batchSize || chunkSize * 4;
  let pend = [], pendCount = 0;
  const doc = {
    count: 0,
    bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity),
  };
  const concat = (Type, parts) => {
    const out = new Type(parts.reduce((t, p) => t + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const COLS = ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'cx', 'cy', 'cz', 'x', 'y', 'z'];
  const flushBatch = () => {
    if (!pendCount) return;
    const cols = {};
    for (const c of COLS) cols[c] = concat(Float64Array, pend.map((p) => p[c]));
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n);
    for (let start = 0; start < n; start += chunkSize) {
      const slice = order.subarray(start, Math.min(start + chunkSize, n));
      const chunk = buildSoupChunk(cols, frame, rnd, slice);
      doc.count += chunk.count;
      const b = doc.bboxLocal, cb = chunk.bboxLocal;
      for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
      onChunk(chunk);
    }
  };
  return {
    push(raw) {
      let taken = 0;
      while (taken < raw.count) {
        const room = batchN - pendCount;
        const n = Math.min(room, raw.count - taken);
        const part = {};
        for (const c of COLS) part[c] = raw[c].subarray(taken, taken + n);
        pend.push(part);
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}

// world f64 corner columns from a resolved index triple against local-f32
// vertices + their origin (the precision dance in the header comment)
export function emitBatch(verts, vo, ia, ib, ic, n) {
  const out = { count: n };
  for (const c of ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'cx', 'cy', 'cz', 'x', 'y', 'z']) out[c] = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = ia[i] * 3, b = ib[i] * 3, c = ic[i] * 3;
    const AX = vo[0] + verts[a], AY = vo[1] + verts[a + 1], AZ = vo[2] + verts[a + 2];
    const BX = vo[0] + verts[b], BY = vo[1] + verts[b + 1], BZ = vo[2] + verts[b + 2];
    const CX = vo[0] + verts[c], CY = vo[1] + verts[c + 1], CZ = vo[2] + verts[c + 2];
    out.ax[i] = AX; out.ay[i] = AY; out.az[i] = AZ;
    out.bx[i] = BX; out.by[i] = BY; out.bz[i] = BZ;
    out.cx[i] = CX; out.cy[i] = CY; out.cz[i] = CZ;
    out.x[i] = (AX + BX + CX) / 3; out.y[i] = (AY + BY + CY) / 3; out.z[i] = (AZ + BZ + CZ) / 3;
  }
  return out;
}

/**
 * Soup-stream an ALREADY-PARSED mesh (oversized .msh/.obj — their formats are
 * whole-file reads anyway; the vertices are transient, the soup is resident).
 * Yields RawChunks for createSoupChunkBuilder.
 */
export async function* soupFromMesh({ vertices, triangles }, { batchTris = 1 << 16 } = {}) {
  const nv = (vertices.length / 3) | 0;
  const vo = nv ? [vertices[0], vertices[1], vertices[2]] : [0, 0, 0];
  const verts = new Float32Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    verts[3 * i] = vertices[3 * i] - vo[0];
    verts[3 * i + 1] = vertices[3 * i + 1] - vo[1];
    verts[3 * i + 2] = vertices[3 * i + 2] - vo[2];
  }
  const nt = (triangles.length / 3) | 0;
  const ia = new Uint32Array(batchTris), ib = new Uint32Array(batchTris), ic = new Uint32Array(batchTris);
  let n = 0;
  for (let t = 0; t < nt; t++) {
    ia[n] = triangles[3 * t]; ib[n] = triangles[3 * t + 1]; ic[n] = triangles[3 * t + 2];
    n++;
    if (n === batchTris) { yield emitBatch(verts, vo, ia, ib, ic, n); n = 0; }
  }
  if (n) yield emitBatch(verts, vo, ia, ib, ic, n);
}
