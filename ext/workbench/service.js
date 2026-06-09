// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/workbench/src/  Build: node ext/workbench/build.js
// @gcu/workbench — shell-side `pipeline` service entry (exports setupService).

// -- pipeline-workers.js --

// Parallel scan driver — fans a sluice scan across @gcu/proc Pool workers, the
// §7a model: the engine orchestrates on the main thread (cheap) and dispatches
// the heavy SCAN off-thread, chunked, then merges the partial states.
//
// Pure / dependency-injected (takes the sluice module + a proc Pool + a sluice
// module URL), so it runs unchanged in the shell (sluice bundled, proc workers)
// and in Node tests (createNodeWorker, sluice via a data: URL). The worker fn is
// self-contained — proc strips closures, so it receives everything as arguments.
//
// Forward-compatible (not a bodge): the chunk crosses as a Blob by reference (no
// byte copy); proc Phase B (VFS-from-worker) later upgrades the SOURCE the worker
// reads, without touching this driver. The accumulator crosses as a serializable
// spec (sluice.accumulatorFromSpec), the permanent cross-realm op contract.

// Worker-side: import sluice from the given module URL, rebuild the accumulator
// from its spec, scan one Blob chunk, return the partial (mergeable) state.
// Standalone — references only its arguments (proc serializes it via toString()).
export async function _scanChunk(blob, sluiceUrl, parseOpts, accSpec, opSpecs) {
  const S = await import(sluiceUrl);
  const acc = S.accumulatorFromSpec(accSpec);
  // Row-expression ops (calc/filter) cross as serializable specs and fuse into
  // the scan after the parse — compiled here, worker-side (the §7a contract).
  return S.scanState(S.recipe(S.fromBlob(blob), S.parseCsv(parseOpts), ...S.opsFromSpecs(opSpecs)), acc);
}

// scanParallel({ sluice, pool, sluiceUrl, blob, parseOpts?, accSpec, workers? })
//   sluice    — the sluice module (main-thread: chunks / accumulatorFromSpec / merge)
//   pool      — a @gcu/proc Pool (pool.map dispatches chunks to workers)
//   sluiceUrl — an import()-able URL of the sluice bundle (data:/blob)
//   blob      — the source as a sliceable Blob/File
//   accSpec   — a serializable accumulator spec (sluice.accumulatorFromSpec)
// Returns the finalized accumulator result (merged across chunks).
export async function scanParallel({ sluice, pool, sluiceUrl, blob, parseOpts = {}, accSpec, opSpecs = [], workers = 4 }) {
  const { header, blobs } = await sluice.chunks(blob, workers, { comment: parseOpts.comment });
  const opts = { ...parseOpts, header };
  const make = () => sluice.accumulatorFromSpec(accSpec);
  const ops = () => sluice.opsFromSpecs(opSpecs);

  let states;
  if (blobs.length <= 1) {
    // Trivial input — skip worker overhead, scan inline.
    const b = blobs[0] || blob;
    states = [await sluice.scanState(sluice.recipe(sluice.fromBlob(b), sluice.parseCsv(opts), ...ops()), make())];
  } else {
    states = await pool.map(blobs, _scanChunk, { extra: [sluiceUrl, opts, accSpec, opSpecs] });
  }

  const acc = make();
  const merged = states.reduce((a, b) => acc.merge(a, b));
  return acc.result(merged);
}

// -- pipeline-service.js --

// The `pipeline` A-Bus service — the shell-side @gcu/flowsheet engine.
//
// Per the runtime/data-residency design (pipeline-engine-design.md §7a): the
// engine runs SHELL-SIDE. A surface edits pipeline.json and pulls outputs; the
// shell resolves the lazy/content-addressed graph and returns small results over
// A-Bus — bytes never cross into the surface.
//
// DEPENDENCY-INJECTED. This module has NO imports of its own (only the sibling
// pipeline-workers, concatenated at build). Everything it needs — the broker, an
// A-Bus `connect`, the workspace vfs, and the @gcu/{flowsheet,sluice,recon,proc}
// libs + a `getLibSource` accessor — arrives through `setupService(ctx)`. That
// is what lets the service run identically whether it's shell-bundled or
// blob-imported from /lib by the broker's cold→hot service activator (the
// works-contribution-registry model): the activator resolves the package's
// declared `requires` and hands them in, so there is no post-boot import-map to
// depend on.
//
// Scan execution: heavy scans fan OUT across @gcu/proc workers (the §7a worker
// model) via pipeline-workers.js → sluice chunks/scanState/merge, with graceful
// fallback to an inline (main-thread) scan when a worker pool isn't available
// (e.g. file:// blocks a worker importing a blob-URL'd lib). The accumulator
// crosses to workers as a serializable spec; the chunk crosses as a Blob by
// reference.
//
// ⚠ Remaining interim (see the project memory): load.csv reads the WHOLE file
// (vfs.readFile → Blob), not streamed. proc Phase B (VFS-from-worker) / a ranged
// streaming Source replaces that without touching the engine or this service.


