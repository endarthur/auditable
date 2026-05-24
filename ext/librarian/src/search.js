// Query-time search. BM25F scoring + optional fuzzy expansion + phrase
// proximity bonus. Returns ranked hits with snippets.

import { tokenize, tokenizeStrings } from './tokenize.js';
import { nearTerms } from './fuzzy.js';

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

export function search(index, query, opts = {}) {
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
export function suggest(index, query, maxEdits = 2) {
  const tokens = tokenizeStrings(query);
  const suggestions = [];
  for (const t of tokens) {
    if (index.terms.has(t)) { suggestions.push(t); continue; }
    const near = nearTerms(t, index.terms.keys(), maxEdits);
    suggestions.push(near.length > 0 ? near[0].term : t);
  }
  return suggestions.join(' ');
}
