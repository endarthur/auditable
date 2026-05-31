// The `pipeline` A-Bus service — the shell-side @gcu/flowsheet engine.
//
// Per the runtime/data-residency design (pipeline-engine-design.md §7a): the
// engine runs SHELL-SIDE. A surface edits pipeline.json and pulls outputs; the
// shell resolves the lazy/content-addressed graph and returns small results over
// A-Bus — bytes never cross into the surface.
//
// ⚠ MVP / interim shortcuts (see the project memory's CRITICAL note — do NOT
// mistake these for done):
//   1. INLINE backend — compute runs on the shell MAIN thread. The MANDATORY
//      follow-up is the @gcu/proc WORKER backend (off-thread, where data lives;
//      shell workers are same-origin → real OPFS/FSAA handles, unlike a surface's
//      own workers). It drops in behind createEngine({ backend }) with no other
//      change — that's the whole point of the backend seam.
//   2. load.csv reads the WHOLE file via vfs.readFile + fromText (NOT streamed).
//      The real streaming VFS Source (ranged / Blob-delegated, §7a Source tiers)
//      must replace it.

import { connect } from '#abus';
import { WKS } from './state.js';
import { createEngine, createRegistry } from '#flowsheet';
import { collect, welford, topK, recipe, fromText, parseCsv, scan, sample } from '#sluice';
import { sniff } from '#recon';

// The shell-side node library. The compute chain (source → sniff → stats) is the
// same pattern proven by ext/flowsheet's Node integration test.
export function createPipelineRegistry(vfs) {
  const reg = createRegistry();

  reg.register({
    type: 'load.csv', version: 1, outputs: { table: 'table' },
    // INTERIM: whole-file read (see header). Real source = streaming/ranged VFS.
    compute: async (_i, p) => ({ table: fromText(await vfs.readFile(p.path, 'utf8')) }),
  });

  reg.register({
    type: 'recon.sniff', version: 1, inputs: { table: 'table' }, outputs: { manifest: 'any' },
    compute: async (i) => ({ manifest: sniff(await sample(i.table, 200)) }),
  });

  reg.register({
    type: 'stats', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { stats: 'scalar' },
    compute: async (i, p) => {
      const m = i.manifest;
      const acc = collect({ v: [welford(), (r) => r[p.column]] });
      return { stats: await scan(recipe(i.table, parseCsv({ delimiter: m.delimiter, columns: m.columns, header: true })), acc) };
    },
  });

  reg.register({
    type: 'categories', version: 1, inputs: { table: 'table', manifest: 'any' }, outputs: { categories: 'scalar' },
    compute: async (i, p) => {
      const m = i.manifest;
      const acc = collect({ c: [topK(), (r) => r[p.column]] });
      const out = await scan(recipe(i.table, parseCsv({ delimiter: m.delimiter, columns: m.columns, header: true })), acc);
      return { categories: out.c };
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
  const engine = createEngine({ registry });    // inline backend, in-memory content cache
  WKS.pipelineEngine = engine;

  // A pipeline is passed inline (the graph JSON) or as a VFS path to a .json file.
  async function resolvePipeline(p) {
    if (typeof p === 'string') return JSON.parse(await vfs.readFile(p, 'utf8'));
    return p;
  }

  bus.expose('/', {
    Pipeline: {
      methods: {
        // Pull a node's output — the whole output object, or one port if given.
        Pull:      async (pipeline, nodeId, port) => engine.pull(await resolvePipeline(pipeline), nodeId, port),
        Validate:  async (pipeline) => engine.validate(await resolvePipeline(pipeline)),
        HashOf:    async (pipeline, nodeId) => engine.hashOf(await resolvePipeline(pipeline), nodeId),
        NodeTypes: () => registry.list(),
      },
    },
  });

  await bus.claim('pipeline');
  WKS.pipelineBus = bus;
  return bus;
}
