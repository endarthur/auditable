// micro records — record identity + doc-kind dispatch, in ONE module.
//
// A layer's docs carry exactly one doc for its source kind (blockDoc / dhDoc /
// plyDoc / lasDoc / gridDoc / meshDoc / tableDoc / tracesDoc), and everything
// that needs to read records, columns, positions, or headers from "whatever
// this layer is" dispatches on that. Those dispatch ladders used to be inlined
// per consumer across the app — which is how Parquet kept being misread as
// delimited text and how record numbering drifted (see the 2026-08 audit,
// [[reference_micro_source_dispatch]]). This module is where those decisions
// live now; a new source kind is added HERE, once.
import { openLas, decodeLasRecords, openPly, openBlockModel, openDmModel, fetchDmRecord, openDmWireframe, fetchDelimitedRecord, openMsh, openObj, openPlyMesh, lineFields } from '../../../ext/condenser/src/main.js';
import { streamParquetColumns, readParquetRow } from '../../../ext/parquet/index.js';
import { compileValue, deps } from '../../../ext/expr/index.js';
import { readLFM } from '../../../ext/lfm/lfm.js';
import { S, activeDocs } from './state.js';

// ── headers + schema ──────────────────────────────────────────────────────────
export function layerHeaderOf(L) {
  const d = L.docs || {};
  return (d.blockDoc || d.dhDoc || d.tableDoc || d.meshDoc || d.plyDoc || d.lasDoc || {}).header || null;
}
export const layerBlob = (L) => { const d = L.docs.blockDoc || L.docs.tableDoc || L.docs.plyDoc || L.docs.lasDoc || L.docs.meshDoc || L.docs.gridDoc; return d && d.blob || null; };
// the layer's COLUMN TABLE header (the table behind the attribute grid /
// filter / stats), when it has one
export function layerTableHeader(L) {
  const d = L.docs || {};
  if (d.meshDoc) return meshVertexHeader(L);               // the `vertices` location
  const h = (d.blockDoc || d.dhDoc || d.tableDoc || {}).header;
  return h && h.columns ? h : null;
}
export function colIsNumeric(L, h, i) {
  const ov = L.colTypes && L.colTypes[h.columns[i]];
  if (ov) return ov === 'number';
  const m = h.mapping || {};
  if (i === m.x || i === m.y || i === m.z) return true;
  return (h.numericColumns || []).some((c) => c.i === i);
}
export function blockSchema(header) {
  const numeric = new Set((header.numericColumns || []).map((c) => c.i));
  const m = header.mapping;                                // a TABLE has no mapping — its numeric columns are the whole story
  if (m) [m.x, m.y, m.z].forEach((i) => numeric.add(i));
  return header.columns.map((name, i) => ({ name, type: numeric.has(i) ? 'number' : 'string' }));
}
export function schemaExt(L, h) {
  let out = blockSchema(h);
  if (L && L.paintCols && L.paintCols.length) out = out.concat(L.paintCols.map((c) => ({ name: c.name, type: c.kind === 'ratio' ? 'number' : 'string' })));   // stored derived (ratio incl. materialized → number)
  if (L && L.calcCols && L.calcCols.length) out = out.concat(L.calcCols.map((c) => ({ name: c.name, type: c.ty === 'string' ? 'string' : 'number' })));       // computed — LAST, so they can reference everything above
  return out;
}

