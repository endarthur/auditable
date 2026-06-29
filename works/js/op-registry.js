// op-registry — the cross-realm op normalizer (proto-@gcu/op core, harvested into Works).
//
// Works has FOUR op sources with THREE descriptor shapes: geas builtins (full effect
// facets, in `ext/geas/src/ops.js GEAS_OPS`), numen/MCP tools (JSON-Schema + annotation
// hints), and surface-contributed agent tools (inputSchema + a `gated` flag). This module
// turns all of them into ONE unified op descriptor so a toolbox / palette / agent can
// list+filter+route them uniformly. It is the "normalizing adapter" the substrate design
// names as proto-@gcu/op — kept here (consumed where it lives) until a 2nd consumer proves
// the shape, then extracted. Pure: zero DOM, zero shell globals → node-testable.
//
// Effect note: geas ops carry DECLARED facets. MCP/surface ops don't, so we INFER facets
// from their hints (destructiveHint / readOnlyHint / the gated flag) and mark the op
// `effectSource: 'inferred'` — the toolbox should show inferred effects more cautiously.
// The GATE (free|confirm|double|always) is always derived from facets via geas's gateOf,
// so the one freeze-grade facet→gate rule stays single-sourced.
//
// DEFERRED (next/service slice): this imports the facet engine from ext/geas/src/ops.js,
// which the Works registry build can't resolve for a works/js module. Resolve before
// wiring op-registry.js into the works build (relocate the facet engine to a neutral
// build-reachable home, or special-case it). Harmless now — this module is not yet in
// works/js/main.js; it's a pure, node-tested unit.
import { effectFacets, gateOf } from '../../ext/geas/src/ops.js';

/**
 * @typedef {Object} OpParam
 * @property {string} name
 * @property {string} type        - JSON-Schema-ish: 'string' | 'number' | 'boolean' | 'array' | 'object'
 * @property {string} [description]
 * @property {boolean} [required]
 *
 * @typedef {Object} UnifiedOp
 * @property {string} id            - `${source}:${name}` — stable, unique across the registry
 * @property {'geas'|'mcp'|'surface'} source
 * @property {string} name
 * @property {string} summary       - one line
 * @property {string} [doc]         - longer prose
 * @property {string|string[]} [synopsis]
 * @property {string[]} [examples]
 * @property {string[]} [seeAlso]
 * @property {OpParam[]} params
 * @property {{writes:string, reverse:string, pure:boolean}} effect  - the facet tuple
 * @property {'declared'|'inferred'} effectSource
 * @property {'free'|'confirm'|'double'|'always'} gate               - derived from effect
 * @property {Object} route         - source-specific invocation hint (the later works.Ops service reads this)
 */

// ── effect inference for the sources that don't declare facets ──

// MCP tool annotations → a facet tuple. Hints are advisory, so this is best-effort.
export function inferMcpEffect(annotations = {}) {
  if (annotations.readOnlyHint) return { writes: 'none', reverse: 'recompute', pure: false };
  if (annotations.destructiveHint) return { writes: 'fs', reverse: 'none', pure: false };
  // not flagged read-only and not destructive: assume a reversible write (e.g. an edit).
  if (annotations.idempotentHint === false) return { writes: 'fs', reverse: 'snapshot', pure: false };
  // nothing useful declared → treat as read (the safe non-mutating default).
  return { writes: 'none', reverse: 'recompute', pure: false };
}

// Surface agent tool: the only signal is `gated` — gated mutates the surface/document.
export function inferSurfaceEffect(gated) {
  return gated
    ? { writes: 'doc', reverse: 'snapshot', pure: false }   // mutates a surface doc, assume undoable
    : { writes: 'none', reverse: 'recompute', pure: false };
}

// JSON-Schema `{type:'object', properties, required}` → OpParam[].
function paramsFromSchema(schema) {
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(props).map(([name, p]) => {
    const param = { name, type: (p && p.type) || 'string' };
    if (p && p.description) param.description = p.description;
    if (required.has(name)) param.required = true;
    return param;
  });
}

