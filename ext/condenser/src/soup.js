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
import { parsePlyHeader } from './ply.js';

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
function emitBatch(verts, vo, ia, ib, ic, n) {
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

/**
 * openPlySoup(blob) — the TRUE streaming provider (binary_le + ascii PLY, the
 * formats photogrammetry exports). Two passes over the blob, neither holding
 * the file: (1) the vertex block → local-f32 xyz (12 B/vertex transient RAM —
 * the honest open-time cost; freed when streaming ends), (2) the face block
 * walked in slabs, fanned, emitted as RawChunk batches.
 * → { header, streamChunks } — header = { kind:'mesh', soup:true, format,
 *    vertexCount, triCount(≈ faces, exact after stream), bbox }
 */
export async function openPlySoup(blob, { onProgress } = {}) {
  let sampleLen = 64 * 1024, ply = null;
  for (;;) {
    const text = new TextDecoder('latin1').decode(await blob.slice(0, Math.min(sampleLen, blob.size)).arrayBuffer());
    ply = parsePlyHeader(text);
    if (ply) break;
    if (sampleLen >= blob.size) throw new Error('ply: no end_header');
    sampleLen *= 4;
  }
  const face = ply.elements.find((e) => e.name === 'face');
  if (!face || !face.count) throw new Error('ply: no face element');
  const px = ply.props.find((p) => p.name.toLowerCase() === 'x');
  const py = ply.props.find((p) => p.name.toLowerCase() === 'y');
  const pz = ply.props.find((p) => p.name.toLowerCase() === 'z');
  if (!px || !py || !pz) throw new Error('ply: vertex needs x/y/z');
  const nv = ply.count, ascii = ply.format === 'ascii';
  const SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const GETTERS = { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' };

  // ── pass 1: vertices → local f32 (+ bbox in world f64) ──
  const verts = new Float32Array(3 * nv);
  const vo = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let faceStart;                                            // byte offset where faces begin (binary) / line index (ascii)
  let asciiLines = null;
  if (!ascii) {
    const SLAB = 1 << 23;                                   // 8 MB windows
    let seen = 0;
    while (seen < nv) {
      const n = Math.min(Math.floor(SLAB / ply.stride) || 1, nv - seen);
      const off = ply.dataOffset + seen * ply.stride;
      const dv = new DataView(await blob.slice(off, off + n * ply.stride).arrayBuffer());
      for (let i = 0; i < n; i++) {
        const X = dv[px.getter](i * ply.stride + px.offset, true);
        const Y = dv[py.getter](i * ply.stride + py.offset, true);
        const Z = dv[pz.getter](i * ply.stride + pz.offset, true);
        if (seen === 0 && i === 0) { vo[0] = X; vo[1] = Y; vo[2] = Z; }
        const k = (seen + i) * 3;
        verts[k] = X - vo[0]; verts[k + 1] = Y - vo[1]; verts[k + 2] = Z - vo[2];
        if (X < min[0]) min[0] = X; if (X > max[0]) max[0] = X;
        if (Y < min[1]) min[1] = Y; if (Y > max[1]) max[1] = Y;
        if (Z < min[2]) min[2] = Z; if (Z > max[2]) max[2] = Z;
      }
      seen += n;
      if (onProgress) onProgress(off + n * ply.stride, blob.size);
    }
    faceStart = ply.dataOffset + nv * ply.stride;
  } else {
    // ascii: one decode, line-split (ascii photogrammetry at soup scale is
    // rare; the binary path is the load-bearing one)
    const text = await blob.text();
    asciiLines = text.slice(ply.dataOffset).split('\n');
    const xi = ply.props.indexOf(px), yi = ply.props.indexOf(py), zi = ply.props.indexOf(pz);
    let rec = 0, at = 0;
    while (rec < nv && at < asciiLines.length) {
      const t = asciiLines[at++].trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      const X = +f[xi], Y = +f[yi], Z = +f[zi];
      if (rec === 0) { vo[0] = X; vo[1] = Y; vo[2] = Z; }
      verts[rec * 3] = X - vo[0]; verts[rec * 3 + 1] = Y - vo[1]; verts[rec * 3 + 2] = Z - vo[2];
      if (X < min[0]) min[0] = X; if (X > max[0]) max[0] = X;
      if (Y < min[1]) min[1] = Y; if (Y > max[1]) max[1] = Y;
      if (Z < min[2]) min[2] = Z; if (Z > max[2]) max[2] = Z;
      rec++;
    }
    faceStart = at;
  }

  const header = {
    kind: 'mesh', soup: true, format: ascii ? 'ply-ascii' : 'ply-binary',
    vertexCount: nv, triCount: face.count, faces: face.count,
    bbox: { min, max },
  };

  // ── pass 2: the face walk → RawChunk batches ──
  async function* streamChunks({ batchTris = 1 << 16, signal, onProgress: op2 } = {}) {
    const ia = new Uint32Array(batchTris), ib = new Uint32Array(batchTris), ic = new Uint32Array(batchTris);
    let n = 0, tris = 0;
    const flushTo = function* (force) {
      if (n && (force || n === batchTris)) { const b = emitBatch(verts, vo, ia, ib, ic, n); tris += n; n = 0; yield b; }
    };
    const pushFan = function* (ix, k) {
      for (let j = 2; j < k; j++) {
        ia[n] = ix[0]; ib[n] = ix[j - 1]; ic[n] = ix[j];
        n++;
        if (n === batchTris) yield* flushTo(true);
      }
    };
    if (!ascii) {
      const MAXREC = 4 + 255 * 8;                           // count + a generous n-gon
      const SLAB = 1 << 23;
      let base = faceStart, carry = new Uint8Array(0), done = 0;
      const ix = new Uint32Array(256);
      while (done < face.count && base < blob.size) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const take = Math.min(SLAB, blob.size - base);
        const slab = new Uint8Array(carry.length + take);
        slab.set(carry, 0);
        slab.set(new Uint8Array(await blob.slice(base, base + take).arrayBuffer()), carry.length);
        base += take;
        const dv = new DataView(slab.buffer);
        let off = 0;
        const last = base >= blob.size;
        while (done < face.count && (last ? off < slab.length : off + MAXREC <= slab.length)) {
          let rOff = off, bad = false;
          for (const pr of face.props) {
            if (pr.list) {
              const cs = SIZES[pr.countType] || 1, is = SIZES[pr.idxType] || 4;
              if (rOff + cs > slab.length) { bad = true; break; }
              const k = dv[GETTERS[cs]](rOff, true); rOff += cs;
              if (rOff + k * is > slab.length) { bad = true; break; }
              if (/vertex_ind/i.test(pr.name) || face.props.length === 1) {
                for (let j = 0; j < k; j++) ix[j] = dv[GETTERS[is]](rOff + j * is, true);
                rOff += k * is;
                yield* pushFan(ix, k);
              } else rOff += k * is;
            } else {
              rOff += SIZES[pr.type] || 4;
              if (rOff > slab.length) { bad = true; break; }
            }
          }
          if (bad) break;
          off = rOff;
          done++;
        }
        carry = slab.subarray(off);
        if (op2) op2(base, blob.size);
      }
    } else {
      let at = faceStart, fc = 0;
      while (fc < face.count && at < asciiLines.length) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const t = asciiLines[at++].trim();
        if (!t) continue;
        const f = t.split(/\s+/);
        const k = +f[0];
        const ix = new Uint32Array(k);
        for (let j = 0; j < k; j++) ix[j] = +f[1 + j];
        yield* pushFan(ix, k);
        fc++;
      }
    }
    yield* flushTo(true);
    header.triCount = tris + n;                             // exact after the stream (fans expand quads)
  }

  return { header, streamChunks };
}