// ── calc columns (ƒ) — compiled against the FULL census ───────────────────────
export function calcOrder(L) {
  const items = ((L && L.calcCols) || []).map((c, idx) => ({ c, idx }));
  if (items.length < 2) return items;
  const byName = new Map(items.map((it) => [String(it.c.name).toLowerCase(), it]));
  const state = new Map(), out = [];
  const visit = (it) => {
    const k = String(it.c.name).toLowerCase();
    if (state.has(k)) return;                              // done, or in-progress (a cycle) → later refs read blank
    state.set(k, 0);
    let ds = []; try { ds = deps(it.c.expr); } catch { /* bad expr → no deps */ }
    for (const d of ds) { const dep = byName.get(String(d).toLowerCase()); if (dep && state.get(String(d).toLowerCase()) !== 0) visit(dep); }
    state.set(k, 1); out.push(it);
  };
  for (const it of items) visit(it);
  return out;
}
export function calcFns(L) {
  if (!L || !L.calcCols || !L.calcCols.length) return null;
  if (L._calcFns && L._calcFns.n === L.calcCols.length) return L._calcFns;
  const h = layerTableHeader(L); if (!h) return null;
  const schema = schemaExt(L, h);                          // the FULL census — calcs see base + paint + materialized + calcs
  L._calcFns = { n: L.calcCols.length, ordered: calcOrder(L).map((it) => { let fn; try { fn = compileValue(it.c.expr, schema, { decimal: '.' }); } catch { fn = () => null; } return { idx: it.idx, fn }; }) };
  return L._calcFns;
}
// rec (the renderer record index) keys painted-column lookups; callers that
// sweep in renderer numbering pass it, others leave painted values blank
export function extendRow(L, f, rec) {
  const pcs = L && L.paintCols && L.paintCols.length ? L.paintCols : null;
  const cf = calcFns(L);
  if ((!cf && !pcs) || !f) return f;
  const out = f.slice();
  if (pcs) for (const pc of pcs) {                          // STORED derived first — calcs may reference them
    if (pc.mat && pc.fvalues) { const v = rec != null && rec < pc.fvalues.length ? pc.fvalues[rec] : NaN; out.push(Number.isFinite(v) ? v : null); continue; }   // materialized: full precision
    const c = rec != null && rec < pc.codes.length ? pc.codes[rec] : 0;
    out.push(pc.kind === 'ratio' ? +(c / 255).toFixed(3) : ((c && pc.dict[c]) || ''));
  }
  if (cf) {
    const start = out.length;                               // calc census slots (input order), filled in DEPENDENCY order
    for (let i = 0; i < cf.n; i++) out.push(null);
    for (const { idx, fn } of cf.ordered) { let v; try { v = fn(out); } catch { v = null; } out[start + idx] = v === undefined ? null : v; }
  }
  return out;
}