// Injected at setup time via ctx (see the header). Declared module-level so the
// helper functions below close over them; assigned once in setupService, which
// the broker runs before any Pull can reach the engine.
let connect, sluice, sniff, createEngine, createRegistry, ProcessManager, getLibSource;

// Lazy, once: a @gcu/proc worker pool + an import()-able blob URL of the sluice
// bundle (the workers import it to rebuild accumulators). null ⇒ run inline.
let _parallel;   // undefined = not tried; null = unavailable; { pool, sluiceUrl } = ready
let _lastScanMode = null;   // 'parallel' | 'fallback' | 'inline' — diagnostic
function ensureParallel() {
  if (_parallel !== undefined) return _parallel;
  _parallel = null;
  // On file:// a worker can't import the blob-URL'd lib (Chromium blocks
  // cross-blob-origin loads), so the pool would only error then fall back.
  // Skip it entirely → straight to the inline scan, no wasted workers, no noise.
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
  try {
    const src = getLibSource('sluice');
    if (!src || typeof URL === 'undefined' || !URL.createObjectURL) return null;
    const sluiceUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const pm = new ProcessManager();
    const pool = pm.createPool(Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4));
    _parallel = { pool, sluiceUrl };
  } catch { _parallel = null; }
  return _parallel;
}

// Run a per-column accumulator (a serializable spec) over a table — parallel
// across workers when available, inline otherwise; same result either way. A
// `table` is { blob, ops }: the source Blob + serializable row-expression ops
// (calc/filter) that fuse into the scan after the parse.
async function runColumnAcc(table, manifest, accSpec) {
  const blob = table.blob, opSpecs = table.ops || [];
  const parseOpts = { delimiter: manifest.delimiter, columns: manifest.columns };
  let out;
  const par = ensureParallel();
  if (par) {
    try { out = await scanParallel({ sluice, pool: par.pool, sluiceUrl: par.sluiceUrl, blob, parseOpts, accSpec, opSpecs }); _lastScanMode = 'parallel'; }
    catch {
      // A pool failure can leave it with no live workers (e.g. workers that
      // died importing the lib) — and the next pool.map would queue forever on
      // the corpse. Tear it down and disable it so all later scans go inline.
      _lastScanMode = 'fallback';
      try { par.pool.terminate(); } catch { /* */ }
      _parallel = null;
    }
  } else { _lastScanMode = 'inline'; }
  if (out === undefined) {
    const acc = sluice.accumulatorFromSpec(accSpec);
    out = await sluice.scan(sluice.recipe(sluice.fromBlob(blob), sluice.parseCsv({ ...parseOpts, header: true }), ...sluice.opsFromSpecs(opSpecs)), acc);
  }
  // Strip non-serializable bits (topK's top() closure) so the result crosses A-Bus.
  return JSON.parse(JSON.stringify(out));
}

// @gcu/omf1, lazily blob-imported shell-side (the lib is a /usr/lib builtin).
let _omf1 = null;
async function ensureOmf1() {
  if (_omf1) return _omf1;
  const src = getLibSource('omf1');
  if (!src) throw new Error('load.omf: @gcu/omf1 is unavailable');
  _omf1 = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  return _omf1;
}

