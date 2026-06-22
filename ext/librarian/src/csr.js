// The unified lean index — a compact, typed-array, CSR-style inverted index
// that is the SOLE index representation. v1's niceties return as opt-in flags
// on this one engine, not as a parallel structure:
//
//   mode      'multi' (default, true per-field BM25F — v1 behaviour) | 'folded'
//             (field boosts folded into one tf dimension; ~45-65× leaner, the
//             weir/large-corpus path). Folded silently changes ranking vs
//             BM25F, so it is a *conscious* opt-in, never the default.
//   storeText default true; keep field text for snippets + doc reconstruction.
//             Off (lean) + a `snippet(docId, fieldName)` callback = consumer
//             supplies snippet text for the top-K only.
//   positions default true; token positions for proximity scoring + snippet
//             alignment. Off (lean) drops the second-largest memory line.
//
// Representation (optional blocks are null unless their flag is on):
//   vocab       Map<term, termId>            dictionary (FST is a later rung)
//   df          Int32Array[V]                doc frequency per term
//   termOffset  Int32Array[V+1]              CSR row pointers into postings
//   postDocs    Int32Array[nnz]              doc ordinal (ascending within a term)
//   postTf      Uint16Array[nnz]             tf (folded: boosted; multi: per-field raw)
//   postField   Uint8Array[nnz] | null       field id (multi only)
//   posOffset   Int32Array[nnz+1] | null     CSR row pointers into pos
//   pos         Int32Array[totalPos] | null  token start offsets
//   docIds      Array[N]                     ordinal -> external id
//   docLen      Int32Array[N]                folded: boosted length (BM25 norm)
//   docFieldLen Int32Array[N*F] | null       multi: per-field token length
//   docText     Array<string[F]> | null      storeText: per-field text
//   docMeta     Array<object> | null          non-field, non-id keys per doc
//   fieldNames  string[]                     declared/inferred field order
//   fieldBoost  Float64Array                 per-field boost
//   fieldAvgLen Float64Array | null          multi: mean tokens per field
//   avg         number                       folded: mean boosted docLen
//
// nnz = total posting entries. Built in two passes (count → fill). Cache-
// friendly (scoring streams contiguous memory) and packs to raw bytes (pack.js).

import { tokenize, tokenizeStrings } from './tokenize.js';
import { nearTerms } from './fuzzy.js';

// Mirror search.js (v1) exactly — the parity gate guards against drift.
const CSR_K1 = 1.5;
const CSR_B = 0.75;
const CSR_PROX_W = 30;
const CSR_PROX_B = 0.2;

function _popcount(n) { let c = 0; while (n) { n &= n - 1; c++; } return c; }

function _cNormFields(spec) {
  const f = spec.fields;
  const norm = {};
  // `fields: 'folded' | 'multi'` is a mode alias (boosts then inferred/1).
  if (typeof f === 'object' && f) {
    for (const [name, conf] of Object.entries(f)) norm[name] = { boost: (conf && conf.boost) || 1 };
  }
  if (Object.keys(norm).length === 0 && spec.docs && spec.docs.length > 0) {
    for (const k of Object.keys(spec.docs[0])) if (k !== 'id') norm[k] = { boost: 1 };
  }
  return norm;
}

function _normalizeSynonyms(spec) {
  const synonyms = {};
  if (spec.synonyms) {
    for (const [k, syns] of Object.entries(spec.synonyms)) {
      synonyms[k.toLowerCase()] = (Array.isArray(syns) ? syns : [syns]).map((s) => String(s).toLowerCase());
    }
  }
  return synonyms;
}

