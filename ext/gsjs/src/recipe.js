// @gcu/gsjs — the recipe API: a JSON-serializable estimation spec + a composable
// JS builder eDSL that produces it, on top of the target-based kriging() core.
//
// Layers (SPEC §"Layered architecture"): the recipe is the SHIPPABLE ARTIFACT —
// language-independent JSON a regulator can diff and a non-JS consumer can read.
// The eDSL (recipe/variogram/search/ok/sk/…) is just a convenient JS way to
// BUILD that JSON; toJSON() emits the canonical form, fromJSON() rebuilds it.
//
// @gcu/build bundles src/ into a self-contained ESM, so this module imports
// what it uses (kriging, realize, the aggregations) from siblings normally. The
// `where` selector is @gcu/sift, imported from its source so @gcu/build's `inline`
// pass folds it into the bundle collision-safe (the over↔dimensions pattern).
//
// Canonical JSON (compact GSLIB vocab, per SPEC §"Core data structures"):
//   { data: { columns:{x,y,z,value,domain?,sk_mean?,dh_id?}, source? },
//     block_grid: { nx,ny,nz, xmn,ymn,zmn, xsiz,ysiz,zsiz, discretization:[a,b,c] },
//     domains?: [ { id, where, model } ],      where = sift predicate (string→spec)
//     default_model?: <DomainEstimation>,
//     output: { distances?, aggregations?: [<AggregationSpec>] } }
//   DomainEstimation = { ktype:'OK'|'SK'|'SK_LVM', sk_mean?, variogram, search, realization }
//   VariogramModel   = { c0, structures:[{ type, cc, aa, anis:[ay/ax,az/ax], ang:[s,d,p] }] }
//   SearchEllipsoid  = { radius, anis:[rmin/rmaj,rvert/rmaj], ang:[s,d,p], ndmin, ndmax, octant? }
//   Realization      = { transform:'none'|'topcut'|'hgr_hard'|'hgr_soft', transform_params:{…} }
//   AggregationSpec  = { kind:'stats'|'histogram'|'swath'|'gradeTonnage', name?, …kind params }
//
// run(recipe, ctx) executes; it is staged so live cap/HGR sliders re-run only the
// cheap tail: estimate() (expensive — search+solve, per domain) → evaluate()
// (cheap — realize + aggregate). Spec: spec_inbox/gsjs-SPEC.md §"Recipe API".

import { parsePredicate, evaluatePredicate, validatePredicate } from '../../sift/src/predicate.js';
import { stats, histogram, swath, gradeTonnage } from './aggregate.js';
import { realize, STATUS } from './realize.js';
import { krige } from './krige.js';

const _TRANSFORMS = new Set(['none', 'topcut', 'hgr_hard', 'hgr_soft']);
const _KTYPES = new Set(['OK', 'SK', 'SK_LVM']);
const _AGG_KINDS = new Set(['stats', 'histogram', 'swath', 'gradeTonnage']);

// ── builders (return plain serializable nodes) ──────────────────────────────

// variogram(structures, { c0 }) → VariogramModel. Each structure:
//   { type:'spherical'|…|1..5, cc, aa, anis?:[ay/ax,az/ax], ang?:[strike,dip,plunge] }
// anis defaults to isotropic [1,1]; ang to [0,0,0].
export function variogram(structures, opts = {}) {
  if (!Array.isArray(structures) || structures.length === 0) {
    throw new Error('gsjs.variogram: need at least one structure');
  }
  return {
    c0: opts.c0 ?? opts.nugget ?? 0,
    structures: structures.map((s) => ({
      type: s.type,
      cc: s.cc ?? s.contribution,
      aa: s.aa ?? s.range,
      anis: s.anis ? [s.anis[0], s.anis[1]] : [1, 1],
      ang: s.ang ? [s.ang[0], s.ang[1], s.ang[2]] : [0, 0, 0],
    })),
  };
}

