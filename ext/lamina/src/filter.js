// @gcu/lamina — filter: a forward scan that builds a list of matching rows, and a
// thin view that REMAPS display rows onto the base view through that list. The
// filtered view reuses ALL of the base ViewSource's windowing / block-cache / tape
// machinery — it's just an index permutation, so it works identically over a
// memory, file, or compressed-tape source.
//
// Decagigabyte note: the match list is one entry per MATCHING row (a Float64 row
// ordinal), so its size tracks selectivity, not file size — a selective filter
// (the normal case: "find the high grades") stays tiny. A pathological filter that
// keeps most of a 500M-row file is capped (refine the filter) rather than OOM.

import { splitRecords, parseFields } from './scan.js';

const DEC = new TextDecoder();
const CMP = {
  '==': (a, b) => a === b, '!=': (a, b) => a !== b,
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
};

/**
 * Compile a filter string into a predicate over a parsed field array. Grammar:
 * one or more `col OP value` terms joined by `&&` (all must hold). OP is one of
 * == != > >= < <= ~ (contains) !~ (not contains). Numeric compare when the value
 * parses as a number (else string). Throws on a bad term / unknown column.
 * @param {string} str
 * @param {Array<{name:string}|string>} columns
 * @returns {(fields:string[])=>boolean | null}  null for an empty filter
 */
export function parseFilter(str, columns) {
  const names = (columns || []).map((c) => (typeof c === 'string' ? c : c.name));
  const lower = names.map((n) => n.toLowerCase());
  const terms = String(str || '').split('&&').map((s) => s.trim()).filter(Boolean);
  if (!terms.length) return null;
  const fns = terms.map((t) => compileTerm(t, names, lower));
  return (fields) => { for (const f of fns) if (!f(fields)) return false; return true; };
}

function colIndex(name, names, lower) {
  let i = names.indexOf(name);
  if (i < 0) i = lower.indexOf(name.toLowerCase());
  if (i < 0) throw new Error(`unknown column: "${name}"`);
  return i;
}

function compileTerm(term, names, lower) {
  const m = term.match(/^(.+?)\s*(!~|~|>=|<=|==|!=|>|<)\s*(.*)$/);
  if (!m) throw new Error(`bad filter term: "${term}"`);
  const i = colIndex(m[1].trim(), names, lower);
  const op = m[2];
  let val = m[3].trim();
  if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
  if (op === '~') { const v = val.toLowerCase(); return (f) => String(f[i] ?? '').toLowerCase().includes(v); }
  if (op === '!~') { const v = val.toLowerCase(); return (f) => !String(f[i] ?? '').toLowerCase().includes(v); }
  const num = Number(val);
  const cmp = CMP[op];
  if (val !== '' && !Number.isNaN(num)) {                  // numeric comparison
    return (f) => { const x = Number(f[i]); return !Number.isNaN(x) && cmp(x, num); };
  }
  return (f) => cmp(String(f[i] ?? ''), val);              // string comparison
}

/**
 * Forward-scan a source applying a predicate, returning the matching DISPLAY rows
 * (base display row = source record − dataStart; the header is skipped). Reads
 * every block once via source.readRange — works over any backing (the tape too,
 * at one full inflate). Capped at `max` matches (then throws — refine the filter).
 * @param {object} source  block index + readRange (source.js)
 * @param {object} opts  { predicate, dataStart?, onProgress?(block,total), max? }
 * @returns {Promise<Float64Array>}  matching base display-row indices, ascending
 */
export async function scanFilter(source, { predicate, dataStart = 0, onProgress, max = 16 * 1024 * 1024 } = {}) {
  const K = source.blockSize;
  const nBlocks = source.blockOffsets.length;
  const qByte = (source.quote || '"').charCodeAt(0);
  const delimited = source.kind === 'delimited';
  let buf = new Float64Array(1024), n = 0;
  const push = (v) => {
    if (n === buf.length) { const a = new Float64Array(buf.length * 2); a.set(buf); buf = a; }
    buf[n++] = v;
    if (n > max) throw new Error('too many matches — refine the filter');
  };
  for (let b = 0; b < nBlocks; b++) {
    const s = source.blockOffsets[b];
    const e = b + 1 < nBlocks ? source.blockOffsets[b + 1] : source.totalBytes;
    const recs = splitRecords(await source.readRange(s, e - s), { kind: source.kind, quote: qByte });
    for (let i = 0; i < recs.length; i++) {
      const srcRow = b * K + i;
      if (srcRow >= source.rowCount) break;
      const disp = srcRow - dataStart;
      if (disp < 0) continue;                               // header row
      const fields = delimited ? parseFields(recs[i], { delimiter: source.delimiter, quote: source.quote }) : [DEC.decode(recs[i])];
      if (predicate(fields)) push(disp);
    }
    if (onProgress) onProgress(b + 1, nBlocks);
  }
  return buf.slice(0, n);                                    // exact-length copy (free the slack)
}

/**
 * A view that shows only the rows in `matches` (base display-row indices), reading
 * each through the base ViewSource — so windowing / caching / PENDING all come for
 * free. rowHeaderAt reports the ORIGINAL row number.
 * @param {object} base  a RecordViewSource (viewsource.js)
 * @param {Float64Array} matches
 */
export function createFilteredViewSource(base, matches) {
  return {
    kind: base.kind,
    cols: base.cols,
    schema: base.schema,
    rowCount() { return matches.length; },
    rowAt(r) { return (r < 0 || r >= matches.length) ? null : base.rowAt(matches[r]); },
    async ensureRow(r) { return (r < 0 || r >= matches.length) ? null : base.ensureRow(matches[r]); },
    rowHeaderAt(r) { return (r < 0 || r >= matches.length) ? r + 1 : matches[r] + 1; },  // original (1-based) row
    header(c) { return base.header(c); },
    colType(c) { return base.colType(c); },
    onReady(cb) { return base.onReady(cb); },
  };
}
