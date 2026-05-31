// The `pipeline` A-Bus service — the shell-side @gcu/flowsheet engine.
//
// Per the runtime/data-residency design (pipeline-engine-design.md §7a): the
// engine runs SHELL-SIDE. A surface edits pipeline.json and pulls outputs; the
// shell resolves the lazy/content-addressed graph and returns small results over
// A-Bus — bytes never cross into the surface.
//
// Scan execution: heavy scans fan OUT across @gcu/proc workers (the §7a worker
// model) via works/js/pipeline-workers.js → sluice chunks/scanState/merge, with
// graceful fallback to an inline (main-thread) scan when a worker pool isn't
// available (e.g. file:// blocks a worker importing a blob-URL'd lib). The
// accumulator crosses to workers as a serializable spec; the chunk crosses as a
// Blob by reference.
//
// ⚠ Remaining interim (see the project memory): load.csv reads the WHOLE file
// (vfs.readFile → Blob), not streamed. proc Phase B (VFS-from-worker) / a ranged
// streaming Source replaces that without touching the engine or this service.

import { connect } from '#abus';
import { WKS } from './state.js';
import { createEngine, createRegistry } from '#flowsheet';
import * as sluice from '#sluice';
import { sniff } from '#recon';
import { ProcessManager } from '#proc';
import { scanParallel } from './pipeline-workers.js';
import { getLibSource } from './surface-registry.js';

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

// Run a per-column accumulator (given as a serializable spec) over a table Blob —
// parallel across workers when available, inline otherwise. Same result either way.
async function runColumnAcc(blob, manifest, accSpec) {
  const parseOpts = { delimiter: manifest.delimiter, columns: manifest.columns };
  let out;
  const par = ensureParallel();
  if (par) {
    try { out = await scanParallel({ sluice, pool: par.pool, sluiceUrl: par.sluiceUrl, blob, parseOpts, accSpec }); _lastScanMode = 'parallel'; }
    catch { _lastScanMode = 'fallback'; /* e.g. file:// cross-blob import block */ }
  } else { _lastScanMode = 'inline'; }
  if (out === undefined) {
    const acc = sluice.accumulatorFromSpec(accSpec);
    out = await sluice.scan(sluice.recipe(sluice.fromBlob(blob), sluice.parseCsv({ ...parseOpts, header: true })), acc);
  }
  // Strip non-serializable bits (topK's top() closure) so the result crosses A-Bus.
  return JSON.parse(JSON.stringify(out));
}

export function createPipelineRegistry(vfs) {
  const reg = createRegistry();

  reg.register({
    type: 'load.csv', version: 1, outputs: { table: 'table' },
    // INTERIM: whole-file read → a Blob (sliceable, so workers can chunk it
    // by reference). Real source = streaming/ranged VFS (proc Phase B).
    compute: async (_i, p) => ({ table: new Blob([await vfs.readFile(p.path, 'utf8')]) }),
  });

  reg.register({
    type: 'recon.sniff', version: 1, inputs: { table: 'table' }, outputs: { manifest: 'any' },
    compute: async (i) => ({ manifest: sniff(await sluice.sample(sluice.fromBlob(i.table), 200)) }),
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

  // summary — one scan over the whole table producing per-column stats: welford
  // for numeric columns, top-K for categorical. Drives the workbench surface's
  // schema + summary-stats + categories views in a single pull.
  reg.register({
    type: 'summary', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { summary: 'scalar' },
    compute: async (i) => {
      const fields = {};
      for (const c of i.manifest.columns) {
        if (c.type === 'numeric') fields[c.name] = { column: c.name, of: { kind: 'welford' } };
        else if (c.type === 'categorical') fields[c.name] = { column: c.name, of: { kind: 'topK', limit: 50 } };
      }
      return { summary: await runColumnAcc(i.table, i.manifest, { kind: 'collect', fields }) };
    },
  });

  return reg;
}

export async function setupPipelineService() {
  const ch = new MessageChannel();
  WKS.broker.connect(ch.port1);
  const bus = await connect(ch.port2, { client: 'pipeline-shell' });
  const vfs = WKS.vfs;

  const registry = createPipelineRegistry(vfs);
  const engine = createEngine({ registry });
  WKS.pipelineEngine = engine;

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
  WKS.pipelineBus = bus;
  return bus;
}
