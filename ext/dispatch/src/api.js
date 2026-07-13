// @gcu/dispatch — the public surface.
//   deriveVocab(session)                         → vocab
//   trainSession({vocab, tools, ...})            → { dispatcher, weights, stats }
//   createDispatcher({vocab, tools, weights})    → { dispatch(q, {surface}) }
// dispatch returns { calls, intent, margin, tags } — calls is [] on refusal
// or failed assembly (the host degrades into its command palette).
import { tokenize } from './text.js';
import { deriveVocab } from './vocab.js';
import { createContext } from './features.js';
import { KINDS, groupTags } from './kinds.js';
import { generate } from './gen.js';
import { alignCorpus, trainModels } from './train.js';

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

export function createDispatcher({ vocab, tools, weights }) {
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
export function trainSession({ vocab, tools, seed = 42, targets, refusalTarget, extraRefusals, excludeTexts, epochs } = {}) {
  const ctx = createContext(vocab);
  const { corpus, excluded } = generate(ctx, tools, { seed, targets, refusalTarget, extraRefusals, excludeTexts });
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const { aligned, dropped } = alignCorpus(corpus, ctx, toolsByName);
  const weights = trainModels(aligned, ctx, { epochs });
  const dispatcher = createDispatcher({ vocab, tools, weights });
  return { dispatcher, weights, stats: { corpus: corpus.length, aligned: aligned.length, dropped, excluded } };
}

export { deriveVocab, createContext, KINDS, groupTags, generate, alignCorpus, trainModels };
