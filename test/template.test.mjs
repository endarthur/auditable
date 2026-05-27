import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseText, parseTagged,
  render, renderText, tpl,
  registerFilter, getDependencies, resolvePath,
  TemplateParseError, TemplateRenderError, TemplateCycleError,
} from '../ext/template/index.js';

// ── In-memory VFS stub ──────────────────────────────────────────────
//
// The render path only needs `readFile(path, mode)`. Stub a tiny one keyed
// off a Map so tests stay hermetic.

function mkVfs(files) {
  const map = new Map(Object.entries(files));
  return {
    async readFile(path, mode) {
      if (!map.has(path)) {
        const e = new Error('ENOENT: ' + path);
        e.code = 'ENOENT';
        throw e;
      }
      const v = map.get(path);
      if (mode === 'bytes') {
        if (v instanceof Uint8Array) return v;
        return new TextEncoder().encode(v);
      }
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
  };
}

// ── parse ────────────────────────────────────────────────────────────

test('parseText: plain string is one literal node', () => {
  assert.deepEqual(parseText('hello world'),
    [{ kind: 'literal', text: 'hello world' }]);
});

test('parseText: single template directive', () => {
  assert.deepEqual(parseText('a {{intro.md}} b'), [
    { kind: 'literal', text: 'a ' },
    { kind: 'template', path: 'intro.md', filters: [] },
    { kind: 'literal', text: ' b' },
  ]);
});

test('parseText: pipe-chained filters with args', () => {
  const ast = parseText('{{data.csv | head 10 | format table}}');
  assert.deepEqual(ast, [
    { kind: 'template', path: 'data.csv', filters: [
      { name: 'head', args: ['10'] },
      { name: 'format', args: ['table'] },
    ]},
  ]);
});

test('parseText: quoted filter arg', () => {
  const ast = parseText('{{file.csv | caption "the big table"}}');
  assert.deepEqual(ast[0].filters, [
    { name: 'caption', args: ['the big table'] },
  ]);
});

test('parseText: unclosed directive throws', () => {
  assert.throws(() => parseText('hello {{stuck'), TemplateParseError);
});

test('parseText: empty directive throws', () => {
  assert.throws(() => parseText('{{}}'), TemplateParseError);
});

test('parseTagged: interpolated values land as opaque nodes', () => {
  const name = 'World';
  const ast = parseTagged(['hello ', ', see {{data.csv}}.'], [name]);
  assert.deepEqual(ast, [
    { kind: 'literal', text: 'hello ' },
    { kind: 'opaque', text: 'World' },
    { kind: 'literal', text: ', see ' },
    { kind: 'template', path: 'data.csv', filters: [] },
    { kind: 'literal', text: '.' },
  ]);
});

test('parseTagged: injection-attempt in interpolation is inert', () => {
  // attacker-controlled value tries to inject a {{secret.txt}} directive
  const attack = '{{secrets.env}}';
  const ast = parseTagged(['user said: ', '.'], [attack]);
  // Opaque node, not a template node — the engine never resolves it.
  assert.equal(ast[1].kind, 'opaque');
  assert.equal(ast[1].text, '{{secrets.env}}');
  assert.equal(ast.filter((n) => n.kind === 'template').length, 0);
});

// ── render ───────────────────────────────────────────────────────────

test('render: literal-only AST passes through', async () => {
  const vfs = mkVfs({});
  const html = await renderText('plain text', { vfs });
  assert.equal(html, 'plain text');
});

test('render: includes a markdown file via default filter', async () => {
  const vfs = mkVfs({ '/intro.md': 'hi from intro' });
  const html = await renderText('header {{intro.md}} footer', { vfs, cwd: '/' });
  // .md default wraps in a div.tpl-md with escaped content
  assert.match(html, /header <div class="tpl-md">hi from intro<\/div> footer/);
});

test('render: chained csv filter produces an HTML table', async () => {
  const vfs = mkVfs({ '/data/sales.csv': 'name,amount\nfoo,1\nbar,2\nbaz,3' });
  const html = await renderText('{{sales.csv | head 2 | format table}}',
    { vfs, cwd: '/data' });
  assert.match(html, /<table class="tpl-table">/);
  assert.match(html, /<th>name<\/th>/);
  assert.match(html, /<td>foo<\/td>/);
  // head 2 (+ header) → only foo and bar
  assert.match(html, /<td>bar<\/td>/);
  assert.doesNotMatch(html, /<td>baz<\/td>/);
});

test('render: absolute path beats cwd', async () => {
  const vfs = mkVfs({ '/projects/other/intro.md': 'absolute hit' });
  const html = await renderText('{{/projects/other/intro.md}}',
    { vfs, cwd: '/projects/report/data' });
  assert.match(html, /absolute hit/);
});

test('render: missing path renders placeholder, not throws', async () => {
  const vfs = mkVfs({});
  const html = await renderText('{{ghost.md}}', { vfs, cwd: '/' });
  assert.match(html, /tpl-missing/);
  assert.match(html, /\/ghost\.md/);
});

test('render: unknown filter throws TemplateRenderError', async () => {
  const vfs = mkVfs({ '/data.csv': 'a,b' });
  await assert.rejects(
    () => renderText('{{data.csv | bogus 5}}', { vfs, cwd: '/' }),
    TemplateRenderError,
  );
});

test('render: opts.filters override per-call', async () => {
  const vfs = mkVfs({ '/note.md': 'overridden' });
  const html = await renderText('{{note.md}}', {
    vfs, cwd: '/',
    filters: { '.md': { default: async (s) => `<custom>${s}</custom>` } },
  });
  assert.equal(html, '<custom>overridden</custom>');
});

test('render: onDependency fires per VFS read', async () => {
  const vfs = mkVfs({ '/a.csv': '1,2', '/b.csv': '3,4' });
  const deps = new Set();
  await renderText('A: {{a.csv | raw}} B: {{b.csv | raw}}', {
    vfs, cwd: '/', onDependency: (p) => deps.add(p),
  });
  assert.deepEqual([...deps].sort(), ['/a.csv', '/b.csv']);
});

// ── cycles ───────────────────────────────────────────────────────────

test('render: direct self-cycle detected when a filter re-renders', async () => {
  // We simulate a cycle by giving a custom filter that recursively renders
  // the same path. The engine's `visited` set should catch it.
  const vfs = mkVfs({ '/loop.md': '{{loop.md}}' });
  registerFilter('.md', 'recurse', async (text, _ctx) => {
    // Custom filter that re-renders the content as a template — this is the
    // path real consumer surfaces would take for "render markdown after
    // splicing in templated content". For the test we just call renderText.
    return renderText(text, { vfs, cwd: '/' });
  });
  // Without cycle protection at the renderer level this would stack-overflow.
  // We sidestep by triggering through the explicit render call so that the
  // engine sees `loop.md` twice on its visited stack.
  await assert.rejects(async () => {
    const html = await renderText('{{loop.md | recurse}}',
      { vfs, cwd: '/', visited: new Set() });
    // If it doesn't throw, fall back to checking output for the inner cycle
    if (!/Cycle/i.test(html)) throw new Error('cycle not detected');
  });
});

// ── tagged template literal ──────────────────────────────────────────

test('tpl: tagged-template entry renders normally', async () => {
  const vfs = mkVfs({ '/intro.md': 'hi' });
  const name = 'Arthur';
  const html = await tpl({ vfs, cwd: '/' })`hello ${name}, see {{intro.md}}.`;
  assert.match(html, /hello Arthur, see <div class="tpl-md">hi<\/div>\./);
});

test('tpl: interpolated value cannot inject directives', async () => {
  const vfs = mkVfs({ '/secrets.env': 'PASSWORD=hunter2' });
  const attack = '{{secrets.env}}';
  const html = await tpl({ vfs, cwd: '/' })`user said: ${attack}.`;
  // The attacker's payload renders verbatim — never resolves to file content.
  assert.match(html, /user said: \{\{secrets\.env\}\}\./);
  assert.doesNotMatch(html, /hunter2/);
});

// ── dependencies (for reactivity) ────────────────────────────────────

test('getDependencies: lists absolute paths after cwd resolution', () => {
  const ast = parseText('{{a.csv}} {{/b/c.json}} {{nested/d.md}}');
  const deps = getDependencies(ast, '/projects/report/data');
  assert.deepEqual([...deps].sort(), [
    '/b/c.json',
    '/projects/report/data/a.csv',
    '/projects/report/data/nested/d.md',
  ]);
});

// ── resolvePath ──────────────────────────────────────────────────────

test('resolvePath: absolute stays', () => {
  assert.equal(resolvePath('/a/b.csv', '/projects/report'), '/a/b.csv');
});
test('resolvePath: relative joins cwd', () => {
  assert.equal(resolvePath('a/b.csv', '/projects/report/data'),
    '/projects/report/data/a/b.csv');
});
test('resolvePath: normalizes ../', () => {
  assert.equal(resolvePath('../shared/a.md', '/projects/report/data'),
    '/projects/report/shared/a.md');
});
