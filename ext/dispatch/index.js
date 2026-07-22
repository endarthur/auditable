// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/dispatch — Session-trained natural-language → tool-call dispatch: a Snips-shaped resolver (averaged-perceptron intent + CRF-class slot tagger + gazetteers + deterministic per-kind assemblers) that trains IN THE BROWSER from the host session's own vocabulary in under a second. Tools are declarative (ten kinds); no shipped model, no network, explainable per decision — refusals return empty calls so the host degrades into its command palette. Born from an incubator where this beat a 26M finetuned transformer 50/52 to 3/24 on a frozen yardstick.

// ── src/vocab.js ──

// @gcu/dispatch — session vocabulary + locale banks. NOTHING here is a
// fixture: the host derives the vocabulary from its live session (columns,
// categories, layers), so the dispatcher speaks THIS project's language and
// is rebuilt when the project changes. The locale bank carries the
// language-level closed classes (operators, units, show/hide verbs,
// word-numbers, refusal seeds); `pt-BR` is a future bank, not a feature.

const LOCALES = {
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
const ELEMENT_LEX = {
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
function deriveVocab({ numCols = [], catCols = {}, catValues = {}, layers = {}, idCols = [], locale = 'en', aliases = {} } = {}) {
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

// ── src/text.js ──

// @gcu/dispatch — text primitives: tokenizer, token shapes, gazetteer spans.
const tokenize = (q) => (q.toLowerCase().match(/[a-z0-9][a-z0-9.\-]*|[^\sa-z0-9]/gi) || []).map((t) => t.replace(/[.,;!?]+$/, '') || t);

const NUM_RE = /^[0-9]+(\.[0-9]+)?$/;
const ID_RE = /^[a-z]+-?[0-9]+$/;
const shape = (t) => (NUM_RE.test(t) ? (t.includes('.') ? 'dec' : 'int') : ID_RE.test(t) ? 'id' : /[0-9]/.test(t) ? 'alnum' : 'alpha');
const num = (t) => (String(t).includes('.') ? +t : parseInt(t, 10));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// build a phrase→value map (multiword synonyms as token-joined keys)
function gazMap(entries) {
  const m = new Map();
  for (const [phrase, val] of entries) m.set(tokenize(phrase).join(' '), val);
  return m;
}
// longest-match spans of a gazetteer map over tokens → [{i, len, val}]
function gazSpans(toks, map) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    for (let len = Math.min(4, toks.length - i); len >= 1; len--) {
      const key = toks.slice(i, i + len).join(' ');
      if (map.has(key)) { out.push({ i, len, val: map.get(key) }); i += len - 1; break; }
    }
  }
  return out;
}
// seeded rng (no Date.now/Math.random — everything reproducible)
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(arr, seed) { const r = mulberry32(seed), out = [...arr]; for (let i = out.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [out[i], out[j]] = [out[j], out[i]]; } return out; }
const normText = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── src/features.js ──

// @gcu/dispatch — featurization over a SESSION context. createContext(vocab)
// builds the gazetteers once per session; everything downstream (training,
// inference) reads them through the context, so a new project = a new
// context = a dispatcher fluent in the new vocabulary.

function createContext(vocab) {
  const colEntries = [], catEntries = [], litEntries = [], layEntries = [], opEntries = [];
  for (const [col, c] of Object.entries(vocab.numCols)) for (const s of c.syn) colEntries.push([s, col]);
  for (const [col, syns] of Object.entries(vocab.catCols)) for (const s of syns) catEntries.push([s, col]);
  for (const [col, vals] of Object.entries(vocab.catValues)) for (const [v, syns] of Object.entries(vals)) for (const s of syns) litEntries.push([s, { col, value: v }]);
  for (const [file, syns] of Object.entries(vocab.layers)) for (const s of syns) layEntries.push([s, file]);
  for (const [op, words] of Object.entries(vocab.L.ops)) for (const w of words) opEntries.push([w, op]);
  const gaz = {
    col: gazMap(colEntries), cat: gazMap(catEntries), lit: gazMap(litEntries),
    layer: gazMap(layEntries), op: gazMap(opEntries),
  };
  const unitSet = new Set(vocab.L.units);

  function tokenFeatures(toks) {
    const colS = gazSpans(toks, gaz.col), catS = gazSpans(toks, gaz.cat), litS = gazSpans(toks, gaz.lit), opS = gazSpans(toks, gaz.op), layS = gazSpans(toks, gaz.layer);
    const mark = (spans, tag) => { const m = new Array(toks.length).fill(null); for (const s of spans) for (let k = 0; k < s.len; k++) m[s.i + k] = `${tag}:${typeof s.val === 'object' ? s.val.value : s.val}`; return m; };
    const colM = mark(colS, 'col'), catM = mark(catS, 'cat'), litM = mark(litS, 'lit'), opM = mark(opS, 'op'), layM = mark(layS, 'lay');
    return toks.map((t, i) => {
      const f = [`w=${t}`, `sh=${shape(t)}`, `pw=${toks[i - 1] || '^'}`, `nw=${toks[i + 1] || '$'}`];
      if (colM[i]) f.push('inCol', colM[i]);
      if (catM[i]) f.push('inCat', catM[i]);
      if (litM[i]) f.push('inLit', litM[i]);
      if (opM[i]) f.push('inOp', opM[i]);
      if (layM[i]) f.push('inLay', layM[i]);
      if (unitSet.has(t)) f.push('unit');
      if (colM[i - 1]) f.push('pCol');
      if (opM[i - 1]) f.push('pOp');
      if (litM[i - 1]) f.push('pLit');
      if (NUM_RE.test(toks[i - 1] || '')) f.push('pNum');
      if (NUM_RE.test(toks[i + 1] || '')) f.push('nNum');
      if (opM[i + 1]) f.push('nOp');
      return f;
    });
  }

  function intentFeatures(toks) {
    const per = tokenFeatures(toks);
    const f = new Map();
    const add = (k, v = 1) => f.set(k, (f.get(k) || 0) + v);
    let nNum = 0, hasOp = 0, hasCol = 0, hasLay = 0, hasLit = 0, hasCat = 0, hasUnit = 0;
    for (let i = 0; i < toks.length; i++) {
      add(`u=${toks[i]}`);
      if (i) add(`b=${toks[i - 1]}_${toks[i]}`);
      for (const x of per[i]) if (!x.startsWith('w=') && !x.startsWith('pw=') && !x.startsWith('nw=')) add(`t:${x}`, 0.5);
      if (NUM_RE.test(toks[i])) nNum++;
      if (per[i].includes('inOp')) hasOp = 1;
      if (per[i].includes('inCol')) hasCol = 1;
      if (per[i].includes('inLay')) hasLay = 1;
      if (per[i].includes('inLit')) hasLit = 1;
      if (per[i].includes('inCat')) hasCat = 1;
      if (per[i].includes('unit')) hasUnit = 1;
    }
    // structural signals, weighted up — the hand-computed nonlinearity that
    // makes a single-layer perceptron sufficient (Minsky honored, routed around)
    if (hasOp && hasCol && nNum) add('has:cmp', 2);
    if (hasOp) add('has:op', 1.5);
    if (hasCol) add('has:col', 1.5);
    if (hasLay) add('has:lay', 2);
    if (hasLit) add('has:lit', 2);
    if (hasCat) add('has:cat', 1.5);
    add(`has:nums${Math.min(nNum, 3)}`, 1.5);
    if (hasUnit) add('has:unit', 1.5);
    add('len', Math.min(toks.length, 12) / 12);
    return f;
  }

  return { vocab, gaz, tokenFeatures, intentFeatures, tokenize };
}

// ── src/kinds.js ──

// @gcu/dispatch — the KIND implementations: the plugin boundary. A tool is a
// DECLARATION ({name, kind, ...kind fields}); each kind owns three verbs:
//   render(tool, ctx, R)              → {q, args}   (corpus generation)
//   align(toks, tags, args, ctx, tool) → bool        (training labels, answer-first)
//   assemble(tool, ctx, toks, tags)    → args | null  (inference)
// Assemblers emit the tool's CANONICAL argument shape (clauses arrays, real
// booleans) — hosts get WebMCP-shaped calls, not a model-era flattening.

// ── shared render helpers (R = { rnd, pick, maybe }) ──
const mkR = (rnd) => ({ rnd, pick: (arr) => arr[(rnd() * arr.length) | 0], maybe: (p) => rnd() < p });
const fill = (frame, slots) => frame.replace(/\{(\w+)\}/g, (m, k) => (slots[k] !== undefined ? slots[k] : m));
const politeWrap = (q, R, L) => {
  const k = R.rnd();
  return k < 0.55 ? q : k < 0.7 ? q + L.politeSuffixes[0] : k < 0.8 ? L.politePrefixes[0] + q : k < 0.9 ? cap(q) + '.' : q + (L.politeSuffixes[1] || '');
};
const numVal = (c, R) => { const v = c.lo + R.rnd() * (c.hi - c.lo); return +v.toFixed(c.dec === 1 && R.maybe(0.5) ? 0 : c.dec); };
const pickNumCol = (vocab, R) => { const names = Object.keys(vocab.numCols); const col = R.pick(names); return { col, cfg: vocab.numCols[col] }; };
const catColOf = (tool, vocab) => tool.column || Object.keys(vocab.catValues)[0];

// ── shared align helpers ──
const mkClaim = (toks, tags) => ({
  claim(start, len, tag) { for (let k = 0; k < len; k++) if (tags[start + k] !== 'O') return false; for (let k = 0; k < len; k++) tags[start + k] = tag; return true; },
  claimGaz(map, want, tag, matchFn) {
    for (const s of gazSpans(toks, map)) {
      const hit = matchFn ? matchFn(s.val) : s.val === want;
      if (hit && tags[s.i] === 'O') { for (let k = 0; k < s.len; k++) tags[s.i + k] = tag; return true; }
    }
    return false;
  },
  claimNum(v, tag) {
    for (let i = 0; i < toks.length; i++) if (tags[i] === 'O' && /^[0-9.]+$/.test(toks[i]) && Math.abs(+toks[i] - +v) < 1e-9) { tags[i] = tag; return i; }
    return -1;
  },
});

// ── shared assemble helpers ──
function groupTags(toks, tags) {
  const groups = [];
  for (let i = 0; i < toks.length; i++) {
    if (tags[i] === 'O') continue;
    const last = groups[groups.length - 1];
    if (last && last.tag === tags[i] && last.end === i - 1) { last.end = i; last.words.push(toks[i]); }
    else groups.push({ tag: tags[i], start: i, end: i, words: [toks[i]] });
  }
  return (tag) => groups.filter((x) => x.tag === tag);
}
const normFrom = (map) => (words) => { for (let l = words.length; l >= 1; l--) for (let i = 0; i + l <= words.length; i++) { const k = words.slice(i, i + l).join(' '); if (map.has(k)) return map.get(k); } return null; };
const opFromGroup = (words, L) => {
  if (words.includes('no') && words.includes('less')) return '>=';
  if (words.includes('at') && words.includes('least')) return '>=';
  if (words.includes('at') && words.includes('most')) return '<=';
  if (words.includes('up') && words.includes('to')) return '<=';
  if (words.includes('>') && words.includes('=')) return '>=';   // the tokenizer splits >= into '>' '='
  if (words.includes('<') && words.includes('=')) return '<=';
  for (const w of words) if (L.opWord[w]) return L.opWord[w];
  return null;
};
const showHide = (toks, L) => {
  const H = new Set(L.hideWords), S = new Set(L.showWords), N = new Set(L.negators);
  let hide = toks.some((t) => H.has(t)), show = toks.some((t) => S.has(t));
  if (toks.some((t) => N.has(t))) { const t2 = hide; hide = show; show = t2; }
  return hide && !show ? 'hide' : show ? 'show' : 'hide';
};
const firstNum = (g, toks) => {
  for (const tag of ['VAL', 'POS', 'THICK']) { const v = g(tag)[0]; if (v && Number.isFinite(num(v.words[0]))) return num(v.words[0]); }
  const t = toks.find((x) => NUM_RE.test(x));
  return t !== undefined ? num(t) : null;
};
const lexFind = (toks, values) => {
  for (const [key, spec] of Object.entries(values)) {
    const syns = Array.isArray(spec) ? spec : spec.syn || [];
    for (const s of [key, ...syns]) {
      const seq = tokenize(s);
      for (let i = 0; i + seq.length <= toks.length; i++) if (seq.every((w, k) => toks[i + k] === w)) return key;
    }
  }
  return null;
};

// ── the kinds ──
const KINDS = {
  // {nouns:[...], rowRegister?:bool, idColumn?, idPrefix?, benchRange? (cat col
  //  with numeric levels, e.g. BENCH), depthRange? ({from, to})}
  'comparison-filter': {
    defaultTarget: 120,
    render(tool, ctx, R) {
      const { vocab } = ctx, L = vocab.L;
      const noun = R.pick(tool.nouns);
      const catCol = Object.keys(vocab.catValues)[0];
      const cats = catCol ? vocab.catValues[catCol] : null;
      const opPhrase = (op) => R.pick(L.ops[op]);
      const clPhrase = (syn, op, v) => R.pick([`${syn} ${opPhrase(op)} ${v}`, `${syn} is ${opPhrase(op)} ${v}`, `the ${syn} ${opPhrase(op)} ${v}`]);
      const kind = R.rnd();
      if (tool.idColumn && kind < 0.12) {
        const id = `${tool.idPrefix || 'ID-'}${String(1 + ((R.rnd() * 120) | 0)).padStart(3, '0')}`;
        return { q: R.pick([`samples from hole ${id}`, `only hole ${id}`, `show the intervals of ${id}`, `rows from ${id}`]), args: { clauses: [{ column: tool.idColumn, op: '=', value: id }], join: 'and' } };
      }
      if (kind < 0.35) {
        const { col, cfg } = pickNumCol(vocab, R);
        const syn = R.pick(cfg.syn), op = R.pick(Object.keys(L.ops)), v = numVal(cfg, R);
        const unit = R.maybe(0.2) ? ' ' + R.pick(['percent', '%']) : '';
        const q = R.pick([`filter ${noun} with ${clPhrase(syn, op, v)}${unit}`, `show ${noun} where ${clPhrase(syn, op, v)}${unit}`, `only ${noun} with ${clPhrase(syn, op, v)}${unit}`, `keep ${clPhrase(syn, op, v)}${unit}`, `filter the ${syn} ${opPhrase(op)} ${v}${unit}`, `${clPhrase(syn, op, v)}${unit}`]);
        return { q, args: { clauses: [{ column: col, op, value: v }], join: 'and' } };
      }
      if (cats && kind < 0.5) {
        const v = R.pick(Object.keys(cats)), syn = R.pick(cats[v]);
        const colSyn = R.pick((vocab.catCols && vocab.catCols[catCol]) || [catCol]);
        return { q: R.pick([`filter ${noun} to ${syn}`, `only ${syn} ${noun}`, `keep just the ${syn}`,
          `only ${syn}`, `${syn} only`, `just ${syn}`, `keep ${syn}`, `show only ${syn}`,
          `${colSyn} is ${syn}`, `${colSyn} = ${syn}`, `where ${colSyn} is ${syn}`]),
          args: { clauses: [{ column: catCol, op: '=', value: v }], join: 'and' } };
      }
      if (kind < 0.68) {
        if (tool.depthRange) {
          const a = 10 * ((2 + R.rnd() * 10) | 0), b = a + 10 * ((2 + R.rnd() * 8) | 0);
          return { q: R.pick([`intervals from ${a} to ${b} meters`, `samples between ${a} and ${b} m depth`]), args: { clauses: [{ column: tool.depthRange.from, op: '>=', value: a }, { column: tool.depthRange.to, op: '<=', value: b }], join: 'and' } };
        }
        if (tool.benchRange) {
          const lv = tool.benchLevels || [940, 960, 980, 1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140];
          const i = (R.rnd() * (lv.length - 3)) | 0, a = lv[i], b = lv[i + 1 + ((R.rnd() * (lv.length - i - 2)) | 0)];
          const bn = tool.benchRange.toLowerCase();
          return { q: R.pick([`${tool.nouns[0]} from ${bn} ${a} to ${bn} ${b}`, `${bn}es ${a} to ${b}`, `between ${bn} ${a} and ${b}`, `${tool.nouns[0]} between ${bn} ${a} and ${bn} ${b}`, `from ${bn} ${a} to ${b}`, `${bn} ${a} to ${bn} ${b}`, `keep the ${bn}es from ${a} to ${b}`, `only ${bn}es ${a} to ${b}`]), args: { clauses: [{ column: tool.benchRange, op: '>=', value: a }, { column: tool.benchRange, op: '<=', value: b }], join: 'and' } };
        }
      }
      const A = pickNumCol(vocab, R);
      let B = pickNumCol(vocab, R), guard = 0;
      while (B.col === A.col && guard++ < 5) B = pickNumCol(vocab, R);
      const aOp = R.pick(Object.keys(L.ops)), aV = numVal(A.cfg, R), aSyn = R.pick(A.cfg.syn);
      const catB = cats && R.maybe(0.3);
      const bCl = catB ? { column: catCol, op: '=', value: R.pick(Object.keys(cats)) } : { column: B.col, op: R.pick(Object.keys(L.ops)), value: numVal(B.cfg, R) };
      const bSyn = catB ? R.pick(cats[bCl.value]) : R.pick(B.cfg.syn);
      const bPhrase = catB ? R.pick([`only ${bSyn} ${noun}`, `${bSyn} only`]) : clPhrase(bSyn, bCl.op, bCl.value);
      const join = R.maybe(0.25) ? 'or' : 'and';
      const q = R.pick([`show ${noun} with ${clPhrase(aSyn, aOp, aV)} ${join} ${bPhrase}`, `filter ${noun} with ${clPhrase(aSyn, aOp, aV)} ${join} ${bPhrase}`, `${clPhrase(aSyn, aOp, aV)} ${join} ${bPhrase}`, ...(catB ? [`only ${bSyn}${tool.rowRegister ? ' samples' : ' blocks'} with ${clPhrase(aSyn, aOp, aV)}`] : [])]);
      return { q, args: { clauses: [{ column: A.col, op: aOp, value: aV }, bCl], join } };
    },
    align(toks, tags, args, ctx, tool) {
      const c = mkClaim(toks, tags), L = ctx.vocab.L;
      const cls = args.clauses;
      const isRange = cls.length === 2 && cls[0].column === cls[1].column && cls[0].op === '>=' && cls[1].op === '<=';
      const isDepth = tool.depthRange && cls.length === 2 && cls[0].column === tool.depthRange.from;
      for (const cl of cls) {
        if (ctx.vocab.catValues[cl.column]) { if (!c.claimGaz(ctx.gaz.lit, null, 'CAT', (v) => v.col === cl.column && v.value === cl.value)) return false; continue; }
        if (cl.column === tool.idColumn) { const i = toks.findIndex((t, k) => tags[k] === 'O' && t.toUpperCase() === String(cl.value).toUpperCase()); if (i < 0) return false; tags[i] = 'ID'; continue; }
        if (!isDepth) { if (!c.claimGaz(ctx.gaz.col, cl.column, 'COL') && !c.claimGaz(ctx.gaz.cat, cl.column, 'COL') && tags.indexOf('COL') < 0) return false; }
        if (c.claimNum(cl.value, 'VAL') < 0) return false;
        const opWords = L.ops[cl.op] || [];
        outer: for (const w of opWords) {
          const seq = tokenize(w);
          for (let i = 0; i + seq.length <= toks.length; i++) if (seq.every((s, k) => toks[i + k] === s && tags[i + k] === 'O')) { c.claim(i, seq.length, 'OP'); break outer; }
        }
      }
      if (isRange || isDepth) {
        const vIdx = tags.map((t, i) => (t === 'VAL' ? i : -1)).filter((i) => i >= 0);
        if (vIdx.length >= 2) for (let i = vIdx[0] + 1; i < vIdx[vIdx.length - 1]; i++) if (tags[i] === 'O' && ctx.vocab.L.rangeWords.includes(toks[i])) { tags[i] = 'RNG'; break; }
      }
      return true;
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags), L = ctx.vocab.L;
      const normCol = (w) => normFrom(ctx.gaz.col)(w) || normFrom(ctx.gaz.cat)(w);
      const clauses = [];
      const cols = g('COL'), ops = g('OP'), vals = g('VAL'), rngs = g('RNG');
      const usedV = new Set(), usedO = new Set();
      for (const c of cols) {
        const col = normCol(c.words);
        if (!col) continue;
        const free = () => vals.filter((v) => !usedV.has(v));
        const rng = rngs.find((r) => !r.used && free().some((v) => v.end < r.start) && free().some((v) => v.start > r.end));
        if (rng && free().length >= 2) {
          const v1 = free().filter((v) => v.end < rng.start).sort((a, b) => b.end - a.end)[0];
          const v2 = free().filter((v) => v.start > rng.end).sort((a, b) => a.start - b.start)[0];
          if (v1 && v2) {
            rng.used = true; usedV.add(v1); usedV.add(v2);
            clauses.push({ at: c.start, column: col, op: '>=', value: num(v1.words[0]) });
            clauses.push({ at: v2.start, column: col, op: '<=', value: num(v2.words[0]) });
            continue;
          }
        }
        const op = ops.filter((o) => !usedO.has(o)).sort((a, b) => Math.abs(a.start - c.end) - Math.abs(b.start - c.end))[0];
        const v = vals.filter((x) => !usedV.has(x) && x.start > c.end).sort((a, b) => a.start - b.start)[0]
          || vals.filter((x) => !usedV.has(x)).sort((a, b) => Math.abs(a.start - c.end) - Math.abs(b.start - c.end))[0];
        if (!v) continue;
        usedV.add(v); if (op) usedO.add(op);
        clauses.push({ at: c.start, column: col, op: (op && opFromGroup(op.words, L)) || '>', value: num(v.words[0]) });
      }
      for (const c of g('CAT')) { const hit = normFrom(ctx.gaz.lit)(c.words); if (hit) clauses.push({ at: c.start, column: hit.col, op: '=', value: hit.value }); }
      if (tool.idColumn) for (const c of g('ID')) clauses.push({ at: c.start, column: tool.idColumn, op: '=', value: c.words[0].toUpperCase() });
      if (tool.depthRange && !clauses.length) {
        const rng = rngs.find((r) => !r.used);
        const free = vals.filter((v) => !usedV.has(v));
        if (rng && free.length >= 2) {
          const v1 = free.filter((v) => v.end < rng.start).sort((a, b) => b.end - a.end)[0];
          const v2 = free.filter((v) => v.start > rng.end).sort((a, b) => a.start - b.start)[0];
          if (v1 && v2) {
            clauses.push({ at: v1.start, column: tool.depthRange.from, op: '>=', value: num(v1.words[0]) });
            clauses.push({ at: v2.start, column: tool.depthRange.to, op: '<=', value: num(v2.words[0]) });
          }
        }
      }
      if (!clauses.length) return null;
      clauses.sort((a, b) => a.at - b.at);
      const out = { clauses: clauses.map(({ at, ...cl }) => cl), join: clauses.length > 1 && toks.includes('or') ? 'or' : 'and' };
      return out;
    },
  },

  // {argName:'column', frames:['color by {col}',...], emptyFrames?:[...],
  //  optional?:bool, pools?:['numeric','categorical']}
  'column-pick': {
    defaultTarget: 100,
    render(tool, ctx, R) {
      const { vocab } = ctx;
      if (tool.optional && tool.emptyFrames && R.maybe(0.4)) return { q: R.pick(tool.emptyFrames), args: {} };
      const pools = tool.pools || ['numeric'];
      const names = [...(pools.includes('numeric') ? Object.keys(vocab.numCols) : []), ...(pools.includes('categorical') ? Object.keys(vocab.catCols) : [])];
      const col = R.pick(names);
      const syn = vocab.numCols[col] ? R.pick(vocab.numCols[col].syn) : R.pick(vocab.catCols[col]);
      return { q: fill(R.pick(tool.frames), { col: syn }), args: { [tool.argName || 'column']: col } };
    },
    align(toks, tags, args, ctx, tool) {
      const c = mkClaim(toks, tags);
      const col = args[tool.argName || 'column'];
      if (col === undefined) return true;
      return c.claimGaz(ctx.gaz.col, col, 'COL') || c.claimGaz(ctx.gaz.cat, col, 'COL');
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags);
      const c = g('COL')[0] || g('CAT')[0];
      const col = c && (normFrom(ctx.gaz.col)(c.words) || normFrom(ctx.gaz.cat)(c.words));
      if (col) return { [tool.argName || 'column']: col };
      return tool.optional ? {} : null;
    },
  },

  // {axes: {Z:[words], X:[words], Y:[words]}, posArg?, thickArg?}
  'axis-position': {
    defaultTarget: 120,
    render(tool, ctx, R) {
      const t = R.maybe(0.3) ? 5 * ((1 + R.rnd() * 10) | 0) : null;
      const th = t ? R.pick([` ${t} m thick`, ` ${t} meter thick`, `, ${t} meters thick`]) : '';
      const kind = R.rnd();
      const posArg = tool.posArg || 'position', thickArg = tool.thickArg || 'thickness';
      const mk = (axis, position, q) => ({ q, args: { axis, [posArg]: position, ...(t ? { [thickArg]: t } : {}) } });
      if (kind < 0.55) {
        const z = 900 + 20 * ((R.rnd() * 13) | 0) + R.pick([0, 5, 10, -5]);
        return mk('Z', z, R.pick([`section at elevation ${z}${th}`, `horizontal section at ${z}${th}`, `cut the model at elevation ${z}${th}`, `slice at ${z} elevation${th}`, `put a section on the ${z} elevation${th}`, `give me a${th} section at elevation ${z}`, `plan section at ${z}${th}`]));
      }
      if (kind < 0.8) {
        const x = 100 * ((30 + R.rnd() * 30) | 0);
        return mk('X', x, R.pick([`north-south section at easting ${x}${th}`, `section at easting ${x}${th}`, `cut at easting ${x}${th}`, `NS section on ${x} east${th}`]));
      }
      const y = 100 * ((70 + R.rnd() * 30) | 0);
      return mk('Y', y, R.pick([`east-west section at northing ${y}${th}`, `section at northing ${y}${th}`, `cut at northing ${y}${th}`, `EW section on ${y} north${th}`]));
    },
    align(toks, tags, args, ctx, tool) {
      const c = mkClaim(toks, tags);
      const thickArg = tool.thickArg || 'thickness', posArg = tool.posArg || 'position';
      if (args[thickArg] !== undefined && c.claimNum(args[thickArg], 'THICK') < 0) return false;
      return c.claimNum(args[posArg], 'POS') >= 0;
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags);
      const pos = g('POS')[0] || g('VAL')[0];
      if (!pos) return null;
      let axis = 'Z';
      outer: for (const t of toks) for (const [ax, words] of Object.entries(tool.axes)) if (words.includes(t)) { axis = ax; break outer; }
      const out = { axis, [tool.posArg || 'position']: num(pos.words[0]) };
      const th = g('THICK')[0];
      if (th) out[tool.thickArg || 'thickness'] = num(th.words[0]);
      return out;
    },
  },

  // {argName:'axis', axes:{X:[words],Y:[],Z:[]}, colArg?:'column',
  //  frames:['swath along {ax}'], colFrames:['swath of {col} along {ax}']}
  'axis-pick': {
    defaultTarget: 90,
    render(tool, ctx, R) {
      const axis = R.pick(Object.keys(tool.axes));
      const ax = R.pick(tool.axes[axis]);
      if (!tool.colArg || R.maybe(0.45)) return { q: fill(R.pick(tool.frames), { ax }), args: { [tool.argName || 'axis']: axis } };
      const { col, cfg } = pickNumCol(ctx.vocab, R);
      return { q: fill(R.pick(tool.colFrames), { ax, col: R.pick(cfg.syn) }), args: { [tool.argName || 'axis']: axis, [tool.colArg]: col } };
    },
    align(toks, tags, args, ctx, tool) {
      const c = mkClaim(toks, tags);
      if (tool.colArg && args[tool.colArg] !== undefined) return c.claimGaz(ctx.gaz.col, args[tool.colArg], 'COL');
      return true;
    },
    assemble(tool, ctx, toks, tags) {
      let axis = null;
      outer: for (const t of toks) for (const [ax, words] of Object.entries(tool.axes)) if (words.includes(t)) { axis = ax; break outer; }
      if (!axis) return null;
      const out = { [tool.argName || 'axis']: axis };
      if (tool.colArg) {
        const g = groupTags(toks, tags);
        const c = g('COL')[0];
        const col = c && normFrom(ctx.gaz.col)(c.words);
        if (col) out[tool.colArg] = col;
      }
      return out;
    },
  },

  // {column:'LITO'} → {column, value, visible:bool}
  'category-visibility': {
    defaultTarget: 110,
    render(tool, ctx, R) {
      const col = catColOf(tool, ctx.vocab);
      const vals = ctx.vocab.catValues[col];
      const v = R.pick(Object.keys(vals)), syn = R.pick(vals[v]);
      const show = R.maybe(0.4);
      const q = show
        ? R.pick([`show ${syn}`, `bring back ${syn}`, `turn on ${syn}`, `make ${syn} visible`, `unhide ${syn}`, `put ${syn} back`, `I want to see ${syn} again`, `${cap(syn)} back on`])
        : R.pick([`hide ${syn}`, `take out ${syn}`, `remove the ${syn} blocks`, `turn off ${syn}`, `${cap(syn)} off`, `drop the ${syn} from the view`, `get rid of ${syn}`, `I don't want to see ${syn}`, `make ${syn} invisible`, `switch off ${syn}`]);
      return { q, args: { column: col, value: v, visible: show } };
    },
    align(toks, tags, args, ctx) {
      const c = mkClaim(toks, tags);
      return c.claimGaz(ctx.gaz.lit, null, 'CAT', (v) => v.col === args.column && v.value === args.value);
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags);
      const c = g('CAT')[0];
      const hit = c && normFrom(ctx.gaz.lit)(c.words);
      if (!hit) return null;
      return { column: hit.col, value: hit.value, visible: showHide(toks, ctx.vocab.L) === 'show' };
    },
  },

  // {argName:'layer', frames:['zoom to {layer}',...]}
  'layer-pick': {
    defaultTarget: 70,
    render(tool, ctx, R) {
      const file = R.pick(Object.keys(ctx.vocab.layers));
      const syn = R.pick(ctx.vocab.layers[file].filter((s) => s !== file));
      return { q: fill(R.pick(tool.frames), { layer: syn }), args: { [tool.argName || 'layer']: file } };
    },
    align(toks, tags, args, ctx, tool) {
      return mkClaim(toks, tags).claimGaz(ctx.gaz.layer, args[tool.argName || 'layer'], 'LAYER');
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags);
      const c = g('LAYER')[0];
      const layer = (c && normFrom(ctx.gaz.layer)(c.words)) || normFrom(ctx.gaz.layer)(toks);
      return layer ? { [tool.argName || 'layer']: layer } : null;
    },
  },

  // {} → {layer, action:'show'|'hide'}
  'layer-action': {
    defaultTarget: 80,
    render(tool, ctx, R) {
      const file = R.pick(Object.keys(ctx.vocab.layers));
      const syn = R.pick(ctx.vocab.layers[file].filter((s) => s !== file));
      const show = R.maybe(0.45);
      const q = show
        ? R.pick([`show ${syn}`, `turn on ${syn}`, `bring ${syn} back`, `${cap(syn)} back on`, `make ${syn} visible`, `show ${syn} again`])
        : R.pick([`hide ${syn}`, `turn off ${syn}`, `remove ${syn} from the view`, `${cap(syn)} off`, `I don't want to see ${syn}`, `make ${syn} invisible`]);
      return { q, args: { layer: file, action: show ? 'show' : 'hide' } };
    },
    align(toks, tags, args, ctx) {
      return mkClaim(toks, tags).claimGaz(ctx.gaz.layer, args.layer, 'LAYER');
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags);
      const c = g('LAYER')[0];
      const layer = (c && normFrom(ctx.gaz.layer)(c.words)) || normFrom(ctx.gaz.layer)(toks);
      return layer ? { layer, action: showHide(toks, ctx.vocab.L) } : null;
    },
  },

  // {argName, values:{key: [syn] | {syn:[...], frames:[...]}}, frames:['use {val}',...]}
  'lexicon-pick': {
    defaultTarget: 55,
    render(tool, ctx, R) {
      const key = R.pick(Object.keys(tool.values));
      const spec = tool.values[key];
      const syns = Array.isArray(spec) ? spec : spec.syn || [key];
      const perValueFrames = !Array.isArray(spec) && spec.frames;
      if (perValueFrames) return { q: R.pick(spec.frames), args: { [tool.argName]: key } };
      return { q: fill(R.pick(tool.frames), { val: R.pick(syns) }), args: { [tool.argName]: key } };
    },
    align() { return true; },                                // lexicon at assembly; no tags
    assemble(tool, ctx, toks) {
      const key = lexFind(toks, tool.values);
      return key ? { [tool.argName]: key } : null;
    },
  },

  // {argName, frames:['exaggerate z by {n}'], values?:[...], wordNumbers?:bool}
  'number-arg': {
    defaultTarget: 45,
    render(tool, ctx, R) {
      const n = tool.values ? R.pick(tool.values) : +(0.5 + R.rnd() * 9.5).toFixed(1);
      const L = ctx.vocab.L;
      const asWord = tool.wordNumbers && Number.isInteger(n) && n >= 1 && n <= 9 && R.maybe(0.3);
      const word = asWord ? Object.keys(L.wordNums).find((k) => L.wordNums[k] === n) : null;
      return { q: fill(R.pick(tool.frames), { n: word || n }), args: { [tool.argName]: n } };
    },
    align(toks, tags, args, ctx, tool) {
      const c = mkClaim(toks, tags);
      if (c.claimNum(args[tool.argName], 'VAL') >= 0) return true;
      if (!tool.wordNumbers) return false;
      const wn = ctx.vocab.L.wordNums;
      const wi = toks.findIndex((t, k) => tags[k] === 'O' && wn[t] === args[tool.argName]);
      if (wi < 0) return false;
      tags[wi] = 'VAL';
      return true;
    },
    assemble(tool, ctx, toks, tags) {
      const g = groupTags(toks, tags);
      let n = firstNum(g, toks);
      if (n == null && tool.wordNumbers) { const wn = ctx.vocab.L.wordNums; const w = toks.find((t) => wn[t]); if (w) n = wn[w]; }
      return n != null ? { [tool.argName]: n } : null;
    },
  },

  // {frames:[...]}
  'no-arg': {
    defaultTarget: 30,
    render(tool, ctx, R) {
      return { q: politeWrap(R.pick(tool.frames), R, ctx.vocab.L), args: {} };
    },
    align() { return true; },
    assemble() { return {}; },
  },
};

