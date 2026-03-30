// @gcu/grid — spatial queries: columns, slices, shells, morphology, nearest, reblocking

import { ijk, flatIndex, isValid, nBlocks, centroid, _rotMatrix, _applyRot, _invertRot } from './geometry.js';

// ── column / slice extraction ──

export function column(g, i, j) {
  const nz = g.count[2], nx = g.count[0], nxy = nx * g.count[1];
  const out = new Int32Array(nz);
  const base = i + j * nx;
  for (let k = 0; k < nz; k++) out[k] = base + k * nxy;
  return out;
}

export function sliceI(g, i) {
  const ny = g.count[1], nz = g.count[2], nx = g.count[0], nxy = nx * ny;
  const out = new Int32Array(ny * nz);
  let p = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) out[p++] = i + j * nx + k * nxy;
  return out;
}

export function sliceJ(g, j) {
  const nx = g.count[0], nz = g.count[2], nxy = nx * g.count[1];
  const out = new Int32Array(nx * nz);
  let p = 0;
  const base = j * nx;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) out[p++] = i + base + k * nxy;
  return out;
}

export function sliceK(g, k) {
  const nx = g.count[0], ny = g.count[1], nxy = nx * ny;
  const out = new Int32Array(nxy);
  const base = k * nxy;
  for (let i = 0; i < nxy; i++) out[i] = base + i;
  return out;
}

export function slicePlane(g, plane) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const n = plane.normal;
  const mag = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  const nn = [n[0] / mag, n[1] / mag, n[2] / mag];
  // max half-block distance along the normal
  const halfDist = 0.5 * (Math.abs(nn[0]) * g.size[0] + Math.abs(nn[1]) * g.size[1] + Math.abs(nn[2]) * g.size[2]);
  const d = nn[0] * plane.point[0] + nn[1] * plane.point[1] + nn[2] * plane.point[2];
  const result = [];
  const m = _rotMatrix(g.rotation);
  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let dx = i * g.size[0], dy = j * g.size[1], dz = kz * g.size[2];
        if (m) {
          const r = _applyRot(m, dx, dy, dz);
          dx = r[0]; dy = r[1]; dz = r[2];
        }
        const cx = g.origin[0] + dx, cy = g.origin[1] + dy, cz = g.origin[2] + dz;
        const dist = Math.abs(nn[0] * cx + nn[1] * cy + nn[2] * cz - d);
        if (dist <= halfDist) result.push(i + j * nx + kz * nxy);
      }
    }
  }
  return new Int32Array(result);
}

// ── shell / morphology ──

export function shell(mask, nLayers) {
  const out = new Uint8Array(mask.length);
  let current = mask;
  for (let layer = 0; layer < nLayers; layer++) {
    const expanded = _dilateOne(current, mask.length);
    // shell = expanded AND NOT current AND NOT original mask
    for (let i = 0; i < mask.length; i++) {
      if (expanded[i] && !current[i] && !mask[i]) out[i] = 1;
    }
    current = expanded;
  }
  return out;
}

export function erode(mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) {
    current = _erodeOne(current, mask.length);
  }
  return current;
}

export function dilate(mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) {
    current = _dilateOne(current, mask.length);
  }
  return current;
}

// note: shell/erode/dilate operate on flat arrays without grid context.
// They need grid dimensions to know neighbor relationships. We'll use a
// context-setting approach — the caller must provide gridDef.

export function shellGrid(g, mask, nLayers) {
  let boundary = _boundaryGrid(g, mask);
  const out = new Uint8Array(mask.length);
  for (let layer = 0; layer < nLayers; layer++) {
    const expanded = _dilateOneGrid(g, boundary);
    for (let i = 0; i < mask.length; i++) {
      if (expanded[i] && !mask[i]) out[i] = 1;
    }
    boundary = expanded;
  }
  return out;
}

export function erodeGrid(g, mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) current = _erodeOneGrid(g, current);
  return current;
}

export function dilateGrid(g, mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) current = _dilateOneGrid(g, current);
  return current;
}

