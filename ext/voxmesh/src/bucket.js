// @gcu/voxmesh — bucketing: collect populated blocks into per-chunk buckets + ghost cells

import { chunkId, chunkRange } from './chunk.js';

export function bucket(chunks, compactVar, binIds) {
  const buckets = new Map();
  const isCompact = compactVar.indices !== undefined;
  const values = isCompact ? compactVar.values : compactVar;
  const n = values.length;
  const nx = chunks.gridDef.count[0], nxy = nx * chunks.gridDef.count[1];

  for (let p = 0; p < n; p++) {
    if (binIds[p] === 255) continue; // NaN
    const gridIdx = isCompact ? compactVar.indices[p] : p;
    const kz = (gridIdx / nxy) | 0;
    const rem = gridIdx - kz * nxy;
    const i = rem % nx, j = (rem / nx) | 0;
    const cid = chunkId(chunks, i, j, kz);

    let b = buckets.get(cid);
    if (!b) {
      b = { ijkList: [], binIdList: [], valueList: [], min: Infinity, max: -Infinity, n: 0 };
      buckets.set(cid, b);
    }
    b.ijkList.push(i, j, kz);
    b.binIdList.push(binIds[p]);
    b.valueList.push(values[p]);
    if (values[p] < b.min) b.min = values[p];
    if (values[p] > b.max) b.max = values[p];
    b.n++;
  }

  // convert lists to typed arrays
  for (const [cid, b] of buckets) {
    b.ijk = new Int32Array(b.ijkList);
    b.binIds = new Uint8Array(b.binIdList);
    b.values = new Float64Array(b.valueList);
    delete b.ijkList; delete b.binIdList; delete b.valueList;
  }

  return buckets;
}

export function addGhosts(chunks, buckets) {
  // build global lookup: "i,j,k" → binId for all populated blocks
  const globalLookup = new Map();
  for (const [_, b] of buckets) {
    for (let p = 0; p < b.n; p++) {
      const i = b.ijk[p * 3], j = b.ijk[p * 3 + 1], k = b.ijk[p * 3 + 2];
      globalLookup.set(i + j * 65536 + k * 65536 * 65536, b.binIds[p]);
    }
  }

  const nx = chunks.gridDef.count[0], ny = chunks.gridDef.count[1], nz = chunks.gridDef.count[2];

  for (const [cid, b] of buckets) {
    const range = chunkRange(chunks, cid);
    const ghostIjk = [], ghostBinIds = [];

    // 1-cell shell around the chunk range
    for (let k = range.k0 - 1; k <= range.k1; k++) {
      for (let j = range.j0 - 1; j <= range.j1; j++) {
        for (let i = range.i0 - 1; i <= range.i1; i++) {
          // skip blocks inside the chunk range
          if (i >= range.i0 && i < range.i1 && j >= range.j0 && j < range.j1 && k >= range.k0 && k < range.k1) continue;
          // skip out of grid bounds
          if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
          const key = i + j * 65536 + k * 65536 * 65536;
          const binId = globalLookup.get(key);
          if (binId !== undefined) {
            ghostIjk.push(i, j, k);
            ghostBinIds.push(binId);
          }
        }
      }
    }

    b.ghostIjk = new Int32Array(ghostIjk);
    b.ghostBinIds = new Uint8Array(ghostBinIds);
  }
}
