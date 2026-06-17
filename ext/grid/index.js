// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/grid — Regular block-model grid utilities: geometry (index/flat conversion, centroids, rotation), selections (masks, boolean ops), compacting, operations (map, reduce, histogram, grade-tonnage), spatial queries (slices, shells, regridding).

// ── src/geometry.js ──

// @gcu/grid — geometry: index conversion, coordinate computation, grid properties

// ── index conversion ──

function ijk(g, k) {
  const nx = g.count[0], nxy = nx * g.count[1];
  const kz = (k / nxy) | 0;
  const rem = k - kz * nxy;
  return [rem % nx, (rem / nx) | 0, kz];
}

function flatIndex(g, i, j, k) {
  return i + j * g.count[0] + k * g.count[0] * g.count[1];
}

function isValid(g, i, j, k) {
  return i >= 0 && i < g.count[0] && j >= 0 && j < g.count[1] && k >= 0 && k < g.count[2];
}

function ijkBatch(g, indices) {
  const n = indices.length;
  const is = new Int32Array(n), js = new Int32Array(n), ks = new Int32Array(n);
  const nx = g.count[0], nxy = nx * g.count[1];
  for (let p = 0; p < n; p++) {
    const idx = indices[p];
    const kz = (idx / nxy) | 0;
    const rem = idx - kz * nxy;
    is[p] = rem % nx;
    js[p] = (rem / nx) | 0;
    ks[p] = kz;
  }
  return { is, js, ks };
}

function flatIndexBatch(g, is, js, ks) {
  const n = is.length;
  const out = new Int32Array(n);
  const nx = g.count[0], nxy = nx * g.count[1];
  for (let p = 0; p < n; p++) out[p] = is[p] + js[p] * nx + ks[p] * nxy;
  return out;
}

// ── rotation ──

function _rotMatrix(rot) {
  if (!rot || (rot[0] === 0 && rot[1] === 0 && rot[2] === 0)) return null;
  // dip direction / dip / rake → rotation matrix
  const dd = rot[0] * Math.PI / 180;
  const dip = rot[1] * Math.PI / 180;
  const rake = rot[2] * Math.PI / 180;
  const cd = Math.cos(dd), sd = Math.sin(dd);
  const cp = Math.cos(dip), sp = Math.sin(dip);
  const cr = Math.cos(rake), sr = Math.sin(rake);
  // Rz(dd) * Rx(dip) * Ry(rake)
  return [
    cd * cr - sd * sp * sr, -sd * cp, cd * sr + sd * sp * cr,
    sd * cr + cd * sp * sr,  cd * cp, sd * sr - cd * sp * cr,
    -cp * sr,                sp,       cp * cr,
  ];
}

function _applyRot(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

function _invertRot(m) {
  // rotation matrix inverse = transpose
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}


// ── coordinate computation ──

function centroid(g, k) {
  const nx = g.count[0], nxy = nx * g.count[1];
  const kz = (k / nxy) | 0;
  const rem = k - kz * nxy;
  const i = rem % nx, j = (rem / nx) | 0;
  let x = g.origin[0] + i * g.size[0];
  let y = g.origin[1] + j * g.size[1];
  let z = g.origin[2] + kz * g.size[2];
  const m = _rotMatrix(g.rotation);
  if (m) {
    const dx = x - g.origin[0], dy = y - g.origin[1], dz = z - g.origin[2];
    const r = _applyRot(m, dx, dy, dz);
    return [g.origin[0] + r[0], g.origin[1] + r[1], g.origin[2] + r[2]];
  }
  return [x, y, z];
}

function corners(g, k) {
  const c = centroid(g, k);
  const hx = g.size[0] / 2, hy = g.size[1] / 2, hz = g.size[2] / 2;
  const m = _rotMatrix(g.rotation);
  const out = new Float64Array(24);
  let p = 0;
  for (let dz = -1; dz <= 1; dz += 2) {
    for (let dy = -1; dy <= 1; dy += 2) {
      for (let dx = -1; dx <= 1; dx += 2) {
        let ox = dx * hx, oy = dy * hy, oz = dz * hz;
        if (m) {
          const r = _applyRot(m, ox, oy, oz);
          ox = r[0]; oy = r[1]; oz = r[2];
        }
        out[p++] = c[0] + ox;
        out[p++] = c[1] + oy;
        out[p++] = c[2] + oz;
      }
    }
  }
  return out;
}

function centroids(g) {
  const n = nBlocks(g);
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const m = _rotMatrix(g.rotation);
  for (let kz = 0; kz < nz; kz++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + kz * nxy;
        let dx = i * g.size[0], dy = j * g.size[1], dz = kz * g.size[2];
        if (m) {
          const r = _applyRot(m, dx, dy, dz);
          dx = r[0]; dy = r[1]; dz = r[2];
        }
        xs[idx] = g.origin[0] + dx;
        ys[idx] = g.origin[1] + dy;
        zs[idx] = g.origin[2] + dz;
      }
    }
  }
  return { xs, ys, zs };
}

