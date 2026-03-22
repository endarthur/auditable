// Unit dimension registry and convert function

const PI = Math.PI;

const UNITS = {
  // length (canonical: m)
  um:  { dim: 'length', mul: 1e-6 },
  mm:  { dim: 'length', mul: 1e-3 },
  cm:  { dim: 'length', mul: 1e-2 },
  m:   { dim: 'length', mul: 1 },
  km:  { dim: 'length', mul: 1e3 },
  in:  { dim: 'length', mul: 0.0254 },
  ft:  { dim: 'length', mul: 0.3048 },

  // mass (canonical: g)
  mg:      { dim: 'mass', mul: 1e-3 },
  g:       { dim: 'mass', mul: 1 },
  kg:      { dim: 'mass', mul: 1e3 },
  t:       { dim: 'mass', mul: 1e6 },
  kt:      { dim: 'mass', mul: 1e9 },
  Mt:      { dim: 'mass', mul: 1e12 },
  st:      { dim: 'mass', mul: 907185 },
  lt_mass: { dim: 'mass', mul: 1016047 },
  oz:      { dim: 'mass', mul: 28.3495 },
  lb:      { dim: 'mass', mul: 453.592 },
  ozt:     { dim: 'mass', mul: 31.1035 },

  // concentration / grade (canonical: fraction, dimensionless 0–1)
  fraction: { dim: 'grade', mul: 1 },
  ppm:      { dim: 'grade', mul: 1e-6 },
  ppb:      { dim: 'grade', mul: 1e-9 },
  pct:      { dim: 'grade', mul: 1e-2 },
  'g/t':    { dim: 'grade', mul: 1e-6 },
  'mg/kg':  { dim: 'grade', mul: 1e-6 },
  'oz/t':   { dim: 'grade', mul: 31.1035 / 907185 },   // troy oz per short ton
  'oz/lt':  { dim: 'grade', mul: 31.1035 / 1016047 },   // troy oz per long ton

  // density (canonical: g/cm3)
  'g/cm3':  { dim: 'density', mul: 1 },
  'kg/m3':  { dim: 'density', mul: 1e-3 },
  't/m3':   { dim: 'density', mul: 1 },
  'lb/ft3': { dim: 'density', mul: 0.016018 },

  // area (canonical: m2)
  mm2: { dim: 'area', mul: 1e-6 },
  cm2: { dim: 'area', mul: 1e-4 },
  m2:  { dim: 'area', mul: 1 },
  ha:  { dim: 'area', mul: 1e4 },
  km2: { dim: 'area', mul: 1e6 },

  // volume (canonical: m3)
  cm3: { dim: 'volume', mul: 1e-6 },
  L:   { dim: 'volume', mul: 1e-3 },
  m3:  { dim: 'volume', mul: 1 },

  // angle (canonical: rad)
  deg:  { dim: 'angle', mul: PI / 180 },
  rad:  { dim: 'angle', mul: 1 },
  grad: { dim: 'angle', mul: PI / 200 },
  mrad: { dim: 'angle', mul: 1e-3 },

  // magnetic field (canonical: T)
  T:  { dim: 'magnetic', mul: 1 },
  mT: { dim: 'magnetic', mul: 1e-3 },
  uT: { dim: 'magnetic', mul: 1e-6 },
  nT: { dim: 'magnetic', mul: 1e-9 },
  Oe: { dim: 'magnetic', mul: 1e-4 },  // 1 Oe = 1 G = 1e-4 T (free space)
};

function convert(value, from, to, opts) {
  const f = UNITS[from], t = UNITS[to];
  if (!f) throw new Error(`unknown unit: ${from}`);
  if (!t) throw new Error(`unknown unit: ${to}`);
  if (f.dim !== t.dim) throw new Error(`incompatible dimensions: ${f.dim} → ${t.dim}`);
  const factor = f.mul / t.mul;
  if (typeof value === 'number') return value * factor;
  // typed array / array-like (duck-type on .length + indexing)
  const data = value.data || value;
  if (opts?.inplace) {
    for (let i = 0; i < data.length; i++) data[i] *= factor;
    return value;
  }
  if (typeof data.constructor === 'function' && data.constructor !== Object && typeof data.length === 'number') {
    const out = new data.constructor(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] * factor;
    return out;
  }
  // plain array
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * factor;
  return out;
}

// Convenience aliases
const length = {
  cmToMm: v => convert(v, 'cm', 'mm'),
  mmToCm: v => convert(v, 'mm', 'cm'),
  umToCm: v => convert(v, 'um', 'cm'),
  cmToUm: v => convert(v, 'cm', 'um'),
  ftToM:  v => convert(v, 'ft', 'm'),
  mToFt:  v => convert(v, 'm', 'ft'),
  kmToM:  v => convert(v, 'km', 'm'),
  inToCm: v => convert(v, 'in', 'cm'),
};

const mass = {
  kgToG:  v => convert(v, 'kg', 'g'),
  gToKg:  v => convert(v, 'g', 'kg'),
  tToKg:  v => convert(v, 't', 'kg'),
  lbToKg: v => convert(v, 'lb', 'kg'),
  ozToG:  v => convert(v, 'oz', 'g'),
  oztToG: v => convert(v, 'ozt', 'g'),
};

const grade = {
  oztToGt:       v => convert(v, 'oz/t', 'g/t'),
  gtToOzt:       v => convert(v, 'g/t', 'oz/t'),
  gtToPpm:       v => convert(v, 'g/t', 'ppm'),
  gtToPct:       v => convert(v, 'g/t', 'pct'),
  pctToFraction: v => convert(v, 'pct', 'fraction'),
  fractionToPct: v => convert(v, 'fraction', 'pct'),
};

const density = {
  kgm3ToGcm3: v => convert(v, 'kg/m3', 'g/cm3'),
  gcm3ToKgm3: v => convert(v, 'g/cm3', 'kg/m3'),
};

const area = {
  haToM2:  v => convert(v, 'ha', 'm2'),
  km2ToM2: v => convert(v, 'km2', 'm2'),
  m2ToHa:  v => convert(v, 'm2', 'ha'),
};

const volume = {
  cm3ToM3: v => convert(v, 'cm3', 'm3'),
  lToM3:   v => convert(v, 'L', 'm3'),
  m3ToL:   v => convert(v, 'm3', 'L'),
};

const angle = {
  degToRad:  v => convert(v, 'deg', 'rad'),
  radToDeg:  v => convert(v, 'rad', 'deg'),
  gradToRad: v => convert(v, 'grad', 'rad'),
};

const magnetic = {
  nTToT:  v => convert(v, 'nT', 'T'),
  oeToT:  v => convert(v, 'Oe', 'T'),
  uTToNT: v => convert(v, 'uT', 'nT'),
};

export { UNITS, convert, length, mass, grade, density, area, volume, angle, magnetic };
