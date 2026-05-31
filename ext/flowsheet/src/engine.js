// @gcu/flowsheet — the lazy, content-addressed pipeline engine.
//
// The pipeline is an EXPLICIT graph (not inferred): nodes with type + params +
// wiring. Evaluation is lazy + pull-based: pull(node) walks upstream, computes a
// LINEAGE hash per node, and short-circuits on a cache hit. Editing a param
// changes a node's hash → cache miss → recompute, and ONLY that node + its
// downstream recompute. Invalidation is free — the hash IS the identity (§6).
//
// Host-agnostic: compute runs through an `execution backend` ({ runNode }). The
// default runs inline/in-process; a @gcu/proc worker or shell backend implements
// the same interface (§7a) without touching the engine.

import { canonicalJson, hashParts } from './hash.js';
import { createRegistry, compatibleKinds } from './registry.js';
import { createMemoryCache } from './cache.js';

// pipeline shape: { nodes: [{ id, type, params?, version?, wiring? }] }
//   wiring: { inputPort: { node: upstreamId, port: upstreamOutputPort } }

export function inlineBackend() {
  return { runNode: (def, inputs, params, ctx) => def.compute(inputs, params, ctx) };
}

export function createEngine({ registry, cache, backend } = {}) {
  registry = registry || createRegistry();
  cache = cache || createMemoryCache();
  backend = backend || inlineBackend();

  const nodeMap = (pipeline) => {
    const m = new Map();
    for (const n of pipeline.nodes) {
      if (m.has(n.id)) throw new Error(`flowsheet: duplicate node id "${n.id}"`);
      m.set(n.id, n);
    }
    return m;
  };

  // Lineage hash for a node (folds in upstream hashes). Memoized; cycle-checked.
  function computeHash(nodes, id, memo, path) {
    if (memo.has(id)) return memo.get(id);
    if (path.has(id)) throw new Error(`flowsheet: cycle through node "${id}"`);
    const node = nodes.get(id);
    if (!node) throw new Error(`flowsheet: unknown node "${id}"`);
    const def = registry.get(node.type);
    if (!def) throw new Error(`flowsheet: unknown node type "${node.type}" (node "${id}")`);
    path.add(id);
    const inHashes = {};
    const wiring = node.wiring || {};
    for (const inport of Object.keys(wiring).sort()) {
      const w = wiring[inport];
      inHashes[inport] = w.port + '@' + computeHash(nodes, w.node, memo, path);
    }
    path.delete(id);
    const version = node.version ?? def.version ?? 1;
    const h = hashParts(node.type, 'v' + version, canonicalJson(node.params || {}), canonicalJson(inHashes));
    memo.set(id, h);
    return h;
  }

  function resolve(state, id) {
    if (state.inflight.has(id)) return state.inflight.get(id);
    const p = doResolve(state, id);
    state.inflight.set(id, p);
    return p;
  }
  async function doResolve(state, id) {
    const h = state.hashMemo.get(id);
    if (cache.has(h)) return cache.get(h);
    const node = state.nodes.get(id);
    const def = registry.get(node.type);
    const wiring = node.wiring || {};
    const inputs = {};
    await Promise.all(Object.keys(wiring).map(async (inport) => {
      const w = wiring[inport];
      const up = await resolve(state, w.node);
      inputs[inport] = up[w.port];
    }));
    const out = await backend.runNode(def, inputs, node.params || {}, { nodeId: id, params: node.params || {}, def });
    cache.set(h, out);
    return out;
  }

  // pull(pipeline, nodeId [, outputPort]) — lazily resolve a node's output.
  async function pull(pipeline, id, port) {
    const nodes = nodeMap(pipeline);
    if (!nodes.has(id)) throw new Error(`flowsheet: unknown node "${id}"`);
    const hashMemo = new Map();
    computeHash(nodes, id, hashMemo, new Set());     // cycle / unknown-type check + all hashes
    const out = await resolve({ nodes, hashMemo, inflight: new Map() }, id);
    return port === undefined ? out : out[port];
  }

  // hashOf(pipeline, nodeId) — the node's current lineage hash (inspection/tests).
  function hashOf(pipeline, id) {
    return computeHash(nodeMap(pipeline), id, new Map(), new Set());
  }

  // validate(pipeline) — wiring + structural checks (no compute). { ok, errors }.
  function validate(pipeline) {
    let nodes;
    try { nodes = nodeMap(pipeline); }
    catch (e) { return { ok: false, errors: [{ error: 'duplicate-id', message: e.message }] }; }
    const errors = [];
    for (const node of pipeline.nodes) {
      const def = registry.get(node.type);
      if (!def) { errors.push({ node: node.id, error: 'unknown-type', type: node.type }); continue; }
      const wiring = node.wiring || {};
      for (const inport of Object.keys(wiring)) {
        if (!(inport in def.inputs)) errors.push({ node: node.id, error: 'unknown-input-port', port: inport });
        const w = wiring[inport];
        const up = nodes.get(w.node);
        if (!up) { errors.push({ node: node.id, error: 'dangling-input', port: inport, to: w.node }); continue; }
        const updef = registry.get(up.type);
        if (!updef) continue;
        if (!(w.port in updef.outputs)) errors.push({ node: node.id, error: 'unknown-output-port', to: w.node, port: w.port });
        else if (!compatibleKinds(updef.outputs[w.port], def.inputs[inport])) {
          errors.push({ node: node.id, error: 'kind-mismatch', port: inport, expected: def.inputs[inport], got: updef.outputs[w.port] });
        }
      }
    }
    try { for (const node of pipeline.nodes) computeHash(nodes, node.id, new Map(), new Set()); }
    catch (e) { errors.push({ error: 'cycle', message: e.message }); }
    return { ok: errors.length === 0, errors };
  }

  return { pull, hashOf, validate, registry, cache, backend };
}
