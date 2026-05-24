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

import { tokenize } from './tokenize.js';

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

export function buildIndex(spec) {
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
export function mergeIndexes(indexes) {
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