function _boundaryGrid(g, mask) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const out = new Uint8Array(mask.length);
  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + kz * nxy;
        if (!mask[idx]) continue;
        // check 6-neighbors
        if (i > 0 && !mask[idx - 1]) { out[idx] = 1; continue; }
        if (i < nx - 1 && !mask[idx + 1]) { out[idx] = 1; continue; }
        if (j > 0 && !mask[idx - nx]) { out[idx] = 1; continue; }
        if (j < ny - 1 && !mask[idx + nx]) { out[idx] = 1; continue; }
        if (kz > 0 && !mask[idx - nxy]) { out[idx] = 1; continue; }
        if (kz < nz - 1 && !mask[idx + nxy]) { out[idx] = 1; continue; }
      }
    }
  }
  return out;
}

function _dilateOneGrid(g, mask) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const out = new Uint8Array(mask);
  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + kz * nxy;
        if (!mask[idx]) continue;
        if (i > 0) out[idx - 1] = 1;
        if (i < nx - 1) out[idx + 1] = 1;
        if (j > 0) out[idx - nx] = 1;
        if (j < ny - 1) out[idx + nx] = 1;
        if (kz > 0) out[idx - nxy] = 1;
        if (kz < nz - 1) out[idx + nxy] = 1;
      }
    }
  }
  return out;
}

function _erodeOneGrid(g, mask) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const out = new Uint8Array(mask);
  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + kz * nxy;
        if (!mask[idx]) continue;
        // erode: remove if any neighbor is 0
        if (i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || kz === 0 || kz === nz - 1) { out[idx] = 0; continue; }
        if (!mask[idx - 1] || !mask[idx + 1] || !mask[idx - nx] || !mask[idx + nx] || !mask[idx - nxy] || !mask[idx + nxy]) out[idx] = 0;
      }
    }
  }
  return out;
}

// stub for flat array versions (without grid context) — treat as 1D
function _dilateOne(mask) { return new Uint8Array(mask); }
function _erodeOne(mask) { return new Uint8Array(mask); }

// ── nearest populated block ──

export function nearestPopulated(g, variable, fi) {
  const c = centroid(g, fi);
  let bestDist = Infinity, bestIdx = -1;
  const n = nBlocks(g);
  const nx = g.count[0], nxy = nx * g.count[1];
  const m = _rotMatrix(g.rotation);
  for (let idx = 0; idx < n; idx++) {
    if (isNaN(variable[idx])) continue;
    const kz = (idx / nxy) | 0;
    const rem = idx - kz * nxy;
    const i = rem % nx, j = (rem / nx) | 0;
    let dx = i * g.size[0], dy = j * g.size[1], dz = kz * g.size[2];
    if (m) {
      const r = _applyRot(m, dx, dy, dz);
      dx = r[0]; dy = r[1]; dz = r[2];
    }
    const ox = g.origin[0] + dx - c[0];
    const oy = g.origin[1] + dy - c[1];
    const oz = g.origin[2] + dz - c[2];
    const d = ox * ox + oy * oy + oz * oz;
    if (d < bestDist) { bestDist = d; bestIdx = idx; }
  }
  return { index: bestIdx, distance: Math.sqrt(bestDist) };
}

export function nearestPopulatedBatch(g, variable, flatIndices) {
  const n = flatIndices.length;
  const indices = new Int32Array(n);
  const distances = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = nearestPopulated(g, variable, flatIndices[i]);
    indices[i] = r.index;
    distances[i] = r.distance;
  }
  return { indices, distances };
}

// ── reblocking ──