// ── src/gen.js ──

// @gcu/dispatch — corpus generation: banks × kinds over the session
// vocabulary, answer-first (arguments picked, utterance rendered), seeded,
// deduplicated, with the eval-contamination guard as a first-class option.

function generate(ctx, tools, { seed = 42, targets = {}, refusalTarget = 70, extraRefusals = [], excludeTexts = null } = {}) {
  const R = mkR(mulberry32(seed));
  const seen = new Set();
  const excluded = new Set();
  const out = [];
  const guard = (q) => {
    const key = normText(q);
    if (seen.has(key)) return false;
    if (excludeTexts && excludeTexts.has(key)) { excluded.add(key); return false; }
    seen.add(key);
    return true;
  };
  for (const tool of tools) {
    const kind = KINDS[tool.kind];
    if (!kind) throw new Error(`unknown kind "${tool.kind}" (tool ${tool.name})`);
    const target = targets[tool.name] ?? tool.target ?? kind.defaultTarget;
    let made = 0, tries = 0;
    while (made < target && tries++ < target * 40) {
      const { q, args } = kind.render(tool, ctx, R);
      if (!guard(q)) continue;
      out.push({ q, tool: tool.name, args });
      made++;
    }
  }
  const refusalBank = [...ctx.vocab.L.refusals, ...extraRefusals];
  let made = 0, tries = 0;
  while (made < refusalTarget && tries++ < refusalTarget * 40) {
    const base = R.pick(refusalBank);
    const q = R.maybe(0.4) ? base : R.pick([`${base} please`, `can you ${base}`, `${base}?`, `${cap(base)}.`, `${base} for me`]);
    if (!guard(q)) continue;
    out.push({ q, tool: null, args: null });
    made++;
  }
  return { corpus: out, excluded: [...excluded] };
}