export function buildCsrIndex(spec = {}) {
  const docsIn = spec.docs || [];
  const N = docsIn.length;
  const fieldConf = _cNormFields(spec);
  const fieldNames = Object.keys(fieldConf);
  const F = fieldNames.length;
  const fieldBoost = new Float64Array(F);
  for (let f = 0; f < F; f++) fieldBoost[f] = fieldConf[fieldNames[f]].boost;

  // Mode: alias via `fields: 'folded'|'multi'`, else `mode`, default 'multi'.
  let mode = spec.mode;
  if (spec.fields === 'folded' || spec.fields === 'multi') mode = spec.fields;
  if (mode !== 'folded') mode = 'multi';
  const storeText = spec.storeText !== false;        // default true
  const positions = spec.positions !== false;        // default true
  const folded = mode === 'folded';

  // Positions are meaningful (and tf == occurrence count) only in multi mode;
  // folded conflates fields, so its boosted tf != occurrence count and index-
  // driven snippet alignment is impossible. Folded is the lean path anyway —
  // it gets snippets from a callback by query-string match (no positions).
  const keepPos = positions && !folded;

  const vocab = new Map();
  const docIds = new Array(N);
  const docLen = new Int32Array(N);
  const docFieldLen = folded ? null : new Int32Array(N * F);
  const docText = storeText ? new Array(N) : null;
  const docMeta = new Array(N);
  const fieldLenSum = new Float64Array(F);
  let totalRawLen = 0;

  // The build re-tokenizes (two passes) rather than holding every doc's
  // postings at once — peak memory is the output CSR arrays, not O(corpus)
  // postings, so 100k full-body docs survive where the nested-map build OOMs.

  // Pass 1 — vocab, df, per-term posting counts, lengths, stored text/meta.
  // Transient per-doc only: a Map<termId, fieldMask> (discarded each doc).
  const df = [];                 // grows with vocab; -> Int32Array after
  const postCount = [];          // posting entries per term
  for (let d = 0; d < N; d++) {
    const doc = docsIn[d] || {};
    docIds[d] = doc.id;
    const texts = storeText ? new Array(F) : null;
    const seen = new Map();      // termId -> field bitmask (this doc)
    let boostedLen = 0, rawLen = 0;
    for (let f = 0; f < F; f++) {
      const fn = fieldNames[f];
      const text = doc[fn] != null ? String(doc[fn]) : '';
      if (storeText) texts[f] = text;
      const toks = tokenize(text);
      const len = toks.length;
      if (!folded) docFieldLen[d * F + f] = len;
      fieldLenSum[f] += len;
      rawLen += len;
      boostedLen += fieldBoost[f] * len;
      for (const { token } of toks) {
        let id = vocab.get(token);
        if (id === undefined) { id = vocab.size; vocab.set(token, id); df[id] = 0; postCount[id] = 0; }
        seen.set(id, (seen.get(id) || 0) | (1 << f));
      }
    }
    docLen[d] = folded ? Math.round(boostedLen) : rawLen;
    totalRawLen += folded ? boostedLen : rawLen;
    for (const [id, mask] of seen) {
      df[id]++;
      // folded -> one entry per term; multi -> one per distinct field.
      postCount[id] += folded ? 1 : _popcount(mask);
    }
    if (storeText) docText[d] = texts;
    const meta = {};
    for (const [k, v] of Object.entries(doc)) { if (k === 'id' || fieldNames.includes(k)) continue; meta[k] = v; }
    docMeta[d] = meta;
  }

  const V = vocab.size;
  const dfArr = new Int32Array(V);
  for (let t = 0; t < V; t++) dfArr[t] = df[t];
  const termOffset = new Int32Array(V + 1);
  for (let t = 0; t < V; t++) termOffset[t + 1] = termOffset[t] + postCount[t];
  const nnz = termOffset[V];

  // Pass 2 — re-tokenize each doc and fill postings at the CSR cursors.
  // Iterating docs in order keeps postDocs ascending within each term (matches
  // v1's Map-insertion / input order, so tie-breaking is identical).
  const postDocs = new Int32Array(nnz);
  const postTf = new Uint16Array(nnz);
  const postField = folded ? null : new Uint8Array(nnz);
  const entryPos = keepPos ? new Array(nnz) : null;
  const cursor = termOffset.slice(0, V);
  for (let d = 0; d < N; d++) {
    const doc = docsIn[d] || {};
    // Per-doc accumulation (transient): termId -> folded {tf} | multi Map<fid,{tf,pos}>.
    const acc = new Map();
    for (let f = 0; f < F; f++) {
      const fn = fieldNames[f];
      const toks = tokenize(doc[fn] != null ? String(doc[fn]) : '');
      for (const { token, start } of toks) {
        const id = vocab.get(token);
        if (folded) {
          let e = acc.get(id);
          if (!e) { e = { tf: 0 }; acc.set(id, e); }
          e.tf += fieldBoost[f];
        } else {
          let byField = acc.get(id);
          if (!byField) { byField = new Map(); acc.set(id, byField); }
          let e = byField.get(f);
          if (!e) { e = { tf: 0, pos: keepPos ? [] : null }; byField.set(f, e); }
          e.tf++;
          if (keepPos) e.pos.push(start);
        }
      }
    }
    for (const [id, val] of acc) {
      if (folded) {
        const p = cursor[id]++;
        postDocs[p] = d; postTf[p] = Math.min(65535, Math.round(val.tf));
      } else {
        const fids = [...val.keys()].sort((a, b) => a - b);
        for (const fid of fids) {
          const e = val.get(fid);
          const p = cursor[id]++;
          postDocs[p] = d; postTf[p] = Math.min(65535, e.tf); postField[p] = fid;
          if (keepPos) entryPos[p] = e.pos;
        }
      }
    }
  }

  // Position CSR from entryPos (multi + positions only).
  let posOffset = null, pos = null;
  if (keepPos) {
    posOffset = new Int32Array(nnz + 1);
    for (let p = 0; p < nnz; p++) posOffset[p + 1] = posOffset[p] + entryPos[p].length;
    pos = new Int32Array(posOffset[nnz]);
    for (let p = 0; p < nnz; p++) { const arr = entryPos[p]; const base = posOffset[p]; for (let j = 0; j < arr.length; j++) pos[base + j] = arr[j]; }
  }

  let fieldAvgLen = null;
  if (!folded) { fieldAvgLen = new Float64Array(F); for (let f = 0; f < F; f++) fieldAvgLen[f] = N > 0 ? fieldLenSum[f] / N : 0; }
  const avg = N > 0 ? totalRawLen / N : 0;

  // v1-shaped stats object for any external reader.
  const statsFieldAvg = {};
  for (let f = 0; f < F; f++) statsFieldAvg[fieldNames[f]] = fieldAvgLen ? fieldAvgLen[f] : (N > 0 ? fieldLenSum[f] / N : 0);

  // Reconstructable build config — the delta segment (incremental.js) is built
  // with these exact flags so its scoring matches the base.
  const fieldsConf = {};
  for (let f = 0; f < F; f++) fieldsConf[fieldNames[f]] = { boost: fieldBoost[f] };

  return {
    _csr: true, mode, storeText, positions: keepPos,
    N, V, vocab, df: dfArr,
    termOffset, postDocs, postTf, postField, posOffset, pos,
    docIds, docLen, docFieldLen, docText, docMeta,
    fieldNames, fieldBoost, fieldAvgLen, avg,
    synonyms: _normalizeSynonyms(spec),
    snippetFn: typeof spec.snippet === 'function' ? spec.snippet : null,
    stats: { totalDocs: N, avgLen: avg, fieldAvgLen: statsFieldAvg },
    _buildOpts: { mode, storeText, positions, fields: fieldsConf, synonyms: spec.synonyms, snippet: spec.snippet },
  };
}