function centroidsSubset(g, indices) {
  const n = indices.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  const nx = g.count[0], nxy = nx * g.count[1];
  const m = _rotMatrix(g.rotation);
  for (let p = 0; p < n; p++) {
    const idx = indices[p];
    const kz = (idx / nxy) | 0;
    const rem = idx - kz * nxy;
    const i = rem % nx, j = (rem / nx) | 0;
    let dx = i * g.size[0], dy = j * g.size[1], dz = kz * g.size[2];
    if (m) {
      const r = _applyRot(m, dx, dy, dz);
      dx = r[0]; dy = r[1]; dz = r[2];
    }
    xs[p] = g.origin[0] + dx;
    ys[p] = g.origin[1] + dy;
    zs[p] = g.origin[2] + dz;
  }
  return { xs, ys, zs };
}

function locate(g, x, y, z) {
  let dx = x - g.origin[0], dy = y - g.origin[1], dz = z - g.origin[2];
  const m = _rotMatrix(g.rotation);
  if (m) {
    const inv = _invertRot(m);
    const r = _applyRot(inv, dx, dy, dz);
    dx = r[0]; dy = r[1]; dz = r[2];
  }
  const i = Math.round(dx / g.size[0]);
  const j = Math.round(dy / g.size[1]);
  const k = Math.round(dz / g.size[2]);
  if (!isValid(g, i, j, k)) return -1;
  return flatIndex(g, i, j, k);
}

function locateBatch(g, xs, ys, zs) {
  const n = xs.length;
  const out = new Int32Array(n);
  const m = _rotMatrix(g.rotation);
  const inv = m ? _invertRot(m) : null;
  const nx = g.count[0], ny = g.count[1], nz = g.count[2];
  for (let p = 0; p < n; p++) {
    let dx = xs[p] - g.origin[0], dy = ys[p] - g.origin[1], dz = zs[p] - g.origin[2];
    if (inv) {
      const r = _applyRot(inv, dx, dy, dz);
      dx = r[0]; dy = r[1]; dz = r[2];
    }
    const i = Math.round(dx / g.size[0]);
    const j = Math.round(dy / g.size[1]);
    const k = Math.round(dz / g.size[2]);
    out[p] = (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz)
      ? i + j * nx + k * nx * ny : -1;
  }
  return out;
}

// ── grid properties ──

function nBlocks(g) {
  return g.count[0] * g.count[1] * g.count[2];
}

function blockVolume(g) {
  return g.size[0] * g.size[1] * g.size[2];
}

function boundingBox(g) {
  // compute all 8 corners of the grid bounding box
  const nx = g.count[0] - 1, ny = g.count[1] - 1, nz = g.count[2] - 1;
  const hx = g.size[0] / 2, hy = g.size[1] / 2, hz = g.size[2] / 2;
  const m = _rotMatrix(g.rotation);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let kz = 0; kz <= 1; kz++) {
    for (let jj = 0; jj <= 1; jj++) {
      for (let ii = 0; ii <= 1; ii++) {
        // corner of grid extent (including half-cell on each side)
        let dx = (ii * nx) * g.size[0] + (ii * 2 - 1) * hx;
        let dy = (jj * ny) * g.size[1] + (jj * 2 - 1) * hy;
        let dz = (kz * nz) * g.size[2] + (kz * 2 - 1) * hz;
        if (m) {
          const r = _applyRot(m, dx, dy, dz);
          dx = r[0]; dy = r[1]; dz = r[2];
        }
        const x = g.origin[0] + dx, y = g.origin[1] + dy, z = g.origin[2] + dz;
        if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      }
    }
  }
  return { min, max };
}