// ── capabilities + record identity ────────────────────────────────────────────
// What a block source CAN DO, asked instead of what it IS. One definition, so a
// new source is right everywhere at once instead of in however many places
// remembered to name it (column-substrate spec §5: capabilities over identity).
//
// `rowIsRecord` is the one that bit us, four times. A DELIMITED source drops rows
// with unparseable coordinates at load and renumbers what survives, so a consumer
// re-reading the source must drop the same rows to stay aligned. `.dm` skips bad
// rows but keeps their TRUE row numbers, and Parquet emits every row — so for both,
// a source row's index IS its record index, and skipping anything shifts the lot.
//
// The format test below is deliberately the LAST one left: it is what providers
// will declare for themselves, and when they do, this function keeps its shape.
export function blockCaps(L) {
  const d = (L && L.docs && L.docs.blockDoc) || null;
  if (!d) return { rowIsRecord: true, stats: false, projection: false, randomAccess: false };
  if (d.caps) return d.caps;                               // declared by its provider
  const dm = !!d.header.dm, pq = !!d.parquet;
  return {
    rowIsRecord: dm || pq,                                 // delimited renumbers; these do not
    nullFill: dm,                                          // .dm returns null for a blank field; CSV returns ''
    stats: pq,                                             // Parquet footer min/max → chunk pruning
    projection: pq || dm,                                  // Parquet columns / .dm strided reads
    randomAccess: true,                                    // all three can fetch one record
  };
}
// one streamed pass of decoded field arrays over the layer's table — the same
// three sources the filter sweeps (dh in-memory, .dm pages, delimited lines)
export async function* layerRows(L, onProgress) {
  const d = L.docs;
  if (d.dhDoc) {
    const dh = d.dhDoc, rows = [];
    for (let i = 0; i < dh.header.count; i++) rows.push(dh.fetchRecord(i));
    yield rows;
  } else if (d.blockDoc && d.blockDoc.header.dm) {
    const { recordBatches } = await openDmModel(d.blockDoc.blob);
    let done = 0;
    for await (const { rows } of recordBatches()) {
      yield rows;
      done += rows.length;
      if (onProgress) onProgress(done, d.blockDoc.header.count);
    }
  } else if (d.blockDoc && d.blockDoc.parquet) {
    const P = d.blockDoc.parquet;
    let done = 0;
    for await (const { count, cols } of streamParquetColumns(P.buf, P.names, P.rowGroups, P.meta)) {
      const rows = [];
      for (let i = 0; i < count; i++) rows.push(P.names.map((n) => { const v = cols[n][i]; return v == null ? '' : v; }));
      yield rows;
      done += count;
      if (onProgress) onProgress(done, d.blockDoc.header.count);
    }
  } else if (d.tableDoc && d.tableDoc.xlsx) {
    let done = 0;
    for await (const batch of d.tableDoc.xlsx.rows({ batch: 4096 })) {
      yield batch;
      done += batch.length;
      if (onProgress) onProgress(done, d.tableDoc.header.count);
    }
  } else if (d.tableDoc) {
    const { blob, header } = d.tableDoc;
    let done = 0;
    for await (const batch of lineFields(blob, header.delim, header.hasHeaderRow)) {
      yield batch;
      done += batch.length;
      if (onProgress) onProgress(done, header.count);
    }
  } else if (d.blockDoc) {
    const { blob, header } = d.blockDoc;
    let done = 0;
    for await (const batch of lineFields(blob, header.delim, header.hasHeaderRow !== undefined ? header.hasHeaderRow : !!header.columns)) {
      yield batch;
      done += batch.length;
      if (onProgress) onProgress(done, header.count);
    }
  }
}
// ONE owner of "what number is this record". Six sweeps used to re-derive this
// rule independently and two of them got it wrong: a DELIMITED source drops rows
// with unparseable coordinates at load, so the renderer never numbered them and a
// consumer must skip the same rows to stay aligned; `.dm` and Parquet number every
// row (blockCaps.rowIsRecord). computeGT and computeSwath incremented
// unconditionally, then used that number to index the selection mask and the
// materialized/painted columns — so on a delimited model with one bad coordinate,
// every later block read another block's selection state and another block's grade.
//
// Yields the row ALREADY extended (calc/paint/materialized appended at their census
// positions) with the record index it belongs to, and applies the `.dm` null-fill
// that only two of thirteen extendRow callers remembered.
export async function* layerRecords(L, onProgress) {
  const h = layerTableHeader(L);
  const m = (h && h.mapping) || {};
  const caps = blockCaps(L);
  const gate = !caps.rowIsRecord && m.x != null && m.y != null && m.z != null;
  const fill = caps.nullFill;
  let rec = 0;
  for await (const batch of layerRows(L, onProgress || null)) {
    for (const f0 of batch) {
      if (gate) {
        const xv = +f0[m.x], yv = +f0[m.y], zv = +f0[m.z];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;   // renderer numbering
      }
      const rAt = rec++;
      yield { f: extendRow(L, fill ? f0.map((v) => (v == null ? '' : v)) : f0, rAt), rec: rAt, raw: f0 };
    }
  }
}
// ONE way to get a cold position stream for a layer's records, whatever the
// source. This dispatch was inlined at each consumer, and Parquet — a blockDoc
// whose `header.dm` is falsy — kept falling into the DELIMITED branch, where the
// CSV reader found no rows and the consumer silently did nothing. Volume
// selection and volume painting were both dead on Parquet models for that reason.
// A doc opened through a provider now carries its own reader and is asked for it;
// the rest re-open cold exactly as before.
export async function docPositionStream(d) {
  if (!d) return null;
  if (d.blockDoc && d.blockDoc.streamChunks) return d.blockDoc.streamChunks;
  if (d.blockDoc && d.blockDoc.header.dm) return (await openDmModel(d.blockDoc.blob)).streamChunks;
  if (d.blockDoc) return (await openBlockModel(d.blockDoc.blob, { mapping: d.blockDoc.header.mapping })).streamChunks;
  if (d.lasDoc) return (await openLas(d.lasDoc.blob)).streamChunks;
  if (d.plyDoc) return (await openPly(d.plyDoc.blob)).streamChunks;
  return null;
}

