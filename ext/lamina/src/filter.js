// @gcu/lamina — filter: a forward scan that records the matching rows, and a
// RESULT VIEW that reads each matching row directly by byte offset.
//
// Why per-row, not a remap onto the base view: a selective filter scatters its
// matches across the file, so a screenful of results would touch ~one base block
// (4096 rows) PER VISIBLE ROW — blowing the base LRU and thrashing (load→evict→
// reload forever). Recording each match's (offset, length) lets the result view
// read exactly the visible rows — small reads, a generous row LRU, no thrash.
//
// Decagigabyte note: the result is 3 × Float64 per matching row (offset, length,
// original row #), so it tracks SELECTIVITY not file size; capped (then "refine
// the filter") rather than OOM.

import { splitRecordsPos, parseFields, parseNum } from './scan.js';
import { LOADING } from './viewsource.js';

const DEC = new TextDecoder();
const CMP = {
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
};

/**
 * Compile a filter string into a predicate over a parsed field array. Grammar:
 * one or more `col OP value` terms joined by `&&`. OP: == != > >= < <= ~ !~.
 * Numeric compare when the value parses as a number (else string). Throws on a
 * bad term / unknown column.
 * @returns {(fields:string[])=>boolean | null}  null for an empty filter
 */
export function parseFilter(str, columns, decimal = '.') {
  const names = (columns || []).map((c) => (typeof c === 'string' ? c : c.name));
  const lower = names.map((n) => n.toLowerCase());
  const terms = String(str || '').split('&&').map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return null;
  const fns = terms.map((t) => compileTerm(t, names, lower, decimal));
  return (fields) => { for (const f of fns) if (!f(fields)) return false; return true; };
}

function colIndex(name, names, lower) {
  let i = names.indexOf(name);
  if (i < 0) i = lower.indexOf(name.toLowerCase());
  if (i < 0) throw new Error(`unknown column: "${name}"`);
  return i;
}

function unquote(v) {
  v = v.trim();
  return (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) ? v.slice(1, -1) : v;
}

function compileTerm(term, names, lower, decimal) {
  // `col in a, b, c` — set membership (the natural OR for multiple categorical values)
  const im = term.match(/^(.+?)\s+in\s+(.+)$/i);
  if (im) {
    const i = colIndex(im[1].trim(), names, lower);
    const set = new Set(im[2].split(',').map(unquote).filter((s) => s !== ''));
    return (f) => set.has(String(f[i] ?? ''));
  }
  const m = term.match(/^(.+?)\s*(!~|~|>=|<=|==|!=|>|<)\s*(.*)$/);
  if (!m) throw new Error(`bad filter term: "${term}"`);
  const i = colIndex(m[1].trim(), names, lower);
  const op = m[2];
  const val = unquote(m[3]);
  if (op === '~') { const v = val.toLowerCase(); return (f) => String(f[i] ?? '').toLowerCase().includes(v); }
  if (op === '!~') { const v = val.toLowerCase(); return (f) => !String(f[i] ?? '').toLowerCase().includes(v); }
  // The expression's literal stays dot-decimal (Number); the cell value parses
  // by the file's decimal separator (so a comma-decimal file compares correctly).
  const num = Number(val);
  const cmp = CMP[op];
  if (val !== '' && !Number.isNaN(num)) return (f) => { const x = parseNum(f[i], decimal); return !Number.isNaN(x) && cmp(x, num); };
  return (f) => cmp(String(f[i] ?? ''), val);
}

// A growable Float64Array (the result columns: offset / length / row#).
function grower() {
  let buf = new Float64Array(1024), n = 0;
  return {
    push(v) { if (n === buf.length) { const a = new Float64Array(buf.length * 2); a.set(buf); buf = a; } buf[n++] = v; },
    get n() { return n; },
    done() { return buf.slice(0, n); },
  };
}

/**
 * Forward-scan a source applying a predicate; return the matching rows as
 * `{ offsets, lengths, nums }` (Float64Arrays — byte offset, byte length, and
 * original DISPLAY row #). Reads every block once via source.readRange.
 * @param {object} opts  { predicate, dataStart?, onProgress?, max? }
 */
