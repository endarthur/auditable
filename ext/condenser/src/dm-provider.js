// @gcu/condenser — Datamine .dm block-model provider, over @gcu/dm's windowed
// reader (micro-spec Addendum A.2). The DD page carries the grid definition as
// implicit constants (XMORIG/YMORIG/ZMORIG corner origin, XINC/YINC/ZINC block
// dims, NX/NY/NZ counts), so — unlike CSV — there is NO discovery sweep: grid,
// bbox, and schema are known from the first page. Centroids come from XC/YC/ZC
// per-record fields; the centroid of block (0,0,0) is MORIG + INC/2.
//
// Record indices are RAW record numbers (rows with missing coordinates are
// skipped but their numbers are not reused), so recordRange gives O(1) fetch of
// any picked record. Categories (first alpha column) build their dictionary
// incrementally during the single streaming sweep (≤255 distinct).
//
// v1 scope: regular uniform grids (INC as DD constants). Sub-blocked models
// (per-record INC) and non-model .dm files are a later milestone.

import { detectDM, parseHeader, recordRange, decodeRecord } from '../../dm/src/dm.js';

const DEF_NAMES = new Set(['IJK', 'XC', 'YC', 'ZC', 'XINC', 'YINC', 'ZINC', 'XMORIG', 'YMORIG', 'ZMORIG', 'NX', 'NY', 'NZ']);