// ── query-time ─────────────────────────────────────────────────────────────

function _idf(N, df) { return Math.log(1 + (N - df + 0.5) / (df + 0.5)); }

// Expand a query term via synonyms + (optional) fuzzy + prefix, against the
// CSR dictionary. Same weights as v1's _expandTerm. `prefix` (default on) gates
// the prefix scan — search-as-you-type wants it for the partial last word; a
// consumer can pass `prefix:false` to match whole terms only.
function _expand(term, index, fuzzy, prefix) {
  const expanded = [{ term, weight: 1.0 }];
  const has = (t) => index.vocab.has(t);
  const syns = index.synonyms[term];
  if (syns) for (const s of syns) if (has(s)) expanded.push({ term: s, weight: 1.0 });
  if (fuzzy > 0 && !has(term)) {
    // Gate the fuzzy radius by query-term length — a 1-edit match on a short word flips its
    // meaning (cat→bat, mina→mira), so don't fuzz short terms. And steepen the down-weight (0.5 @ d1,
    // 0.2 @ d2) so a fuzzy hit can't outrank a literal/synonym match on a rare term's IDF alone
    // (the sondagem→soldagem false-friend). Conservative fuzzy = typo fallback; the synonym ring
    // above is the precise multilingual mechanism.
    const fz = term.length < 5 ? 0 : term.length < 8 ? Math.min(fuzzy, 1) : fuzzy;
    if (fz > 0) {
      const near = nearTerms(term, index.vocab.keys(), fz);
      for (const { term: t, distance } of near) expanded.push({ term: t, weight: Math.max(0, 0.5 - 0.3 * (distance - 1)) });
    }
  }
  if (prefix && term.length >= 3 && !has(term)) {
    for (const t of index.vocab.keys()) if (t !== term && t.startsWith(term)) expanded.push({ term: t, weight: 0.8 });
  }
  return expanded;
}

