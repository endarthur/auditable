// renderMd — the notebook's markdown wrapper (src/js/markdown.js), now a thin
// preset-pinning layer over @gcu/markdown (ext/markdown — engine tests live in
// gcu-markdown.test.mjs). This suite asserts the WRAPPER contract: the output
// shapes renderMd's consumers and CSS depend on, and the §5 security posture
// that replaced the old blacklist sanitizer — raw HTML is INERT (escaped to
// visible text), never parsed, never executed. The old "safe HTML passes
// through" behavior is deliberately gone: HTML cells are the escape hatch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd, slugify } from '../src/js/markdown.js';

describe('renderMd (wrapper contract)', () => {
  it('renders h1-h3 with slug ids; h4-h6 anchor-less', () => {
    assert.ok(renderMd('# Hello').includes('<h1 id="hello">Hello</h1>'));
    assert.ok(renderMd('## World').includes('<h2 id="world">World</h2>'));
    assert.ok(renderMd('### Sub').includes('<h3 id="sub">Sub</h3>'));
    assert.ok(renderMd('#### deep').includes('<h4>deep</h4>'));
    assert.ok(renderMd('###### six').includes('<h6>six</h6>'));
  });

  it('slug includes inline-code content', () => {
    assert.ok(renderMd('## Save `data` format!').includes('id="save-data-format"'));
  });

  it('slugify export preserved', () => {
    assert.equal(slugify('Hello World!'), 'hello-world');
  });

  it('admonitions keep the renderMd markup', () => {
    const out = renderMd('!!! tip\n\n    quick body');
    assert.ok(out.includes('class="admonition adm-tip"'), out);
    assert.ok(out.includes('<div class="admonition-title">Tip</div>'), out);
    assert.ok(out.includes('quick body'), out);
    assert.ok(renderMd('!!! warning "Heads up"\n\n    careful').includes('>Heads up</div>'));
  });

  it('++keys++ render as kbd pills joined by +', () => {
    assert.ok(renderMd('press ++ctrl+enter++').includes('<kbd>ctrl</kbd>+<kbd>enter</kbd>'));
  });

  it('core inline + block features', () => {
    assert.ok(renderMd('**bold**').includes('<strong>bold</strong>'));
    assert.ok(renderMd('*italic*').includes('<em>italic</em>'));
    assert.ok(renderMd('~~gone~~').includes('<del>gone</del>'));
    assert.ok(renderMd('`code`').includes('<code>code</code>'));
    assert.ok(renderMd('[text](https://example.com)').includes('<a href="https://example.com">text</a>'));
    assert.ok(renderMd('```js\nconst x = 1;\n```').includes('<pre><code class="language-js">'));
    assert.ok(renderMd('- one\n- two').includes('<li>one</li>'));
    assert.ok(renderMd('1. first').includes('<ol>'));
    assert.ok(renderMd('hello').startsWith('<p>'));
    assert.equal(typeof renderMd(''), 'string');
  });

  it('NEW dialect over the old renderer: nested lists and task lists', () => {
    const out = renderMd('- a\n  - nested');
    assert.ok(/<ul>\n<li>a\n<ul>\n<li>nested<\/li>/.test(out), out);
    assert.ok(renderMd('- [x] done').includes('type="checkbox" disabled checked'));
  });

  it('tables: plain headers, inline markup in cells, non-tables ignored', () => {
    const t = renderMd('| a | b |\n|---|---|\n| 1 | 2 |');
    assert.ok(t.includes('<table>') && t.includes('<th>a</th>') && t.includes('<td>1</td>'));
    assert.ok(renderMd('| f | w |\n|---|---|\n| **S** | x |').includes('<strong>S</strong>'));
    assert.ok(!renderMd('a | b').includes('<table>'));
  });

  // ── security: html-INERT (the blacklist sanitizer is gone) ──
  it('script tags are escaped text — never parsed, never stripped-with-residue', () => {
    const out = renderMd('<script>alert("xss")</script>');
    assert.ok(!out.includes('<script>'), out);
    assert.ok(out.includes('&lt;script&gt;'), out);   // visible, inert
  });

  it('ALL raw HTML is inert — including formerly-"safe" tags', () => {
    const out = renderMd('<p align="center"><img src="logo.png" /></p>');
    assert.ok(!out.includes('<img'), out);
    assert.ok(out.includes('&lt;img'), out);
    const evt = renderMd('<a href="x" onclick="evil()">link</a>');
    assert.ok(!evt.includes('<a href'), evt);
    assert.ok(evt.includes('&lt;a href'), evt);
  });

  it('rejects javascript: URIs in links and images', () => {
    const link = renderMd('[click](javascript:alert("xss"))');
    assert.ok(!link.includes('href'), link);
    assert.ok(link.includes('click'));
    const img = renderMd('![alt](javascript:alert(1))');
    assert.ok(!img.includes('<img'), img);
    assert.ok(img.includes('alt'));
  });

  it('allows raster data: images; URL bodies immune to inline rules', () => {
    assert.ok(renderMd('![chart](data:image/png;base64,iVBOR)').includes('<img src="data:image/png;base64,iVBOR"'));
    const url = 'data:image/png;base64,AAAA++X5my++BBBB~~no~~*x*CCCC';
    const out = renderMd('![r](' + url + ')');
    assert.ok(out.includes('<img src="' + url + '"'), out);
    assert.ok(!/<img[^>]*<kbd>/.test(out), 'no <kbd> injected into the src');
  });

  it('quote-in-url cannot break out of the href attribute', () => {
    const out = renderMd('[x](https://e.com" onclick="alert(1))');
    assert.ok(!out.includes('onclick="alert'), out);
  });

  it('math passes through in a span (KaTeX downstream hook)', () => {
    const out = renderMd('inline $x^2$ math');
    assert.ok(out.includes('class="math math-inline"'), out);
    assert.ok(out.includes('$x^2$'), out);
  });

  it('${expr} interpolation text survives untouched (substituted upstream)', () => {
    // cell-render substitutes BEFORE renderMd; a stray literal ${} in prose
    // must not be eaten by the math extension.
    const out = renderMd('a ${not math} b');
    assert.ok(out.includes('${not math}'), out);
  });
});