export async function scanFilter(source, { predicate, dataStart = 0, onProgress, max = 16 * 1024 * 1024 } = {}) {
  const K = source.blockSize;
  const nBlocks = source.blockOffsets.length;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  const offsets = grower(), lengths = grower(), nums = grower();
  for (let b = 0; b < nBlocks; b++) {
    const s = source.blockOffsets[b];
    const e = b + 1 < nBlocks ? source.blockOffsets[b + 1] : source.totalBytes;
    const bytes = await source.readRange(s, e - s);
    const pos = splitRecordsPos(bytes, { kind: source.kind, quote: qByte });
    for (let i = 0; i < pos.length; i++) {
      const srcRow = b * K + i;
      if (srcRow >= source.rowCount) break;
      const disp = srcRow - dataStart;
      if (disp < 0) continue;                               // header / preamble
      const rec = bytes.subarray(pos[i].start, pos[i].end);
      const fields = delimited ? parseFields(rec, { delimiter: source.delimiter, quote: source.quote }) : [DEC.decode(rec)];
      if (predicate(fields)) {
        offsets.push(s + pos[i].start); lengths.push(pos[i].end - pos[i].start); nums.push(disp);
        if (offsets.n > max) throw new Error('too many matches — refine the filter');
      }
    }
    if (onProgress) onProgress(b + 1, nBlocks);
  }
  return { offsets: offsets.done(), lengths: lengths.done(), nums: nums.done() };
}

/**
 * A view over a RESULT SET (filter or sort): `{ offsets, lengths, nums }` rows
 * read directly from the source by byte offset, with a generous row LRU — so a
 * scattered result scrolls without touching the base blocks (no thrash). Same
 * provider contract as the windowed view.
 * @param {object} source  block index + readRange (source.js)
 * @param {object} result  { offsets, lengths, nums } (Float64Arrays)
 * @param {Array} schema   column descriptors (for header / colType)
 * @param {object} opts     { cacheRows? }
 */
export function createResultView(source, result, schema, { cacheRows = 1024 } = {}) {
  const { offsets, lengths, nums } = result;
  const cache = new Map();          // r → fields[]  (insertion-order LRU)
  const inflight = new Map();
  const readyCbs = [];
  const cols = schema ? schema.length : 1;
  const delimited = source.kind === 'delimited';
  const notify = () => { for (const cb of readyCbs) { try { cb(); } catch (e) { console.error('[lamina] onReady threw', e); } } };

  function loadRow(r) {
    if (cache.has(r)) return Promise.resolve();
    if (inflight.has(r)) return inflight.get(r);
    const p = Promise.resolve(source.readRange(offsets[r], lengths[r])).then((bytes) => {
      cache.set(r, delimited ? parseFields(bytes, { delimiter: source.delimiter, quote: source.quote }) : [DEC.decode(bytes)]);
      while (cache.size > cacheRows) cache.delete(cache.keys().next().value);
      inflight.delete(r); notify();
    }, (err) => { inflight.delete(r); console.error('[lamina] loadRow failed', err); });
    inflight.set(r, p);
    return p;
  }

  return {
    kind: source.kind,
    cols,
    schema,
    rowCount() { return offsets.length; },
    rowAt(r) {
      if (r < 0 || r >= offsets.length) return null;
      if (cache.has(r)) { const v = cache.get(r); cache.delete(r); cache.set(r, v); return v; }   // LRU touch
      loadRow(r);
      return LOADING;
    },
    async ensureRow(r) { if (r < 0 || r >= offsets.length) return null; await loadRow(r); return this.rowAt(r); },
    rowHeaderAt(r) { return (r < 0 || r >= nums.length) ? r + 1 : nums[r] + 1; },   // original (1-based) row
    header(c) { return { label: schema && schema[c] ? schema[c].name : `col ${c + 1}`, type: this.colType(c) }; },
    colType(c) { return (schema && schema[c] && schema[c].type) || 'string'; },
    onReady(cb) { readyCbs.push(cb); return () => { const i = readyCbs.indexOf(cb); if (i >= 0) readyCbs.splice(i, 1); }; },
  };
}
