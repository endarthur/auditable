// @gcu/condenser — context-tier mesh providers (micro-layers §7, tier 1).
// Wireframes, solids, TINs: whole-file reads into { vertices, triangles },
// then buildMeshChunk rebases to frame-local Float32 for the static indexed
// pipeline (gl-mesh.js). The tier is bounded by design — huge triangle-soup
// scans (photogrammetry) belong to the roadmapped streaming tier, which gets
// the full Morton/prefix treatment. Context meshes carry no records: scenery.
//
// Providers (each → { header, vertices: Float64Array(3n), triangles: Uint32Array(3m) }):
//   openMsh(blob)      — Leapfrog ARANZ-1.0 .msh via @gcu/msh
//   openObj(blob)      — Wavefront OBJ (v/f; fans n-gons; negative indices)
//   openPlyMesh(blob)  — PLY with a face element (ascii + binary_little_endian)
// header = { kind:'mesh', format, vertexCount, triCount, bbox:{min,max} }

import { readMSH } from '../../msh/msh.js';
import { parsePlyHeader } from './ply.js';

function meshBbox(vertices) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function meshHeader(format, vertices, triangles) {
  return {
    kind: 'mesh', format,
    vertexCount: (vertices.length / 3) | 0,
    triCount: (triangles.length / 3) | 0,
    bbox: meshBbox(vertices),
  };
}

// ── Leapfrog .msh ──
export async function openMsh(blob) {
  const msh = await readMSH(new Uint8Array(await blob.arrayBuffer()));
  if (!msh.vertices || !msh.triangles) throw new Error('msh: no vertex/triangle arrays found');
  const vertices = Float64Array.from(msh.vertices);
  const triangles = Uint32Array.from(msh.triangles);
  return { header: meshHeader('msh', vertices, triangles), vertices, triangles };
}

// ── Wavefront OBJ — v + f only (groups/materials are the records roadmap) ──
export async function openObj(blob) {
  const text = await blob.text();
  const vx = [], tris = [];
  let nv = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line[0] === '#') continue;
    if (line.startsWith('v ')) {
      const f = line.split(/\s+/);
      vx.push(+f[1], +f[2], +f[3]);
      nv++;
    } else if (line.startsWith('f ')) {
      const f = line.split(/\s+/);
      const ix = [];
      for (let k = 1; k < f.length; k++) {
        // "v", "v/vt", "v//vn", "v/vt/vn" — the vertex index leads; negatives
        // count back from the vertices seen so far (OBJ spec)
        let v = parseInt(f[k], 10);
        if (!Number.isFinite(v) || v === 0) continue;
        if (v < 0) v = nv + v; else v = v - 1;
        ix.push(v);
      }
      for (let k = 2; k < ix.length; k++) tris.push(ix[0], ix[k - 1], ix[k]);   // fan
    }
  }
  if (!nv || !tris.length) throw new Error('obj: no v/f geometry found');
  const vertices = Float64Array.from(vx);
  const triangles = Uint32Array.from(tris);
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= nv) throw new Error(`obj: face index ${triangles[i]} out of range (${nv} vertices)`);
  return { header: meshHeader('obj', vertices, triangles), vertices, triangles };
}

// ── PLY with faces — reuses ply.js's header parse (vertex first, face after) ──
export async function openPlyMesh(blob) {
  let sampleLen = 64 * 1024, ply = null;
  for (;;) {
    const text = new TextDecoder('latin1').decode(await blob.slice(0, Math.min(sampleLen, blob.size)).arrayBuffer());
    ply = parsePlyHeader(text);
    if (ply) break;
    if (sampleLen >= blob.size) throw new Error('ply: no end_header');
    sampleLen *= 4;
  }
  const face = ply.elements.find((e) => e.name === 'face');
  if (!face || !face.count) throw new Error('ply: no face element (points file — use openPly)');
  const px = ply.props.findIndex((p) => p.name.toLowerCase() === 'x');
  const py = ply.props.findIndex((p) => p.name.toLowerCase() === 'y');
  const pz = ply.props.findIndex((p) => p.name.toLowerCase() === 'z');
  if (px < 0 || py < 0 || pz < 0) throw new Error('ply: vertex needs x/y/z');
  const nv = ply.count;
  const vertices = new Float64Array(3 * nv);
  const tris = [];
  const SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const GETTERS = { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' };

  if (ply.format === 'ascii') {
    const text = await blob.text();
    const lines = text.slice(ply.dataOffset).split('\n');
    let at = 0, rec = 0;
    while (rec < nv && at < lines.length) {
      const t = lines[at++].trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      vertices[3 * rec] = +f[px]; vertices[3 * rec + 1] = +f[py]; vertices[3 * rec + 2] = +f[pz];
      rec++;
    }
    let fc = 0;
    while (fc < face.count && at < lines.length) {
      const t = lines[at++].trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      const k = +f[0];
      for (let j = 2; j < k; j++) tris.push(+f[1], +f[j], +f[j + 1]);   // fan
      fc++;
    }
  } else {
    const bytes = await blob.arrayBuffer();
    const dv = new DataView(bytes);
    for (let i = 0; i < nv; i++) {
      const base = ply.dataOffset + i * ply.stride;
      vertices[3 * i] = dv[ply.props[px].getter](base + ply.props[px].offset, true);
      vertices[3 * i + 1] = dv[ply.props[py].getter](base + ply.props[py].offset, true);
      vertices[3 * i + 2] = dv[ply.props[pz].getter](base + ply.props[pz].offset, true);
    }
    // faces: sequential walk (variable-size records). Only the vertex-index
    // list is kept; other per-face properties are stepped over.
    let off = ply.dataOffset + nv * ply.stride;
    // counts + indices are unsigned in practice (int32 indices are non-negative)
    const rd = (size) => { const v = dv[GETTERS[size]](off, true); off += size; return v; };
    for (let i = 0; i < face.count; i++) {
      for (const p of face.props) {
        if (p.list) {
          const cs = SIZES[p.countType] || 1, is = SIZES[p.idxType] || 4;
          const k = rd(cs);
          if (/vertex_ind/i.test(p.name) || face.props.length === 1) {
            const ix = new Array(k);
            for (let j = 0; j < k; j++) ix[j] = rd(is);
            for (let j = 2; j < k; j++) tris.push(ix[0], ix[j - 1], ix[j]);
          } else off += k * is;
        } else {
          const sz = SIZES[p.type] || 4;
          off += sz;
        }
      }
    }
  }
  if (!tris.length) throw new Error('ply: face element yielded no triangles');
  const triangles = Uint32Array.from(tris);
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= nv) throw new Error(`ply: face index ${triangles[i]} out of range (${nv} vertices)`);
  return { header: meshHeader(ply.format === 'ascii' ? 'ply-ascii' : 'ply-binary', vertices, triangles), vertices, triangles };
}

