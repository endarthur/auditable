// Serialise / deserialise an index to/from JSON. Used by the build
// pipeline to pre-compute indexes (so the docs surface boots with the
// index already built) and by future docpack downloads.

export function serialize(index) {
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

export function deserialize(json) {
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