// ── src/train.js ──

// @gcu/dispatch — training: alignment (per kind, answer-first) + two
// averaged perceptrons (multiclass intent incl. REFUSE; structured tagger
// with Viterbi). Pure — takes a corpus, returns a JSON-serializable weight
// table. Seconds on any machine, browser included.

const TAGS = ['O', 'COL', 'OP', 'VAL', 'CAT', 'RNG', 'POS', 'THICK', 'ID', 'LAYER'];

function alignCorpus(corpus, ctx, toolsByName) {
  const aligned = [];
  let dropped = 0;
  for (const ex of corpus) {
    const toks = tokenize(ex.q);
    if (ex.tool === null) { aligned.push({ toks, tags: null, intent: 'REFUSE' }); continue; }
    const tool = toolsByName[ex.tool];
    const tags = new Array(toks.length).fill('O');
    const ok = KINDS[tool.kind].align(toks, tags, ex.args, ctx, tool);
    if (!ok) { dropped++; continue; }
    aligned.push({ toks, tags, intent: ex.tool });
  }
  return { aligned, dropped };
}

function trainModels(aligned, ctx, { epochs = 25 } = {}) {
  // ── intent: averaged multiclass perceptron ──
  const CLASSES = [...new Set(aligned.map((x) => x.intent))].sort();
  const iw = {}, iacc = {};
  for (const c of CLASSES) { iw[c] = new Map(); iacc[c] = new Map(); }
  let it = 1;
  const iscore = (c, f) => { let s = iw[c].get('_bias') || 0; for (const [k, v] of f) s += (iw[c].get(k) || 0) * v; return s; };
  const ibump = (c, f, d) => {
    const W = iw[c], A = iacc[c];
    W.set('_bias', (W.get('_bias') || 0) + d); A.set('_bias', (A.get('_bias') || 0) + d * it);
    for (const [k, v] of f) { W.set(k, (W.get(k) || 0) + d * v); A.set(k, (A.get(k) || 0) + d * v * it); }
  };
  for (let e = 0; e < epochs; e++) {
    let errs = 0;
    for (const ex of shuffled(aligned, 1000 + e)) {
      const f = ctx.intentFeatures(ex.toks);
      let best = null, bs = -Infinity;
      for (const c of CLASSES) { const s = iscore(c, f); if (s > bs) { bs = s; best = c; } }
      if (best !== ex.intent) { ibump(ex.intent, f, 1); ibump(best, f, -1); errs++; }
      it++;
    }
    if (!errs) break;
  }
  const intent = {};
  for (const c of CLASSES) {
    intent[c] = {};
    for (const [k, v] of iw[c]) { const avg = v - (iacc[c].get(k) || 0) / it; if (Math.abs(avg) > 1e-6) intent[c][k] = +avg.toFixed(5); }
  }

  // ── tags: averaged structured perceptron ──
  const tw = {}, tacc = {}, tr = new Map(), tracc = new Map();
  for (const t of TAGS) { tw[t] = new Map(); tacc[t] = new Map(); }
  let tt = 1;
  const T = TAGS.length;
  function decode(per, n) {
    const dp = Array.from({ length: n }, () => new Float64Array(T).fill(-1e9));
    const bp = Array.from({ length: n }, () => new Int32Array(T));
    const emit = (i, t) => { let s = 0; const W = tw[TAGS[t]]; for (const k of per[i]) s += W.get(k) || 0; return s; };
    for (let t = 0; t < T; t++) dp[0][t] = emit(0, t) + (tr.get(`^>${TAGS[t]}`) || 0);
    for (let i = 1; i < n; i++) for (let t = 0; t < T; t++) {
      const e = emit(i, t);
      for (let p = 0; p < T; p++) { const s = dp[i - 1][p] + (tr.get(`${TAGS[p]}>${TAGS[t]}`) || 0) + e; if (s > dp[i][t]) { dp[i][t] = s; bp[i][t] = p; } }
    }
    let best = 0;
    for (let t = 1; t < T; t++) if (dp[n - 1][t] > dp[n - 1][best]) best = t;
    const out = new Array(n);
    for (let i = n - 1, t = best; i >= 0; i--) { out[i] = TAGS[t]; t = bp[i][t]; }
    return out;
  }
  const tagged = aligned.filter((x) => x.tags);
  for (let e = 0; e < epochs; e++) {
    let errs = 0;
    for (const ex of shuffled(tagged, 2000 + e)) {
      const per = ctx.tokenFeatures(ex.toks);
      const pred = decode(per, ex.toks.length);
      for (let i = 0; i < ex.toks.length; i++) {
        if (pred[i] === ex.tags[i]) continue;
        errs++;
        const up = tw[ex.tags[i]], ua = tacc[ex.tags[i]], dn = tw[pred[i]], da = tacc[pred[i]];
        for (const k of per[i]) {
          up.set(k, (up.get(k) || 0) + 1); ua.set(k, (ua.get(k) || 0) + tt);
          dn.set(k, (dn.get(k) || 0) - 1); da.set(k, (da.get(k) || 0) - tt);
        }
        const pg = i ? ex.tags[i - 1] : '^', pp = i ? pred[i - 1] : '^';
        for (const [key, d] of [[`${pg}>${ex.tags[i]}`, 1], [`${pp}>${pred[i]}`, -1]]) {
          tr.set(key, (tr.get(key) || 0) + d); tracc.set(key, (tracc.get(key) || 0) + d * tt);
        }
      }
      tt++;
    }
    if (!errs) break;
  }
  const tag = {}, trans = {};
  for (const t of TAGS) {
    tag[t] = {};
    for (const [k, v] of tw[t]) { const avg = v - (tacc[t].get(k) || 0) / tt; if (Math.abs(avg) > 1e-6) tag[t][k] = +avg.toFixed(5); }
  }
  for (const [k, v] of tr) { const avg = v - (tracc.get(k) || 0) / tt; if (Math.abs(avg) > 1e-6) trans[k] = +avg.toFixed(5); }

  return { tags: TAGS, classes: CLASSES, intent, tag, trans };
}