// BM25(F) contribution of one (term, doc), plus the per-field breakdown needed
// for snippets/proximity. Walks the term's CSR row from `lo` to `hi`; the row
// is doc-sorted so a doc's field entries are contiguous. Returns the score and
// (when positions are on) [{ fieldId, positions }].
function _scoreTermDoc(index, termId, doc, lo, hi) {
  const N = index.N;
  const idf = _idf(N, index.df[termId]);
  // Find the contiguous block for `doc` via the row (binary search start).
  let s = lo, e = hi;
  // Linear is fine here (rows short in multi mode); but narrow with bsearch.
  while (s < e) { const mid = (s + e) >> 1; if (index.postDocs[mid] < doc) s = mid + 1; else e = mid; }
  let score = 0; const fieldHits = [];
  for (let p = s; p < hi && index.postDocs[p] === doc; p++) {
    const tf = index.postTf[p];
    if (index.mode === 'folded') {
      const denom = tf + CSR_K1 * (1 - CSR_B + CSR_B * index.docLen[doc] / (index.avg || 1));
      score += idf * (tf * (CSR_K1 + 1)) / denom;
    } else {
      const f = index.postField[p];
      const fieldLen = index.docFieldLen[doc * index.fieldNames.length + f] || 0;
      const avgF = index.fieldAvgLen[f] || 1;
      const denom = tf + CSR_K1 * (1 - CSR_B + CSR_B * fieldLen / avgF);
      score += index.fieldBoost[f] * idf * (tf * (CSR_K1 + 1)) / denom;
    }
    if (index.positions) {
      const f = index.mode === 'folded' ? 0 : index.postField[p];
      const positions = index.pos.subarray(index.posOffset[p], index.posOffset[p + 1]);
      fieldHits.push({ fieldId: f, positions });
    }
  }
  return { score, fieldHits };
}

function _cEsc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }

