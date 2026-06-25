// @gcu/lamina — viewsource: the read-only windowed data layer over a source.
//
// `rowAt(r)` is SYNC: the parsed fields if the row's block is cached, the LOADING
// sentinel if a `readRange` was kicked (the loom provider maps it → loom's
// PENDING and repaints on `onReady`), or null if out of range. Blocks are
// fetched + decoded + split on demand and held in a small LRU — only a few
// screenfuls are ever resident, never the file. This is the read-only
// indexed-original ViewSource (strata-windowing §3b); windowed strata reuses it.

import { splitRecords, parseFields } from './scan.js';

export const LOADING = Symbol('lamina.loading');   // a row whose block isn't loaded yet

/**
 * @param {object} source  see source.js (block index + readRange)
 * @param {object} opts  { schema?: [{name,type}], cacheBlocks?: number }
 */
export function createRecordViewSource(source, { schema = null, cacheBlocks = 16, dataStart = 0 } = {}) {
  // dataStart = source records to skip (e.g. a header row). Display row r → source
  // record r + dataStart; the schema (from detect) supplies the header, not a row.
  const K = source.blockSize;
  const qByte = (source.quote || '"').charCodeAt(0);
  const cache = new Map();        // blockIndex → fields[][]  (Map = insertion-order LRU)
  const inflight = new Map();     // blockIndex → Promise
  const readyCbs = [];
  const cols = schema ? schema.length : 1;

  const notify = () => { for (const cb of readyCbs) { try { cb(); } catch (e) { console.error('[lamina] onReady threw', e); } } };

  function parseBlock(bytes) {
    const recs = splitRecords(bytes, { kind: source.kind, quote: qByte });
    return source.kind === 'delimited'
      ? recs.map((rb) => parseFields(rb, { delimiter: source.delimiter, quote: source.quote }))
      : recs.map((rb) => [new TextDecoder().decode(rb)]);
  }

  function loadBlock(b) {
    if (cache.has(b)) return Promise.resolve();
    if (inflight.has(b)) return inflight.get(b);
    const s = source.blockOffsets[b];
    const e = b + 1 < source.blockOffsets.length ? source.blockOffsets[b + 1] : source.totalBytes;
    const p = Promise.resolve(source.readRange(s, e - s)).then((bytes) => {
      cache.set(b, parseBlock(bytes));
      while (cache.size > cacheBlocks) cache.delete(cache.keys().next().value);  // evict oldest
      inflight.delete(b);
      notify();
    }, (err) => { inflight.delete(b); console.error('[lamina] loadBlock failed', err); });
    inflight.set(b, p);
    return p;
  }

  return {
    kind: source.kind,
    cols,
    schema,
    rowCount() { return Math.max(0, source.rowCount - dataStart); },

    // Sync: fields[] (cached) | LOADING (load kicked) | null (out of range).
    rowAt(r) {
      const u = r + dataStart;                               // display row → source record
      if (r < 0 || u >= source.rowCount) return null;
      const b = Math.floor(u / K);
      if (cache.has(b)) {
        const rows = cache.get(b);
        cache.delete(b); cache.set(b, rows);                 // LRU touch
        return rows[u - b * K] || null;
      }
      loadBlock(b);
      return LOADING;
    },

    // Await a row's block (prefetch / tests).
    async ensureRow(r) { const u = r + dataStart; if (r >= 0 && u < source.rowCount) await loadBlock(Math.floor(u / K)); return this.rowAt(r); },

    header(c) { return { label: schema && schema[c] ? schema[c].name : `col ${c + 1}`, type: this.colType(c) }; },
    colType(c) { return (schema && schema[c] && schema[c].type) || 'string'; },

    onReady(cb) { readyCbs.push(cb); return () => { const i = readyCbs.indexOf(cb); if (i >= 0) readyCbs.splice(i, 1); }; },
  };
}