// search({ radius, anis?, ang?, ndmin, ndmax, octant? }) → SearchEllipsoid.
export function search(opts = {}) {
  return {
    radius: opts.radius,
    anis: opts.anis ? [opts.anis[0], opts.anis[1]] : [1, 1],
    ang: opts.ang ? [opts.ang[0], opts.ang[1], opts.ang[2]] : [0, 0, 0],
    ndmin: opts.ndmin ?? 1,
    ndmax: opts.ndmax,
    ...(opts.octant ? { octant: { ...opts.octant } } : {}),
    // neighbourhood policies (the JS engine drives them); all serializable
    ...(opts.perHoleMax != null ? { perHoleMax: opts.perHoleMax } : {}),   // needs data.columns.dh_id
    ...(opts.sectors ? { sectors: { ...opts.sectors } } : {}),
    ...(opts.minSampleDistance != null ? { minSampleDistance: opts.minSampleDistance } : {}),
    ...(opts.benchThickness != null ? { benchThickness: opts.benchThickness } : {}),
  };
}

// realization predicate builders → Realization nodes (transform + params).
export function none() { return { transform: 'none', transform_params: {} }; }
export function topcut(p = {}) { return { transform: 'topcut', transform_params: { cap: p.cap } }; }

// hgr({ mode:'hard'|'soft', cap, d_thresh?, d_max?, grade_thresh }) — high-grade
// restriction. mode defaults to 'hard'; 'soft' ramps over distance (needs d_max).
export function hgr(p = {}) {
  const mode = p.mode || (p.d_max != null && p.d_thresh == null ? 'soft' : 'hard');
  const tp = { cap: p.cap, grade_thresh: p.grade_thresh };
  if (mode === 'hard') tp.d_thresh = p.d_thresh;
  else tp.d_max = p.d_max;
  return { transform: 'hgr_' + mode, transform_params: tp };
}

// model builders → DomainEstimation. realization defaults to none().
function _model(ktype, m) {
  return {
    ktype,
    ...(m.sk_mean != null ? { sk_mean: m.sk_mean } : {}),
    variogram: m.variogram,
    search: m.search,
    realization: m.realization || none(),
  };
}
export function ok(m) { return _model('OK', m); }
export function sk(m) { return _model('SK', { sk_mean: m.sk_mean ?? 0, ...m }); }
export function sk_lvm(m) { return _model('SK_LVM', m); }

// ── where selector (sift predicate, serializable) ───────────────────────────
// Accepts a string ("DOMAIN == 'HG'" → parsed to a sift spec), a sift spec
// object ({form:'spec',root} or a bare Expr), or a JS function (in-memory escape
// hatch that does NOT round-trip — toJSON refuses it).
function _normalizeWhere(where) {
  if (where == null) return null;
  if (typeof where === 'string') return parsePredicate(where);
  if (typeof where === 'function') return { _fn: where };
  if (typeof where === 'object') { validatePredicate(where); return where; }
  throw new Error('gsjs: domain `where` must be a string, sift predicate, or function');
}
function _whereFn(nw) {
  if (nw == null) return () => true;
  if (nw._fn) return (row) => !!nw._fn(row);
  return (row) => evaluatePredicate(nw, (col) => row[col]);
}

// ── validation (structural; throws — the artifact must be valid) ─────────────

