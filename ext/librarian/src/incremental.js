// Incremental lifecycle — the segment model in miniature (§4 of the spec): an
// immutable packed CSR base + a small mutable delta + periodic merge. Makes a
// streaming inserter (a feed poller) cost O(doc) per insert instead of the
// O(corpus) of a full rebuild.
//
//   addDoc(index, doc)   append to the delta segment (re-adding an existing id
//                        tombstones the old copy first — last write wins).
//   removeDoc(index, id) tombstone the doc (O(1)); scoring skips it.
//   compact(index)       fold the live delta + drop tombstones into a fresh
//                        packed CSR base, in place. O(corpus), idle work.
//   pendingCompaction(index) -> { delta, tombstones, ratio } — cheap signal
//                        so the consumer knows when compaction is worthwhile.
//
// Search (csr.js searchCsr) transparently merges base + delta and skips
// tombstones, so results always reflect adds/removes between compactions.

import { buildCsrIndex } from './csr.js';

// Attach the mutable-segment machinery on first use. The base id→ordinal map
// is built once (O(N)); subsequent adds/removes are O(doc)/O(1).
function _ensureIncr(index) {
  if (index._deltaDocs) return;
  index._deleted = index._deleted || new Uint8Array(index.N);
  index._deltaDocs = [];
  index._deltaDeleted = new Set();
  index._deltaIndex = null;
  index._deltaDirty = false;
  const m = new Map();
  for (let ord = 0; ord < index.N; ord++) m.set(index.docIds[ord], { seg: 'base', ord });
  index._idMap = m;
}

export function addDoc(index, doc) {
  if (!index || !index._csr) throw new Error('addDoc: not a CSR index');
  _ensureIncr(index);
  const id = doc.id;
  if (index._idMap.has(id)) removeDoc(index, id);   // update = remove + re-add
  const ord = index._deltaDocs.length;
  index._deltaDocs.push(doc);
  index._idMap.set(id, { seg: 'delta', ord });
  index._deltaDirty = true;                          // delta index needs rebuild
  return index;
}

export function removeDoc(index, id) {
  if (!index || !index._csr) throw new Error('removeDoc: not a CSR index');
  _ensureIncr(index);
  const loc = index._idMap.get(id);
  if (!loc) return false;
  if (loc.seg === 'base') {
    index._deleted[loc.ord] = 1;                     // live tombstone, no rebuild
  } else {
    index._deltaDeleted.add(loc.ord);
    if (index._deltaIndex && loc.ord < index._deltaIndex.N) index._deltaIndex._deleted[loc.ord] = 1;
  }
  index._idMap.delete(id);
  return true;
}

export function pendingCompaction(index) {
  if (!index || !index._deltaDocs) return { delta: 0, tombstones: 0, ratio: 0 };
  let liveDelta = 0;
  for (let ord = 0; ord < index._deltaDocs.length; ord++) if (!index._deltaDeleted.has(ord)) liveDelta++;
  let tombstones = 0;
  for (let i = 0; i < index._deleted.length; i++) tombstones += index._deleted[i];
  const denom = Math.max(1, index.N);
  return { delta: liveDelta, tombstones, ratio: (liveDelta + tombstones) / denom };
}

