// op-registry — the cross-realm op normalizer (proto-@gcu/op core). Three descriptor
// shapes (geas / MCP / surface) → one unified op descriptor; gate derived from facets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromGeasOp, fromMcpTool, fromSurfaceTool,
  inferMcpEffect, inferSurfaceEffect,
  buildOpRegistry, filterOps,
} from '../works/js/op-registry.js';
import { GEAS_OPS } from '../ext/geas/src/ops.js';

test('fromGeasOp carries declared facets + derives the gate, preserves the doc fields', () => {
  const rm = fromGeasOp('rm', GEAS_OPS.rm);
  assert.equal(rm.id, 'geas:rm');
  assert.equal(rm.source, 'geas');
  assert.equal(rm.effectSource, 'declared');
  assert.deepEqual(rm.effect, { writes: 'fs', reverse: 'none', pure: false });
  assert.equal(rm.gate, 'double');                 // fs + irreversible → double-confirm
  assert.equal(rm.route.kind, 'geas');
  assert.equal(rm.route.cmd, 'rm');
  assert.ok(rm.doc && rm.examples && rm.synopsis);  // rich descriptor fields survive
  assert.equal(rm.params[0].name, 'args');          // coarse v0 param

  const echo = fromGeasOp('echo', GEAS_OPS.echo);
  assert.equal(echo.gate, 'free');                  // pure → free
});

test('inferMcpEffect maps the annotation hints to facets', () => {
  assert.deepEqual(inferMcpEffect({ readOnlyHint: true }), { writes: 'none', reverse: 'recompute', pure: false });
  assert.deepEqual(inferMcpEffect({ destructiveHint: true }), { writes: 'fs', reverse: 'none', pure: false });
  assert.deepEqual(inferMcpEffect({ idempotentHint: false }), { writes: 'fs', reverse: 'snapshot', pure: false });
  assert.deepEqual(inferMcpEffect({}), { writes: 'none', reverse: 'recompute', pure: false });  // safe default
});

test('fromMcpTool normalizes inputSchema → params and infers effect/gate', () => {
  const tool = {
    name: 'worksWriteFile',
    description: 'Write a text file to the Works workspace.\nSecond line ignored in summary.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'target path' }, content: { type: 'string' } }, required: ['path', 'content'] },
    annotations: { destructiveHint: true, title: 'Write workspace file' },
  };
  const u = fromMcpTool(tool);
  assert.equal(u.id, 'mcp:worksWriteFile');
  assert.equal(u.summary, 'Write workspace file');           // annotation title wins
  assert.equal(u.effectSource, 'inferred');
  assert.equal(u.gate, 'double');                            // destructive → fs+none → double
  assert.deepEqual(u.params, [
    { name: 'path', type: 'string', description: 'target path', required: true },
    { name: 'content', type: 'string', required: true },
  ]);
  assert.equal(u.route.tool, 'worksWriteFile');

  const read = fromMcpTool({ name: 'worksReadFile', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } });
  assert.equal(read.gate, 'free');                            // read-only → free
  assert.equal(read.summary, 'Read a file.');                 // no title → first line of description
});

test('fromSurfaceTool: gated → confirm-class write, ungated → free read', () => {
  const gated = fromSurfaceTool({ name: 'doMutate', description: 'Mutate the surface.', inputSchema: { type: 'object', properties: { x: { type: 'number' } } }, surface: 's', interface: 'Custom', member: 'Mutate', args: ['x'], gated: true, pkg: '@gcu/thing' });
  assert.equal(gated.id, 'surface:doMutate');
  assert.deepEqual(gated.effect, { writes: 'doc', reverse: 'snapshot', pure: false });
  assert.equal(gated.gate, 'confirm');                        // doc + reversible → confirm
  assert.deepEqual(gated.route, { kind: 'surface', surface: 's', interface: 'Custom', member: 'Mutate', args: ['x'], pkg: '@gcu/thing' });

  const open = fromSurfaceTool({ name: 'doRead', description: 'Read it.', inputSchema: { type: 'object', properties: {} }, surface: 's', interface: 'Custom', member: 'Read', gated: false });
  assert.equal(open.gate, 'free');
  assert.deepEqual(open.route.args, []);                      // missing args → []
});

test('inferSurfaceEffect', () => {
  assert.deepEqual(inferSurfaceEffect(true), { writes: 'doc', reverse: 'snapshot', pure: false });
  assert.deepEqual(inferSurfaceEffect(false), { writes: 'none', reverse: 'recompute', pure: false });
});

test('buildOpRegistry aggregates all three sources, sorts, dedups by id', () => {
  const reg = buildOpRegistry({
    geas: { echo: GEAS_OPS.echo, rm: GEAS_OPS.rm },
    mcp: [{ name: 'worksWriteFile', description: 'w', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } }],
    surface: [{ name: 'doMutate', description: 'm', inputSchema: { type: 'object', properties: {} }, surface: 's', interface: 'I', member: 'M', gated: true }],
  });
  assert.equal(reg.length, 4);
  // sorted by (source, name): geas:echo, geas:rm, mcp:worksWriteFile, surface:doMutate
  assert.deepEqual(reg.map((o) => o.id), ['geas:echo', 'geas:rm', 'mcp:worksWriteFile', 'surface:doMutate']);
  // every op has the unified shape
  for (const o of reg) {
    assert.ok(o.id && o.source && o.name && o.effect && o.gate && o.route && Array.isArray(o.params));
  }
});

test('buildOpRegistry over the REAL GEAS_OPS table — every geas op normalizes coherently', () => {
  const reg = buildOpRegistry({ geas: GEAS_OPS });
  assert.equal(reg.length, Object.keys(GEAS_OPS).length);
  for (const o of reg) {
    assert.equal(o.source, 'geas');
    assert.equal(o.effectSource, 'declared');
    assert.ok(['free', 'confirm', 'double', 'always'].includes(o.gate), `${o.id} gate ${o.gate}`);
  }
  // spot-check the textbook gates flowed through normalization
  const byName = Object.fromEntries(reg.map((o) => [o.name, o]));
  assert.equal(byName.cp.gate, 'confirm');
  assert.equal(byName.rm.gate, 'double');
  assert.equal(byName.ls.gate, 'free');
});

test('filterOps: source / gate / writes / search all AND together', () => {
  const reg = buildOpRegistry({ geas: GEAS_OPS });
  assert.ok(filterOps(reg, { gate: 'double' }).every((o) => o.gate === 'double'));
  assert.ok(filterOps(reg, { writes: 'fs' }).every((o) => o.effect.writes === 'fs'));
  assert.ok(filterOps(reg, { source: 'geas' }).length === reg.length);
  const remove = filterOps(reg, { search: 'remove' });
  assert.ok(remove.some((o) => o.name === 'rm'));
  assert.equal(filterOps(reg, { source: 'mcp' }).length, 0);   // no mcp ops in this registry
});
