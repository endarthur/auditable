// @gcu/voxmesh — convenience wrappers and incremental updates

import { binBreaks, binQuantiles, discretize } from './bin.js';
import { chunk } from './chunk.js';
import { bucket, addGhosts } from './bucket.js';
import { meshAll } from './mesh.js';

export function prepare(gridDef, compactVar, opts) {
  const hint = opts?.hint || 32;

  // determine bin breaks
  const values = compactVar.values || compactVar;
  let breaks;
  if (opts?.breaks) {
    breaks = opts.breaks;
  } else if (opts?.count) {
    breaks = binBreaks(values, { count: opts.count });
  } else if (opts?.quantiles) {
    breaks = binQuantiles(values, { count: opts.quantiles });
  } else {
    breaks = null; // categorical — values are bin IDs directly
  }

  let binIds;
  if (breaks) {
    binIds = discretize(values, breaks);
  } else {
    // categorical: cast to Uint8
    binIds = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) {
      binIds[i] = isNaN(values[i]) ? 255 : values[i];
    }
  }

  const chunks = chunk(gridDef, { hint });
  const buckets = bucket(chunks, compactVar, binIds);
  addGhosts(chunks, buckets);
  const meshes = meshAll(buckets, chunks, gridDef);

  return { meshes, chunks, buckets, binIds, breaks: breaks || new Float64Array(0), _compactVar: compactVar };
}

export function diffBins(buckets, oldBinIds, newBinIds) {
  // find chunks where at least one block changed bin ID
  // requires mapping compact indices to chunks — use bucket's stored ijk
  const affected = new Set();
  // simplified: for each bucket, check if its min/max straddles any changed region
  // full implementation would track compact index → bucket mapping
  // for now, compare old vs new bin IDs directly
  if (oldBinIds.length !== newBinIds.length) {
    for (const cid of buckets.keys()) affected.add(cid);
    return affected;
  }
  // build set of changed compact indices
  const changed = new Set();
  for (let i = 0; i < oldBinIds.length; i++) {
    if (oldBinIds[i] !== newBinIds[i]) changed.add(i);
  }
  if (changed.size === 0) return affected;
  // mark all chunks as affected if any change (conservative but correct)
  for (const cid of buckets.keys()) affected.add(cid);
  return affected;
}

export function rebin(prepared, opts) {
  const compactVar = prepared._compactVar;
  const values = compactVar.values || compactVar;

  let breaks;
  if (opts?.breaks) breaks = opts.breaks;
  else if (opts?.count) breaks = binBreaks(values, { count: opts.count });
  else if (opts?.quantiles) breaks = binQuantiles(values, { count: opts.quantiles });
  else breaks = prepared.breaks;

  const oldBinIds = prepared.binIds;
  const newBinIds = discretize(values, breaks);

  // re-bucket with new bin IDs and re-mesh
  const buckets = bucket(prepared.chunks, compactVar, newBinIds);
  addGhosts(prepared.chunks, buckets);
  const meshes = meshAll(buckets, prepared.chunks, prepared.chunks.gridDef);

  // update prepared state
  prepared.meshes = meshes;
  prepared.buckets = buckets;
  prepared.binIds = newBinIds;
  prepared.breaks = breaks;

  return { affected: meshes, meshes, binIds: newBinIds, breaks };
}