// ── world f64 → one frame-local GPU-ready chunk ──
// Float32 positions are safe at frame-local magnitudes (the whole point of
// @gcu/frame); indices stay u32. Context meshes are ONE chunk — they draw
// whole on clear frames, no prefix, no budget.
export function buildMeshChunk({ vertices, triangles, frame }) {
  const o = frame ? frame.origin : [0, 0, 0];
  const n = (vertices.length / 3) | 0;
  const pos = new Float32Array(3 * n);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[3 * i + k] - o[k];
      pos[3 * i + k] = v;
      if (v < bb[k]) bb[k] = v;
      if (v > bb[k + 3]) bb[k + 3] = v;
    }
  }
  return {
    kind: 'mesh',
    pos,
    idx: triangles instanceof Uint32Array ? triangles : Uint32Array.from(triangles),
    count: (triangles.length / 3) | 0,                     // elements = triangles
    vertexCount: n,
    bboxLocal: Float64Array.from(bb),
  };
}

// A regular grid IS a single-valued heightfield — triangulate its lattice into a
// mesh chunk with per-vertex smooth normals (grid-gradient central differences)
// and a per-vertex value (the caller maps it to a colour via its own colormap).
// Quads touching a nodata corner are dropped → clean holes. Coords are frame-
// local. Strided to a display cap by the caller (bounded triangle count).
export function buildHeightfieldMesh(grid, { stride = 1, frame = null } = {}) {
  const { nx, ny, data, x0, y0, dx, dy, nodata } = grid;
  const o = (frame && frame.origin) || [0, 0, 0];
  const isBad = (v) => Number.isNaN(v) || (nodata != null && (nodata >= 1.7e38 ? v >= 1.7014e38 : v === nodata));
  const cols = Math.floor((nx - 1) / stride) + 1, rows = Math.floor((ny - 1) / stride) + 1;
  const vidx = new Int32Array(rows * cols).fill(-1);
  let nv = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!isBad(data[Math.min(ny - 1, r * stride) * nx + Math.min(nx - 1, c * stride)])) vidx[r * cols + c] = nv++;
  }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), values = new Float32Array(nv);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const zAt = (r, c) => { const v = data[Math.min(ny - 1, Math.max(0, r * stride)) * nx + Math.min(nx - 1, Math.max(0, c * stride))]; return isBad(v) ? NaN : v; };
  const sx = 2 * stride * dx, sy = 2 * stride * dy;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const vi = vidx[r * cols + c]; if (vi < 0) continue;
    const gr = Math.min(ny - 1, r * stride), gc = Math.min(nx - 1, c * stride), z = data[gr * nx + gc];
    const px = (x0 + gc * dx) - o[0], py = (y0 - gr * dy) - o[1], pz = z - o[2];
    pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz; values[vi] = z;
    if (px < bb[0]) bb[0] = px; if (py < bb[1]) bb[1] = py; if (pz < bb[2]) bb[2] = pz;
    if (px > bb[3]) bb[3] = px; if (py > bb[4]) bb[4] = py; if (pz > bb[5]) bb[5] = pz;
    // heightfield normal N = (-∂z/∂x, -∂z/∂y, 1); y decreases as row increases
    let zl = zAt(r, c - 1), zr = zAt(r, c + 1), zdn = zAt(r - 1, c), zup = zAt(r + 1, c);
    if (Number.isNaN(zl)) zl = z; if (Number.isNaN(zr)) zr = z; if (Number.isNaN(zdn)) zdn = z; if (Number.isNaN(zup)) zup = z;
    const nX = -(zr - zl) / sx, nY = -(zdn - zup) / sy, nZ = 1, nl = Math.hypot(nX, nY, nZ) || 1;
    normal[vi * 3] = nX / nl; normal[vi * 3 + 1] = nY / nl; normal[vi * 3 + 2] = nZ / nl;
  }
  const tris = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = vidx[r * cols + c], b = vidx[r * cols + c + 1], d = vidx[(r + 1) * cols + c], e = vidx[(r + 1) * cols + c + 1];
    if (a < 0 || b < 0 || d < 0 || e < 0) continue;        // drop quads touching nodata → clean holes
    tris.push(a, d, b, b, d, e);
  }
  return { kind: 'mesh', pos, idx: Uint32Array.from(tris), normal, values, count: (tris.length / 3) | 0, vertexCount: nv, bboxLocal: Float64Array.from(bb) };
}