export function upscale(g, variable, opts) {
  const factor = opts.factor;
  const method = opts.method || 'mean';
  const mask = opts.mask;
  const density = opts.density;
  const cnx = Math.ceil(g.count[0] / factor[0]);
  const cny = Math.ceil(g.count[1] / factor[1]);
  const cnz = Math.ceil(g.count[2] / factor[2]);
  const coarseGrid = {
    origin: [...g.origin],
    size: [g.size[0] * factor[0], g.size[1] * factor[1], g.size[2] * factor[2]],
    count: [cnx, cny, cnz],
    rotation: g.rotation ? [...g.rotation] : [0, 0, 0],
  };
  const cn = cnx * cny * cnz;
  const coarseVar = new Float64Array(cn).fill(NaN);
  const support = new Int32Array(cn);
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const cnxy = cnx * cny;

  // for majority method
  const buckets = method === 'majority' ? Array.from({ length: cn }, () => new Map()) : null;

  for (let kz = 0; kz < nz; kz++) {
    const ck = (kz / factor[2]) | 0;
    for (let j = 0; j < ny; j++) {
      const cj = (j / factor[1]) | 0;
      for (let i = 0; i < nx; i++) {
        const fineIdx = i + j * nx + kz * nxy;
        if (mask && !mask[fineIdx]) continue;
        if (isNaN(variable[fineIdx])) continue;
        const ci = (i / factor[0]) | 0;
        const coarseIdx = ci + cj * cnx + ck * cnxy;
        support[coarseIdx]++;

        if (method === 'majority') {
          const v = variable[fineIdx];
          buckets[coarseIdx].set(v, (buckets[coarseIdx].get(v) || 0) + 1);
        } else if (method === 'sum') {
          coarseVar[coarseIdx] = (isNaN(coarseVar[coarseIdx]) ? 0 : coarseVar[coarseIdx]) + variable[fineIdx];
        } else if (method === 'min') {
          if (isNaN(coarseVar[coarseIdx]) || variable[fineIdx] < coarseVar[coarseIdx]) coarseVar[coarseIdx] = variable[fineIdx];
        } else if (method === 'max') {
          if (isNaN(coarseVar[coarseIdx]) || variable[fineIdx] > coarseVar[coarseIdx]) coarseVar[coarseIdx] = variable[fineIdx];
        } else if (method === 'volumeWeightedMean' && density) {
          const d = typeof density === 'number' ? density : density[fineIdx];
          const prev = isNaN(coarseVar[coarseIdx]) ? 0 : coarseVar[coarseIdx];
          // store running weighted sum in coarseVar, divide later
          coarseVar[coarseIdx] = prev + variable[fineIdx] * d;
        } else {
          // mean (default)
          const prev = isNaN(coarseVar[coarseIdx]) ? 0 : coarseVar[coarseIdx];
          coarseVar[coarseIdx] = prev + variable[fineIdx];
        }
      }
    }
  }

  // finalize
  for (let c = 0; c < cn; c++) {
    if (support[c] === 0) continue;
    if (method === 'mean') coarseVar[c] /= support[c];
    else if (method === 'volumeWeightedMean' && density) {
      // need total weight
      // recompute total density for this coarse block
      let totalW = 0;
      const ci = c % cnx, cj = ((c % cnxy) / cnx) | 0, ck = (c / cnxy) | 0;
      for (let dk = 0; dk < factor[2]; dk++) {
        const kz = ck * factor[2] + dk;
        if (kz >= nz) break;
        for (let dj = 0; dj < factor[1]; dj++) {
          const jj = cj * factor[1] + dj;
          if (jj >= ny) break;
          for (let di = 0; di < factor[0]; di++) {
            const ii = ci * factor[0] + di;
            if (ii >= nx) break;
            const fIdx = ii + jj * nx + kz * nxy;
            if (mask && !mask[fIdx]) continue;
            if (isNaN(variable[fIdx])) continue;
            totalW += typeof density === 'number' ? density : density[fIdx];
          }
        }
      }
      coarseVar[c] = totalW > 0 ? coarseVar[c] / totalW : NaN;
    } else if (method === 'majority') {
      let best = 0, bestCount = 0;
      for (const [val, cnt] of buckets[c]) {
        if (cnt > bestCount) { bestCount = cnt; best = val; }
      }
      coarseVar[c] = best;
    }
  }

  return { gridDef: coarseGrid, variable: coarseVar, support };
}

