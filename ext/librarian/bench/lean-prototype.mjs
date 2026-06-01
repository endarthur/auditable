// Prototype + benchmark for librarian v2: how far does "everything in RAM"
// stretch if we (a) use a lean CSR/typed-array inverted index instead of
// librarian v1's nested Maps + stored text, and (b) keep a contiguous
// search_text blob for scan-based search. Backs spec_inbox/librarian-search-spec.md.
// Run: node --expose-gc bench/lean-prototype.mjs   (from ext/librarian/)
import { Librarian } from '../index.js';
import { tokenize, tokenizeStrings } from '../src/tokenize.js';

// ---- realistic corpus (large vocab, front-biased term frequency) ----
const VOCAB = (() => {
  const out = []; const ab = 'abcdefghijklmnopqrstuvwxyz';
  let s = 12345; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  for (let i = 0; i < 30000; i++) { const n = 4 + Math.floor(r() * 6); let w = ''; for (let j = 0; j < n; j++) w += ab[Math.floor(r() * 26)]; out.push(w); }
  return out;
})();
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; }
function corpus(n, bodyWords) {
  const r = rng(42); const pick = () => VOCAB[Math.floor(r() * r() * VOCAB.length)];
  return Array.from({ length: n }, (_, i) => ({
    id: 'd' + i,
    title: Array.from({ length: 6 }, pick).join(' '),
    body: Array.from({ length: bodyWords }, pick).join(' '),
  }));
}
function mem() { if (global.gc) { global.gc(); global.gc(); } const m = process.memoryUsage(); return (m.heapUsed + m.arrayBuffers) / 1048576; }

// ---- LEAN index: CSR typed-array postings, no stored text, single folded field ----
// title tokens counted titleBoost× toward tf (approximates BM25F title boost).
function buildLean(docs, titleBoost = 4) {
  const vocab = new Map();          // term -> termId
  const docTf = new Array(docs.length);  // per doc: Map<termId, tf>
  const docLen = new Int32Array(docs.length);
  let postings = 0;
  for (let d = 0; d < docs.length; d++) {
    const tf = new Map();
    const add = (text, boost) => {
      for (const { token } of tokenize(text)) {
        let id = vocab.get(token); if (id === undefined) { id = vocab.size; vocab.set(token, id); }
        tf.set(id, (tf.get(id) || 0) + boost); docLen[d] += boost;
      }
    };
    add(docs[d].title, titleBoost); add(docs[d].body, 1);
    docTf[d] = tf; postings += tf.size;
  }
  const V = vocab.size;
  const df = new Int32Array(V);
  for (let d = 0; d < docs.length; d++) for (const id of docTf[d].keys()) df[id]++;
  const off = new Int32Array(V + 1);
  for (let t = 0; t < V; t++) off[t + 1] = off[t] + df[t];
  const postDocs = new Int32Array(postings);
  const postTf = new Uint16Array(postings);
  const cur = off.slice(0, V);
  for (let d = 0; d < docs.length; d++) {
    for (const [id, f] of docTf[d]) { const p = cur[id]++; postDocs[p] = d; postTf[p] = Math.min(65535, f); }
    docTf[d] = null;   // free as we go
  }
  let total = 0; for (let d = 0; d < docs.length; d++) total += docLen[d];
  return { vocab, df, off, postDocs, postTf, docLen, N: docs.length, avg: total / docs.length };
}
function searchLean(idx, query, { fuzzy = 0, limit = 10 } = {}) {
  const k1 = 1.5, b = 0.75, N = idx.N, avg = idx.avg;
  const scores = new Map();
  for (const term of tokenizeStrings(query)) {
    const exps = [];
    const exact = idx.vocab.get(term);
    if (exact !== undefined) exps.push([exact, 1]);
    else {
      // prefix + fuzzy expansion scan the vocab (same cost model as librarian)
      for (const [t, id] of idx.vocab) {
        if (t.startsWith(term) && term.length >= 3) exps.push([id, 0.8]);
      }
      if (fuzzy > 0) for (const [t, id] of idx.vocab) { if (Math.abs(t.length - term.length) <= fuzzy && Librarian.editDistance(term, t, fuzzy) <= fuzzy) exps.push([id, 0.6]); }
    }
    for (const [id, w] of exps) {
      const dft = idx.df[id]; const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      for (let p = idx.off[id]; p < idx.off[id + 1]; p++) {
        const doc = idx.postDocs[p], tf = idx.postTf[p];
        const denom = tf + k1 * (1 - b + b * idx.docLen[doc] / avg);
        scores.set(doc, (scores.get(doc) || 0) + w * idf * (tf * (k1 + 1)) / denom);
      }
    }
  }
  return [...scores.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, limit);
}