const firstLine = (s) => (typeof s === 'string' ? s.split('\n')[0].trim() : '');

// ── per-source normalizers ──

// geas op: `name` (the key) + `{ effect, summary, synopsis?, doc?, examples?, seeAlso? }`.
export function fromGeasOp(name, op) {
  const effect = effectFacets(op.effect);
  const u = {
    id: `geas:${name}`,
    source: 'geas',
    name,
    summary: op.summary || '',
    // geas args are Bash-style, not structured. v0 carries one coarse `args` param; the
    // synopsis is the real usage hint. Structured per-arg parsing is a later refinement.
    params: [{ name: 'args', type: 'array', description: 'command-line arguments — see synopsis', required: false }],
    effect,
    effectSource: 'declared',
    gate: gateOf(effect),
    route: { kind: 'geas', cmd: name },
  };
  if (op.doc) u.doc = op.doc;
  if (op.synopsis) u.synopsis = op.synopsis;
  if (op.examples) u.examples = op.examples;
  if (op.seeAlso) u.seeAlso = op.seeAlso;
  return u;
}

// MCP tool: `{ name, description, inputSchema, annotations }`.
export function fromMcpTool(tool) {
  const effect = inferMcpEffect(tool.annotations);
  const u = {
    id: `mcp:${tool.name}`,
    source: 'mcp',
    name: tool.name,
    summary: (tool.annotations && tool.annotations.title) || firstLine(tool.description) || tool.name,
    params: paramsFromSchema(tool.inputSchema),
    effect,
    effectSource: 'inferred',
    gate: gateOf(effect),
    route: { kind: 'mcp', tool: tool.name },
  };
  if (tool.description) u.doc = tool.description;
  return u;
}

// Surface agent tool: `{ name, description, inputSchema, surface, interface, member, args, gated, pkg }`.
export function fromSurfaceTool(tool) {
  const effect = inferSurfaceEffect(tool.gated);
  const u = {
    id: `surface:${tool.name}`,
    source: 'surface',
    name: tool.name,
    summary: firstLine(tool.description) || tool.name,
    params: paramsFromSchema(tool.inputSchema),
    effect,
    effectSource: 'inferred',
    gate: gateOf(effect),
    route: { kind: 'surface', surface: tool.surface, interface: tool.interface, member: tool.member, args: tool.args || [] },
  };
  if (tool.description) u.doc = tool.description;
  if (tool.pkg) u.route.pkg = tool.pkg;
  return u;
}

// ── aggregation ──

/**
 * Build the unified op registry from the raw sources.
 * @param {Object} sources
 * @param {Object} [sources.geas]      - the GEAS_OPS table: { name → descriptor }
 * @param {Object[]} [sources.mcp]     - MCP tool descriptors
 * @param {Object[]} [sources.surface] - surface agent tool descriptors
 * @returns {UnifiedOp[]} sorted by (source, name); ids deduped (first wins)
 */
export function buildOpRegistry({ geas, mcp, surface } = {}) {
  const ops = [];
  if (geas) for (const [name, op] of Object.entries(geas)) ops.push(fromGeasOp(name, op));
  if (Array.isArray(mcp)) for (const t of mcp) ops.push(fromMcpTool(t));
  if (Array.isArray(surface)) for (const t of surface) ops.push(fromSurfaceTool(t));
  const seen = new Set();
  const deduped = ops.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
  deduped.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return deduped;
}

/**
 * Filter the registry. All criteria AND together; `search` matches name/summary/doc (case-insensitive).
 * @param {UnifiedOp[]} ops
 * @param {Object} [q] - { source, gate, writes, search }
 */
export function filterOps(ops, q = {}) {
  const needle = q.search ? q.search.toLowerCase() : null;
  return ops.filter((o) => {
    if (q.source && o.source !== q.source) return false;
    if (q.gate && o.gate !== q.gate) return false;
    if (q.writes && o.effect.writes !== q.writes) return false;
    if (needle) {
      const hay = `${o.name}\n${o.summary}\n${o.doc || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