// ── src/api.js ──

// @gcu/dispatch — the public surface.
//   deriveVocab(session)                         → vocab
//   trainSession({vocab, tools, ...})            → { dispatcher, weights, stats }
//   createDispatcher({vocab, tools, weights})    → { dispatch(q, {surface}) }
// dispatch returns { calls, intent, margin, tags } — calls is [] on refusal
// or failed assembly (the host degrades into its command palette).

function scoreIntents(ctx, weights, toks) {
  const f = ctx.intentFeatures(toks);
  const scores = {};
  for (const [cls, wv] of Object.entries(weights.intent)) {
    let s = wv._bias || 0;
    for (const [k, v] of f) s += (wv[k] || 0) * v;
    scores[cls] = s;
  }
  return scores;
}
function viterbi(ctx, weights, toks) {
  const per = ctx.tokenFeatures(toks);
  const tags = weights.tags;
  const n = toks.length, T = tags.length;
  const emit = (i, t) => { const wv = weights.tag[tags[t]]; if (!wv) return 0; let s = 0; for (const k of per[i]) s += wv[k] || 0; return s; };
  const dp = Array.from({ length: n }, () => new Float64Array(T).fill(-1e9));
  const bp = Array.from({ length: n }, () => new Int32Array(T));
  for (let t = 0; t < T; t++) dp[0][t] = emit(0, t) + (weights.trans[`^>${tags[t]}`] || 0);
  for (let i = 1; i < n; i++) for (let t = 0; t < T; t++) {
    const e = emit(i, t);
    for (let p = 0; p < T; p++) { const s = dp[i - 1][p] + (weights.trans[`${tags[p]}>${tags[t]}`] || 0) + e; if (s > dp[i][t]) { dp[i][t] = s; bp[i][t] = p; } }
  }
  let best = 0;
  for (let t = 1; t < T; t++) if (dp[n - 1][t] > dp[n - 1][best]) best = t;
  const out = new Array(n);
  for (let i = n - 1, t = best; i >= 0; i--) { out[i] = tags[t]; t = bp[i][t]; }
  return out;
}