function isCompatible(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.origin[i] !== b.origin[i]) return false;
    if (a.size[i] !== b.size[i]) return false;
    if (a.count[i] !== b.count[i]) return false;
  }
  const ra = a.rotation || [0, 0, 0], rb = b.rotation || [0, 0, 0];
  return ra[0] === rb[0] && ra[1] === rb[1] && ra[2] === rb[2];
}

// ── sub-grid ──

function subgrid(g, ranges) {
  const [i0, i1] = ranges.iRange;
  const [j0, j1] = ranges.jRange;
  const [k0, k1] = ranges.kRange;
  const snx = i1 - i0 + 1, sny = j1 - j0 + 1, snz = k1 - k0 + 1;
  const m = _rotMatrix(g.rotation);
  // compute new origin (centroid of block i0,j0,k0)
  let dx = i0 * g.size[0], dy = j0 * g.size[1], dz = k0 * g.size[2];
  if (m) {
    const r = _applyRot(m, dx, dy, dz);
    dx = r[0]; dy = r[1]; dz = r[2];
  }
  const newGrid = {
    origin: [g.origin[0] + dx, g.origin[1] + dy, g.origin[2] + dz],
    size: [...g.size],
    count: [snx, sny, snz],
    rotation: g.rotation ? [...g.rotation] : [0, 0, 0],
  };
  const nx = g.count[0], nxy = nx * g.count[1];
  const n = snx * sny * snz;
  const parentIndices = new Int32Array(n);
  const childIndices = new Int32Array(n);
  let p = 0;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        parentIndices[p] = i + j * nx + k * nxy;
        childIndices[p] = (i - i0) + (j - j0) * snx + (k - k0) * snx * sny;
        p++;
      }
    }
  }
  return { gridDef: newGrid, parentIndices, childIndices };
}

// ── src/selection.js ──

// @gcu/grid — selection: masks, scatter/gather, surface helpers

// ── mask ↔ indices ──

function maskToIndices(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  const out = new Int32Array(count);
  let p = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[p++] = i;
  return out;
}

function indicesToMask(indices, n) {
  const mask = new Uint8Array(n);
  for (let i = 0; i < indices.length; i++) mask[indices[i]] = 1;
  return mask;
}

// ── set operations on masks ──

function union(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

function intersection(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & b[i];
  return out;
}

function difference(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & (b[i] ^ 1);
  return out;
}

function invert(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ^ 1;
  return out;
}

function maskCount(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── scatter / gather ──

function scatter(compact, indices, n, fill) {
  const out = new compact.constructor(n);
  if (fill !== undefined && fill !== 0) out.fill(fill);
  else if (compact instanceof Float64Array || compact instanceof Float32Array) {
    for (let i = 0; i < n; i++) out[i] = NaN;
    if (fill === 0) out.fill(0);
    else if (fill === undefined) { /* NaN default for float */ }
    else out.fill(fill);
  }
  for (let i = 0; i < indices.length; i++) out[indices[i]] = compact[i];
  return out;
}

function gather(full, indices) {
  const out = new full.constructor(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = full[indices[i]];
  return out;
}

function take(compact, localIndices) {
  const out = new compact.constructor(localIndices.length);
  for (let i = 0; i < localIndices.length; i++) out[i] = compact[localIndices[i]];
  return out;
}

function reindex(gridIndices, activeIndices) {
  // binary search each gridIndex in the sorted activeIndices
  const out = new Int32Array(gridIndices.length);
  for (let i = 0; i < gridIndices.length; i++) {
    const target = gridIndices[i];
    let lo = 0, hi = activeIndices.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (activeIndices[mid] === target) { found = mid; break; }
      if (activeIndices[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    out[i] = found;
  }
  return out;
}

// ── surface-to-mask helpers ──

function maskAbove(g, surfaceZ) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const mask = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = g.origin[2] + k * g.size[2];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (z > surfaceZ[i + j * nx]) mask[i + j * nx + k * nxy] = 1;
      }
    }
  }
  return mask;
}

function maskBelow(g, surfaceZ) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const mask = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = g.origin[2] + k * g.size[2];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (z < surfaceZ[i + j * nx]) mask[i + j * nx + k * nxy] = 1;
      }
    }
  }
  return mask;
}