function _validateVario(v, ctx) {
  if (!v || !Array.isArray(v.structures) || v.structures.length === 0) throw new Error(`gsjs${ctx}: variogram needs structures[]`);
  if (v.c0 < 0) throw new Error(`gsjs${ctx}: nugget c0 must be ≥ 0`);
  for (const s of v.structures) {
    if (s.cc == null || s.cc < 0) throw new Error(`gsjs${ctx}: structure cc must be ≥ 0`);
    if (!(s.aa > 0)) throw new Error(`gsjs${ctx}: structure range aa must be > 0`);
    if (!(s.anis[0] > 0) || !(s.anis[1] > 0)) throw new Error(`gsjs${ctx}: anisotropy ratios must be > 0`);
  }
}
function _validateSearch(s, ctx) {
  if (!(s.radius > 0)) throw new Error(`gsjs${ctx}: search radius must be > 0`);
  if (!(s.ndmax >= s.ndmin) || !(s.ndmin >= 1)) throw new Error(`gsjs${ctx}: need ndmax ≥ ndmin ≥ 1`);
  if (!(s.anis[0] > 0) || !(s.anis[1] > 0)) throw new Error(`gsjs${ctx}: search anis ratios must be > 0`);
}
function _validateRealization(r, ctx) {
  if (!_TRANSFORMS.has(r.transform)) throw new Error(`gsjs${ctx}: unknown transform '${r.transform}'`);
  const p = r.transform_params || {};
  if (r.transform === 'topcut' && p.cap == null) throw new Error(`gsjs${ctx}: topcut needs cap`);
  if (r.transform === 'hgr_hard' && (p.cap == null || p.d_thresh == null || p.grade_thresh == null)) throw new Error(`gsjs${ctx}: hgr_hard needs cap, d_thresh, grade_thresh`);
  if (r.transform === 'hgr_soft' && (p.cap == null || p.d_max == null || p.grade_thresh == null)) throw new Error(`gsjs${ctx}: hgr_soft needs cap, d_max, grade_thresh`);
}
function _validateModel(m, ctx) {
  if (!_KTYPES.has(m.ktype)) throw new Error(`gsjs${ctx}: unknown ktype '${m.ktype}'`);
  if (m.ktype === 'SK' && typeof m.sk_mean !== 'number') throw new Error(`gsjs${ctx}: SK needs a numeric sk_mean`);
  if (m.ktype === 'SK_LVM' && m.sk_mean == null) throw new Error(`gsjs${ctx}: SK_LVM needs an sk_mean source (column name or array)`);
  _validateVario(m.variogram, ctx);
  _validateSearch(m.search, ctx);
  _validateRealization(m.realization, ctx);
}
function _validateGrid(g) {
  for (const k of ['nx', 'ny', 'nz']) if (!(g[k] >= 1)) throw new Error(`gsjs: block_grid.${k} must be ≥ 1`);
  for (const k of ['xsiz', 'ysiz', 'zsiz']) if (!(g[k] > 0)) throw new Error(`gsjs: block_grid.${k} must be > 0`);
  if (g.discretization && (!Array.isArray(g.discretization) || g.discretization.length !== 3)) throw new Error('gsjs: block_grid.discretization must be [nx,ny,nz]');
}
function _validateAgg(a) {
  if (!_AGG_KINDS.has(a.kind)) throw new Error(`gsjs: unknown aggregation kind '${a.kind}'`);
  if (a.kind === 'gradeTonnage' && !Array.isArray(a.cutoffs)) throw new Error('gsjs: gradeTonnage needs cutoffs[]');
  if (a.kind === 'swath' && !['x', 'y', 'z'].includes(a.axis)) throw new Error("gsjs: swath needs axis 'x'|'y'|'z'");
}

// ── recipe() — normalize + validate, return a live recipe with toJSON() ─────

// recipe(spec) accepts the eDSL/JSON shape and returns a live object carrying the
// normalized spec (where-selectors parsed to sift specs) + a toJSON() that emits
// the canonical, serializable artifact. Validation runs at construction time.
export function recipe(spec) {
  if (!spec || !spec.data || !spec.data.columns) throw new Error('gsjs.recipe: need data.columns');
  if (!spec.block_grid) throw new Error('gsjs.recipe: need block_grid');
  if (!spec.domains && !spec.default_model) throw new Error('gsjs.recipe: need domains[] or default_model');

  _validateGrid(spec.block_grid);
  if (spec.default_model) _validateModel(spec.default_model, '.default_model');

  const domains = (spec.domains || []).map((d) => {
    if (d.id == null) throw new Error('gsjs.recipe: each domain needs an id');
    _validateModel(d.model, `.domain[${d.id}]`);
    return { id: d.id, where: _normalizeWhere(d.where), model: d.model };
  });

  const aggregations = (spec.output && spec.output.aggregations) || [];
  for (const a of aggregations) _validateAgg(a);

  const norm = {
    data: { columns: { ...spec.data.columns }, ...(spec.data.source != null ? { source: spec.data.source } : {}) },
    block_grid: { ...spec.block_grid },
    ...(domains.length ? { domains } : {}),
    ...(spec.default_model ? { default_model: spec.default_model } : {}),
    output: { distances: !!(spec.output && spec.output.distances), aggregations },
  };

  return {
    ...norm,
    toJSON() {
      const out = JSON.parse(JSON.stringify({ ...norm, domains: undefined }));
      if (norm.domains) {
        out.domains = norm.domains.map((d) => {
          if (d.where && d.where._fn) throw new Error(`gsjs.recipe.toJSON: domain '${d.id}' uses a JS function selector that can't be serialized — use a sift predicate string instead`);
          return { id: d.id, ...(d.where ? { where: d.where } : {}), model: d.model };
        });
      }
      return out;
    },
  };
}

