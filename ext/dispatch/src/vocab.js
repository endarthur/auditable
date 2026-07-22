// @gcu/dispatch — session vocabulary + locale banks. NOTHING here is a
// fixture: the host derives the vocabulary from its live session (columns,
// categories, layers), so the dispatcher speaks THIS project's language and
// is rebuilt when the project changes. The locale bank carries the
// language-level closed classes (operators, units, show/hide verbs,
// word-numbers, refusal seeds); `pt-BR` is a future bank, not a feature.

export const LOCALES = {
  en: {
    ops: {
      '>': ['above', 'over', 'greater than', 'more than', 'higher than', '>'],
      '>=': ['at least', 'no less than', '>='],
      '<': ['below', 'under', 'less than', 'lower than', '<'],
      '<=': ['at most', 'up to', '<='],
      '=': ['equal to', 'exactly', '=', '=='],
    },
    opWord: { above: '>', over: '>', greater: '>', more: '>', higher: '>', least: '>=', below: '<', under: '<', less: '<', lower: '<', most: '<=', up: '<=', equal: '=', exactly: '=', different: '!=', '>': '>', '<': '<', '=': '=' },
    units: ['percent', '%', 'm', 'meter', 'meters', 'metre', 'metres'],
    hideWords: ['hide', 'remove', 'off', 'rid', 'invisible', 'drop', 'take', 'switch'],
    showWords: ['show', 'back', 'unhide', 'visible', 'on', 'see', 'want'],
    negators: ['don', "don't", 'dont', 'not', 'no'],
    wordNums: { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 },
    rangeWords: ['to', 'and', 'between', '-'],
    politeSuffixes: [' please', ' for me'],
    politePrefixes: ['can you '],
    refusals: [
      'what is the average grade', 'how many records are there', 'undo that',
      'save everything', 'what does this column mean', 'email this to the team',
      'close the program', 'rename the project', 'delete everything',
      'make it prettier', 'help me', 'what can you do',
    ],
  },
};

// element/assay lexicon — free synonyms hosts get for commonly named columns
export const ELEMENT_LEX = {
  FE: ['iron', 'Fe', 'the iron grade', 'ferro'],
  SIO2: ['silica', 'SiO2', 'the silica'],
  P: ['phosphorus', 'phos'],
  LOI: ['loss on ignition'],
  AL2O3: ['alumina'],
  MN: ['manganese'],
  AU: ['gold', 'Au', 'the gold grade'],
  CU: ['copper', 'Cu'],
  S: ['sulfur', 'the sulfur'],
  MGO: ['MgO', 'magnesia'],
  CAO: ['CaO', 'lime'],
  ZN: ['zinc', 'Zn'],
  NI: ['nickel', 'Ni'],
  AG: ['silver', 'Ag'],
  SG: ['density', 'specific gravity', 'the density'],
  DENS: ['density', 'the density'],
};

// deriveVocab — the host's session → synonym pools.
//   numCols:   ['FE', ...] or { FE: { syn?, lo?, hi?, dec? } }
//   catCols:   { LITO: ['lithology', 'litho'], ... }        (column-name synonyms)
//   catValues: { LITO: { HEMATITE: ['hematite'], ... } }    (per-column value synonyms)
//   layers:    { 'topo.tif': ['the topography', 'topo'], ... }
//   idCols:    ['BHID']                                     (free-string id columns)
export function deriveVocab({ numCols = [], catCols = {}, catValues = {}, layers = {}, idCols = [], locale = 'en', aliases = {} } = {}) {
  const L = LOCALES[locale];
  if (!L) throw new Error(`unknown locale ${locale}`);
  const nc = {};
  const entries = Array.isArray(numCols) ? numCols.map((n) => [n, {}]) : Object.entries(numCols);
  for (const [name, cfg] of entries) {
    const syn = [name, ...(cfg.syn || []), ...(ELEMENT_LEX[name.toUpperCase()] || []), ...(aliases[name] || [])];
    nc[name] = { syn: [...new Set(syn)], lo: cfg.lo ?? 0.1, hi: cfg.hi ?? 100, dec: cfg.dec ?? 1 };
  }
  const cc = {};
  for (const [name, syns] of Object.entries(catCols)) cc[name] = [...new Set([name, ...(syns || []), ...(aliases[name] || [])])];
  const cv = {};
  for (const [col, vals] of Object.entries(catValues)) {
    cv[col] = {};
    for (const [v, syns] of Object.entries(vals)) cv[col][v] = [...new Set([...(syns && syns.length ? syns : [v.toLowerCase()]), ...(aliases[v] || [])])];
  }
  const ly = {};
  for (const [file, syns] of Object.entries(layers)) ly[file] = [...new Set([file, ...(syns || []), ...(aliases[file] || [])])];
  return { numCols: nc, catCols: cc, catValues: cv, layers: ly, idCols, locale, L };
}
