// @gcu/strata — auditable column-oriented table working model (base+overlay)
// Auto-generated from ext/strata/src/ — do not edit directly

// -- values.js --

// @gcu/strata — values: type coercion, the null vocabulary, display formatting.
//
// Shared by ingest (parsing source rows) and the provider (parsing edits) so a
// hand-typed value and an imported one travel the same path. Pure, zero-dep.

// Column types strata carries (a subset of @gcu/loom's CellType, by value — the
// provider hands these strings straight to loom). 'category' = a low-cardinality
// string (lithology, domain); 'string' = free text; 'number' = f64.
const COL_TYPES = ['number', 'category', 'string'];

// The mining/geoscience null vocabulary — a light mirror of recon's
// NULL_SENTINELS (the full set lives there; this covers the common tokens so
// strata's built-in sniffer path handles them without a recon dependency).
const NULL_TOKENS = new Set([
  '', 'na', 'n/a', 'nan', 'null', 'none', '-', '--',
  '-9999', '-99', '-1e32', '-1e+32', '1e32',
]);

// Coerce a raw string (from CSV or an edit) to a typed value, or null.
function coerceValue(raw, type) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || NULL_TOKENS.has(s.toLowerCase())) return null;
  if (type === 'number') {
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  return s;
}

// Faithful display text for a typed value. Numbers print at full precision
// (a data table shows the real datum — column-level precision formatting is a
// later, additive nicety); null → empty.
function fmtCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v);
}

// -- table.js --

// @gcu/strata — table: the in-memory working model (strata-spec §2 role 1, §4
// layers 1-2). An immutable typed-columnar BASE + a sparse value-patch OVERLAY;
// every read is base⊕overlay. This is the spine that makes strata auditable and
// non-destructive by construction: the source is never mutated, edits are an op
// log (= undo stack = dirty delta = the eventual overlay.json), and a cell's
// provenance (raw vs edited, and its original base value) is always recoverable.
//
// v1 scope: base + value patches only. Deferred (the other §4 layers): derived
// columns (the DAG), structural ops (tombstones/inserts/reorder), the view
// pipeline. Row identity = implicit ordinal (§4.1) — free because the base never
// moves. Base columns are plain arrays for v1 (null-clean); typed-array packing
// is a windowing-era optimization.
//
// Pure, zero-dep (beyond ./values).


/**
 * @param {object} spec
 * @param {Array<{name,type,unit?,role?,analyte?}>} spec.schema  column descriptors
 * @param {Array<Array>} spec.columns   per-column base arrays (length nrows)
 * @param {number} spec.nrows
 */
function createTable({ schema, columns, nrows }) {
  const overlay = new Map();             // 'r:c' → { value, base }
  const key = (r, c) => r + ':' + c;

  const t = {
    schema,
    nrows,
    cols: schema.length,
    _base: columns,
    _overlay: overlay,

    // Base value at (r,c) — the immutable source, ignoring any patch.
    baseValue(r, c) { return columns[c][r]; },

    isEdited(r, c) { return overlay.has(key(r, c)); },

    // Merged read: { value, edited, base }. `base` is the original datum so the
    // UI can show "was X" provenance on an edited cell.
    getCell(r, c) {
      const k = key(r, c);
      if (overlay.has(k)) { const o = overlay.get(k); return { value: o.value, edited: true, base: o.base }; }
      const v = columns[c][r];
      return { value: v, edited: false, base: v };
    },

    // Write a value patch. Editing a cell back to its base value clears the
    // patch (no phantom dirty marks) — equality is by value (numbers/strings).
    setCell(r, c, value) {
      const k = key(r, c);
      const base = columns[c][r];
      if (value === base || (value == null && base == null)) { overlay.delete(k); return; }
      overlay.set(k, { value, base });
    },

    // Drop a patch, reverting (r,c) to base.
    revert(r, c) { overlay.delete(key(r, c)); },

    // Number of cells currently patched (the dirty count).
    dirtyCount() { return overlay.size; },

    // The effective (base⊕overlay) values of column c, as a fresh array. The
    // bridge to the rest of the workspace: a notebook reads this as an array, a
    // chart plots it, export writes it.
    column(c) {
      const out = columns[c].slice();
      for (const [k, o] of overlay) {
        const i = k.indexOf(':');
        if (Number(k.slice(i + 1)) === c) out[Number(k.slice(0, i))] = o.value;
      }
      return out;
    },

    columnByName(name) {
      const i = schema.findIndex((s) => s.name === name);
      return i < 0 ? null : this.column(i);
    },

    // Display text for (r,c) — faithful formatting of the merged value.
    displayAt(r, c) { return fmtCell(this.getCell(r, c).value); },

    // Coerce + commit a raw edited string to (r,c), per the column's type.
    commitRaw(r, c, raw) { this.setCell(r, c, coerceValue(raw, schema[c].type)); },
  };
  return t;
}

