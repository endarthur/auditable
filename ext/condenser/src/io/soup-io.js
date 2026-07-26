// @gcu/condenser — the streaming triangle-soup PROVIDER (io): openPlySoup
// walks a photogrammetry-scale PLY in two passes, neither holding the file,
// and emits RawChunk batches for core/soup-geom's builder. The geometry
// discipline (Morton, shuffle, quantize) lives in core/soup-geom.js.

import { parsePlyHeader } from './ply.js';
import { emitBatch } from '../core/soup-geom.js';

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
