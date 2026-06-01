// The scan path — instant first-keystroke + cold/deep substring fallback.
//
// Orthogonal to the inverted index (no postings, no scoring model): a single
// contiguous lowercased blob of every doc's searchable text plus an offset
// table, scanned with exact `indexOf` (vectorised in V8 — sub-millisecond at
// any size) or bitap (shift-or / Wu-Manber) for typo-tolerant fuzzy substring.
// Near-zero memory beyond the text itself; ~17 MB for 50k excerpts.
//
// Unlike `search()`, the query is treated as ONE substring needle, not
// tokenised — that's what makes it the "as you type" layer (partial words,
// punctuation, mid-token matches all just work).
//
//   buildBlob(docs, opts?) -> { blob, starts, ids, N }
//     docs        [{ id, ...fields }]
//     opts.fields  field names to include (default: every non-id key whose
//                  value is a string or number)
//     blob         all docs' lowercased text, joined by '\n'
//     starts       Int32Array[N+1], char offset of each doc (starts[N] sentinel)
//     ids          ordinal -> external id
//
//   scan(blob, query, { fuzzy?, limit? }) -> [{ id, score, pos }]
//     fuzzy 0  exact substring (indexOf)
//     fuzzy k  bitap, up to k edits, patterns <= 31 chars (longer -> exact)
//     score    occurrence count in the doc; pos = first hit offset within the doc

const MAX_HITS = 5000;        // safety bound on total occurrences scanned
const BITAP_MAX_LEN = 31;     // pattern must fit one 32-bit word (sign bit spare)

function _fieldText(doc, fields) {
  const parts = [];
  for (const fn of fields) {
    const v = doc[fn];
    if (v != null && (typeof v === 'string' || typeof v === 'number')) parts.push(String(v));
  }
  return parts.join(' ');
}

export function buildBlob(docs, opts = {}) {
  const list = docs || [];
  const N = list.length;
  // Determine the fields to fold into the blob.
  let fields = opts.fields;
  if (!fields || fields.length === 0) {
    const seen = new Set();
    for (const d of list) {
      for (const k of Object.keys(d || {})) {
        if (k === 'id') continue;
        const v = d[k];
        if (typeof v === 'string' || typeof v === 'number') seen.add(k);
      }
    }
    fields = [...seen];
  }
  const parts = new Array(N);
  const ids = new Array(N);
  const starts = new Int32Array(N + 1);
  let pos = 0;
  for (let d = 0; d < N; d++) {
    const text = _fieldText(list[d] || {}, fields).toLowerCase();
    parts[d] = text;
    ids[d] = (list[d] || {}).id;
    starts[d] = pos;
    pos += text.length + 1;   // +1 for the '\n' separator
  }
  starts[N] = pos;            // sentinel just past the end
  return { blob: parts.join('\n'), starts, ids, N };
}

// Largest doc ordinal d with starts[d] <= pos. starts[N] is a sentinel > any
// valid pos, so the result is always in [0, N).
function _docAt(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function _scanExact(b, needle) {
  const byDoc = new Map();   // doc ordinal -> { count, pos }
  let i = b.blob.indexOf(needle);
  let n = 0;
  while (i !== -1 && n < MAX_HITS) {
    const d = _docAt(b.starts, i);
    let e = byDoc.get(d);
    if (!e) { e = { count: 0, pos: i - b.starts[d] }; byDoc.set(d, e); }
    e.count++;
    i = b.blob.indexOf(needle, i + needle.length);
    n++;
  }
  return byDoc;
}

// Bitap (Wu-Manber approximate matching) — collects every match END index in
// `text` within <= k edits (insertion, deletion, substitution). 0 = match
// convention, OR-mask-then-shift, full match shows as bit m cleared. Patterns
// must be <= 31 chars (one 32-bit word). Two swapped row buffers, no per-char
// allocation. Per text char c with mask M (bit i = 0 where pattern[i] === c):
//   nR[0] = (R[0] | M) << 1
//   nR[d] = ((R[d] | M) << 1)   // match
//         & (R[d-1]     << 1)   // substitution
//         & (nR[d-1]    << 1)   // deletion (skip a pattern char)
//         &  R[d-1]             // insertion (skip a text char)
function _bitapEnds(text, pattern, k) {
  const m = pattern.length;
  const ends = [];
  if (m === 0 || m > BITAP_MAX_LEN) return ends;
  const mask = new Map();
  for (let i = 0; i < m; i++) {
    const c = pattern.charCodeAt(i);
    mask.set(c, (mask.has(c) ? mask.get(c) : ~0) & ~(1 << i));
  }
  let R = new Array(k + 1).fill(~1);
  let nR = new Array(k + 1);
  const matchBit = 1 << m;
  const len = text.length;
  for (let i = 0; i < len && ends.length < MAX_HITS; i++) {
    const cm = mask.has(text.charCodeAt(i)) ? mask.get(text.charCodeAt(i)) : ~0;
    nR[0] = (R[0] | cm) << 1;
    for (let d = 1; d <= k; d++) {
      nR[d] = ((R[d] | cm) << 1) & (R[d - 1] << 1) & (nR[d - 1] << 1) & R[d - 1];
    }
    if ((nR[k] & matchBit) === 0) ends.push(i);
    const swap = R; R = nR; nR = swap;
  }
  return ends;
}

function _scanFuzzy(b, needle, k, m) {
  const ends = _bitapEnds(b.blob, needle, k);
  const byDoc = new Map();
  let lastDoc = -1, lastEnd = -Infinity;
  for (const i of ends) {
    const d = _docAt(b.starts, i);
    // Collapse a run of adjacent end positions (one fuzzy match fires at
    // several consecutive ends) into a single hit per doc.
    if (d === lastDoc && i - lastEnd < m) { lastEnd = i; continue; }
    let e = byDoc.get(d);
    const startPos = Math.max(0, i - m + 1) - b.starts[d];
    if (!e) { e = { count: 0, pos: Math.max(0, startPos) }; byDoc.set(d, e); }
    e.count++;
    lastDoc = d; lastEnd = i;
  }
  return byDoc;
}

export function scan(b, query, opts = {}) {
  const fuzzy = opts.fuzzy != null ? opts.fuzzy : 0;
  const limit = opts.limit != null ? opts.limit : 50;
  const needle = String(query || '').toLowerCase().trim();
  if (!needle || !b || !b.blob) return [];

  const byDoc = (fuzzy > 0 && needle.length <= BITAP_MAX_LEN)
    ? _scanFuzzy(b, needle, fuzzy, needle.length)
    : _scanExact(b, needle);

  const out = [];
  for (const [d, e] of byDoc) out.push({ id: b.ids[d], score: e.count, pos: e.pos });
  // Rank by occurrence count, then earliest position.
  out.sort((a, c) => (c.score - a.score) || (a.pos - c.pos));
  return out.slice(0, limit);
}
