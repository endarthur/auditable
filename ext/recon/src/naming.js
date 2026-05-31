// @gcu/recon — column-NAME analysis: coordinate roles, units, analytes.
// Standalone detectors (exported; useful + testable on their own).

// XYZ / DXYZ name patterns (harvested from BMA).
export const XYZ_PATTERNS = {
  x: [/^x$/i, /^xc$/i, /^x[_-]?cent(re|er)?$/i, /^mid[_-]?x$/i, /^centroid[_-]?x$/i, /^east(ing)?$/i, /^x[_-]?coord$/i, /^xcenter$/i, /^xmid$/i, /^xblock$/i],
  y: [/^y$/i, /^yc$/i, /^y[_-]?cent(re|er)?$/i, /^mid[_-]?y$/i, /^centroid[_-]?y$/i, /^north(ing)?$/i, /^y[_-]?coord$/i, /^ycenter$/i, /^ymid$/i, /^yblock$/i],
  z: [/^z$/i, /^zc$/i, /^z[_-]?cent(re|er)?$/i, /^mid[_-]?z$/i, /^centroid[_-]?z$/i, /^elev(ation)?$/i, /^rl$/i, /^z[_-]?coord$/i, /^zcenter$/i, /^zmid$/i, /^zblock$/i, /^level$/i, /^bench$/i],
};
export const DXYZ_PATTERNS = {
  dx: [/^dx$/i, /^xinc$/i, /^xsize$/i, /^dimx$/i, /^xlen$/i, /^x[_-]?dim$/i, /^x[_-]?size$/i, /^size[_-]?x$/i],
  dy: [/^dy$/i, /^yinc$/i, /^ysize$/i, /^dimy$/i, /^ylen$/i, /^y[_-]?dim$/i, /^y[_-]?size$/i, /^size[_-]?y$/i],
  dz: [/^dz$/i, /^zinc$/i, /^zsize$/i, /^dimz$/i, /^zlen$/i, /^z[_-]?dim$/i, /^z[_-]?size$/i, /^size[_-]?z$/i],
};

// guessCoords — identify X/Y/Z (and dX/dY/dZ) columns among numeric columns by name,
// with a first-3-numeric positional fallback for X/Y/Z. Returns { cols, confidence }.
export function guessCoords(header, types) {
  const isNum = (i) => !types || types[i] === 'numeric' || types[i] === 'id';
  const cols = {}; const confidence = {};
  for (const axis of ['x', 'y', 'z']) {
    for (const pat of XYZ_PATTERNS[axis]) {
      const i = header.findIndex((h, idx) => isNum(idx) && pat.test(h.trim()));
      if (i >= 0) { cols[axis] = header[i]; confidence[axis] = 0.9; break; }
    }
  }
  for (const axis of ['dx', 'dy', 'dz']) {
    for (const pat of DXYZ_PATTERNS[axis]) {
      const i = header.findIndex((h, idx) => isNum(idx) && pat.test(h.trim()));
      if (i >= 0) { cols[axis] = header[i]; confidence[axis] = 0.9; break; }
    }
  }
  if (!(cols.x && cols.y && cols.z)) {
    const numCols = header.filter((_, i) => isNum(i));
    if (numCols.length >= 3 && !cols.x && !cols.y && !cols.z) {
      cols.x = numCols[0]; cols.y = numCols[1]; cols.z = numCols[2];
      confidence.x = confidence.y = confidence.z = 0.3;  // positional fallback
    }
  }
  return { cols, confidence };
}

// detectUnit — parse a physical unit from a column name. Returns { unit, confidence } | null.
const UNIT_SUFFIXES = [
  [/(_|\b)(g[_/]?t|gpt|gt)$/i, 'g/t'], [/(_|\b)ppm$/i, 'ppm'], [/(_|\b)ppb$/i, 'ppb'],
  [/(_|\b)(pct|pc|perc(ent)?)$/i, '%'], [/(_|\b)(g[_/]?cm3|gcm3|sg|dens(ity)?)$/i, 'g/cm3'],
  [/(_|\b)(m|metres?|meters?)$/i, 'm'], [/(_|\b)(rl)$/i, 'm'], [/(_|\b)(deg|degrees?)$/i, 'deg'],
];
export function detectUnit(name) {
  // Bracketed/parenthetical unit wins (explicit): "Au (g/t)", "FE [%]".
  const br = name.match(/[([{]\s*([^)\]}]+?)\s*[)\]}]\s*$/);
  if (br) {
    const u = normalizeUnit(br[1]);
    if (u) return { unit: u, confidence: 0.95 };
  }
  for (const [re, unit] of UNIT_SUFFIXES) {
    if (re.test(name)) return { unit, confidence: 0.8 };
  }
  if (/(^|_)%$/.test(name) || name.endsWith('%')) return { unit: '%', confidence: 0.9 };
  return null;
}
function normalizeUnit(raw) {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  const map = { 'g/t': 'g/t', gpt: 'g/t', 'gt': 'g/t', '%': '%', pct: '%', percent: '%', ppm: 'ppm', ppb: 'ppb', 'g/cm3': 'g/cm3', gcm3: 'g/cm3', sg: 'g/cm3', m: 'm', deg: 'deg' };
  return map[s] || (/^[a-z%/0-9]+$/.test(s) ? raw.trim() : null);
}

// detectAnalyte — element symbol or common oxide from a column name. { analyte, confidence } | null.
const ELEMENTS = new Set(['Au', 'Ag', 'Cu', 'Pb', 'Zn', 'Fe', 'Ni', 'Co', 'Mo', 'U', 'Sn', 'W', 'As', 'Sb', 'Bi', 'Cd', 'Cr', 'Mn', 'V', 'Ti', 'S', 'C', 'P', 'K', 'Na', 'Ca', 'Mg', 'Al', 'Si', 'Hg', 'Te', 'Se', 'Ba', 'Sr', 'Li', 'Be', 'Pt', 'Pd', 'Rh', 'Ir', 'Os', 'Ru', 'Re', 'Ta', 'Nb', 'Zr', 'Hf', 'Ga', 'Ge', 'In', 'Tl', 'Sc', 'Y', 'La', 'Ce', 'Nd', 'Th']);
const OXIDES = new Set(['SiO2', 'Al2O3', 'Fe2O3', 'FeO', 'CaO', 'MgO', 'K2O', 'Na2O', 'TiO2', 'MnO', 'P2O5', 'Cr2O3', 'SO3', 'LOI', 'BaO', 'SrO']);
const ELEM_LC = new Map([...ELEMENTS].map((e) => [e.toLowerCase(), e]));
const OX_LC = new Map([...OXIDES].map((o) => [o.toLowerCase(), o]));

export function detectAnalyte(name) {
  // strip a leading/trailing unit-ish or descriptor token, then test the core token(s).
  const tokens = name.split(/[_\s\-.]+/).filter(Boolean);
  for (const tok of tokens) {
    if (OXIDES.has(tok)) return { analyte: tok, confidence: 0.95 };
    if (OX_LC.has(tok.toLowerCase())) return { analyte: OX_LC.get(tok.toLowerCase()), confidence: 0.85 };
    if (ELEMENTS.has(tok)) return { analyte: tok, confidence: 0.95 };
    if (ELEM_LC.has(tok.toLowerCase())) return { analyte: ELEM_LC.get(tok.toLowerCase()), confidence: 0.8 };
  }
  return null;
}