// Merge CSR segments into a fresh CSR — directly over typed arrays, no
// re-tokenization, so it works without stored text (the lean path). Each
// segment = { index, deleted: Uint8Array|null }. Drops tombstoned docs and
// renumbers ordinals (base docs first, then delta), keeping postDocs ascending
// within each term. Compaction is the only caller; it is O(corpus) idle work.
export function mergeCsr(segments, buildOpts) {
  const segs = segments.filter((s) => s && s.index);
  const ref = segs.length ? segs[0].index : null;
  const folded = buildOpts.mode === 'folded';
  const storeText = buildOpts.storeText !== false;
  const fieldNames = ref ? ref.fieldNames.slice() : [];
  const F = fieldNames.length;
  const fieldBoost = ref ? Float64Array.from(ref.fieldBoost) : new Float64Array(0);
  const keepPos = ref ? ref.positions : false;       // effective positions flag

  // New doc ordinals (live docs only), base segments first.
  const map = [];                                     // [segIdx][oldOrd] -> newOrd | -1
  let newN = 0;
  for (let si = 0; si < segs.length; si++) {
    const idx = segs[si].index, del = segs[si].deleted;
    const row = new Int32Array(idx.N);
    for (let o = 0; o < idx.N; o++) row[o] = (del && del[o]) ? -1 : newN++;
    map.push(row);
  }

  // Union vocab + per-segment term remap.
  const vocab = new Map();
  const termRemap = [];
  for (let si = 0; si < segs.length; si++) {
    const idx = segs[si].index;
    const remap = new Int32Array(idx.V);
    for (const [term, oldId] of idx.vocab) {
      let nid = vocab.get(term);
      if (nid === undefined) { nid = vocab.size; vocab.set(term, nid); }
      remap[oldId] = nid;
    }
    termRemap.push(remap);
  }
  const V = vocab.size;

  // Pass A — posting counts per new term.
  const postCount = new Int32Array(V);
  for (let si = 0; si < segs.length; si++) {
    const idx = segs[si].index, del = segs[si].deleted, remap = termRemap[si];
    for (let t = 0; t < idx.V; t++) {
      const nt = remap[t];
      for (let p = idx.termOffset[t]; p < idx.termOffset[t + 1]; p++) {
        const od = idx.postDocs[p];
        if (del && del[od]) continue;
        postCount[nt]++;
      }
    }
  }
  const termOffset = new Int32Array(V + 1);
  for (let t = 0; t < V; t++) termOffset[t + 1] = termOffset[t] + postCount[t];
  const nnz = termOffset[V];

  // Pass B — fill. Segments in order (base docs lower newOrd) keeps ascending.
  const postDocs = new Int32Array(nnz);
  const postTf = new Uint16Array(nnz);
  const postField = folded ? null : new Uint8Array(nnz);
  const entryPos = keepPos ? new Array(nnz) : null;
  const cursor = termOffset.slice(0, V);
  for (let si = 0; si < segs.length; si++) {
    const idx = segs[si].index, del = segs[si].deleted, remap = termRemap[si], rowMap = map[si];
    for (let t = 0; t < idx.V; t++) {
      const nt = remap[t];
      for (let p = idx.termOffset[t]; p < idx.termOffset[t + 1]; p++) {
        const od = idx.postDocs[p];
        if (del && del[od]) continue;
        const np = cursor[nt]++;
        postDocs[np] = rowMap[od];
        postTf[np] = idx.postTf[p];
        if (!folded) postField[np] = idx.postField[p];
        if (keepPos) entryPos[np] = idx.pos.slice(idx.posOffset[p], idx.posOffset[p + 1]);
      }
    }
  }

  // df by scanning each term row for distinct docs (ascending → count changes).
  const df = new Int32Array(V);
  for (let t = 0; t < V; t++) {
    let last = -1, c = 0;
    for (let p = termOffset[t]; p < termOffset[t + 1]; p++) { if (postDocs[p] !== last) { c++; last = postDocs[p]; } }
    df[t] = c;
  }

  // Doc-level arrays, renumbered.
  const docIds = new Array(newN);
  const docLen = new Int32Array(newN);
  const docFieldLen = folded ? null : new Int32Array(newN * F);
  const docText = storeText ? new Array(newN) : null;
  const docMeta = new Array(newN);
  for (let si = 0; si < segs.length; si++) {
    const idx = segs[si].index, rowMap = map[si];
    for (let o = 0; o < idx.N; o++) {
      const no = rowMap[o];
      if (no < 0) continue;
      docIds[no] = idx.docIds[o];
      docLen[no] = idx.docLen[o];
      if (!folded) for (let f = 0; f < F; f++) docFieldLen[no * F + f] = idx.docFieldLen[o * F + f];
      if (storeText) docText[no] = idx.docText ? idx.docText[o] : null;
      docMeta[no] = idx.docMeta ? idx.docMeta[o] : {};
    }
  }

  // Position CSR + per-field / global length stats.
  let posOffset = null, pos = null;
  if (keepPos) {
    posOffset = new Int32Array(nnz + 1);
    for (let p = 0; p < nnz; p++) posOffset[p + 1] = posOffset[p] + entryPos[p].length;
    pos = new Int32Array(posOffset[nnz]);
    for (let p = 0; p < nnz; p++) { const a = entryPos[p], b = posOffset[p]; for (let j = 0; j < a.length; j++) pos[b + j] = a[j]; }
  }
  let totalLen = 0; for (let o = 0; o < newN; o++) totalLen += docLen[o];
  const avg = newN > 0 ? totalLen / newN : 0;
  let fieldAvgLen = null;
  if (!folded) {
    fieldAvgLen = new Float64Array(F);
    for (let f = 0; f < F; f++) { let s = 0; for (let o = 0; o < newN; o++) s += docFieldLen[o * F + f]; fieldAvgLen[f] = newN > 0 ? s / newN : 0; }
  }
  const statsFieldAvg = {};
  for (let f = 0; f < F; f++) statsFieldAvg[fieldNames[f]] = fieldAvgLen ? fieldAvgLen[f] : 0;

  const fieldsConf = {};
  for (let f = 0; f < F; f++) fieldsConf[fieldNames[f]] = { boost: fieldBoost[f] };

  return {
    _csr: true, mode: ref ? ref.mode : 'multi', storeText, positions: keepPos,
    N: newN, V, vocab, df,
    termOffset, postDocs, postTf, postField, posOffset, pos,
    docIds, docLen, docFieldLen, docText, docMeta,
    fieldNames, fieldBoost, fieldAvgLen, avg,
    synonyms: ref ? ref.synonyms : {},
    snippetFn: ref ? ref.snippetFn : null,
    stats: { totalDocs: newN, avgLen: avg, fieldAvgLen: statsFieldAvg },
    _buildOpts: ref ? ref._buildOpts : buildOpts,
  };
}

export function compact(index) {
  if (!index || !index._csr) throw new Error('compact: not a CSR index');
  _ensureIncr(index);
  const opts = index._buildOpts;
  const segs = [{ index, deleted: index._deleted }];
  if (index._deltaDocs.length) {
    const di = buildCsrIndex({ docs: index._deltaDocs, ...opts });
    const del = new Uint8Array(di.N);
    for (const ord of index._deltaDeleted) if (ord < di.N) del[ord] = 1;
    segs.push({ index: di, deleted: del });
  }
  const merged = mergeCsr(segs, opts);
  // Replace base contents in place; reset the delta machinery.
  for (const k of Object.keys(index)) delete index[k];
  Object.assign(index, merged);
  _ensureIncr(index);
  return index;
}
