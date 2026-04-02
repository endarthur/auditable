// dee tool — synthetic block model generator (no GSLIB dependency)

// seeded PRNG (xoshiro128**)
function _rng(seed) {
  let s = [seed >>> 0, (seed * 0x6C078965 + 1) >>> 0, (seed * 0x5D588B65 + 1) >>> 0, (seed * 0x9908B0DF + 1) >>> 0];
  return function() {
    const r = (Math.imul(s[1], 5) << 7 | Math.imul(s[1], 5) >>> 25) * 9;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (r >>> 0) / 4294967296;
  };
}

// 3D value noise with interpolation
function _noise3d(rand, nx, ny, nz) {
  // generate random field then smooth
  const n = nx * ny * nz;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = rand() * 2 - 1;

  // box filter smoothing (3 passes for approximate Gaussian)
  function smooth(arr) {
    const out = new Float64Array(n);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          let sum = 0, c = 0;
          for (let dk = -1; dk <= 1; dk++) {
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                const ii = i + di, jj = j + dj, kk = k + dk;
                if (ii >= 0 && ii < nx && jj >= 0 && jj < ny && kk >= 0 && kk < nz) {
                  sum += arr[ii + jj * nx + kk * nx * ny];
                  c++;
                }
              }
            }
          }
          out[i + j * nx + k * nx * ny] = sum / c;
        }
      }
    }
    return out;
  }

  let field = raw;
  for (let pass = 0; pass < 3; pass++) field = smooth(field);
  return field;
}

function generateSynthetic(opts = {}) {
  const preset = PRESETS[opts.size] || PRESETS.medium;
  const { nx, ny, nz } = preset;
  const n = nx * ny * nz;
  const seed = opts.seed || 42;
  const blockSize = opts.blockSize || [10, 10, (nz > 30 ? 5 : 10)];
  const rand = _rng(seed);

  const gridDef = {
    origin: [650000, 7200000, -nz * blockSize[2] / 2],
    size: blockSize,
    count: [nx, ny, nz],
  };

  // base field with spatial correlation
  const field = _noise3d(rand, nx, ny, nz);

  // optional enrichment zone (ellipsoidal high-grade core)
  const cx = nx / 2, cy = ny / 2, cz = nz / 2;
  const values = new Float64Array(n);
  const indices = new Int32Array(n);
  let count = 0;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + j * nx + k * nx * ny;
        // distance from center (normalized)
        const di = (i - cx) / (nx * 0.35);
        const dj = (j - cy) / (ny * 0.35);
        const dk = (k - cz) / (nz * 0.4);
        const r2 = di * di + dj * dj + dk * dk;
        // enrichment: high grade near center
        const enrichment = Math.max(0, 3.0 * (1 - r2));
        // base grade + enrichment + noise
        const grade = Math.max(1, field[idx] * 8 + 25 + enrichment);
        values[count] = grade;
        indices[count] = idx;
        count++;
      }
    }
  }

  const compactVar = { values: values.slice(0, count), indices: indices.slice(0, count) };

  // synthetic drillholes
  const drillholes = [];
  const spacing = Math.max(3, Math.floor(nx / 6));
  let holeId = 0;
  for (let dj = 2; dj < ny; dj += spacing) {
    for (let di = 2; di < nx; di += spacing) {
      const hx = gridDef.origin[0] + di * blockSize[0];
      const hy = gridDef.origin[1] + dj * blockSize[1];
      const collar = [hx, hy, gridDef.origin[2] + (nz - 1) * blockSize[2]];
      const intervals = [];
      for (let k = nz - 1; k >= 0; k--) {
        const idx = di + dj * nx + k * nx * ny;
        const depth = (nz - 1 - k) * blockSize[2];
        intervals.push({ from: depth, to: depth + blockSize[2], value: values[idx] });
      }
      holeId++;
      drillholes.push({
        id: `DDH-${String(holeId).padStart(3, '0')}`,
        collar,
        surveys: [{ depth: 0, azimuth: 0, dip: -90 }],
        intervals,
      });
    }
  }

  return { gridDef, compactVar, drillholes, columnNames: ['grade'], columns: { grade: compactVar } };
}
