// @gcu/grid — geometry: index conversion, coordinate computation, grid properties

// ── index conversion ──

export function ijk(g, k) {
  const nx = g.count[0], nxy = nx * g.count[1];
  const kz = (k / nxy) | 0;
  const rem = k - kz * nxy;
  return [rem % nx, (rem / nx) | 0, kz];
}

export function flatIndex(g, i, j, k) {
  return i + j * g.count[0] + k * g.count[0] * g.count[1];
}

export function isValid(g, i, j, k) {
  return i >= 0 && i < g.count[0] && j >= 0 && j < g.count[1] && k >= 0 && k < g.count[2];
}

export function ijkBatch(g, indices) {
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

export function flatIndexBatch(g, is, js, ks) {
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

export { _rotMatrix, _applyRot, _invertRot };

// ── coordinate computation ──

export function centroid(g, k) {
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

export function corners(g, k) {
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

export function centroids(g) {
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

export function centroidsSubset(g, indices) {
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

export function locate(g, x, y, z) {
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

export function locateBatch(g, xs, ys, zs) {
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

export function nBlocks(g) {
  return g.count[0] * g.count[1] * g.count[2];
}

export function blockVolume(g) {
  return g.size[0] * g.size[1] * g.size[2];
}

export function boundingBox(g) {
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

export function isCompatible(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.origin[i] !== b.origin[i]) return false;
    if (a.size[i] !== b.size[i]) return false;
    if (a.count[i] !== b.count[i]) return false;
  }
  const ra = a.rotation || [0, 0, 0], rb = b.rotation || [0, 0, 0];
  return ra[0] === rb[0] && ra[1] === rb[1] && ra[2] === rb[2];
}

// ── sub-grid ──

export function subgrid(g, ranges) {
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