function maskBetween(g, topZ, botZ) {
  const nx = g.count[0], ny = g.count[1], nz = g.count[2], nxy = nx * ny;
  const mask = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = g.origin[2] + k * g.size[2];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const col = i + j * nx;
        if (z < topZ[col] && z > botZ[col]) mask[col + k * nxy] = 1;
      }
    }
  }
  return mask;
}

function maskFromClassification(classification, value) {
  const mask = new Uint8Array(classification.length);
  if (value && typeof value === 'object' && value.nonzero) {
    for (let i = 0; i < classification.length; i++) if (classification[i] !== 0) mask[i] = 1;
  } else {
    for (let i = 0; i < classification.length; i++) if (classification[i] === value) mask[i] = 1;
  }
  return mask;
}

// ── mask from variable threshold ──

function maskWhere(variable, predicate) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (predicate(variable[i])) mask[i] = 1;
  return mask;
}

function maskAboveValue(variable, threshold) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] > threshold) mask[i] = 1;
  return mask;
}

function maskBelowValue(variable, threshold) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] < threshold) mask[i] = 1;
  return mask;
}

function maskEqualTo(variable, value) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] === value) mask[i] = 1;
  return mask;
}

function maskInRange(variable, lo, hi) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] >= lo && variable[i] <= hi) mask[i] = 1;
  return mask;
}

function maskNotNaN(variable) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (!isNaN(variable[i])) mask[i] = 1;
  return mask;
}

// ── src/compact.js ──

// @gcu/grid — compact variables: alignment, reduction, domain operations

// ── alignment ──

function align(compactVars, opts) {
  const fill = opts?.fill ?? NaN;
  // merge all index sets into a sorted union
  const indices = unionIndices(...compactVars.map(v => v.indices));
  const n = indices.length;
  // build lookup: grid index → position in union
  const lookup = new Map();
  for (let i = 0; i < n; i++) lookup.set(indices[i], i);
  // align each variable
  const aligned = compactVars.map(cv => {
    const out = new Float64Array(n).fill(fill);
    for (let i = 0; i < cv.indices.length; i++) {
      const pos = lookup.get(cv.indices[i]);
      if (pos !== undefined) out[pos] = cv.values[i];
    }
    return out;
  });
  return { aligned, indices };
}

// ── reduction ──

function reduce(compactVars, fn, opts) {
  const fill = opts?.fill ?? NaN;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const d = compactVars.length;
  const values = new Float64Array(n);
  const buf = new Array(d);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) buf[j] = aligned[j][i];
    values[i] = fn(buf, indices[i]);
  }
  return { values, indices };
}

// ── named fast-path reductions ──

function dilute(domains) {
  const allIndices = unionIndices(...domains.map(d => d.indices));
  const n = allIndices.length;
  const values = new Float64Array(n);
  // build per-domain lookups
  const lookups = domains.map(d => {
    const m = new Map();
    for (let i = 0; i < d.indices.length; i++) m.set(d.indices[i], i);
    return m;
  });
  for (let i = 0; i < n; i++) {
    const gIdx = allIndices[i];
    let sum = 0;
    for (let d = 0; d < domains.length; d++) {
      const pos = lookups[d].get(gIdx);
      if (pos !== undefined) sum += domains[d].values[pos] * domains[d].proportions[pos];
    }
    values[i] = sum;
  }
  return { values, indices: allIndices };
}