// -- ingest.js --

// @gcu/strata — ingest: source adapters into the working model (strata-spec §6).
//
// v1: CSV/TSV → a typed StrataTable. Schema detection is recon-injectable: pass
// @gcu/recon's `sniff` for the rich path (roles, units, analytes — so an
// `Au_gpt` column arrives typed number with unit g/t and analyte Au), or omit it
// and strata uses a minimal built-in sniffer (delimiter + numeric/string only),
// so it ingests CSV standalone without a recon dependency. recon is *injected*,
// not imported — keeps strata zero-dep and lets a Works surface pass
// `(await load('@gcu/recon')).sniff`.
//
// Pure, zero-dep (beyond ./values, ./table).



// recon type → strata type. Generous matching (recon may say numeric/integer/
// float/categorical/text); unknown → string.
function mapReconType(t) {
  if (!t) return 'string';
  if (/num|int|float|real|double/i.test(t)) return 'number';
  if (/cat/i.test(t)) return 'category';
  return 'string';
}

// Normalize to \n, split, drop trailing blank lines.
function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

// Pick the delimiter by counting candidates in the header line.
function detectDelimiter(headerLine) {
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestN = -1;
  for (const d of cands) {
    const n = headerLine.split(d).length - 1;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

// Minimal schema sniffer (the recon-less fallback): delimiter + per-column
// number-vs-string inference over a sample.
function builtinSniff(lines) {
  const delimiter = detectDelimiter(lines[0] || '');
  const header = (lines[0] || '').split(delimiter);
  const sample = lines.slice(1, 51);
  const columns = header.map((name, c) => {
    let numeric = true, saw = false;
    for (const ln of sample) {
      const v = ln.split(delimiter)[c];
      if (v == null || v.trim() === '') continue;
      saw = true;
      if (Number.isNaN(Number(v.trim()))) { numeric = false; break; }
    }
    return { name: name.trim(), type: saw && numeric ? 'number' : 'string' };
  });
  return { delimiter, columns };
}

/**
 * Parse CSV/TSV text into a StrataTable.
 * @param {string} text
 * @param {object} [opts]
 * @param {function} [opts.sniff]  @gcu/recon sniff(lines) → manifest. If given,
 *   used for delimiter + rich schema; else the built-in sniffer is used.
 * @param {number} [opts.sampleSize=200]  lines fed to the sniffer.
 */
function tableFromCsv(text, opts = {}) {
  const lines = splitLines(text);
  if (lines.length === 0) return createTable({ schema: [], columns: [], nrows: 0 });

  let delimiter, schema;
  if (typeof opts.sniff === 'function') {
    const sample = lines.slice(0, (opts.sampleSize || 200) + 1);
    const m = opts.sniff(sample);
    delimiter = m.delimiter || detectDelimiter(lines[0]);
    schema = m.columns.map((col) => ({
      name: col.name,
      type: mapReconType(col.type),
      ...(col.unit ? { unit: col.unit } : {}),
      ...(col.role ? { role: col.role } : {}),
      ...(col.analyte ? { analyte: col.analyte } : {}),
    }));
  } else {
    const s = builtinSniff(lines);
    delimiter = s.delimiter;
    schema = s.columns.map((col) => ({ name: col.name, type: col.type }));
  }

  const ncols = schema.length;
  const columns = Array.from({ length: ncols }, () => []);
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter);
    for (let c = 0; c < ncols; c++) columns[c].push(coerceValue(cells[c], schema[c].type));
  }
  return createTable({ schema, columns, nrows: lines.length - 1 });
}