// fromJSON(spec) — rebuild an executable recipe from canonical JSON. Idempotent
// with toJSON(): where-selectors are already sift specs, recipe() re-validates.
export function fromJSON(spec) { return recipe(spec); }

// ── translation: compact recipe vocab → kriging() verbose opts ──────────────

function _krigingVario(v) {
  return {
    nugget: v.c0,
    structures: v.structures.map((s) => ({
      type: s.type,
      contribution: s.cc,
      range: s.aa,
      rangeMinor: s.aa * s.anis[0],
      rangeVert: s.aa * s.anis[1],
      angle: s.ang[0], angle2: s.ang[1], angle3: s.ang[2],
    })),
  };
}
function _krigingSearch(s) {
  return {
    radius: s.radius,
    radiusMinor: s.radius * s.anis[0],
    radiusVert: s.radius * s.anis[1],
    angle: s.ang[0], angle2: s.ang[1], angle3: s.ang[2],
    ndmin: s.ndmin, ndmax: s.ndmax,
    ...(s.perHoleMax != null ? { perHoleMax: s.perHoleMax } : {}),
    ...(s.sectors ? { sectors: s.sectors } : {}),
    ...(s.minSampleDistance != null ? { minSampleDistance: s.minSampleDistance } : {}),
    ...(s.benchThickness != null ? { type: 'bench', benchThickness: s.benchThickness } : {}),
  };
}

// Extract [x,y,z,value] sample rows from host rows via the column mapping, plus a
// parallel holeId side array when a dh_id column is mapped (for the per-hole cap).
function _samples(rows, cols, predFn) {
  const data = [], holeId = cols.dh_id != null ? [] : null;
  for (const row of rows) {
    if (predFn && !predFn(row)) continue;
    const v = row[cols.value];
    if (v == null || Number.isNaN(+v)) continue;        // skip missing assays
    data.push([+row[cols.x], +row[cols.y], +row[cols.z], +v]);
    if (holeId) holeId.push(row[cols.dh_id]);
  }
  return { data, holeId };
}

// ── estimate() — the EXPENSIVE stage (search + solve), per domain ───────────
//
// ctx: { rows, blockDomains? }
//   rows         — host data rows (array of objects keyed by column name)
//   blockDomains — per-block domain id (Array | TypedArray length nxyz, OR a
//                  function (ix,iy,iz,x,y,z,idx)=>id). Required iff the recipe
//                  has domains[]. Each block runs the model of the domain whose
//                  id it carries; unmatched blocks fall to default_model (if any)
//                  else status NOT_ATTEMPTED.
//
// Returns { grid, geom, nxyz, status, domains:[{id, tensor, gridIndex, model}], _recipe }.
export function estimate(R, ctx = {}) {
  const r = R.toJSON ? R : recipe(R);              // accept live recipe or raw spec
  const cols = r.data.columns;
  const rows = ctx.rows;
  if (!Array.isArray(rows)) throw new Error('gsjs.estimate: ctx.rows (host data rows) is required');
  const g = r.block_grid;
  const nxyz = g.nx * g.ny * g.nz;
  const disc = g.discretization ? { nx: g.discretization[0], ny: g.discretization[1], nz: g.discretization[2] } : undefined;
  const wantDist = !!r.output.distances;
  const status = new Uint8Array(nxyz).fill(STATUS.NOT_ATTEMPTED);

  // Resolve the work list: a domain is { id, predFn, model, blockMask | null }.
  // Single default_model (no domains) → one full-grid run (allocation-free).
  const work = [];
  if (!r.domains) {
    work.push({ id: '_default', predFn: () => true, model: r.default_model, mask: null });
  } else {
    if (ctx.blockDomains == null) throw new Error('gsjs.estimate: recipe has domains[] — ctx.blockDomains (per-block id) is required');
    const bd = ctx.blockDomains;
    const idOf = typeof bd === 'function'
      ? (ix, iy, iz, x, y, z, idx) => bd(ix, iy, iz, x, y, z, idx)
      : (ix, iy, iz, x, y, z, idx) => bd[idx];
    // bucket blocks by domain id
    const masks = new Map();
    let idx = 0;
    for (let iz = 0; iz < g.nz; iz++) for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++, idx++) {
      const x = g.xmn + ix * g.xsiz, y = g.ymn + iy * g.ysiz, z = g.zmn + iz * g.zsiz;
      const id = idOf(ix, iy, iz, x, y, z, idx);
      if (id == null) continue;
      let m = masks.get(id);
      if (!m) { m = new Uint8Array(nxyz); masks.set(id, m); }
      m[idx] = 1;
    }
    const byId = new Map(r.domains.map((d) => [d.id, d]));
    for (const [id, mask] of masks) {
      const d = byId.get(id);
      if (d) work.push({ id, predFn: _whereFn(d.where), model: d.model, mask });
      else if (r.default_model) work.push({ id, predFn: () => true, model: r.default_model, mask });
      // else: blocks of an unknown id stay NOT_ATTEMPTED
    }
  }

  const outDomains = [];
  for (const w of work) {
    if (w.model.ktype === 'SK_LVM') throw new Error("gsjs.estimate: SK_LVM (locally varying mean) isn't supported by krige() yet — use OK or SK");
    const { data, holeId } = _samples(rows, cols, w.predFn);
    const kopts = {
      data,
      variogram: _krigingVario(w.model.variogram),
      search: _krigingSearch(w.model.search),
      ktype: w.model.ktype,
      ...(w.model.ktype === 'SK' ? { skmean: w.model.sk_mean } : {}),
      grid: g,
      ...(w.mask ? { mask: w.mask } : {}),
      ...(disc ? { discretization: disc } : {}),
      ...(holeId ? { holeId } : {}),
      distances: wantDist,
    };
    // faithful:true → the recipe stays bit-identical to gslib.kt3d (no user-visible
    // numerical change from the atra fork), now via the neighbourhood-driven JS engine.
    const tensor = krige({ ...kopts, faithful: true });
    // scatter this domain's per-target status into the full-grid status array
    for (let t = 0; t < tensor.n_targets; t++) {
      const gi = tensor.gridIndex ? tensor.gridIndex[t] : t;
      status[gi] = tensor.status[t];
    }
    outDomains.push({ id: w.id, tensor, gridIndex: tensor.gridIndex, model: w.model });
  }

  return { grid: g, geom: { grid: g }, nxyz, status, domains: outDomains, _recipe: r };
}

