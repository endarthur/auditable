// DCDMA wireline diamond core sizes

const CORES = [
  { code: 'AQ',  core_mm: 27.0, hole_mm: 48.0,  variant: 'standard' },
  { code: 'BQ',  core_mm: 36.5, hole_mm: 60.0,  variant: 'standard' },
  { code: 'NQ',  core_mm: 47.6, hole_mm: 75.7,  variant: 'standard' },
  { code: 'NQ2', core_mm: 50.6, hole_mm: 75.7,  variant: 'oversize' },
  { code: 'NQ3', core_mm: 45.1, hole_mm: 75.7,  variant: 'triple_tube' },
  { code: 'HQ',  core_mm: 63.5, hole_mm: 96.0,  variant: 'standard' },
  { code: 'HQ3', core_mm: 61.1, hole_mm: 96.0,  variant: 'triple_tube' },
  { code: 'PQ',  core_mm: 85.0, hole_mm: 122.6, variant: 'standard' },
  { code: 'PQ3', core_mm: 83.0, hole_mm: 122.6, variant: 'triple_tube' },
];

const BY_CODE = {};
for (const row of CORES) BY_CODE[row.code] = row;

function lookup(code) {
  const row = BY_CODE[code];
  if (!row) throw new Error(`unknown core code: ${code}`);
  return row;
}

function mmToCm(mm) {
  return Math.round(mm * 100) / 1000;
}

const core = {
  diameter(code) {
    const { core_mm } = lookup(code);
    return { mm: core_mm, cm: mmToCm(core_mm) };
  },

  holeDiameter(code) {
    const { hole_mm } = lookup(code);
    return { mm: hole_mm, cm: mmToCm(hole_mm) };
  },

  halfCoreDiameter(code) {
    const { core_mm } = lookup(code);
    const half = core_mm / 2;
    return { mm: Math.round(half * 10) / 10, cm: mmToCm(half) };
  },

  unitVolume(code, opts) {
    const { core_mm } = lookup(code);
    const d_cm = core_mm / 10;
    // cross-sectional area × 100 cm (1 metre of core)
    let cm3 = PI / 4 * d_cm * d_cm * 100;
    const split = opts?.split || 'whole';
    if (split === 'half') cm3 /= 2;
    else if (split === 'quarter') cm3 /= 4;
    return {
      cm3_per_m: Math.round(cm3 * 10) / 10,
      m3_per_m: Math.round(cm3 * 1e-6 * 1e9) / 1e9,
    };
  },

  sampleMass({ code, length_m, density_gcm3, split }) {
    const vol = core.unitVolume(code, { split: split || 'whole' });
    const volume_cm3 = vol.cm3_per_m * length_m;
    const mass_g = volume_cm3 * density_gcm3;
    return {
      mass_g: Math.round(mass_g),
      mass_kg: Math.round(mass_g / 100) / 10,
      volume_cm3: Math.round(volume_cm3 * 10) / 10,
    };
  },

  table() {
    return CORES.map(r => ({ ...r }));
  },
};

export { core };