function sum(compactVars, opts) {
  const fill = opts?.fill ?? 0;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < aligned.length; d++) s += aligned[d][i];
    values[i] = s;
  }
  return { values, indices };
}

function mean(compactVars, opts) {
  const skipNaN = opts?.skipNaN !== false;
  const { aligned, indices } = align(compactVars, { fill: NaN });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let d = 0; d < aligned.length; d++) {
      const v = aligned[d][i];
      if (skipNaN && isNaN(v)) continue;
      s += v; c++;
    }
    values[i] = c > 0 ? s / c : NaN;
  }
  return { values, indices };
}

function min(compactVars, opts) {
  const fill = opts?.fill ?? Infinity;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let d = 0; d < aligned.length; d++) {
      const v = aligned[d][i];
      if (v < m) m = v;
    }
    values[i] = m;
  }
  return { values, indices };
}

function max(compactVars, opts) {
  const fill = opts?.fill ?? -Infinity;
  const { aligned, indices } = align(compactVars, { fill });
  const n = indices.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let d = 0; d < aligned.length; d++) {
      const v = aligned[d][i];
      if (v > m) m = v;
    }
    values[i] = m;
  }
  return { values, indices };
}

function countPresent(compactVars) {
  const allIndices = unionIndices(...compactVars.map(v => v.indices));
  const n = allIndices.length;
  const values = new Int32Array(n);
  const sets = compactVars.map(v => new Set(Array.from(v.indices)));
  for (let i = 0; i < n; i++) {
    const gIdx = allIndices[i];
    let c = 0;
    for (const s of sets) if (s.has(gIdx)) c++;
    values[i] = c;
  }
  return { values, indices: allIndices };
}

// ── compact set operations ──

function unionIndices(...indexArrays) {
  const s = new Set();
  for (const arr of indexArrays) for (let i = 0; i < arr.length; i++) s.add(arr[i]);
  const out = new Int32Array(s.size);
  let p = 0;
  for (const v of s) out[p++] = v;
  out.sort();
  return out;
}

function intersectionIndices(...indexArrays) {
  if (indexArrays.length === 0) return new Int32Array(0);
  const sets = indexArrays.map(arr => new Set(Array.from(arr)));
  const base = sets[0];
  const result = [];
  for (const v of base) {
    if (sets.every(s => s.has(v))) result.push(v);
  }
  result.sort((a, b) => a - b);
  return new Int32Array(result);
}

function differenceIndices(a, b) {
  const bSet = new Set(Array.from(b));
  const result = [];
  for (let i = 0; i < a.length; i++) if (!bSet.has(a[i])) result.push(a[i]);
  return new Int32Array(result);
}

function restrict(compactVar, targetIndices) {
  const tSet = new Set(Array.from(targetIndices));
  const vals = [], idxs = [];
  for (let i = 0; i < compactVar.indices.length; i++) {
    if (tSet.has(compactVar.indices[i])) {
      vals.push(compactVar.values[i]);
      idxs.push(compactVar.indices[i]);
    }
  }
  return { values: new Float64Array(vals), indices: new Int32Array(idxs) };
}

// ── domain operations ──

function dominantDomain(domains, domainCodes) {
  const allIndices = unionIndices(...domains.map(d => d.indices));
  const n = allIndices.length;
  const values = new Int32Array(n);
  const lookups = domains.map(d => {
    const m = new Map();
    for (let i = 0; i < d.indices.length; i++) m.set(d.indices[i], i);
    return m;
  });
  for (let i = 0; i < n; i++) {
    const gIdx = allIndices[i];
    let bestProp = -1, bestCode = 0;
    for (let d = 0; d < domains.length; d++) {
      const pos = lookups[d].get(gIdx);
      if (pos !== undefined && domains[d].proportions[pos] > bestProp) {
        bestProp = domains[d].proportions[pos];
        bestCode = domainCodes[d];
      }
    }
    values[i] = bestCode;
  }
  return { values, indices: allIndices };
}

function domainFromCategorical(categorical, code) {
  const result = [];
  for (let i = 0; i < categorical.values.length; i++) {
    if (categorical.values[i] === code) result.push(categorical.indices[i]);
  }
  return new Int32Array(result);
}

