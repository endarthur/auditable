// micro element manifests — the data-model artifact builders (column-substrate
// spec Appendix A, `v: 1`): geometry interpretation + locations + relations +
// ops + columns keyed (location, name). Written beside the source as
// <layer>.element.json; the sidecar writer and (increasingly) the resolver
// consume it. `ops[]` is the AUDIT TRAIL — each op a recorded, re-runnable
// computation stored as DATA (closed vocabulary, never code): a derived column
// realizes by executing its op, a materialized one records how it was baked.
// Boundaries held here: manifest = data model, project.json = view state;
// persistence (persistElement/loadElement) stays app-side — these BUILD and
// HYDRATE, they never touch storage.
import { layerTableHeader, primaryLocationOf, attrRowCountOf, colIsNumeric } from './records.js';
import { matColSourceHash, isStoredCat, PAINT_BLANK } from './columns.js';
import { basename, layerFiles, dhSetName } from './paths.js';

export function elementGeometry(L, h) {
  if (L.dh || h.kind === 'drillholes') return { kind: 'drillhole', crs: null };
  if (h.grid) return { kind: 'block-model', variant: h.subBlocked ? 'sub-blocked' : 'regular', crs: null, origin: null, rotation: null };
  return { kind: 'points', crs: null };
}
// one layer's column set + ops at a location — shared by the single-location
// builder and the multi-location drillhole SET builder (idp namespaces op ids)
export function layerColumnsOps(L, h, loc, idp) {
  const m = h.mapping || {};
  const src = basename(L.name);
  const ops = [], columns = [];
  for (let i = 0; i < h.columns.length; i++) {              // base columns (coords are rows of the source too)
    const col = { loc, name: h.columns[i], type: i === m.cat ? 'category' : (colIsNumeric(L, h, i) ? 'number' : 'string'), from: 'base' };
    if (i === m.cat && h.categories) col.categories = Object.fromEntries(h.categories.map((nm, k) => [String(k + 1), { name: nm }]));
    columns.push(col);
  }
  // ONE pass over paintCols, in CENSUS order. It used to be two — every
  // materialized column, then every category column — which silently reordered
  // them relative to how schemaExt and extendRow read them. Since hydration
  // restores in manifest order, a layer that had (INBOX, DBL) in memory came back
  // as (DBL, INBOX) after a save and reload, and the census shifted underneath
  // every positional consumer. The resolver core promises one order precisely so
  // positions cannot drift; the manifest has to keep that promise too.
  (L.paintCols || []).forEach((c, i) => {
    if (c.mat) {                                            // materialized: mkLineage stamps PROMOTE to ops
      let def;
      if (c.lineage && c.lineage.op) {
        const ln = c.lineage;
        const kind = ln.op === 'interpolate' ? 'estimate' : (ln.op === 'materialize' && ln.params && ln.params.from === 'calc' ? 'calc' : ln.op);
        def = idp + 'm' + (i + 1);
        ops.push({ id: def, op: kind, params: kind === 'calc' ? { expr: ln.params.expr } : (ln.params || {}), outputs: [c.name], at: ln.at, build: ln.build, sources: ln.sources && ln.sources.length ? ln.sources : undefined,
          ...(kind === 'broadcast' && ln.params && ln.params.from ? { inputs: [{ loc: ln.params.from, column: ln.params.column }] } : {}),
          ...(ln.params && ln.params.fromElement ? { inputs: [{ element: ln.params.fromElement, loc: 'cells', column: ln.params.column }] } : {}) });   // cross-location/-element inputs are explicit (rule 6)
      }
      columns.push({
        loc, name: c.name, type: 'number', from: 'materialized', ...(def ? { def } : {}),
        file: `${src}.cols/${c.name}.parquet`, storage: 'dense',
        stats: { min: c.min, max: c.max, count: c.count, nonnull: c.nonnull, hasBlank: c.nonnull < c.count },
      });
      return;
    }
    if (!isStoredCat(c)) return;                            // CATEGORY sidecar columns: op-produced (def = the op)
    const ln = c.lineage && c.lineage.op ? c.lineage : null; // AND hand-paint (materialized with no def — there is no op)
    let id;
    if (ln) {
      id = idp + 'p' + (i + 1);
      ops.push({ id, op: ln.op, params: ln.params || {}, outputs: [c.name], at: ln.at, build: ln.build,
        ...(ln.op === 'broadcast' && ln.params && ln.params.from ? { inputs: [{ loc: ln.params.from, column: ln.params.column }] } : {}),
        ...(ln.params && ln.params.fromElement ? { inputs: [{ element: ln.params.fromElement, loc: 'cells', column: ln.params.column }] } : {}) });
    }
    const nonnull = (c.counts || []).reduce((t, x, k) => (k ? t + x : t), 0);
    columns.push({ loc, name: c.name, type: 'category', from: 'materialized', ...(id ? { def: id } : {}),
      file: `${src}.cols/${c.name}.parquet`, storage: 'dense',
      stats: { count: c.codes.length, nonnull, hasBlank: nonnull < c.codes.length },
      ...(c.blankColor && c.blankColor !== PAINT_BLANK ? { blankColor: c.blankColor } : {}),
      categories: Object.fromEntries(c.dict.map((nm, k) => [String(k), { name: nm, color: c.colors[k] }]).filter(([k2, v2]) => k2 !== '0' && v2.name != null)) });
  });
  (L.calcCols || []).forEach((c, i) => {                    // derived ƒ: the op IS the definition (no file)
    const id = idp + 'c' + (i + 1);
    ops.push({ id, op: 'calc', params: { expr: c.expr }, outputs: [c.name] });
    columns.push({ loc, name: c.name, type: c.ty === 'string' ? 'string' : 'number', from: 'derived', def: id });
  });
  return { ops, columns };
}
export function buildElementManifest(L) {
  const h = layerTableHeader(L); if (!h) return null;
  const loc = primaryLocationOf(L);                        // one naming rule, shared with the in-memory model
  const m = h.mapping || {};
  const src = basename(L.name);
  const fmt = /\.parquet$/i.test(src) ? 'parquet' : (h.dm ? 'dm' : 'csv');
  const { ops, columns } = layerColumnsOps(L, h, loc, '');
  const locSpec = {
    storage: 'table', count: attrRowCountOf(L) || 0, chunk: 1 << 18,
    source: { file: src, format: fmt, hash: matColSourceHash(L) },
  };
  if (m.x != null) locSpec.coords = { x: h.columns[m.x], y: h.columns[m.y], z: h.columns[m.z] };
  if (h.grid) locSpec.block = { dx: h.grid.x.pitch, dy: h.grid.y.pitch, dz: h.grid.z.pitch, nx: h.grid.x.count, ny: h.grid.y.count, nz: h.grid.z.count };
  return {
    v: 1, name: src.replace(/\.[^.]+$/, ''),
    geometry: elementGeometry(L, h),
    locations: { [loc]: locSpec },
    relations: [],
    ops, columns,
    ...(L._elementExtra || {}),
  };
}
// ── the DRILLHOLE SET element (spec A.3 — the first MULTI-LOCATION element):
// collars (the collar file — hole-granularity attributes like EOH/COMPANY,
// exactly what a LineSet flattening drops), vertices (producedBy the desurvey
// op — its records don't exist until the op runs), and one interval location
// PER break-set (intervals / intervals_<name>), each with geometryFrom (the
// records are the file's rows; the op computes WHERE they are). Relations bind
// every child location to collars by the hole-id key. The desurvey op's params
// ARE the loader config, so this manifest REPLACES .holes.json as the set
// descriptor (descFromElement maps it back to the loader's shape; legacy
// .holes.json still reads). Cross-location ops (broadcast/aggregate) land on
// these relations next.
export const dhElementName = (L) => dhSetName(L).replace(/\.holes\.json$/, '.element.json');
export async function peekCollarCols(dh) {                 // header + first-row peek: names + rough types (cached)
  if (dh._collarCols) return dh._collarCols;
  try {
    const head = (await dh.blobs.collar.slice(0, 65536).text()).split(/\r?\n/);
    const delim = [',', ';', '\t'].reduce((a, b2) => (head[0].split(b2).length > head[0].split(a).length ? b2 : a), ',');
    const cells2 = (ln) => ln.split(delim).map((x) => x.trim().replace(/^"|"$/g, ''));
    const names = cells2(head[0]).filter(Boolean), row1 = head[1] ? cells2(head[1]) : [];
    dh._collarCols = names.map((nm, i) => ({ name: nm, type: row1[i] !== undefined && row1[i] !== '' && Number.isFinite(+row1[i]) ? 'number' : 'string' }));
  } catch { dh._collarCols = []; }
  return dh._collarCols;
}
export async function buildDhSetManifest(members) {
  const rep = members[0], dh = rep.docs.dhDoc, h = dh.header, files = layerFiles(rep);
  const collarName = basename(files[0].name), surveyName = basename(files[1].name);
  await peekCollarCols(dh);
  const ops = [{ id: 'ds1', op: 'desurvey', inputs: [{ loc: 'collars' }, { file: surveyName, format: 'csv' }], params: { ...dh.config }, outputs: [] }];
  const locations = {
    collars: { storage: 'table', count: h.holes || 0, chunk: 1 << 18, source: { file: collarName, format: 'csv', hash: `${(files[0].blob && files[0].blob.size) || 0}:${h.holes || 0}` } },
    vertices: { storage: 'table', count: null, producedBy: 'ds1' },
  };
  const relations = [{ child: 'vertices', parent: 'collars', by: 'key', key: null }];
  const columns = dh._collarCols.map((c) => ({ loc: 'collars', name: c.name, type: c.type, from: 'base' }));
  for (const L of members) {
    const lh = layerTableHeader(L); if (!lh) continue;
    const ivFile = basename(layerFiles(L)[2].name);
    const base = ivFile.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
    const loc = members.length === 1 ? 'intervals' : 'intervals_' + base;
    const im = lh.intervalMapping || {};
    const bhid = im.bhid != null ? lh.columns[im.bhid] : null;
    locations[loc] = { storage: 'table', count: lh.count || attrRowCountOf(L) || 0, chunk: 1 << 18, source: { file: ivFile, format: 'csv', hash: matColSourceHash(L) }, geometryFrom: 'ds1' };
    relations.push({ child: loc, parent: 'collars', by: 'key', key: bhid });
    if (!relations[0].key && bhid) relations[0].key = bhid;
    const part = layerColumnsOps(L, lh, loc, members.length === 1 ? '' : loc + '.');
    ops.push(...part.ops); columns.push(...part.columns);
  }
  return {
    v: 1, name: dhSetName(rep).replace(/\.holes\.json$/, ''),
    geometry: { kind: 'drillhole', crs: null },
    locations, relations, ops, columns,
    ...(rep._elementExtra || {}),
  };
}
// map a v1 drillhole-set manifest back to the loader's descriptor shape
export function descFromElement(man) {
  if (!man || man.v !== 1 || !man.geometry || man.geometry.kind !== 'drillhole' || !man.locations) return null;
  const ds = (man.ops || []).find((o) => o.op === 'desurvey');
  const collar = man.locations.collars && man.locations.collars.source && man.locations.collars.source.file;
  const survey = ds && (ds.inputs || []).map((x) => x && x.file).find(Boolean);
  const intervals = Object.values(man.locations).filter((l) => l.source && l.source.file && l.geometryFrom).map((l) => l.source.file);
  if (!collar || !survey || !intervals.length) return null;
  return { collar, survey, intervals, config: (ds && ds.params) || {} };
}
export function buildGridElementManifest(L) {
  const gd = L.docs && L.docs.gridDoc; if (!gd || !gd.grid) return null;
  const g = gd.grid;
  const src = basename(L.name);
  const fmt = /\.(tif|tiff)$/i.test(src) ? 'geotiff' : (/\.grd$/i.test(src) ? 'surfer-grd' : (/\.asc$/i.test(src) ? 'esri-asc' : 'grid'));
  const nBands = g.bands && g.bands > 1 ? g.bands : 1;
  const columns = [];
  for (let i = 0; i < nBands; i++) columns.push({ loc: 'nodes', name: nBands > 1 ? 'band ' + (i + 1) : 'value', type: 'number', from: 'base', ...(nBands > 1 && (g.band || 0) === i ? { active: true } : {}) });
  return {
    v: 1, name: src.replace(/\.[^.]+$/, ''),
    geometry: { kind: 'grid', variant: '2D', crs: g.crs || null, origin: null, rotation: null },
    locations: {
      nodes: {
        storage: 'array', count: (g.nx || 0) * (g.ny || 0), chunk: 1 << 18,
        source: { file: src, format: fmt, hash: `${(gd.blob && gd.blob.size) || 0}:${(g.nx || 0) * (g.ny || 0)}` },
        lattice: { nx: g.nx, ny: g.ny, dx: g.dx, dy: g.dy, x0: g.x0, y0: g.y0 },
      },
    },
    relations: [], ops: [], columns,
    ...(L._elementExtra || {}),
  };
}
// hydrate the live layer state FROM a v1 element manifest: derived columns →
// L.calcCols (authoritative over the transitional project.json copy), and the
// list of materialized columns to read (name + reconstructed lineage stamp).
export function elementHydrate(L, man, lk) {
  const ops = new Map((man.ops || []).map((o) => [o.id, o]));
  const calc = [], mats = [];
  for (const col of man.columns || []) {
    if (lk && col.loc !== lk) continue;                    // only THIS layer's location
    const op = col.def != null ? ops.get(col.def) : null;
    if (col.from === 'derived' && op && op.op === 'calc') calc.push({ name: col.name, expr: op.params.expr, ty: col.type === 'string' ? 'string' : 'number' });
    else if (col.from === 'materialized') mats.push({ name: col.name, type: col.type, categories: col.categories, blankColor: col.blankColor, lineage: op ? { op: op.op, at: op.at, build: op.build, params: op.params || {}, sources: op.sources || [] } : null });
  }
  if (calc.length || (L.calcCols || []).length) { L.calcCols = calc; L._calcFns = null; }
  const known = ['v', 'name', 'geometry', 'locations', 'relations', 'ops', 'columns'];
  const extra = Object.fromEntries(Object.entries(man).filter(([k]) => !known.includes(k)));
  L._elementExtra = Object.keys(extra).length ? extra : null;
  return mats;
}