// Snippet — ports v1's _snippet to CSR. perField: Map<fieldId, [{token, positions}]>.
function _cSnippet(index, doc, perField, contextChars = 80) {
  let best = null;
  for (const [fid, fhits] of perField) {
    if (!fhits.length) continue;
    const p = fhits[0].positions[0];
    if (best == null || p < best.pos) best = { fid, pos: p, fhits };
  }
  if (!best) return '';
  let text = '';
  if (index.storeText && index.docText) text = index.docText[doc][best.fid] || '';
  else if (index.snippetFn) text = String(index.snippetFn(index.docIds[doc], index.fieldNames[best.fid]) || '');
  if (!text) return '';
  const start = Math.max(0, best.pos - contextChars);
  const end = Math.min(text.length, best.pos + contextChars);
  let slice = text.slice(start, end);
  const spans = [];
  for (const { positions } of best.fhits) for (const p of positions) if (p >= start && p < end) spans.push([p - start, Math.min(slice.length, p - start + 30)]);
  if (spans.length > 0) {
    const [s, e] = spans[0];
    const after = slice.slice(e).search(/\s|$/);
    const wordEnd = e + (after >= 0 ? after : 0);
    slice = slice.slice(0, s) + '<mark>' + _cEsc(slice.slice(s, wordEnd)) + '</mark>' + _cEsc(slice.slice(wordEnd));
    slice = (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
  } else {
    slice = _cEsc((start > 0 ? '…' : '') + slice + (end < text.length ? '…' : ''));
  }
  return slice;
}

// Snippet without positions (the lean path): locate the first query token in
// the supplied text by indexOf and mark it. Text comes from storeText or the
// consumer's snippet callback. Used when `positions` is off.
function _snippetFromText(text, queryTokens, contextChars = 80) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let pos = -1, hitTok = '';
  for (const t of queryTokens) { const i = lower.indexOf(t); if (i !== -1 && (pos === -1 || i < pos)) { pos = i; hitTok = t; } }
  if (pos === -1) {
    const head = text.slice(0, contextChars * 2);
    return _cEsc(head) + (text.length > contextChars * 2 ? '…' : '');
  }
  const start = Math.max(0, pos - contextChars), end = Math.min(text.length, pos + contextChars);
  let slice = text.slice(start, end);
  const s = pos - start, e = Math.min(slice.length, s + hitTok.length);
  slice = slice.slice(0, s) + '<mark>' + _cEsc(slice.slice(s, e)) + '</mark>' + _cEsc(slice.slice(e));
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
}

function _cProximity(perToken) {
  if (perToken.length < 2) return 0;
  let pairs = 0; const all = [];
  for (const { positions } of perToken) for (const p of positions) all.push(p);
  all.sort((a, b) => a - b);
  for (let i = 1; i < all.length; i++) if (all[i] - all[i - 1] <= CSR_PROX_W) pairs++;
  return CSR_PROX_B * pairs;
}

function _cPublicDoc(index, doc) {
  const out = { id: index.docIds[doc], ...(index.docMeta ? index.docMeta[doc] : {}) };
  if (index.storeText && index.docText) for (let f = 0; f < index.fieldNames.length; f++) out[index.fieldNames[f]] = index.docText[doc][f];
  return out;
}