function createDispatcher({ vocab, tools, weights }) {
  const ctx = createContext(vocab);
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const surfaceOf = (t) => t.surface || t.name.split('.')[0];
  function dispatch(query, opts = {}) {
    const toks = tokenize(query);
    if (!toks.length) return { calls: [], intent: 'REFUSE', margin: 0 };
    const scores = scoreIntents(ctx, weights, toks);
    const inScope = opts.surface
      ? ([cls]) => cls === 'REFUSE' || (toolsByName[cls] && surfaceOf(toolsByName[cls]) === opts.surface)
      : () => true;
    const ranked = Object.entries(scores).filter(inScope).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { calls: [], intent: 'REFUSE', margin: 0 };
    const intent = ranked[0][0];
    const margin = ranked[0][1] - (ranked[1] ? ranked[1][1] : 0);
    if (intent === 'REFUSE') return { calls: [], intent, margin };
    const tool = toolsByName[intent];
    const tags = viterbi(ctx, weights, toks);
    const args = KINDS[tool.kind].assemble(tool, ctx, toks, tags);
    if (!args) return { calls: [], intent, margin, note: 'assembly failed' };
    return { calls: [{ name: intent, arguments: args }], intent, margin, tags };
  }
  return { dispatch, ctx, weights, tools };
}