// ── the mesh VERTEX location's provider ───────────────────────────────────────
// .lfm → the condenser mesh contract. The merged view (all meshes as one)
// serves the unsplit open; the split path writes ONE-MESH .lfm children via
// writeLFM, so every layer stays a real Leapfrog file (round-trippable,
// self-contained for projects, re-parsed by winding).
export async function openLfmMesh(blob) {
  const r = await readLFM(await blob.arrayBuffer());
  let nv = 0, nt = 0;
  for (const m of r.meshes) { nv += m.vCount; nt += m.tCount; }
  const vertices = new Float64Array(nv * 3);
  const triangles = new Uint32Array(nt * 3);
  let vo = 0, to = 0;
  for (const m of r.meshes) {
    vertices.set(m.vertices, vo * 3);
    for (let k = 0; k < m.triangles.length; k++) triangles[to * 3 + k] = m.triangles[k] + vo;
    vo += m.vCount; to += m.tCount;
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return {
    header: { kind: 'mesh', format: 'lfm', vertexCount: nv, triCount: nt, bbox: { min, max } },
    vertices, triangles,
    lfmMeshes: r.meshes.map((m) => ({ name: m.name, colour: m.colour })),
  };
}
// Re-derive a context mesh's { vertices, triangles } from its source(s). A Datamine
// wireframe is a pt/tr PAIR (md.ptBlob + md.blob); everything else is single-file.
export async function reReadMesh(md) {
  if (md.header.format === 'dm-wireframe') return openDmWireframe(md.ptBlob, md.blob);
  const open = /\.msh$/i.test(md.name) ? openMsh : /\.obj$/i.test(md.name) ? openObj : /\.lfm$/i.test(md.name) ? openLfmMesh : openPlyMesh;
  return open(md.blob);
}
// A context mesh keeps no CPU geometry: meshDoc holds a blob and a header, and
// the vertices are re-parsed whenever something needs them. That was fine while
// a mesh was scenery, but the `vertices` location needs its records to be
// readable, so the parse gets one owner and one cache instead of each consumer
// re-reading the file. Solid queries share it, so opening the attribute table
// and running a by-solid query parse once between them.
//
// On demand rather than at load, deliberately: the arrays are the size of the
// mesh, and a scenery mesh nobody interrogates should not pay for them.
export async function meshVertexData(L) {
  const md = L.docs && L.docs.meshDoc;
  if (!md || md.header.soup) return null;                  // streamed tier keeps no CPU records
  // cached on the DOC, not the layer: reinterpreting or reloading a layer swaps
  // its meshDoc, and hanging the arrays off the doc means that swap invalidates
  // them for free rather than relying on someone remembering to clear a field
  if (md._vtxData) return md._vtxData;
  const m = await reReadMesh(md);
  return (md._vtxData = { vertices: m.vertices, triangles: m.triangles, attrs: m.attrs || {} });
}
// The vertex location's column table. Synthesizable the moment the mesh loads —
// the coordinate columns are implied and the file's own per-vertex properties
// are named in the header — so this is sync and the data can arrive later.
export function meshVertexHeader(L) {
  const md = L.docs && L.docs.meshDoc;
  if (!md || md.header.soup) return null;
  if (md._vtxHeader) return md._vtxHeader;
  const extra = md.header.vertexColumns || [];
  const columns = ['X', 'Y', 'Z', ...extra];
  return (md._vtxHeader = {
    kind: 'mesh-vertices',
    count: md.header.vertexCount | 0,
    columns,
    mapping: { x: 0, y: 1, z: 2 },
    numericColumns: columns.map((_, i) => ({ i })),        // coordinates and PLY properties are all numeric
    bbox: md.header.bbox,
  });
}

// ── single-record fetch ───────────────────────────────────────────────────────
export async function fetchCsvRecord(rec, doc = activeDocs().blockDoc) {
  const { blob, header } = doc;
  // sparse line-offset index (built during discovery): jump to the nearest
  // anchor + walk ≤k lines, instead of sweeping the file from byte 0
  if (header.index) return await fetchDelimitedRecord(blob, header, rec);
  const m = header.mapping;
  let n = 0;
  for await (const batch of lineFields(blob, header.delim, header.hasHeaderRow !== undefined ? header.hasHeaderRow : !!header.columns)) {
    for (const f of batch) {
      const xv = +f[m.x], yv = +f[m.y], zv = +f[m.z];
      if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
      if (n === rec) return f;
      n++;
    }
  }
  return null;
}
// the complete doc-kind ladder for "read one record's row" — defer to this
// rather than re-deriving the dispatch (Measure's copy was the one missing
// grids and meshes, so it silently did nothing there)
export async function fetchLayerRow(L, rec) {
  const d = L.docs;
  if (d.meshDoc) {
    const v = await meshVertexData(L);
    if (!v) return [];
    const names = d.meshDoc.header.vertexColumns || [];
    const out = [+v.vertices[rec * 3].toFixed(3), +v.vertices[rec * 3 + 1].toFixed(3), +v.vertices[rec * 3 + 2].toFixed(3)];
    for (const n of names) { const col = v.attrs[n]; out.push(col ? col[rec] : null); }
    return out;
  }
  if (d.gridDoc) {
    const g = d.gridDoc;
    const i = g.dispIdx ? g.dispIdx[rec] : rec;
    const r = (i / g.grid.nx) | 0, c = i % g.grid.nx;
    return [+(g.grid.x0 + c * g.grid.dx).toFixed(3), +(g.grid.y0 - r * g.grid.dy).toFixed(3), +g.grid.data[i].toFixed(3), r, c];
  }
  if (d.tableDoc && d.tableDoc.xlsx) return d.tableDoc.xlsx.at(rec);
  if (d.tableDoc) return await fetchDelimitedRecord(d.tableDoc.blob, d.tableDoc.header, rec);
  if (d.dhDoc) return d.dhDoc.fetchRecord(rec);
  if (d.tracesDoc) return d.tracesDoc.fetchRecord(rec);    // pick a trace → its collar record
  if (d.blockDoc && d.blockDoc.parquet) { const row = await readParquetRow(d.blockDoc.parquet.buf, rec, d.blockDoc.parquet.meta); return row ? d.blockDoc.parquet.names.map((n) => { const v = row[n]; return v == null ? '' : v; }) : null; }
  if (d.blockDoc && d.blockDoc.header.dm) return await fetchDmRecord(d.blockDoc.blob, d.blockDoc.header.dm, rec);
  if (d.blockDoc) return await fetchCsvRecord(rec, d.blockDoc);
  if (d.plyDoc) return await d.plyDoc.fetchRecord(rec);
  if (d.lasDoc) {
    const { blob, header } = d.lasDoc;
    const off = header.pointOffset + rec * header.recordLen;
    const dv = new DataView(await blob.slice(off, off + header.recordLen).arrayBuffer());
    const one = decodeLasRecords(dv, header, 1, rec);
    return [+one.x[0].toFixed(3), +one.y[0].toFixed(3), +one.z[0].toFixed(3), one.intensity[0], one.classification[0]];
  }
  return null;
}
export function attrColumnsOf(L) {
  const h = layerTableHeader(L);
  if (h) {
    const cols = h.columns.map((name, i) => ({ name, num: colIsNumeric(L, h, i) }));
    for (const c of L.paintCols || []) cols.push({ name: (c.kind === 'ratio' ? '% ' : '✎ ') + c.name, num: c.kind === 'ratio' });   // census order: stored before calc (matches extendRow)
    for (const c of L.calcCols || []) cols.push({ name: 'ƒ ' + c.name, num: (c.ty || 'number') === 'number' });
    return cols;
  }
  if (L.docs.gridDoc) return [{ name: 'X', num: true }, { name: 'Y', num: true }, { name: 'Z', num: true }, { name: 'row', num: true }, { name: 'col', num: true }];
  if (L.docs.plyDoc) return L.docs.plyDoc.header.columns.map((name) => ({ name, num: true }));
  if (L.docs.lasDoc) return [{ name: 'X', num: true }, { name: 'Y', num: true }, { name: 'Z', num: true }, { name: 'intensity', num: true }, { name: 'classification', num: true }];
  return null;
}

// ── LOCATIONS — where an element's records live ───────────────────────────────
// A layer is an ELEMENT, and its records live in one or more named LOCATIONS: a
// record space at a stated granularity. A column is keyed `(location, name)`, so
// a collar attribute and an interval assay never collide on one element
// (column-substrate spec §3.1). The element MANIFEST has spoken this language
// since it landed — every column it writes carries a `loc` — while the in-memory
// model still assumed one flat record space per layer. These functions are that
// vocabulary, and `primaryLocationOf` is the naming rule the manifest already
// used, lifted out of it so there is one definition rather than two.
//
// Nearly every element has exactly ONE location, which is why the flat
// assumption survived this long: a block model is `cells`, a grid is `nodes`, a
// point cloud is `points`. A surface mesh is the first with genuinely two —
// `vertices` and `faces` — which is what forces the key to become explicit.
export function primaryLocationOf(L) {
  const d = (L && L.docs) || {};
  if (d.meshDoc) return 'vertices';
  if (d.gridDoc) return 'nodes';
  const h = layerHeaderOf(L);
  return (L && L.dh) || (h && h.kind === 'drillholes') ? 'intervals' : 'cells';
}
// The record spaces an element's GEOMETRY defines, whether or not attributes
// hang off them yet. Distinct from attrRowCountOf below, and the distinction is
// the point: a mesh has 4 M triangles as geometry and no attribute rows at all.
export function locationsOf(L) {
  const d = (L && L.docs) || {};
  if (d.meshDoc) {
    const h = d.meshDoc.header || {};
    if (h.soup) return [];                                 // streamed — keeps no CPU records to attach to
    return [{ name: 'vertices', count: h.vertexCount | 0, shape: 'table' },
            { name: 'faces', count: h.triCount | 0, shape: 'table' }];
  }
  const n = attrRowCountOf(L);
  return n ? [{ name: primaryLocationOf(L), count: n, shape: d.gridDoc ? 'array' : 'table' }] : [];
}
// How many ATTRIBUTE ROWS a location has — NOT how many things the renderer drew.
//
// Those two used to be the same expression: the old body fell through to
// `renderer.layerElementCount`, so a mesh (whose header carries vertexCount and
// triCount but no `count`) reported its TRIANGLE count — a plausible number with
// no attribute row behind it. Nothing here guarded that; roughly fifteen call
// sites each separately remembered to write `L.kind !== 'mesh'`, and any that
// forgot got the wrong answer silently. The guard belongs in one place, so it is
// here, and `hasRecords` below is what those call sites should ask.
//
// A mesh's vertices and faces are real record spaces (see locationsOf) but carry
// no attribute table yet — the provider that gives them one is a later step, and
// until it lands zero is the honest answer rather than a stand-in.
export function attrRowCountOf(L, loc) {
  const name = loc || primaryLocationOf(L);
  if (name !== primaryLocationOf(L)) return 0;             // the second location has no columns yet
  // a falsy count must FALL THROUGH, not answer 0: some table headers carry
  // columns without a count and have always leaned on the renderer for it, and
  // answering zero there reads to the whole app as "this layer has no data"
  const th = layerTableHeader(L);
  if (th && th.count) return th.count | 0;
  if (L && L.docs && L.docs.meshDoc) return 0;             // streamed mesh — no CPU records at all
  const h = layerHeaderOf(L);
  return (h && h.count) || S.renderer.layerElementCount(L.id) || 0;
}
// "Does this location have an attribute table behind it?" — the predicate the
// paint / filter / export / join call sites want, in place of hand-rolled
// kind tests.
export function hasRecords(L, loc) { return attrRowCountOf(L, loc) > 0; }