// ── src/operations.js ──

// @gcu/grid — variable operations: map, stats, histogram, grade-tonnage, swath plots


// ── per-block operations ──

function map(variable, fn) {
  const out = new variable.constructor(variable.length);
  for (let i = 0; i < variable.length; i++) out[i] = fn(variable[i], i);
  return out;
}

function mapMasked(variable, mask, fn) {
  const out = new variable.constructor(variable.length);
  for (let i = 0; i < variable.length; i++) out[i] = mask[i] ? fn(variable[i], i) : variable[i];
  return out;
}

function combine(a, b, fn) {
  const out = new a.constructor(a.length);
  for (let i = 0; i < a.length; i++) out[i] = fn(a[i], b[i], i);
  return out;
}

// ── statistics ──

function stats(variable, opts) {
  const mask = opts?.mask;
  // collect valid values
  const vals = [];
  for (let i = 0; i < variable.length; i++) {
    if (mask && !mask[i]) continue;
    if (!isNaN(variable[i])) vals.push(variable[i]);
  }
  const n = vals.length;
  if (n === 0) return { count: 0, min: NaN, max: NaN, mean: NaN, variance: NaN, stddev: NaN, p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, sum: 0, nNaN: variable.length - n };
  vals.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += vals[i];
  const mn = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (vals[i] - mn) ** 2;
  v /= n;
  const nNaN = (mask ? _maskCount(mask) : variable.length) - n;
  return {
    count: n, min: vals[0], max: vals[n - 1], mean: mn,
    variance: v, stddev: Math.sqrt(v),
    p10: _percentile(vals, 0.10), p25: _percentile(vals, 0.25),
    p50: _percentile(vals, 0.50), p75: _percentile(vals, 0.75),
    p90: _percentile(vals, 0.90),
    sum, nNaN,
  };
}