// ── evaluate() — the CHEAP stage (realize + aggregate), re-runnable ─────────
//
// kriged: the estimate() result. overrides: per-domain realization overrides,
//   { [domainId]: { transform?, transform_params? } } — what a live slider sets
//   (e.g. { HG: { transform_params: { cap: 28 } } }) to re-realize WITHOUT
//   re-kriging. Returns { estimates, status, geom, aggregations, domains }.
export function evaluate(kriged, overrides = {}) {
  const r = kriged._recipe;
  const { nxyz, status, geom } = kriged;
  const estimates = new Float64Array(nxyz);
  const perDomain = [];

  for (const d of kriged.domains) {
    const base = d.model.realization || none();
    const ov = overrides[d.id] || {};
    const transform = ov.transform || base.transform;
    const params = { ...(base.transform_params || {}), ...(ov.transform_params || {}) };
    const est = realize(d.tensor, d.tensor.values, { transform, params });
    for (let t = 0; t < d.tensor.n_targets; t++) {
      const gi = d.gridIndex ? d.gridIndex[t] : t;
      estimates[gi] = est[t];
    }
    perDomain.push({ id: d.id, estimates: est, gridIndex: d.gridIndex });
  }

  const aggregations = {};
  for (const a of r.output.aggregations) {
    const name = a.name || (a.kind === 'swath' ? `swath_${a.axis}` : a.kind);
    if (a.kind === 'stats') aggregations[name] = stats(estimates, status);
    else if (a.kind === 'histogram') aggregations[name] = histogram(estimates, status, { min: a.min, max: a.max, nbins: a.nbins });
    else if (a.kind === 'swath') aggregations[name] = swath(estimates, status, geom, { axis: a.axis, nbins: a.nbins });
    else if (a.kind === 'gradeTonnage') aggregations[name] = gradeTonnage(estimates, status, { cutoffs: a.cutoffs, blockTonnage: a.blockTonnage });
  }

  return { estimates, status, geom, aggregations, domains: perDomain };
}

// run(recipe, ctx, overrides?) — convenience: the full pipeline. For live
// sliders, hold the estimate() result and call evaluate() repeatedly instead.
export function run(R, ctx = {}, overrides = {}) {
  return evaluate(estimate(R, ctx), overrides);
}
