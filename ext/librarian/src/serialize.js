// JSON serialise / deserialise for the CSR index — the debug + tiny-docpack
// form. For real persistence use pack()/unpack() (binary, zero-copy reload);
// this JSON form is human-readable and round-trippable, handy for golden files
// and pre-built docpacks shipped as JSON. Typed arrays become plain arrays.

function _arr(ta) { return ta ? Array.from(ta) : null; }

export function serialize(index) {
  if (!index || !index._csr) throw new Error('serialize: not a CSR index');
  const terms = new Array(index.V);
  for (const [t, id] of index.vocab) terms[id] = t;
  return {
    version: 2,
    mode: index.mode, storeText: index.storeText, positions: index.positions,
    N: index.N, V: index.V,
    fieldNames: index.fieldNames.slice(),
    fieldBoost: _arr(index.fieldBoost),
    fieldAvgLen: _arr(index.fieldAvgLen),
    avg: index.avg,
    vocab: terms,
    df: _arr(index.df),
    termOffset: _arr(index.termOffset),
    postDocs: _arr(index.postDocs),
    postTf: _arr(index.postTf),
    postField: _arr(index.postField),
    posOffset: _arr(index.posOffset),
    pos: _arr(index.pos),
    docIds: index.docIds,
    docLen: _arr(index.docLen),
    docFieldLen: _arr(index.docFieldLen),
    docText: index.docText || null,
    docMeta: index.docMeta || null,
    synonyms: index.synonyms || {},
  };
}

export function deserialize(json, opts = {}) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const F = o.fieldNames.length;
  const vocab = new Map();
  for (let i = 0; i < o.vocab.length; i++) vocab.set(o.vocab[i], i);
  const fieldAvgLen = o.fieldAvgLen ? Float64Array.from(o.fieldAvgLen) : null;
  const statsFieldAvg = {};
  for (let f = 0; f < F; f++) statsFieldAvg[o.fieldNames[f]] = fieldAvgLen ? fieldAvgLen[f] : 0;
  const fieldBoost = Float64Array.from(o.fieldBoost);
  const fieldsConf = {};
  for (let f = 0; f < F; f++) fieldsConf[o.fieldNames[f]] = { boost: fieldBoost[f] };
  const snippetFn = typeof opts.snippet === 'function' ? opts.snippet : null;
  return {
    _csr: true, mode: o.mode, storeText: o.storeText, positions: o.positions,
    N: o.N, V: o.V, vocab,
    df: Int32Array.from(o.df),
    termOffset: Int32Array.from(o.termOffset),
    postDocs: Int32Array.from(o.postDocs),
    postTf: Uint16Array.from(o.postTf),
    postField: o.postField ? Uint8Array.from(o.postField) : null,
    posOffset: o.posOffset ? Int32Array.from(o.posOffset) : null,
    pos: o.pos ? Int32Array.from(o.pos) : null,
    docIds: o.docIds,
    docLen: Int32Array.from(o.docLen),
    docFieldLen: o.docFieldLen ? Int32Array.from(o.docFieldLen) : null,
    docText: o.docText || null,
    docMeta: o.docMeta || null,
    fieldNames: o.fieldNames.slice(), fieldBoost, fieldAvgLen, avg: o.avg,
    synonyms: o.synonyms || {}, snippetFn,
    stats: { totalDocs: o.N, avgLen: o.avg, fieldAvgLen: statsFieldAvg },
    _buildOpts: { mode: o.mode, storeText: o.storeText, positions: o.positions, fields: fieldsConf, synonyms: o.synonyms, snippet: snippetFn },
  };
}
