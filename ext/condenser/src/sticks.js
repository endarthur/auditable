// @gcu/condenser — stick chunks: drillhole interval SEGMENTS (desurveyed
// endpoint pairs) as instanced capsule impostors (micro-layers spec §6).
// Same chunk discipline as blocks/points: batch-Morton on the midpoints,
// intra-chunk shuffle (any prefix = a uniform subsample), per-chunk channel
// quantization. Coordinates stay Float32 frame-local — stick counts are
// 10³–10⁶, so the uint16 squeeze isn't needed and endpoints stay exact
// to ~mm at frame-local magnitudes.

import { mulberry32, shuffledIndices, shuffleInPlace } from './chunks.js';
import { mortonKeys, radixSortIndices } from './morton.js';

/**
 * Build one StickChunk from columnar world-space endpoints + attributes.
 * raw = { ax..az, bx..bz (endpoints), x,y,z (midpoints), chan, cat, recIdx }.
 * `indices` = optional gather list (a Morton slice); shuffled like the others.
 */
export function buildStickChunk(raw, frame, rnd, indices = null) {
  const n = indices ? indices.length : raw.x.length;
  const o = frame.origin;
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const seg = new Float32Array(6 * n);                     // ax ay az bx by bz, frame-local
  const outChan = new Uint16Array(n), outCat = new Uint8Array(n), outR = new Uint32Array(n);
  let cMin = Infinity, cMax = -Infinity;
  for (let k = 0; k < n; k++) { const v = raw.chan[perm[k]]; if (Number.isFinite(v)) { if (v < cMin) cMin = v; if (v > cMax) cMax = v; } }
  if (!Number.isFinite(cMin)) { cMin = 0; cMax = 0; }
  const cScale = cMax > cMin ? 65535 / (cMax - cMin) : 0;
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    const A = [raw.ax[i] - o[0], raw.ay[i] - o[1], raw.az[i] - o[2]];
    const B = [raw.bx[i] - o[0], raw.by[i] - o[1], raw.bz[i] - o[2]];
    seg[k * 6] = A[0]; seg[k * 6 + 1] = A[1]; seg[k * 6 + 2] = A[2];
    seg[k * 6 + 3] = B[0]; seg[k * 6 + 4] = B[1]; seg[k * 6 + 5] = B[2];
    for (let a = 0; a < 3; a++) {
      if (A[a] < bb[a]) bb[a] = A[a]; if (A[a] > bb[a + 3]) bb[a + 3] = A[a];
      if (B[a] < bb[a]) bb[a] = B[a]; if (B[a] > bb[a + 3]) bb[a + 3] = B[a];
    }
    const cv = raw.chan[i];
    outChan[k] = Number.isFinite(cv) ? ((cv - cMin) * cScale + 0.5) | 0 : 0;
    outCat[k] = raw.cat ? raw.cat[i] : 0;
    outR[k] = raw.recIdx[i];
  }
  // NB: the culling bbox covers the SEGMENTS; the renderer pads it by the
  // current stick radius at cull time (the radius is a live per-layer knob).
  return { kind: 'sticks', count: n, seg, chan: outChan, chanRange: [cMin, cMax], cat: outCat, recIdx: outR, bboxLocal: Float64Array.from(bb) };
}

// Exact midpoint of element k, frame-local (tests + pick verification).
export function stickLocalCenter(chunk, k) {
  const s = chunk.seg;
  return [(s[k * 6] + s[k * 6 + 3]) / 2, (s[k * 6 + 1] + s[k * 6 + 4]) / 2, (s[k * 6 + 2] + s[k * 6 + 5]) / 2];
}

/**
 * StickChunkBuilder — the blocks builder's shape over segment RawChunks
 * ({ count, ax..bz, x,y,z, chan, cat, recIdx }). Batch-Morton on midpoints,
 * sliced, shuffled.
 */
export function createStickChunkBuilder({ frame, chunkSize = 1 << 17, batchSize = 0, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  const batchN = batchSize || chunkSize * 4;
  let pend = [], pendCount = 0;
  const doc = {
    count: 0,
    bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity),
    chanRange: [Infinity, -Infinity],
  };
  const concat = (Type, parts) => {
    const out = new Type(parts.reduce((t, p) => t + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const flushBatch = () => {
    if (!pendCount) return;
    const cols = {
      ax: concat(Float64Array, pend.map((p) => p.ax)), ay: concat(Float64Array, pend.map((p) => p.ay)), az: concat(Float64Array, pend.map((p) => p.az)),
      bx: concat(Float64Array, pend.map((p) => p.bx)), by: concat(Float64Array, pend.map((p) => p.by)), bz: concat(Float64Array, pend.map((p) => p.bz)),
      x: concat(Float64Array, pend.map((p) => p.x)), y: concat(Float64Array, pend.map((p) => p.y)), z: concat(Float64Array, pend.map((p) => p.z)),
      chan: concat(Float64Array, pend.map((p) => p.chan)),
      cat: pend.every((p) => p.cat) ? concat(Uint8Array, pend.map((p) => p.cat)) : null,
      recIdx: concat(Uint32Array, pend.map((p) => p.recIdx)),
    };
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n);
    for (let start = 0; start < n; start += chunkSize) {
      const slice = order.subarray(start, Math.min(start + chunkSize, n));
      const chunk = buildStickChunk(cols, frame, rnd, slice);
      doc.count += chunk.count;
      const b = doc.bboxLocal, cb = chunk.bboxLocal;
      for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
      if (chunk.chanRange[0] < doc.chanRange[0]) doc.chanRange[0] = chunk.chanRange[0];
      if (chunk.chanRange[1] > doc.chanRange[1]) doc.chanRange[1] = chunk.chanRange[1];
      onChunk(chunk);
    }
  };
  return {
    push(raw) {
      let recIdx = raw.recIdx;
      if (!recIdx) {
        recIdx = new Uint32Array(raw.count);
        for (let i = 0; i < raw.count; i++) recIdx[i] = (raw.recStart || 0) + i;
      }
      let taken = 0;
      while (taken < raw.count) {
        const room = batchN - pendCount;
        const n = Math.min(room, raw.count - taken);
        const s = (a) => (a ? a.subarray(taken, taken + n) : null);
        pend.push({ ax: s(raw.ax), ay: s(raw.ay), az: s(raw.az), bx: s(raw.bx), by: s(raw.by), bz: s(raw.bz), x: s(raw.x), y: s(raw.y), z: s(raw.z), chan: s(raw.chan), cat: s(raw.cat), recIdx: recIdx.subarray(taken, taken + n) });
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}