// Score one CSR segment (base or delta). Non-recursive; `searchCsr` wraps this
// to merge a base index with its mutable delta.
function _searchOne(index, query, opts = {}) {
  const fuzzy = opts.fuzzy != null ? opts.fuzzy : 1;
  const limit = opts.limit != null ? opts.limit : 10;
  const prefix = opts.prefix != null ? opts.prefix : true;          // on by default
  const filter = typeof opts.filter === 'function' ? opts.filter : null;
  const tokens = tokenizeStrings(query);
  if (tokens.length === 0) return [];

  const docScores = new Map();
  const docHits = new Map();   // doc -> { perField: Map<fid,[{token,positions}]>, perToken: [{term,positions}] }
  const skip = index._deleted;

  for (const tok of tokens) {
    const expansions = _expand(tok, index, fuzzy, prefix);
    // Per-doc best expansion for this token.
    const tokBest = new Map();   // doc -> { score, term, fieldHits }
    for (const { term, weight } of expansions) {
      const termId = index.vocab.get(term);
      if (termId === undefined) continue;
      const lo = index.termOffset[termId], hi = index.termOffset[termId + 1];
      // Walk distinct docs in this row.
      let p = lo;
      while (p < hi) {
        const doc = index.postDocs[p];
        // advance p past this doc's block while scoring it once
        const { score, fieldHits } = _scoreTermDoc(index, termId, doc, lo, hi);
        const cand = weight * score;
        const prev = tokBest.get(doc);
        if ((!prev || cand > prev.score) && cand > 0 && !(skip && skip[doc])) tokBest.set(doc, { score: cand, term, fieldHits });
        // skip to next doc block
        while (p < hi && index.postDocs[p] === doc) p++;
      }
    }
    for (const [doc, b] of tokBest) {
      docScores.set(doc, (docScores.get(doc) || 0) + b.score);
      let dh = docHits.get(doc);
      if (!dh) { dh = { perField: new Map(), perToken: [] }; docHits.set(doc, dh); }
      const merged = [];
      for (const { fieldId, positions } of b.fieldHits) {
        let fh = dh.perField.get(fieldId);
        if (!fh) { fh = []; dh.perField.set(fieldId, fh); }
        fh.push({ token: b.term, positions });
        for (const x of positions) merged.push(x);
      }
      dh.perToken.push({ term: b.term, positions: merged });
    }
  }

  const results = [];
  for (const [doc, score] of docScores) {
    // Scoped search — an optional predicate on the external id (§5). Applied
    // before the limit slice, so the result is the top-K of the filtered set.
    if (filter && !filter(index.docIds[doc])) continue;
    const dh = docHits.get(doc);
    const finalScore = score + (index.positions ? _cProximity(dh.perToken) : 0);
    const out = { id: index.docIds[doc], score: finalScore, doc: _cPublicDoc(index, doc) };
    if (index.positions && (index.storeText || index.snippetFn)) {
      out.snippet = _cSnippet(index, doc, dh.perField);        // position-aligned (v1 parity)
    } else if (index.storeText || index.snippetFn) {
      // Lean path — no positions; mark the first query token in the text.
      let text = '';
      if (index.storeText && index.docText) text = (index.docText[doc] || []).join(' ');
      else text = String(index.snippetFn(index.docIds[doc], index.mode === 'folded' ? null : index.fieldNames[0]) || '');
      out.snippet = _snippetFromText(text, tokens);
    } else { out.snippet = ''; }
    out.hits = _cHitsSummary(index, dh.perField);
    results.push(out);
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// Public search — scores the base segment and, if a mutable delta exists,
// the (lazily rebuilt) delta segment, then merges. A doc in the merged top-K
// is in the top-K of its own segment, so slicing each to `limit` before the
// merge is exact.
export function searchCsr(index, query, opts = {}) {
  const base = _searchOne(index, query, opts);
  const delta = index._deltaDocs;
  if (!delta || delta.length === 0) return base;
  if (index._deltaDirty || !index._deltaIndex) {
    const di = buildCsrIndex({ docs: delta, ...index._buildOpts });
    di._deleted = new Uint8Array(di.N);
    for (const ord of index._deltaDeleted) if (ord < di.N) di._deleted[ord] = 1;
    index._deltaIndex = di;
    index._deltaDirty = false;
  }
  const dres = _searchOne(index._deltaIndex, query, opts);
  const limit = opts.limit != null ? opts.limit : 10;
  return base.concat(dres).sort((a, b) => b.score - a.score).slice(0, limit);
}

function _cHitsSummary(index, perField) {
  const out = {};
  for (const [fid, fhits] of perField) out[index.fieldNames[fid]] = fhits.map((h) => ({ token: h.token, count: h.positions.length }));
  return out;
}

export function suggestCsr(index, query, maxEdits = 2) {
  const tokens = tokenizeStrings(query);
  const suggestions = [];
  for (const t of tokens) {
    if (index.vocab.has(t)) { suggestions.push(t); continue; }
    const near = nearTerms(t, index.vocab.keys(), maxEdits);
    suggestions.push(near.length > 0 ? near[0].term : t);
  }
  return suggestions.join(' ');
}
