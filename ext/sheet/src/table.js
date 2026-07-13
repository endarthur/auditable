// @gcu/sheet — the TABLE-DOCUMENT adapter.
//
// `read()` already resolves a worksheet into typed columns (Float64Array for
// numbers and dates, Uint8Array for booleans, string arrays otherwise). This
// exposes that as the same table-document shape the rest of GCU speaks —
// { header: { table, columns, count, numericColumns }, rows, at } — so a
// consumer can hand a worksheet to anything that reads a table WITHOUT a
// round-trip through CSV. Types come from Excel; nothing is re-sniffed.
//
// A workbook is not a coordinate system: nothing here infers geometry. A sheet
// is a table. Promoting one to something spatial is the host's explicit act.
import { read } from './reader.js';

const bytesOf = async (source) => {
  if (source instanceof Uint8Array) return source;
  if (source && typeof source.arrayBuffer === 'function') return new Uint8Array(await source.arrayBuffer());
  return new Uint8Array(source);
};

// A cheap look inside: what sheets are in here, and how big are they? Enough to
// draw a picker without committing to a full parse of every sheet.
export async function census(source, options) {
  const { sheets } = await read(await bytesOf(source), options);
  return {
    sheets: sheets.map((s) => ({
      name: s.name,
      rows: s.rows,
      columns: s.headers.length,
      headers: s.headers,
      empty: !s.rows || !s.headers.length,
    })),
  };
}

// One worksheet → a table document. `sheet` names it; omitted takes the first.
export async function openSheet(source, { sheet = null, headerRow = 1 } = {}) {
  const { sheets } = await read(await bytesOf(source), { sheet: sheet || undefined, headerRow });
  const ws = sheet ? sheets.find((s) => s.name === sheet) : sheets[0];
  if (!ws) throw new Error(`sheet "${sheet}" not found`);
  const columns = ws.headers.map((h, i) => (String(h).trim() || `col${i + 1}`));
  const data = columns.map((name, i) => ws.columns[ws.headers[i]]);
  // a column is numeric because EXCEL says so (Float64Array), not because a
  // string parsed — dates included (they arrive as serial numbers)
  const numericColumns = [];
  columns.forEach((name, i) => { if (data[i] instanceof Float64Array) numericColumns.push({ i, name }); });
  const count = ws.rows || 0;
  const cell = (ci, r) => {
    const col = data[ci];
    if (!col) return '';
    const v = col[r];
    if (v == null) return '';
    if (col instanceof Float64Array) return Number.isNaN(v) ? '' : v;
    if (col instanceof Uint8Array) return v ? 'true' : 'false';
    return v;
  };
  return {
    header: {
      table: true, sheet: ws.name, columns, count,
      numericColumns, mapping: null, grid: null, bbox: null,
    },
    // one row as an array of field values, in column order (the shape every
    // table consumer already reads)
    at: (r) => columns.map((_, ci) => cell(ci, r)),
    // batched iteration, so a host can stream it like any other table
    async *rows({ batch = 4096 } = {}) {
      for (let start = 0; start < count; start += batch) {
        const end = Math.min(count, start + batch);
        const out = [];
        for (let r = start; r < end; r++) out.push(columns.map((_, ci) => cell(ci, r)));
        yield out;
      }
    },
  };
}