export async function openDmModel(blob, { mapping = null, forcePoints = false } = {}) {
  const head = new Uint8Array(await blob.slice(0, Math.min(8192, blob.size)).arrayBuffer());
  const fmt = detectDM(head);
  if (!fmt) throw new Error('dm: not a recognizable .dm file');
  const h = parseHeader(head, fmt);
  const names = h.columns.map((c) => c.name);
  const idx = (n) => names.indexOf(n);
  const constVal = (n) => { const c = h.columns[idx(n)]; return c && c.isConstant ? c.constantValue : null; };

  const xc = idx('XC') >= 0 ? idx('XC') : idx('X');
  const yc = idx('YC') >= 0 ? idx('YC') : idx('Y');
  const zc = idx('ZC') >= 0 ? idx('ZC') : idx('Z');
  if (xc < 0 || yc < 0 || zc < 0) throw new Error('dm: no XC/YC/ZC centroid fields — not a block model export');

  // Decoded-record batches (a cold recipe — call again for the filter sweep or
  // the sub-blocked bbox sweep). Reads ~4 MB page runs sequentially; yields
  // { recStart, rows } with RAW record numbering (recStart + k, no skips here).
  async function* recordBatches({ signal } = {}) {
    const pagesPer = Math.max(1, Math.floor((4 << 20) / h.pageSize));
    for (let page = 2; page <= h.lastPage; page += pagesPer) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const pEnd = Math.min(page + pagesPer - 1, h.lastPage);
      const bytes = new Uint8Array(await blob.slice((page - 1) * h.pageSize, pEnd * h.pageSize).arrayBuffer());
      const rows = [];
      for (let pg = page; pg <= pEnd; pg++) {
        const nRec = pg === h.lastPage ? h.lastRec : h.recordsPerPage;
        const base = (pg - page) * h.pageSize;
        for (let r = 0; r < nRec; r++) {
          rows.push(decodeRecord(bytes.subarray(base + r * h.maxLen * h.wordSize, base + (r + 1) * h.maxLen * h.wordSize), h));
        }
      }
      yield { recStart: (page - 2) * h.recordsPerPage, rows };
    }
  }

  // the grid, straight from the DD (corner origin → centroid convention).
  // A regular model carries the grid as DD constants (XMORIG/XINC/NX…) → no sweep.
  // A SUB-BLOCKED model has per-record XINC/YINC/ZINC (not constants) → a discovery
  // sweep finds the fine lattice (pitch = min dim /2) + a size palette, exactly
  // like the CSV provider → variable-size boxes. Anything else → points (grid:null).
  const mor = [constVal('XMORIG'), constVal('YMORIG'), constVal('ZMORIG')];
  const inc = [constVal('XINC'), constVal('YINC'), constVal('ZINC')];
  const cnt = [constVal('NX'), constVal('NY'), constVal('NZ')];
  const regular = !forcePoints && mor.every(Number.isFinite) && inc.every((v) => Number.isFinite(v) && v > 0) && cnt.every((v) => Number.isFinite(v) && v >= 1);
  // per-record dim columns (non-constant XINC/YINC/ZINC) → sub-block candidate
  const incIdx = { x: idx('XINC'), y: idx('YINC'), z: idx('ZINC') };
  const perRecDims = !regular && !forcePoints && incIdx.x >= 0 && incIdx.y >= 0 && incIdx.z >= 0
    && !h.columns[incIdx.x].isConstant && !h.columns[incIdx.y].isConstant && !h.columns[incIdx.z].isConstant;
  let grid = null, bbox, subBlocked = false, dimPalette = null, dimCode = null;
  if (regular) {
    grid = {
      x: { origin: mor[0] + inc[0] / 2, pitch: inc[0], count: Math.round(cnt[0]) },
      y: { origin: mor[1] + inc[1] / 2, pitch: inc[1], count: Math.round(cnt[1]) },
      z: { origin: mor[2] + inc[2] / 2, pitch: inc[2], count: Math.round(cnt[2]) },
    };
    bbox = { min: [mor[0], mor[1], mor[2]], max: [mor[0] + inc[0] * cnt[0], mor[1] + inc[1] * cnt[1], mor[2] + inc[2] * cnt[2]] };
  } else {
    const CAP = 300000, r10 = (v) => Number(v.toPrecision(10));
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const ax = [new Set(), new Set(), new Set()];            // axis distinct centroids (for the fine lattice)
    const minDim = [Infinity, Infinity, Infinity], dimSet = new Set();
    for await (const { rows } of recordBatches({})) {
      for (const vals of rows) {
        const xv = vals[xc], yv = vals[yc], zv = vals[zc];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
        if (xv < min[0]) min[0] = xv; if (xv > max[0]) max[0] = xv;
        if (yv < min[1]) min[1] = yv; if (yv > max[1]) max[1] = yv;
        if (zv < min[2]) min[2] = zv; if (zv > max[2]) max[2] = zv;
        if (perRecDims) {
          if (ax[0].size < CAP) ax[0].add(r10(xv)); if (ax[1].size < CAP) ax[1].add(r10(yv)); if (ax[2].size < CAP) ax[2].add(r10(zv));
          const dx = +vals[incIdx.x], dy = +vals[incIdx.y], dz = +vals[incIdx.z];
          if (dx > 0 && dy > 0 && dz > 0) {
            if (dx < minDim[0]) minDim[0] = dx; if (dy < minDim[1]) minDim[1] = dy; if (dz < minDim[2]) minDim[2] = dz;
            if (dimSet.size <= 300) dimSet.add(`${r10(dx)},${r10(dy)},${r10(dz)}`);
          }
        }
      }
    }
    if (!Number.isFinite(min[0])) throw new Error('dm: no finite XC/YC/ZC centroids');
    bbox = { min, max };
    // sub-blocked: fine lattice (pitch = minDim/2) + size palette — same rule as CSV
    if (perRecDims && dimSet.size > 1 && Number.isFinite(minDim[0])) {
      const finePitch = [minDim[0] / 2, minDim[1] / 2, minDim[2] / 2];
      const fineAxes = [0, 1, 2].map((a) => {
        if (ax[a].size >= CAP || !(finePitch[a] > 0)) return null;
        const vals = [...ax[a]].sort((u, v) => u - v);
        const origin = vals[0], pitch = finePitch[a];
        const c = Math.round((vals[vals.length - 1] - origin) / pitch) + 1;
        if (c > 65535) return null;
        const eps = Math.max(pitch * 1e-3, Math.abs(origin) * 1e-6);
        for (const v of vals) if (Math.abs(origin + Math.round((v - origin) / pitch) * pitch - v) > eps) return null;
        return { origin, pitch, count: c };
      });
      if (fineAxes.every(Boolean)) {
        subBlocked = true;
        const dims = [...dimSet].slice(0, 256).map((k) => k.split(',').map(Number));
        dimPalette = dims.map(([dx, dy, dz]) => [dx / 2, dy / 2, dz / 2]);
        dimCode = new Map(dims.map((d, i) => [`${r10(d[0])},${r10(d[1])},${r10(d[2])}`, i]));
        grid = { x: fineAxes[0], y: fineAxes[1], z: fineAxes[2] };
      }
    }
  }

  // channels: every per-record numeric non-definition column; first alpha = category
  const numericColumns = h.columns
    .map((c, i) => ({ c, i }))
    .filter((o) => o.c.type === 'N' && !o.c.isConstant && !DEF_NAMES.has(o.c.name))
    .map((o) => ({ i: o.i, name: o.c.name }));
  const chan = mapping && mapping.chan != null ? mapping.chan : (numericColumns[0] ? numericColumns[0].i : null);
  const catIdx = h.columns.findIndex((c) => c.type === 'A' && !c.isConstant);
  const categories = catIdx >= 0 ? [] : null;              // fills incrementally during the sweep
  const catCode = catIdx >= 0 ? new Map() : null;

  const header = {
    kind: 'blockmodel', count: h.recordCount,
    bbox, grid, subBlocked, dimPalette,
    columns: names,
    mapping: { x: xc, y: yc, z: zc, chan, cat: catIdx >= 0 ? catIdx : null },
    numericColumns, categories,
    attributes: [...(chan != null ? [names[chan]] : []), ...(catIdx >= 0 ? [names[catIdx]] : [])],
    dm: h,                                                  // the @gcu/dm header: O(1) record fetch + the filter sweep
  };

  const r10s = (v) => Number(v.toPrecision(10));
  async function* streamChunks({ chunkPoints = 1 << 18, signal, onProgress } = {}) {
    const alloc = () => ({
      x: new Float64Array(chunkPoints), y: new Float64Array(chunkPoints), z: new Float64Array(chunkPoints),
      chan: new Float64Array(chunkPoints), cat: catCode ? new Uint8Array(chunkPoints) : null,
      dim: dimCode ? new Uint8Array(chunkPoints) : null,
      recIdx: new Uint32Array(chunkPoints),
    });
    let buf = alloc(), fill = 0, done = 0;
    for await (const { recStart, rows } of recordBatches({ signal })) {
      for (let k = 0; k < rows.length; k++) {
        const vals = rows[k];
        const xv = vals[xc], yv = vals[yc], zv = vals[zc];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;   // skipped, raw number NOT reused
        buf.x[fill] = xv; buf.y[fill] = yv; buf.z[fill] = zv;
        const cv = chan != null ? vals[chan] : 0;
        buf.chan[fill] = cv == null ? NaN : cv;
        if (buf.cat) {
          const v = String(vals[catIdx] == null ? '' : vals[catIdx]);
          let code = catCode.get(v);
          if (code === undefined) {
            if (catCode.size < 255) { code = catCode.size; catCode.set(v, code); categories.push(v); }
            else code = 0;
          }
          buf.cat[fill] = code;
        }
        if (buf.dim) { const c = dimCode.get(`${r10s(+vals[incIdx.x])},${r10s(+vals[incIdx.y])},${r10s(+vals[incIdx.z])}`); buf.dim[fill] = c === undefined ? 0 : c; }
        buf.recIdx[fill] = recStart + k;                   // RAW record number — the join key
        fill++;
        if (fill === chunkPoints) {
          yield { count: fill, x: buf.x, y: buf.y, z: buf.z, chan: buf.chan, cat: buf.cat, dim: buf.dim, recIdx: buf.recIdx, recStart: 0 };
          buf = alloc(); fill = 0;
        }
      }
      done += rows.length;
      if (onProgress) onProgress(done, h.recordCount);
    }
    if (fill) {
      yield {
        count: fill, x: buf.x.subarray(0, fill), y: buf.y.subarray(0, fill), z: buf.z.subarray(0, fill),
        chan: buf.chan.subarray(0, fill), cat: buf.cat ? buf.cat.subarray(0, fill) : null,
        dim: buf.dim ? buf.dim.subarray(0, fill) : null,
        recIdx: buf.recIdx.subarray(0, fill), recStart: 0,
      };
    }
  }

  return { header, streamChunks, recordBatches };
}

// O(1) fetch of one record by RAW record number (the pick → inspector path).
export async function fetchDmRecord(blob, h, rec) {
  const { offset, length } = recordRange(h, rec);
  const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  return decodeRecord(bytes, h);                           // positional values, h.columns order
}
