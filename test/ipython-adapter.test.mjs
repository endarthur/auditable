// @gcu/ipython-adapter — adder bridge integration test.
//
// Verifies that `from IPython.display import HTML, Markdown, Image, ...`
// works inside adder cells, and that the wrapper objects carry the
// _repr_html_ hook auditable's display() uses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── DOM shim ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
    src: '', width: 0, height: 0, alt: '',
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };

await import('../ext/ipython-adapter/adder.js');
const { pythonExecute } = await import('../ext/adder/src/cell.js');

async function runCell(code) {
  const cell = { id: `t${Math.random().toString(36).slice(2)}` };
  const { defines } = await pythonExecute(code, {}, cell);
  return { scope: defines };
}

describe('IPython.display — namespace resolution', () => {
  test('from IPython.display import HTML, Markdown, Image', async () => {
    const { scope } = await runCell(
      'from IPython.display import HTML, Markdown, Image\n' +
      'a = HTML\n' +
      'b = Markdown\n' +
      'c = Image\n'
    );
    assert.equal(typeof scope.a, 'function');
    assert.equal(typeof scope.b, 'function');
    assert.equal(typeof scope.c, 'function');
  });

  test('from IPython import get_ipython', async () => {
    const { scope } = await runCell(
      'from IPython import get_ipython\n' +
      'shell = get_ipython()\n' +
      'has = shell is not None\n'
    );
    assert.equal(scope.has, true);
  });

  test('from IPython.display import display, clear_output', async () => {
    const { scope } = await runCell(
      'from IPython.display import display, clear_output\n' +
      'a = display\n' +
      'b = clear_output\n'
    );
    assert.equal(typeof scope.a, 'function');
    assert.equal(typeof scope.b, 'function');
  });
});

describe('IPython.display — wrappers expose _repr_html_', () => {
  test('HTML("...") wrapper', async () => {
    const { scope } = await runCell(
      'from IPython.display import HTML\n' +
      'h = HTML("<b>hi</b>")\n'
    );
    assert.equal(typeof scope.h._repr_html_, 'function');
    assert.equal(scope.h._repr_html_(), '<b>hi</b>');
  });

  test('Markdown wrapper renders through auditable.renderMd if available', async () => {
    // No window.auditable.renderMd in node test — falls back to <pre>.
    const { scope } = await runCell(
      'from IPython.display import Markdown\n' +
      'm = Markdown("# heading")\n'
    );
    const out = scope.m._repr_html_();
    // Fallback path: <pre>-wrapped.
    assert.ok(out.includes('# heading') || out.includes('<h1>'));
  });

  test('SVG wrapper: inline markup passes through', async () => {
    const { scope } = await runCell(
      'from IPython.display import SVG\n' +
      's = SVG("<svg></svg>")\n'
    );
    assert.equal(scope.s._repr_html_(), '<svg></svg>');
  });

  test('SVG wrapper: URL wraps as <img>', async () => {
    const { scope } = await runCell(
      'from IPython.display import SVG\n' +
      's = SVG("/path/to.svg")\n'
    );
    assert.ok(scope.s._repr_html_().startsWith('<img src='));
  });

  test('Image(url) returns a DOM <img>', async () => {
    const { scope } = await runCell(
      'from IPython.display import Image\n' +
      'i = Image("http://example.com/x.png")\n'
    );
    assert.equal(scope.i.tagName, 'IMG');
    assert.equal(scope.i.src, 'http://example.com/x.png');
  });

  test('JSON wrapper pretty-prints', async () => {
    const { scope } = await runCell(
      'from IPython.display import JSON\n' +
      'j = JSON({"a": 1, "b": [2, 3]})\n'
    );
    const html = scope.j._repr_html_();
    assert.ok(html.includes('"a"'));
    assert.ok(html.includes('"b"'));
  });

  test('Latex wrapper wraps in $$...$$ for markdown', async () => {
    const { scope } = await runCell(
      'from IPython.display import Latex\n' +
      'l = Latex("x^2")\n'
    );
    const html = scope.l._repr_html_();
    assert.ok(html.includes('x^2'));
  });
});

describe('IPython.display — display() routes through active cell context', () => {
  test('display(HTML(...)) invokes the cell display function', async () => {
    let captured = null;
    const displayCalls = [];
    // Stub cell._ctx so the hook captures it.
    const cell = {
      id: 't_display',
      _ctx: { display: (...args) => { displayCalls.push(args); } },
    };
    await pythonExecute(
      'from IPython.display import display, HTML\n' +
      'display(HTML("<i>x</i>"))\n',
      {}, cell,
    );
    assert.equal(displayCalls.length, 1);
    assert.equal(typeof displayCalls[0][0]._repr_html_, 'function');
    assert.equal(displayCalls[0][0]._repr_html_(), '<i>x</i>');
  });

  test('clear_output empties outputEl.innerHTML', async () => {
    const outputEl = { innerHTML: '<p>old</p>' };
    const cell = {
      id: 't_clear',
      _ctx: { display: () => {}, outputEl },
    };
    await pythonExecute(
      'from IPython.display import clear_output\n' +
      'clear_output()\n',
      {}, cell,
    );
    assert.equal(outputEl.innerHTML, '');
  });
});

describe('IPython.get_ipython() — library detection stub', () => {
  test('returns a truthy object with run_line_magic', async () => {
    const { scope } = await runCell(
      'from IPython import get_ipython\n' +
      'shell = get_ipython()\n' +
      'has_mag = hasattr(shell, "run_line_magic")\n'
    );
    assert.equal(scope.has_mag, true);
  });
});
