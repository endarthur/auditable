// @gcu/dispatch — featurization over a SESSION context. createContext(vocab)
// builds the gazetteers once per session; everything downstream (training,
// inference) reads them through the context, so a new project = a new
// context = a dispatcher fluent in the new vocabulary.
import { tokenize, gazMap, gazSpans, NUM_RE, shape } from './text.js';

export function createContext(vocab) {
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