// -- document.js --

// @gcu/strata — document: the native `.strata` file (strata-spec §3).
//
// A `.strata` is a DOCUMENT, not a data format: a zip (sibling of .gcudat/
// .gcupkg, via @gcu/archive) holding the data PLUS its schema, units, the
// overlay, and provenance — things Arrow/CSV have nowhere to put. v1 is role-2
// (small/medium, rewrite-whole — no chunking), so the base is materialized and
// self-contained.
//
//   table.strata (zip)
//     document.json    { strata, name, created, rowCount, colCount, columns[], view? }
//     schema.json      { fields: [{ name, type, unit?, role?, analyte? }] }  ← Frictionless-shaped
//     columns.json     { <name>: [base values…] }          ← the immutable base
//     overlay.json     { "r:c": { value, base }, … }        ← the value-patch stack (§4)
//     provenance.json  { created, source?, edits }          ← v1: minimal
//
// GROWABLE BY DESIGN: each column carries an `encoding` in document.json's
// `columns[]` manifest. v1 writes/reads only `'json'`, but the read path
// dispatches on it, so a v2 `'f64'` typed-.bin column (the windowing-era packing)
// drops in alongside JSON columns and they round-trip together. The format
// version (`strata: N`) gates breaking changes.
//
// @gcu/archive is INJECTED (createWriter for write, readZip for read), not
// imported — strata stays zero-dep; a surface passes `await load('@gcu/archive')`.


const STRATA_VERSION = 1;

function jsonBytes(obj) { return new TextEncoder().encode(JSON.stringify(obj)); }

/**
 * Serialize a StrataTable to `.strata` zip bytes.
 * @param {object} table
 * @param {object} opts
 * @param {function} opts.createWriter  @gcu/archive createWriter (required)
 * @param {string}   [opts.name]        document name
 * @param {string}   [opts.created]     ISO timestamp (defaults to now)
 * @param {string}   [opts.source]      provenance: where the data came from
 * @param {object}   [opts.view]        view config (sort/filter) — reserved
 * @returns {Promise<Uint8Array>}
 */
async function writeStrata(table, opts = {}) {
  const { createWriter } = opts;
  if (typeof createWriter !== 'function') {
    throw new Error('writeStrata: opts.createWriter (@gcu/archive) is required');
  }
  const created = opts.created || new Date().toISOString();

  const columnsManifest = table.schema.map((s) => ({ name: s.name, encoding: 'json' }));
  const document = {
    strata: STRATA_VERSION,
    name: opts.name || 'untitled',
    created,
    rowCount: table.nrows,
    colCount: table.cols,
    columns: columnsManifest,
  };
  if (opts.view) document.view = opts.view;

  // BASE only (not the merged column) — the overlay is stored separately so
  // base⊕overlay reconstitutes losslessly on load.
  const columns = {};
  for (let c = 0; c < table.cols; c++) columns[table.schema[c].name] = table._base[c];

  const overlay = {};
  for (const [k, o] of table._overlay) overlay[k] = { value: o.value, base: o.base };

  const provenance = {
    created,
    ...(opts.source ? { source: opts.source } : {}),
    edits: Object.keys(overlay).length,
  };

  const w = createWriter('memory', { format: 'zip' });
  await w.addFile('document.json', jsonBytes(document));
  await w.addFile('schema.json', jsonBytes({ fields: table.schema }));
  await w.addFile('columns.json', jsonBytes(columns));
  await w.addFile('overlay.json', jsonBytes(overlay));
  await w.addFile('provenance.json', jsonBytes(provenance));
  return w.close();
}

/**
 * Parse `.strata` zip bytes back into a StrataTable.
 * @param {Uint8Array} bytes
 * @param {object} opts
 * @param {function} opts.readZip  @gcu/archive readZip(bytes, innerPath) (required)
 * @returns {{ table: object, document: object }}
 */