// ---- BLOB: contiguous lowercased search_text + exact indexOf scan ----
function buildBlob(docs) {
  const parts = new Array(docs.length); const start = new Int32Array(docs.length + 1);
  let pos = 0;
  for (let d = 0; d < docs.length; d++) { const t = (docs[d].title + ' ' + docs[d].body).toLowerCase(); parts[d] = t; start[d] = pos; pos += t.length + 1; }
  start[docs.length] = pos;
  return { blob: parts.join('\n'), start };
}
function scanBlob(b, needle) {   // exact substring, collect distinct docs
  needle = needle.toLowerCase(); const hits = []; let i = b.blob.indexOf(needle);
  while (i !== -1 && hits.length < 50) { hits.push(i); i = b.blob.indexOf(needle, i + 1); }
  return hits.length;
}

function row(label, buildMs, ramMb, extra) {
  console.log(`${label.padEnd(26)} build ${String(Math.round(buildMs)).padStart(6)}ms   RAM ${ramMb.toFixed(0).padStart(5)}MB   ${extra}`);
}

function bench(n, bodyWords, tag) {
  const docs = corpus(n, bodyWords);
  const w = VOCAB[0];
  console.log(`\n## ${tag}  n=${n}, ~${bodyWords}-word bodies`);

  // librarian baseline (skip the configs we already know OOM)
  if (!(bodyWords > 100 && n >= 50000)) {
    const m0 = mem(); const t0 = performance.now();
    let lib = Librarian.index({ docs, fields: { title: { boost: 4 }, body: { boost: 1 } } });
    const lbuild = performance.now() - t0; const lram = mem() - m0;
    const ts = performance.now(); for (let k = 0; k < 20; k++) Librarian.search(lib, w, { fuzzy: 1, limit: 10 }); const lsearch = (performance.now() - ts) / 20;
    row('librarian', lbuild, lram, `search ${lsearch.toFixed(2)}ms`);
    lib = null;
  } else { console.log('librarian'.padEnd(26) + ' — skipped (OOMs at this size)'); }

  // lean
  { const m0 = mem(); const t0 = performance.now(); const idx = buildLean(docs); const bms = performance.now() - t0; const ram = mem() - m0;
    const ts = performance.now(); for (let k = 0; k < 20; k++) searchLean(idx, w, { fuzzy: 1, limit: 10 }); const s = (performance.now() - ts) / 20;
    const top = searchLean(idx, w, { fuzzy: 1, limit: 3 });
    row('lean (CSR, no text)', bms, ram, `search ${s.toFixed(2)}ms  vocab ${idx.vocab.size}  postings ${idx.postDocs.length}`);
  }
  // blob
  { const m0 = mem(); const t0 = performance.now(); const b = buildBlob(docs); const bms = performance.now() - t0; const ram = mem() - m0;
    const ts = performance.now(); for (let k = 0; k < 20; k++) scanBlob(b, w); const s = (performance.now() - ts) / 20;
    row('blob (exact scan)', bms, ram, `scan ${s.toFixed(2)}ms  chars ${b.blob.length}`);
  }
}

bench(10000, 40, 'EXCERPTS');
bench(50000, 40, 'EXCERPTS');
bench(10000, 600, 'FULL BODIES');
bench(50000, 600, 'FULL BODIES');
