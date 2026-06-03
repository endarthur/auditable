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

import { createTable } from './table.js';

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
export async function writeStrata(table, opts = {}) {
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
export function readStrata(bytes, opts = {}) {
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
