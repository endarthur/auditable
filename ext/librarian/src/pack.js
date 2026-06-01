// Binary persistence — pack(index) -> ArrayBuffer / unpack(buf) -> index.
//
// v1's serialize() emits JSON (re-inflates every string + array — huge and
// slow). pack writes a length-prefixed binary blob: a small header, the
// dictionary + doc-id/meta/text as encoded strings, and every typed-array
// section copied VERBATIM at an aligned offset. unpack rebuilds the index with
// the typed arrays as zero-copy views over the buffer — one readFile + a few
// `new Int32Array(buf, off, len)`, no re-tokenization, no GC churn. A consumer
// persists this to VFS/OPFS and reloads a 50k-doc index in « 100 ms.
//
// The dictionary + docIds + meta + (optional) stored text are the only parts
// that decode; the postings/length arrays are bytes. Sequential layout with
// deterministic alignment padding — reader and writer walk the same order, so
// no offset index is needed.
//
// A `snippet` callback can't be serialized; pass it back via unpack(buf, {snippet}).

import { compact } from './incremental.js';

const MAGIC = 0x4c425231;   // 'LBR1'

class _Writer {
  constructor() { this.chunks = []; this.len = 0; }
  _pad(align) { const m = this.len % align; if (m) { const p = align - m; this.chunks.push(new Uint8Array(p)); this.len += p; } }
  u32(x) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x >>> 0, true); this.chunks.push(b); this.len += 4; }
  f64(x) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x, true); this.chunks.push(b); this.len += 8; }
  bytes(u8) { this.chunks.push(u8); this.len += u8.length; }
  str(s) { const u8 = new TextEncoder().encode(s == null ? '' : String(s)); this.u32(u8.length); this.bytes(u8); }
  ta(arr) { this._pad(arr.BYTES_PER_ELEMENT); this.bytes(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); }
  done() { const out = new Uint8Array(this.len); let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length; } return out.buffer; }
}

class _Reader {
  constructor(buf) { this.buf = buf; this.dv = new DataView(buf); this.off = 0; this.dec = new TextDecoder(); }
  _pad(align) { const m = this.off % align; if (m) this.off += align - m; }
  u32() { const v = this.dv.getUint32(this.off, true); this.off += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.off, true); this.off += 8; return v; }
  str() { const n = this.u32(); const s = this.dec.decode(new Uint8Array(this.buf, this.off, n)); this.off += n; return s; }
  ta(Ctor, len) { this._pad(Ctor.BYTES_PER_ELEMENT); const v = new Ctor(this.buf, this.off, len); this.off += v.byteLength; return v; }
}

export function pack(index) {
  if (!index || !index._csr) throw new Error('pack: not a CSR index');
  // Fold any pending delta + tombstones so the packed form is the live state.
  if (index._deltaDocs && (index._deltaDocs.length || (index._deleted && index._deleted.some((x) => x)))) compact(index);
  const folded = index.mode === 'folded';
  const positions = !!index.positions;
  const storeText = !!index.storeText;
  const F = index.fieldNames.length;
  const nnz = index.postDocs.length;
  const totalPos = positions ? index.pos.length : 0;

  const w = new _Writer();
  w.u32(MAGIC);
  w.u32((storeText ? 1 : 0) | (positions ? 2 : 0) | (folded ? 4 : 0));
  w.u32(index.N); w.u32(index.V); w.u32(F); w.u32(nnz); w.u32(totalPos);
  w.f64(index.avg);

  // Field config.
  for (let f = 0; f < F; f++) w.str(index.fieldNames[f]);
  for (let f = 0; f < F; f++) w.f64(index.fieldBoost[f]);
  if (!folded) for (let f = 0; f < F; f++) w.f64(index.fieldAvgLen[f]);

  // Dictionary in termId order (decode on load).
  const terms = new Array(index.V);
  for (const [term, id] of index.vocab) terms[id] = term;
  for (let i = 0; i < index.V; i++) w.str(terms[i]);

  // Typed-array sections (verbatim, aligned).
  w.ta(index.df);
  w.ta(index.termOffset);
  w.ta(index.postDocs);
  w.ta(index.postTf);
  if (!folded) w.ta(index.postField);
  if (positions) { w.ta(index.posOffset); w.ta(index.pos); }
  w.ta(index.docLen);
  if (!folded) w.ta(index.docFieldLen);

  // Variable-shape doc data + synonyms as JSON strings.
  w.str(JSON.stringify(index.docIds));
  w.str(JSON.stringify(index.docMeta || []));
  w.str(storeText ? JSON.stringify(index.docText || []) : '');
  w.str(JSON.stringify(index.synonyms || {}));

  return w.done();
}

export function unpack(buf, opts = {}) {
  const r = new _Reader(buf);
  if (r.u32() !== MAGIC) throw new Error('unpack: bad magic (not a librarian pack)');
  const flags = r.u32();
  const storeText = !!(flags & 1), positions = !!(flags & 2), folded = !!(flags & 4);
  const N = r.u32(), V = r.u32(), F = r.u32(), nnz = r.u32(), totalPos = r.u32();
  const avg = r.f64();

  const fieldNames = new Array(F);
  for (let f = 0; f < F; f++) fieldNames[f] = r.str();
  const fieldBoost = new Float64Array(F);
  for (let f = 0; f < F; f++) fieldBoost[f] = r.f64();
  let fieldAvgLen = null;
  if (!folded) { fieldAvgLen = new Float64Array(F); for (let f = 0; f < F; f++) fieldAvgLen[f] = r.f64(); }

  const vocab = new Map();
  for (let i = 0; i < V; i++) vocab.set(r.str(), i);

  const df = r.ta(Int32Array, V);
  const termOffset = r.ta(Int32Array, V + 1);
  const postDocs = r.ta(Int32Array, nnz);
  const postTf = r.ta(Uint16Array, nnz);
  const postField = folded ? null : r.ta(Uint8Array, nnz);
  let posOffset = null, pos = null;
  if (positions) { posOffset = r.ta(Int32Array, nnz + 1); pos = r.ta(Int32Array, totalPos); }
  const docLen = r.ta(Int32Array, N);
  const docFieldLen = folded ? null : r.ta(Int32Array, N * F);

  const docIds = JSON.parse(r.str());
  const docMeta = JSON.parse(r.str());
  const dtStr = r.str();
  const docText = storeText ? JSON.parse(dtStr) : null;
  const synonyms = JSON.parse(r.str());

  const statsFieldAvg = {};
  for (let f = 0; f < F; f++) statsFieldAvg[fieldNames[f]] = fieldAvgLen ? fieldAvgLen[f] : 0;
  const fieldsConf = {};
  for (let f = 0; f < F; f++) fieldsConf[fieldNames[f]] = { boost: fieldBoost[f] };
  const mode = folded ? 'folded' : 'multi';
  const snippetFn = typeof opts.snippet === 'function' ? opts.snippet : null;

  return {
    _csr: true, mode, storeText, positions,
    N, V, vocab, df,
    termOffset, postDocs, postTf, postField, posOffset, pos,
    docIds, docLen, docFieldLen, docText, docMeta,
    fieldNames, fieldBoost, fieldAvgLen, avg,
    synonyms, snippetFn,
    stats: { totalDocs: N, avgLen: avg, fieldAvgLen: statsFieldAvg },
    _buildOpts: { mode, storeText, positions, fields: fieldsConf, synonyms, snippet: snippetFn },
  };
}