function readStrata(bytes, opts = {}) {
  const { readZip } = opts;
  if (typeof readZip !== 'function') {
    throw new Error('readStrata: opts.readZip (@gcu/archive) is required');
  }
  const dec = new TextDecoder();
  const readJson = (name) => { const b = readZip(bytes, name); return b ? JSON.parse(dec.decode(b)) : null; };

  const document = readJson('document.json');
  if (!document || !document.strata) throw new Error('readStrata: not a .strata document');
  if (document.strata > STRATA_VERSION) {
    throw new Error(`readStrata: document format v${document.strata} is newer than this build (v${STRATA_VERSION})`);
  }

  const schema = (readJson('schema.json') || { fields: [] }).fields;
  const colsRaw = readJson('columns.json') || {};
  const manifest = document.columns || schema.map((s) => ({ name: s.name, encoding: 'json' }));

  const columns = manifest.map((m) => {
    if (!m.encoding || m.encoding === 'json') return colsRaw[m.name] || [];
    // GROWTH SEAM (v2): m.encoding === 'f64' →
    //   new Float64Array(readZip(bytes, `columns/${m.name}.bin`).buffer) → Array
    throw new Error(`readStrata: column encoding '${m.encoding}' not supported in this build`);
  });

  const table = createTable({ schema, columns, nrows: document.rowCount });

  // Reapply the value-patch overlay. setCell recomputes base from the freshly
  // loaded columns (identical to the stored base), so a patch equal to base
  // self-clears — exactly the live-edit semantics.
  const overlay = readJson('overlay.json') || {};
  for (const k of Object.keys(overlay)) {
    const i = k.indexOf(':');
    table.setCell(Number(k.slice(0, i)), Number(k.slice(i + 1)), overlay[k].value);
  }

  return { table, document };
}

// -- provider.js --

// @gcu/strata — provider: adapt a StrataTable to the @gcu/loom cell-provider
// contract. This is the real provider that replaces loom's toy memory-provider:
// the base⊕overlay model rendered as a grid, edits routed back to the overlay.
//
// Deliberately decoupled from loom's *bundle*: it returns plain contract-shaped
// objects whose `state`/`type` strings match loom's CellState/CellType enum
// VALUES (loom compares by value), so strata never imports loom. The two are
// joined only by the contract, not the code.
//
// Pure, zero-dep (beyond ./values).


// MUST match @gcu/loom CellState / CellType enum values.
const STATE_RAW = 'raw';
const STATE_EDITED = 'edited';
const TYPE = { number: 'number', category: 'category', string: 'string' };

/**
 * @param {object} table  a StrataTable (see ./table.js)
 * @returns a loom provider: dims / cellAt / header / rowHeader / commit / onReady
 */
function createTableProvider(table) {
  const readyListeners = [];

  return {
    table,

    dims() { return { rows: table.nrows, cols: table.cols }; },

    cellAt(r, c) {
      if (r < 0 || r >= table.nrows || c < 0 || c >= table.cols) return null;
      const cell = table.getCell(r, c);
      if (cell.value == null && !cell.edited) return null; // empty → blank
      return {
        value: cell.value,
        state: cell.edited ? STATE_EDITED : STATE_RAW,
        type: TYPE[table.schema[c].type] || 'string',
        style: { text: fmtCell(cell.value) },
      };
    },

    header(c) {
      const s = table.schema[c];
      return { label: s.unit ? `${s.name} (${s.unit})` : s.name, type: TYPE[s.type] || 'string' };
    },

    rowHeader(r) { return r + 1; },

    // Edits flow to the overlay. loom calls its own refresh() after commit, so
    // we don't repaint here. Coercion is the column's, owned by strata.
    commit(r, c, raw) {
      table.setCell(r, c, coerceValue(raw, table.schema[c].type));
    },

    // Reserved for async windowing (strata-spec §11 upgrade #1): a streaming
    // base will call these when a window lands so loom repaints. v1 is fully
    // loaded, so it never fires — but the seam exists from day one.
    onReady(cb) {
      readyListeners.push(cb);
      return () => { const i = readyListeners.indexOf(cb); if (i >= 0) readyListeners.splice(i, 1); };
    },
    _notifyReady() { for (const cb of readyListeners) { try { cb(); } catch (e) { console.error('[strata] onReady listener threw', e); } } },
  };
}

export {
  COL_TYPES,
  NULL_TOKENS,
  builtinSniff,
  coerceValue,
  createTable,
  createTableProvider,
  detectDelimiter,
  fmtCell,
  readStrata,
  tableFromCsv,
  writeStrata,
};
