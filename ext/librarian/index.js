// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/librarian/src/  Build: node ext/librarian/build.js
// @gcu/librarian — BM25F text search with fuzzy / synonyms / proximity.

// -- tokenize.js --

// Tokenizer. Lower-case ASCII split on non-alphanumeric boundaries,
// stopword filter, optional Unicode passthrough so CJK / accented
// terms aren't lost.
//
// Returns positions alongside tokens — `search()` uses them for phrase
// proximity scoring + snippet extraction.

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'he','her','his','i','if','in','into','is','it','its','of','on','or','our',
  'she','so','than','that','the','their','them','then','there','these','they',
  'this','to','us','was','we','were','what','when','where','which','while',
  'who','will','with','you','your',
]);

// Match runs of ASCII alphanumerics + apostrophes (so "don't" stays one
// token) OR any non-ASCII letter range (covers CJK, accented Latin).
const TOKEN_RE = /[a-z0-9']+|[^\x00-\x7f]+/g;

function tokenize(text, opts = {}) {
  const stop = opts.keepStopwords ? new Set() : STOPWORDS;
  const minLen = opts.minLen != null ? opts.minLen : 2;
  const lower = String(text || '').toLowerCase();
  const out = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(lower)) != null) {
    let tok = m[0];
    // Strip leading/trailing apostrophes.
    tok = tok.replace(/^'+|'+$/g, '');
    if (!tok) continue;
    if (tok.length < minLen) continue;
    if (stop.has(tok)) continue;
    out.push({ token: tok, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Just the token strings, no positions — used when scoring queries.
function tokenizeStrings(text) {
  return tokenize(text).map((t) => t.token);
}

// -- fuzzy.js --

// Damerau-Levenshtein edit distance, bounded for efficiency: aborts when
// distance exceeds `max`. Used both for the fuzzy-match step at query
// time and for "did you mean?" suggestions when an exact term hits zero
// results.

function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Two-row dynamic programming with the Damerau transposition extension.
  // We track three rows for transpositions.
  const prev2 = new Array(lb + 1);
  const prev1 = new Array(lb + 1);
  const curr  = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev1[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(
        curr[j - 1] + 1,      // insertion
        prev1[j] + 1,         // deletion
        prev1[j - 1] + cost,  // substitution
      );
      // Transposition (Damerau).
      if (i > 1 && j > 1
          && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
          && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + cost);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Prune: if the best score in this row already exceeds max, no
    // continuation can recover.
    if (rowMin > max) return max + 1;
    // Slide the rolling window.
    for (let j = 0; j <= lb; j++) { prev2[j] = prev1[j]; prev1[j] = curr[j]; }
  }
  return prev1[lb];
}

// Find every term in `dictionary` within `max` edits of `target`.
// Returns sorted ascending by distance.
function nearTerms(target, dictionary, max) {
  const hits = [];
  for (const term of dictionary) {
    const d = editDistance(target, term, max);
    if (d <= max) hits.push({ term, distance: d });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

// -- index.js --

// Index construction. Builds a BM25F-shaped inverted index over a
// collection of documents with named fields. Per-token postings carry
// positions (for snippet generation + phrase proximity scoring).
//
// Doc shape: { id, ...fields } where each field is a string.
// Spec shape:
//   {
//     docs: [doc, ...],
//     fields: { name: { boost?: number }, ... },
//     synonyms: { 'term': ['syn1','syn2'], ... },   // optional
//   }
//
// Index internal shape:
//   {
//     terms: Map<term, { df, postings: Map<docId, Map<fieldName, [positions]>> }>
//     docs: Map<docId, { id, fields: { name: { text, length } }, totalLen }>
//     fields: { name: { boost } }
//     synonyms: { term: [syn] }
//     stats: { totalDocs, avgLen, fieldAvgLen: { name: number } }
//   }


function _normalizeFields(spec) {
  const f = spec.fields || {};
  const norm = {};
  for (const [name, conf] of Object.entries(f)) {
    norm[name] = { boost: (conf && conf.boost) || 1 };
  }
  // If no fields declared, infer from the first doc (excluding id).
  if (Object.keys(norm).length === 0 && spec.docs && spec.docs.length > 0) {
    for (const k of Object.keys(spec.docs[0])) {
      if (k !== 'id') norm[k] = { boost: 1 };
    }
  }
  return norm;
}

function buildIndex(spec) {
  const fields = _normalizeFields(spec);
  const fieldNames = Object.keys(fields);
  const terms = new Map();
  const docs = new Map();
  const fieldLenSum = {};
  for (const fn of fieldNames) fieldLenSum[fn] = 0;
  let totalLen = 0;

  for (const doc of (spec.docs || [])) {
    const id = doc.id;
    if (id == null) continue;
    const docFields = {};
    let docLen = 0;
    for (const fn of fieldNames) {
      const text = doc[fn] != null ? String(doc[fn]) : '';
      const toks = tokenize(text);
      docFields[fn] = { text, length: toks.length };
      fieldLenSum[fn] += toks.length;
      docLen += toks.length;
      // Posting accumulator: group positions by (term, field).
      for (const { token, start } of toks) {
        let entry = terms.get(token);
        if (!entry) {
          entry = { df: 0, postings: new Map() };
          terms.set(token, entry);
        }
        let docPostings = entry.postings.get(id);
        if (!docPostings) {
          docPostings = new Map();
          entry.postings.set(id, docPostings);
          // df is the count of distinct docs containing the term.
          entry.df++;
        }
        let positions = docPostings.get(fn);
        if (!positions) {
          positions = [];
          docPostings.set(fn, positions);
        }
        positions.push(start);
      }
    }
    // Preserve any extra (non-field, non-id) properties as `meta` so
    // consumers can attach arbitrary doc-level data (file paths,
    // anchors, timestamps, …) and read it back from search hits.
    const meta = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'id' || fieldNames.includes(k)) continue;
      meta[k] = v;
    }
    docs.set(id, { id, fields: docFields, totalLen: docLen, meta });
    totalLen += docLen;
  }

  const N = docs.size;
  const fieldAvgLen = {};
  for (const fn of fieldNames) {
    fieldAvgLen[fn] = N > 0 ? fieldLenSum[fn] / N : 0;
  }

  // Normalise synonyms: lowercase keys, lowercase synonym lists.
  const synonyms = {};
  if (spec.synonyms) {
    for (const [k, syns] of Object.entries(spec.synonyms)) {
      synonyms[k.toLowerCase()] = (Array.isArray(syns) ? syns : [syns])
        .map((s) => String(s).toLowerCase());
    }
  }

  return {
    terms, docs, fields, synonyms,
    stats: { totalDocs: N, avgLen: N > 0 ? totalLen / N : 0, fieldAvgLen },
  };
}

// Merge multiple indexes into one. doc IDs must be unique across sources;
// if they collide, later wins. Used for v2 multi-source / docpack worlds.
function mergeIndexes(indexes) {
  const all = { docs: [], fields: {}, synonyms: {} };
  for (const idx of indexes) {
    if (idx.fields) Object.assign(all.fields, idx.fields);
    if (idx.synonyms) Object.assign(all.synonyms, idx.synonyms);
    for (const [id, doc] of idx.docs) {
      const recon = { id };
      for (const [fn, info] of Object.entries(doc.fields)) {
        recon[fn] = info.text;
      }
      all.docs.push(recon);
    }
  }
  return buildIndex(all);
}

// -- search.js --

// Query-time search. BM25F scoring + optional fuzzy expansion + phrase
// proximity bonus. Returns ranked hits with snippets.



const BM25_K1 = 1.5;
const BM25_B  = 0.75;
const PROXIMITY_WINDOW = 30;   // tokens — close-by hits get a bonus
const PROXIMITY_BONUS  = 0.2;  // added to the score per close pair

// Expand a query term via synonyms + (optional) fuzzy match against the
// index's term dictionary. Returns an array of { term, weight } where
// weight is 1.0 for exact, < 1.0 for fuzzy/synonym (so fuzzy matches
// don't dominate ranking).
function _expandTerm(term, index, fuzzy) {
  const expanded = [{ term, weight: 1.0 }];
  // Synonyms — equal weight.
  const syns = index.synonyms[term];
  if (syns) {
    for (const s of syns) {
      if (index.terms.has(s)) expanded.push({ term: s, weight: 1.0 });
    }
  }
  // Fuzzy — only if exact term isn't already in the index.
  if (fuzzy > 0 && !index.terms.has(term)) {
    const near = nearTerms(term, index.terms.keys(), fuzzy);
    for (const { term: t, distance } of near) {
      // Penalise by edit distance — 1-edit hits get 0.7, 2-edit 0.5, etc.
      expanded.push({ term: t, weight: 1 - 0.3 * distance });
    }
  }
  // Prefix match — also useful, especially for partial words like "encr".
  if (term.length >= 3 && !index.terms.has(term)) {
    for (const t of index.terms.keys()) {
      if (t !== term && t.startsWith(term)) {
        expanded.push({ term: t, weight: 0.8 });
      }
    }
  }
  return expanded;
}

// BM25F contribution of one (term, doc) pair, summed across fields.
function _bm25fScore(term, docId, index) {
  const N = index.stats.totalDocs;
  const termEntry = index.terms.get(term);
  if (!termEntry) return 0;
  const postings = termEntry.postings.get(docId);
  if (!postings) return 0;
  const idf = Math.log(1 + (N - termEntry.df + 0.5) / (termEntry.df + 0.5));
  const doc = index.docs.get(docId);
  let score = 0;
  for (const [fieldName, positions] of postings) {
    const tf = positions.length;
    const fieldConf = index.fields[fieldName] || { boost: 1 };
    const fieldLen = doc.fields[fieldName].length;
    const avgFieldLen = index.stats.fieldAvgLen[fieldName] || 1;
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * fieldLen / avgFieldLen);
    score += fieldConf.boost * idf * (tf * (BM25_K1 + 1)) / denom;
  }
  return score;
}

// Snippet around the first matching position in any field. Highlights
// hits with <mark>...</mark>; returns plain markup, never raw HTML
// fragments from the source (we tokenise positions to character spans).
function _snippet(doc, hits, contextChars = 80) {
  // hits: Map<fieldName, Array<{ token, positions }>>
  // Pick the field with the densest hit cluster.
  let best = null;
  for (const [fn, fhits] of hits) {
    if (!fhits.length) continue;
    const pos = fhits[0].positions[0];
    if (best == null || pos < best.pos) best = { fn, pos, fhits };
  }
  if (!best) return '';
  const text = doc.fields[best.fn].text;
  const start = Math.max(0, best.pos - contextChars);
  const end = Math.min(text.length, best.pos + contextChars);
  let slice = text.slice(start, end);
  // Build a sorted list of (start, end) hit spans within the slice for
  // highlighting.
  const spans = [];
  for (const { positions } of best.fhits) {
    for (const p of positions) {
      if (p >= start && p < end) {
        // The token's length isn't preserved in positions[], so we just
        // mark its starting position with a small fixed-width highlight.
        // The slice text + position alignment is approximate but fine
        // for visual cues.
        spans.push([p - start, Math.min(slice.length, p - start + 30)]);
      }
    }
  }
  // Naive: just emit the slice with one mark around the first hit area.
  // Avoids ranges-overlapping concerns; honest "approximately correct".
  if (spans.length > 0) {
    const [s, e] = spans[0];
    // Snap the end to a word boundary.
    const after = slice.slice(e).search(/\s|$/);
    const wordEnd = e + (after >= 0 ? after : 0);
    slice = slice.slice(0, s)
      + '<mark>' + _esc(slice.slice(s, wordEnd)) + '</mark>'
      + _esc(slice.slice(wordEnd));
    slice = (start > 0 ? '…' : '') + slice.slice((start > 0 ? 0 : 0))
      + (end < text.length ? '…' : '');
  } else {
    slice = _esc((start > 0 ? '…' : '') + slice + (end < text.length ? '…' : ''));
  }
  return slice;
}

function _esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' })[c]);
}

