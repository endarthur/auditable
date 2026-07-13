// @gcu/dispatch — training: alignment (per kind, answer-first) + two
// averaged perceptrons (multiclass intent incl. REFUSE; structured tagger
// with Viterbi). Pure — takes a corpus, returns a JSON-serializable weight
// table. Seconds on any machine, browser included.
import { tokenize, shuffled } from './text.js';
import { KINDS } from './kinds.js';

export const TAGS = ['O', 'COL', 'OP', 'VAL', 'CAT', 'RNG', 'POS', 'THICK', 'ID', 'LAYER'];

export function alignCorpus(corpus, ctx, toolsByName) {
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

export function trainModels(aligned, ctx, { epochs = 25 } = {}) {
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
