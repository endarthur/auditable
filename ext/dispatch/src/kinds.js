// @gcu/dispatch — the KIND implementations: the plugin boundary. A tool is a
// DECLARATION ({name, kind, ...kind fields}); each kind owns three verbs:
//   render(tool, ctx, R)              → {q, args}   (corpus generation)
//   align(toks, tags, args, ctx, tool) → bool        (training labels, answer-first)
//   assemble(tool, ctx, toks, tags)    → args | null  (inference)
// Assemblers emit the tool's CANONICAL argument shape (clauses arrays, real
// booleans) — hosts get WebMCP-shaped calls, not a model-era flattening.
import { tokenize, gazSpans, NUM_RE, num, cap } from './text.js';

// ── shared render helpers (R = { rnd, pick, maybe }) ──
export const mkR = (rnd) => ({ rnd, pick: (arr) => arr[(rnd() * arr.length) | 0], maybe: (p) => rnd() < p });
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
export function groupTags(toks, tags) {
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
export const KINDS = {
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
        return { q: R.pick([`filter ${noun} to ${syn}`, `only ${syn} ${noun}`, `keep just the ${syn}`]), args: { clauses: [{ column: catCol, op: '=', value: v }], join: 'and' } };
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