export function downscale(g, variable, opts) {
  const factor = opts.factor;
  const fnx = g.count[0] * factor[0];
  const fny = g.count[1] * factor[1];
  const fnz = g.count[2] * factor[2];
  const fineGrid = {
    origin: [...g.origin],
    size: [g.size[0] / factor[0], g.size[1] / factor[1], g.size[2] / factor[2]],
    count: [fnx, fny, fnz],
    rotation: g.rotation ? [...g.rotation] : [0, 0, 0],
  };
  // adjust origin: fine block (0,0,0) centroid = coarse block (0,0,0) centroid - offset
  // fine origin = coarse origin - (factor-1)/2 * fineSize
  fineGrid.origin[0] = g.origin[0] - (factor[0] - 1) / 2 * fineGrid.size[0];
  fineGrid.origin[1] = g.origin[1] - (factor[1] - 1) / 2 * fineGrid.size[1];
  fineGrid.origin[2] = g.origin[2] - (factor[2] - 1) / 2 * fineGrid.size[2];
  const fn = fnx * fny * fnz;
  const fineVar = new Float64Array(fn);
  const nx = g.count[0], nxy = nx * g.count[1];
  const fnxy = fnx * fny;
  for (let kz = 0; kz < g.count[2]; kz++) {
    for (let j = 0; j < g.count[1]; j++) {
      for (let i = 0; i < g.count[0]; i++) {
        const val = variable[i + j * nx + kz * nxy];
        for (let dk = 0; dk < factor[2]; dk++) {
          for (let dj = 0; dj < factor[1]; dj++) {
            for (let di = 0; di < factor[0]; di++) {
              const fi = i * factor[0] + di;
              const fj = j * factor[1] + dj;
              const fk = kz * factor[2] + dk;
              fineVar[fi + fj * fnx + fk * fnxy] = val;
            }
          }
        }
      }
    }
  }
  return { gridDef: fineGrid, variable: fineVar };
}

export function regrid(sourceG, sourceVar, targetG, opts) {
  const method = opts?.method || 'nearest';
  const mask = opts?.mask;
  const tn = nBlocks(targetG);
  const out = new Float64Array(tn).fill(NaN);
  const tnx = targetG.count[0], tny = targetG.count[1], tnz = targetG.count[2], tnxy = tnx * tny;
  const tm = _rotMatrix(targetG.rotation);

  if (method === 'nearest') {
    // for each target block, locate in source grid
    const sm = _rotMatrix(sourceG.rotation);
    const sinv = sm ? _invertRot(sm) : null;
    const snx = sourceG.count[0], sny = sourceG.count[1], snz = sourceG.count[2];
    for (let k = 0; k < tnz; k++) {
      for (let j = 0; j < tny; j++) {
        for (let i = 0; i < tnx; i++) {
          // target block centroid in world coords
          let dx = i * targetG.size[0], dy = j * targetG.size[1], dz = k * targetG.size[2];
          if (tm) {
            const r = _applyRot(tm, dx, dy, dz);
            dx = r[0]; dy = r[1]; dz = r[2];
          }
          const wx = targetG.origin[0] + dx;
          const wy = targetG.origin[1] + dy;
          const wz = targetG.origin[2] + dz;
          // locate in source grid
          let sdx = wx - sourceG.origin[0], sdy = wy - sourceG.origin[1], sdz = wz - sourceG.origin[2];
          if (sinv) {
            const r = _applyRot(sinv, sdx, sdy, sdz);
            sdx = r[0]; sdy = r[1]; sdz = r[2];
          }
          const si = Math.round(sdx / sourceG.size[0]);
          const sj = Math.round(sdy / sourceG.size[1]);
          const sk = Math.round(sdz / sourceG.size[2]);
          if (si >= 0 && si < snx && sj >= 0 && sj < sny && sk >= 0 && sk < snz) {
            const srcIdx = si + sj * snx + sk * snx * sny;
            if (mask && !mask[srcIdx]) continue;
            out[i + j * tnx + k * tnxy] = sourceVar[srcIdx];
          }
        }
      }
    }
  }
  // volumeWeighted deferred to v2

  return out;
}