// nearest-rank percentile
function _percentile(sorted, p) {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function _maskCount(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

function histogram(variable, opts) {
  const mask = opts?.mask;
  const vals = [];
  for (let i = 0; i < variable.length; i++) {
    if (mask && !mask[i]) continue;
    if (!isNaN(variable[i])) vals.push(variable[i]);
  }
  const n = vals.length;
  let lo = opts?.min, hi = opts?.max;
  if (lo === undefined) { lo = Infinity; for (const v of vals) if (v < lo) lo = v; }
  if (hi === undefined) { hi = -Infinity; for (const v of vals) if (v > hi) hi = v; }
  let nBins = opts?.nBins;
  if (opts?.binWidth) nBins = Math.ceil((hi - lo) / opts.binWidth);
  if (!nBins) nBins = Math.max(1, Math.ceil(Math.sqrt(n)));
  const w = (hi - lo) / nBins;
  const edges = new Float64Array(nBins + 1);
  for (let i = 0; i <= nBins; i++) edges[i] = lo + i * w;
  const counts = new Int32Array(nBins);
  for (const v of vals) {
    let bin = Math.floor((v - lo) / w);
    if (bin >= nBins) bin = nBins - 1;
    if (bin < 0) bin = 0;
    counts[bin]++;
  }
  const frequencies = new Float64Array(nBins);
  if (n > 0) for (let i = 0; i < nBins; i++) frequencies[i] = counts[i] / n;
  return { edges, counts, frequencies };
}

function weightedStats(variable, weights, opts) {
  const mask = opts?.mask;
  let sumW = 0, sumWV = 0, mn = 0;
  const vals = [], ws = [];
  for (let i = 0; i < variable.length; i++) {
    if (mask && !mask[i]) continue;
    if (isNaN(variable[i])) continue;
    vals.push(variable[i]);
    ws.push(weights[i]);
    sumW += weights[i];
    sumWV += weights[i] * variable[i];
  }
  const n = vals.length;
  if (n === 0 || sumW === 0) return { count: 0, min: NaN, max: NaN, mean: NaN, variance: NaN, stddev: NaN, sum: 0 };
  mn = sumWV / sumW;
  let v = 0;
  for (let i = 0; i < n; i++) v += ws[i] * (vals[i] - mn) ** 2;
  v /= sumW;
  let lo = Infinity, hi = -Infinity;
  for (const x of vals) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return { count: n, min: lo, max: hi, mean: mn, variance: v, stddev: Math.sqrt(v), sum: sumWV };
}

// ── grade-tonnage ──

function gradeTonnage(grade, density, opts) {
  const mask = opts?.mask;
  const g = opts?.gridDef;
  const vol = g ? blockVolume(g) : 1;

  // determine cutoffs
  let cutoffs = opts?.cutoffs;
  if (!cutoffs) {
    const nc = opts?.nCutoffs || 50;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < grade.length; i++) {
      if (mask && !mask[i]) continue;
      const v = grade[i];
      if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    cutoffs = new Float64Array(nc);
    for (let i = 0; i < nc; i++) cutoffs[i] = lo + (hi - lo) * i / (nc - 1);
  }
  const nc = cutoffs.length;

  // collect valid blocks
  const grades = [], tons = [];
  const isUniform = typeof density === 'number';
  for (let i = 0; i < grade.length; i++) {
    if (mask && !mask[i]) continue;
    if (isNaN(grade[i])) continue;
    grades.push(grade[i]);
    tons.push((isUniform ? density : density[i]) * vol);
  }

  // sort by grade descending for cumulative-from-top
  const idx = Array.from({ length: grades.length }, (_, i) => i);
  idx.sort((a, b) => grades[b] - grades[a]);

  const tonnes = new Float64Array(nc);
  const avgGrade = new Float64Array(nc);
  const metal = new Float64Array(nc);
  const volume = new Float64Array(nc);
  const nBlocksArr = new Int32Array(nc);

  for (let c = 0; c < nc; c++) {
    const co = cutoffs[c];
    let tSum = 0, mSum = 0, count = 0;
    for (let p = 0; p < idx.length; p++) {
      const j = idx[p];
      if (grades[j] < co) break; // sorted descending, done once below cutoff
      tSum += tons[j];
      mSum += tons[j] * grades[j];
      count++;
    }
    tonnes[c] = tSum;
    avgGrade[c] = tSum > 0 ? mSum / tSum : 0;
    metal[c] = mSum;
    volume[c] = count * vol;
    nBlocksArr[c] = count;
  }

  return { cutoffs, tonnes, grade: avgGrade, metal, volume, nBlocks: nBlocksArr };
}

// ── swath plots ──

function swathPlot(variable, gridDef, opts) {
  const axis = opts?.axis || 'z';
  const mask = opts?.mask;
  const statFn = opts?.stat || 'mean';
  const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const nSlices = gridDef.count[ai];
  const nx = gridDef.count[0], ny = gridDef.count[1], nz = gridDef.count[2];
  const nxy = nx * ny;

  const positions = new Float64Array(nSlices);
  for (let s = 0; s < nSlices; s++) positions[s] = gridDef.origin[ai] + s * gridDef.size[ai];

  const sums = new Float64Array(nSlices);
  const counts = new Int32Array(nSlices);
  const sliceVals = Array.from({ length: nSlices }, () => []);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + k * nxy;
        if (mask && !mask[idx]) continue;
        if (isNaN(variable[idx])) continue;
        const s = ai === 0 ? i : ai === 1 ? j : k;
        sums[s] += variable[idx];
        counts[s]++;
        if (typeof statFn === 'function' || statFn === 'p50' || statFn === 'variance') {
          sliceVals[s].push(variable[idx]);
        }
      }
    }
  }

  const values = new Float64Array(nSlices);
  for (let s = 0; s < nSlices; s++) {
    if (counts[s] === 0) { values[s] = NaN; continue; }
    if (statFn === 'mean') { values[s] = sums[s] / counts[s]; }
    else if (statFn === 'count') { values[s] = counts[s]; }
    else if (statFn === 'p50') {
      sliceVals[s].sort((a, b) => a - b);
      values[s] = _percentile(sliceVals[s], 0.5);
    } else if (statFn === 'variance') {
      const mn = sums[s] / counts[s];
      let v = 0;
      for (const x of sliceVals[s]) v += (x - mn) ** 2;
      values[s] = v / counts[s];
    } else if (typeof statFn === 'function') {
      values[s] = statFn(sliceVals[s]);
    }
  }

  return { positions, values, counts };
}

