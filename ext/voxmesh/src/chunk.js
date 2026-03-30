// @gcu/voxmesh — chunking: spatial partitioning of grid into sub-ranges

export function chunk(gridDef, opts) {
  const hint = opts?.hint || 32;
  const cx = Math.min(hint, gridDef.count[0]);
  const cy = Math.min(hint, gridDef.count[1]);
  const cz = Math.min(hint, gridDef.count[2]);
  const ncx = Math.ceil(gridDef.count[0] / cx);
  const ncy = Math.ceil(gridDef.count[1] / cy);
  const ncz = Math.ceil(gridDef.count[2] / cz);
  return {
    chunkDims: [cx, cy, cz],
    chunkCount: [ncx, ncy, ncz],
    nChunks: ncx * ncy * ncz,
    gridDef,
  };
}

export function chunkId(chunks, i, j, k) {
  const ci = (i / chunks.chunkDims[0]) | 0;
  const cj = (j / chunks.chunkDims[1]) | 0;
  const ck = (k / chunks.chunkDims[2]) | 0;
  return ci + cj * chunks.chunkCount[0] + ck * chunks.chunkCount[0] * chunks.chunkCount[1];
}

export function chunkRange(chunks, chunkIndex) {
  const ncx = chunks.chunkCount[0], ncxy = ncx * chunks.chunkCount[1];
  const ck = (chunkIndex / ncxy) | 0;
  const rem = chunkIndex - ck * ncxy;
  const ci = rem % ncx, cj = (rem / ncx) | 0;
  const g = chunks.gridDef;
  return {
    i0: ci * chunks.chunkDims[0],
    i1: Math.min((ci + 1) * chunks.chunkDims[0], g.count[0]),
    j0: cj * chunks.chunkDims[1],
    j1: Math.min((cj + 1) * chunks.chunkDims[1], g.count[1]),
    k0: ck * chunks.chunkDims[2],
    k1: Math.min((ck + 1) * chunks.chunkDims[2], g.count[2]),
  };
}
