// @gcu/grid — selection: masks, scatter/gather, surface helpers

// ── mask ↔ indices ──

export function maskToIndices(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  const out = new Int32Array(count);
  let p = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[p++] = i;
  return out;
}

export function indicesToMask(indices, n) {
  const mask = new Uint8Array(n);
  for (let i = 0; i < indices.length; i++) mask[indices[i]] = 1;
  return mask;
}

// ── set operations on masks ──

export function union(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

export function intersection(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & b[i];
  return out;
}

export function difference(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & (b[i] ^ 1);
  return out;
}

export function invert(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ^ 1;
  return out;
}

export function maskCount(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── scatter / gather ──

export function scatter(compact, indices, n, fill) {
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

export function gather(full, indices) {
  const out = new full.constructor(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = full[indices[i]];
  return out;
}

export function take(compact, localIndices) {
  const out = new compact.constructor(localIndices.length);
  for (let i = 0; i < localIndices.length; i++) out[i] = compact[localIndices[i]];
  return out;
}

export function reindex(gridIndices, activeIndices) {
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

export function maskAbove(g, surfaceZ) {
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

export function maskBelow(g, surfaceZ) {
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

export function maskBetween(g, topZ, botZ) {
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

export function maskFromClassification(classification, value) {
  const mask = new Uint8Array(classification.length);
  if (value && typeof value === 'object' && value.nonzero) {
    for (let i = 0; i < classification.length; i++) if (classification[i] !== 0) mask[i] = 1;
  } else {
    for (let i = 0; i < classification.length; i++) if (classification[i] === value) mask[i] = 1;
  }
  return mask;
}

// ── mask from variable threshold ──

export function maskWhere(variable, predicate) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (predicate(variable[i])) mask[i] = 1;
  return mask;
}

export function maskAboveValue(variable, threshold) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] > threshold) mask[i] = 1;
  return mask;
}

export function maskBelowValue(variable, threshold) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] < threshold) mask[i] = 1;
  return mask;
}

export function maskEqualTo(variable, value) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] === value) mask[i] = 1;
  return mask;
}

export function maskInRange(variable, lo, hi) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (variable[i] >= lo && variable[i] <= hi) mask[i] = 1;
  return mask;
}

export function maskNotNaN(variable) {
  const mask = new Uint8Array(variable.length);
  for (let i = 0; i < variable.length; i++) if (!isNaN(variable[i])) mask[i] = 1;
  return mask;
}