// ── src/spatial.js ──

// @gcu/grid — spatial queries: columns, slices, shells, morphology, nearest, reblocking


// ── column / slice extraction ──

function column(g, i, j) {
  const nz = g.count[2], nx = g.count[0], nxy = nx * g.count[1];
  const out = new Int32Array(nz);
  const base = i + j * nx;
  for (let k = 0; k < nz; k++) out[k] = base + k * nxy;
  return out;
}

function sliceI(g, i) {
  const ny = g.count[1], nz = g.count[2], nx = g.count[0], nxy = nx * ny;
  const out = new Int32Array(ny * nz);
  let p = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) out[p++] = i + j * nx + k * nxy;
  return out;
}

function sliceJ(g, j) {
  const nx = g.count[0], nz = g.count[2], nxy = nx * g.count[1];
  const out = new Int32Array(nx * nz);
  let p = 0;
  const base = j * nx;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) out[p++] = i + base + k * nxy;
  return out;
}

function sliceK(g, k) {
  const nx = g.count[0], ny = g.count[1], nxy = nx * ny;
  const out = new Int32Array(nxy);
  const base = k * nxy;
  for (let i = 0; i < nxy; i++) out[i] = base + i;
  return out;
}

function slicePlane(g, plane) {
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

function shell(mask, nLayers) {
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

function erode(mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) {
    current = _erodeOne(current, mask.length);
  }
  return current;
}

function dilate(mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) {
    current = _dilateOne(current, mask.length);
  }
  return current;
}

// note: shell/erode/dilate operate on flat arrays without grid context.
// They need grid dimensions to know neighbor relationships. We'll use a
// context-setting approach — the caller must provide gridDef.

function shellGrid(g, mask, nLayers) {
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

function erodeGrid(g, mask, nLayers) {
  let current = new Uint8Array(mask);
  for (let layer = 0; layer < nLayers; layer++) current = _erodeOneGrid(g, current);
  return current;
}

function dilateGrid(g, mask, nLayers) {
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

function nearestPopulated(g, variable, fi) {
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

function nearestPopulatedBatch(g, variable, flatIndices) {
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

function upscale(g, variable, opts) {
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

function downscale(g, variable, opts) {
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

function regrid(sourceG, sourceVar, targetG, opts) {
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

// ── src/main.js ──



export {
  ijk,
  flatIndex,
  isValid,
  ijkBatch,
  flatIndexBatch,
  _rotMatrix,
  _applyRot,
  _invertRot,
  centroid,
  corners,
  centroids,
  centroidsSubset,
  locate,
  locateBatch,
  nBlocks,
  blockVolume,
  boundingBox,
  isCompatible,
  subgrid,
  maskToIndices,
  indicesToMask,
  union,
  intersection,
  difference,
  invert,
  maskCount,
  equal,
  scatter,
  gather,
  take,
  reindex,
  maskAbove,
  maskBelow,
  maskBetween,
  maskFromClassification,
  maskWhere,
  maskAboveValue,
  maskBelowValue,
  maskEqualTo,
  maskInRange,
  maskNotNaN,
  align,
  reduce,
  dilute,
  sum,
  mean,
  min,
  max,
  countPresent,
  unionIndices,
  intersectionIndices,
  differenceIndices,
  restrict,
  dominantDomain,
  domainFromCategorical,
  map,
  mapMasked,
  combine,
  stats,
  histogram,
  weightedStats,
  gradeTonnage,
  swathPlot,
  column,
  sliceI,
  sliceJ,
  sliceK,
  slicePlane,
  shell,
  erode,
  dilate,
  shellGrid,
  erodeGrid,
  dilateGrid,
  nearestPopulated,
  nearestPopulatedBatch,
  upscale,
  downscale,
  regrid,
};