// Expand an OMF VolumeElement (regular block model) to a CSV table — X/Y/Z block
// centroids + one column per cell-located variable — so the existing table nodes
// (recon.sniff / summary / stats / gt / categories) consume it unchanged. INTERIM
// (matches load.csv): materializes the whole model as CSV text; the streaming
// path is the @gcu/blockmodel work. recon tags X/Y/Z as coords (GT skips them).
function omfVolumeToCsv(omf1, vol) {
  const cent = omf1.blockModelCentroids(vol.geometry);
  const N = (cent.length / 3) | 0;
  const safe = (s) => String(s).replace(/[",\r\n]/g, '_');
  const cols = [];   // { name, arr, big }
  for (const d of vol.data || []) {
    if (d.location && d.location !== 'cells') continue;   // only cell data aligns with blocks
    if (d.type === 'MappedData' && d.indices && d.indices.length === N) cols.push({ name: safe(d.name), arr: d.indices, big: true });
    else if (d.array && d.array.length === N) cols.push({ name: safe(d.name), arr: d.array });
  }
  const lines = ['X,Y,Z' + cols.map((c) => ',' + c.name).join('')];
  for (let i = 0; i < N; i++) {
    let row = cent[i * 3] + ',' + cent[i * 3 + 1] + ',' + cent[i * 3 + 2];
    for (const c of cols) row += ',' + (c.big ? Number(c.arr[i]) : c.arr[i]);
    lines.push(row);
  }
  return lines.join('\n');
}

export function createPipelineRegistry(vfs) {
  const reg = createRegistry();

  reg.register({
    type: 'load.csv', version: 1, outputs: { table: 'table' },
    // INTERIM: whole-file read → a Blob (sliceable, so workers can chunk it
    // by reference). Real source = streaming/ranged VFS (proc Phase B).
    compute: async (_i, p) => ({ table: { blob: new Blob([await vfs.readFile(p.path, 'utf8')]), ops: [] } }),
  });

  // load.omf — read an OMF v1 block model from the workspace and present it as a
  // table (the gridded block model in row form, design §4a). Binary read.
  reg.register({
    type: 'load.omf', version: 1, outputs: { table: 'table' },
    compute: async (_i, p) => {
      const omf1 = await ensureOmf1();
      const project = await omf1.readOMF(await vfs.readFile(p.path, 'bytes'));
      const vol = (project.elements || []).find((e) => e.type === 'VolumeElement');
      if (!vol) throw new Error('load.omf: no VolumeElement (block model) in ' + p.path);
      return { table: { blob: new Blob([omfVolumeToCsv(omf1, vol)]), ops: [] } };
    },
  });

  // calc — append a derived column (an expression over existing columns) to the
  // table recipe. Streaming: no new table is built; the op fuses into the next
  // scan (and crosses to workers as a string). e.g. expr "Au*0.6 + ifnull(Cu,0)".
  reg.register({
    type: 'calc', version: 1, inputs: { table: 'table' }, outputs: { table: 'table' },
    compute: async (i, p) => ({ table: { blob: i.table.blob, ops: [...(i.table.ops || []), { kind: 'derive', name: p.name, expr: p.expr }] } }),
  });

  // filter — keep rows where an expression is truthy. Same streaming append.
  reg.register({
    type: 'filter', version: 1, inputs: { table: 'table' }, outputs: { table: 'table' },
    compute: async (i, p) => ({ table: { blob: i.table.blob, ops: [...(i.table.ops || []), { kind: 'filter', expr: p.expr }] } }),
  });

  reg.register({
    type: 'recon.sniff', version: 1, inputs: { table: 'table' }, outputs: { manifest: 'any' },
    compute: async (i) => ({ manifest: sniff(await sluice.sample(sluice.fromBlob(i.table.blob), 200)) }),
  });

  reg.register({
    type: 'stats', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { stats: 'scalar' },
    compute: async (i, p) => ({
      stats: await runColumnAcc(i.table, i.manifest, { kind: 'collect', fields: { v: { column: p.column, of: { kind: 'welford' } } } }),
    }),
  });

  reg.register({
    type: 'categories', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { categories: 'scalar' },
    compute: async (i, p) => {
      const out = await runColumnAcc(i.table, i.manifest, { kind: 'collect', fields: { c: { column: p.column, of: { kind: 'topK' } } } });
      return { categories: out.c };
    },
  });

  // gt — cumulative grade-tonnage curve over a grade column. Tonnage model:
  // a fixed blockVolume or dx·dy·dz columns, × an optional density column.
  reg.register({
    type: 'gt', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { gt: 'scalar' },
    compute: async (i, p) => ({
      gt: await runColumnAcc(i.table, i.manifest, {
        kind: 'gradeTonnage', grade: p.grade, gradeMin: p.gradeMin, gradeMax: p.gradeMax,
        bins: p.bins || 200, blockVolume: p.blockVolume ?? null, dims: p.dims ?? null, density: p.density ?? null,
      }),
    }),
  });

  // swath — binned stats along a coordinate axis: bin rows by `axis` (sparse,
  // by binWidth — a natural bench/section width, no extent needed) and welford a
  // grade per bin. Result: [{ center, value: { g: <welford> } }, …] sorted by
  // bin. The standard trend/validation profile, on the proven binned primitive.
  reg.register({
    type: 'swath', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { swath: 'scalar' },
    compute: async (i, p) => ({
      swath: await runColumnAcc(i.table, i.manifest, {
        kind: 'binned', column: p.axis, bins: { binWidth: p.binWidth },
        of: { kind: 'collect', fields: { g: { column: p.grade, of: { kind: 'welford' } } } },
      }),
    }),
  });

  // count — row count after the table's ops (a filter shrinks it). One scan.
  reg.register({
    type: 'count', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { count: 'scalar' },
    compute: async (i) => ({ count: await runColumnAcc(i.table, i.manifest, { kind: 'count' }) }),
  });

  // summary — one scan over the whole table producing per-column stats: welford
  // for numeric columns, top-K for categorical. Drives the workbench surface's
  // schema + summary-stats + categories views in a single pull. `extraNumeric`
  // names derived (calc) columns not in the manifest so they get welford too.
  reg.register({
    type: 'summary', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { summary: 'scalar' },
    compute: async (i, p) => {
      const fields = {};
      for (const c of i.manifest.columns) {
        if (c.type === 'numeric') fields[c.name] = { column: c.name, of: { kind: 'welford' } };
        else if (c.type === 'categorical') fields[c.name] = { column: c.name, of: { kind: 'topK', limit: 50 } };
      }
      for (const name of (p && p.extraNumeric) || []) fields[name] = { column: name, of: { kind: 'welford' } };
      return { summary: await runColumnAcc(i.table, i.manifest, { kind: 'collect', fields }) };
    },
  });

  return reg;
}

// The cold→hot service activator entry. The broker calls this once, on the first
// `pipeline` call, with the injected ctx. It connects to the broker, builds the
// flowsheet engine + node registry, exposes the Pipeline interface, and claims
// the `pipeline` service name.
//
// ctx = {
//   broker,                              // the A-Bus broker (broker.connect)
//   connect,                             // @gcu/abus connect()
//   vfs,                                 // the workspace VFS
//   libDir,                              // '/lib/@gcu/workbench' (unused today)
//   getLibSource,                        // (name) → decompressed lib source string
//   deps: { flowsheet, sluice, recon, proc },   // the resolved `requires` namespaces
// }
export async function setupService(ctx) {
  ({ connect, getLibSource } = ctx);
  const { broker, vfs, deps } = ctx;
  sluice = deps.sluice;
  sniff = deps.recon.sniff;
  ({ createEngine, createRegistry } = deps.flowsheet);
  ProcessManager = deps.proc.ProcessManager;

  const ch = new MessageChannel();
  broker.connect(ch.port1);
  const bus = await connect(ch.port2, { client: 'pipeline-shell' });

  const registry = createPipelineRegistry(vfs);
  const engine = createEngine({ registry });

  async function resolvePipeline(p) {
    if (typeof p === 'string') return JSON.parse(await vfs.readFile(p, 'utf8'));
    return p;
  }

  bus.expose('/', {
    Pipeline: {
      methods: {
        Pull:      async (pipeline, nodeId, port) => engine.pull(await resolvePipeline(pipeline), nodeId, port),
        Validate:  async (pipeline) => engine.validate(await resolvePipeline(pipeline)),
        HashOf:    async (pipeline, nodeId) => engine.hashOf(await resolvePipeline(pipeline), nodeId),
        NodeTypes: () => registry.list(),
        // Diagnostic: whether the proc worker pool is live (vs inline fallback).
        WorkerInfo: () => { const p = _parallel; return { pooled: !!(p && p.pool), workers: p && p.pool ? p.pool.list().length : 0, lastScanMode: _lastScanMode }; },
      },
    },
  });

  await bus.claim('pipeline');
  return bus;
}