// Proximity bonus: scan positions across the matched terms in one doc;
// if any two hits sit within PROXIMITY_WINDOW tokens, add a bonus.
function _proximityBonus(termHits) {
  // termHits: array of { term, positions: number[] } (already merged across fields)
  if (termHits.length < 2) return 0;
  let pairs = 0;
  // Flatten all positions, sort, count adjacent within window.
  const all = [];
  for (const { positions } of termHits) {
    for (const p of positions) all.push(p);
  }
  all.sort((a, b) => a - b);
  for (let i = 1; i < all.length; i++) {
    if (all[i] - all[i - 1] <= PROXIMITY_WINDOW) pairs++;
  }
  return PROXIMITY_BONUS * pairs;
}

function search(index, query, opts = {}) {
  const fuzzy = opts.fuzzy != null ? opts.fuzzy : 1;
  const limit = opts.limit != null ? opts.limit : 10;
  const queryTokens = tokenizeStrings(query);
  if (queryTokens.length === 0) return [];

  // For each query token, expand and union-collect candidate docs.
  const expandedPerToken = queryTokens.map((t) => _expandTerm(t, index, fuzzy));

  // Score: sum BM25F contributions over expanded terms. Each query
  // token's contribution is the MAX over its expansions (so we don't
  // double-count synonyms / fuzzy variants).
  const docScores = new Map();
  // Per-doc, per-token term hits — for proximity + snippets.
  const docHits = new Map();   // docId → { perField: Map<field, [{token, positions}]>, perToken: [{term, positions}] }

  for (const tokenExpansions of expandedPerToken) {
    const candidateDocs = new Set();
    for (const { term } of tokenExpansions) {
      const entry = index.terms.get(term);
      if (!entry) continue;
      for (const docId of entry.postings.keys()) candidateDocs.add(docId);
    }
    for (const docId of candidateDocs) {
      // Best (term, weight) for this token-in-this-doc.
      let bestScore = 0;
      let bestTerm = null;
      for (const { term, weight } of tokenExpansions) {
        const s = weight * _bm25fScore(term, docId, index);
        if (s > bestScore) { bestScore = s; bestTerm = term; }
      }
      if (bestScore > 0) {
        docScores.set(docId, (docScores.get(docId) || 0) + bestScore);
        // Record hits for snippet + proximity.
        let dh = docHits.get(docId);
        if (!dh) {
          dh = { perField: new Map(), perToken: [] };
          docHits.set(docId, dh);
        }
        const entry = index.terms.get(bestTerm);
        const fieldPostings = entry.postings.get(docId);
        const mergedPositions = [];
        for (const [fn, positions] of fieldPostings) {
          let fhits = dh.perField.get(fn);
          if (!fhits) { fhits = []; dh.perField.set(fn, fhits); }
          fhits.push({ token: bestTerm, positions });
          mergedPositions.push(...positions);
        }
        dh.perToken.push({ term: bestTerm, positions: mergedPositions });
      }
    }
  }

  // Apply proximity bonus.
  const results = [];
  for (const [docId, score] of docScores) {
    const dh = docHits.get(docId);
    const finalScore = score + _proximityBonus(dh.perToken);
    const doc = index.docs.get(docId);
    results.push({
      id: docId,
      score: finalScore,
      doc: _publicDoc(doc),
      snippet: _snippet(doc, dh.perField),
      hits: _hitsSummary(dh.perField),
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function _publicDoc(doc) {
  const out = { id: doc.id, ...(doc.meta || {}) };
  for (const [fn, info] of Object.entries(doc.fields)) out[fn] = info.text;
  return out;
}

function _hitsSummary(perField) {
  const out = {};
  for (const [fn, fhits] of perField) {
    out[fn] = fhits.map((h) => ({ token: h.token, count: h.positions.length }));
  }
  return out;
}

// "Did you mean?" — when zero results, find the closest term(s) in the
// index dictionary for each query token.
function suggest(index, query, maxEdits = 2) {
  const tokens = tokenizeStrings(query);
  const suggestions = [];
  for (const t of tokens) {
    if (index.terms.has(t)) { suggestions.push(t); continue; }
    const near = nearTerms(t, index.terms.keys(), maxEdits);
    suggestions.push(near.length > 0 ? near[0].term : t);
  }
  return suggestions.join(' ');
}

// -- serialize.js --

// Serialise / deserialise an index to/from JSON. Used by the build
// pipeline to pre-compute indexes (so the docs surface boots with the
// index already built) and by future docpack downloads.

function serialize(index) {
  const terms = {};
  for (const [term, entry] of index.terms) {
    const postings = {};
    for (const [docId, fieldMap] of entry.postings) {
      const f = {};
      for (const [fn, positions] of fieldMap) f[fn] = positions;
      postings[docId] = f;
    }
    terms[term] = { df: entry.df, postings };
  }
  const docs = {};
  for (const [id, doc] of index.docs) {
    const fields = {};
    for (const [fn, info] of Object.entries(doc.fields)) {
      fields[fn] = info;   // { text, length }
    }
    docs[id] = { id, fields, totalLen: doc.totalLen, meta: doc.meta || {} };
  }
  return {
    version: 1,
    terms, docs,
    fields: index.fields,
    synonyms: index.synonyms,
    stats: index.stats,
  };
}

function deserialize(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  const terms = new Map();
  for (const [term, entry] of Object.entries(obj.terms || {})) {
    const postings = new Map();
    for (const [docId, fieldObj] of Object.entries(entry.postings)) {
      const fieldMap = new Map();
      for (const [fn, positions] of Object.entries(fieldObj)) {
        fieldMap.set(fn, positions);
      }
      postings.set(docId, fieldMap);
    }
    terms.set(term, { df: entry.df, postings });
  }
  const docs = new Map();
  for (const [id, doc] of Object.entries(obj.docs || {})) {
    docs.set(id, doc);
  }
  return {
    terms, docs,
    fields: obj.fields || {},
    synonyms: obj.synonyms || {},
    stats: obj.stats || { totalDocs: docs.size, avgLen: 0, fieldAvgLen: {} },
  };
}

// -- api.js --

// Public Librarian API. Pure functions; no hidden state.






const Librarian = {
  index: buildIndex,
  search,
  suggest,
  serialize,
  deserialize,
  merge: mergeIndexes,
  tokenize,
  editDistance,
};

export { Librarian };