// the session-trained loop: generate → align → train → dispatcher, in one
// call, fast enough to run at project load.
function trainSession({ vocab, tools, seed = 42, targets, refusalTarget, extraRefusals, excludeTexts, epochs } = {}) {
  const ctx = createContext(vocab);
  const { corpus, excluded } = generate(ctx, tools, { seed, targets, refusalTarget, extraRefusals, excludeTexts });
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const { aligned, dropped } = alignCorpus(corpus, ctx, toolsByName);
  const weights = trainModels(aligned, ctx, { epochs });
  const dispatcher = createDispatcher({ vocab, tools, weights });
  return { dispatcher, weights, stats: { corpus: corpus.length, aligned: aligned.length, dropped, excluded } };
}

// ── src/main.js ──

// @gcu/dispatch — module manifest / curated export surface.
// One utterance in, one routed, explainable tool call out — session-trained
// (the model is younger than your coffee), zero-dep, browser-pure, Sealed-
// compatible. See SPEC.md; provenance: the gcu-dispatch incubator.

export {
  deriveVocab,
  LOCALES,
  ELEMENT_LEX,
  createContext,
  KINDS,
  generate,
  alignCorpus,
  trainModels,
  TAGS,
  createDispatcher,
  trainSession,
  tokenize,
  normText,
  mulberry32,
};
