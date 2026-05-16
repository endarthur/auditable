import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd } from '../src/js/markdown.js';

describe('renderMd', () => {
  it('renders h1', () => {
    assert.ok(renderMd('# Hello').includes('<h1>Hello</h1>'));
  });

  it('renders h2', () => {
    assert.ok(renderMd('## World').includes('<h2>World</h2>'));
  });

  it('renders h3', () => {
    assert.ok(renderMd('### Sub').includes('<h3>Sub</h3>'));
  });

  it('renders bold', () => {
    assert.ok(renderMd('**bold**').includes('<strong>bold</strong>'));
  });

  it('renders italic', () => {
    assert.ok(renderMd('*italic*').includes('<em>italic</em>'));
  });

  it('renders inline code', () => {
    assert.ok(renderMd('`code`').includes('<code>code</code>'));
  });

  it('renders links', () => {
    const result = renderMd('[text](https://example.com)');
    assert.ok(result.includes('<a href="https://example.com">text</a>'));
  });

  it('strips dangerous tags entirely', () => {
    // renderMd now passes safe HTML through verbatim but strips a
    // blacklist of dangerous tags (script, iframe, style, etc.).
    const result = renderMd('<script>alert("xss")</script>');
    assert.ok(!result.includes('<script>'));
    assert.ok(!result.includes('alert'));  // body of script tag also gone
  });

  it('passes safe inline HTML through', () => {
    // Centered images and other inline HTML (common in imported notebooks)
    // should render rather than appear as escaped text.
    const result = renderMd('<p align="center"><img src="logo.png" /></p>');
    assert.ok(result.includes('<img src="logo.png"'));
    assert.ok(result.includes('align="center"'));
  });

  it('renders h4, h5, h6', () => {
    assert.ok(renderMd('#### four').includes('<h4>four</h4>'));
    assert.ok(renderMd('##### five').includes('<h5>five</h5>'));
    assert.ok(renderMd('###### six').includes('<h6>six</h6>'));
  });

  it('renders image syntax', () => {
    const result = renderMd('![alt text](img.png)');
    assert.ok(result.includes('<img src="img.png"'));
    assert.ok(result.includes('alt="alt text"'));
  });

  it('rejects javascript: URLs in images', () => {
    const result = renderMd('![alt](javascript:alert(1))');
    assert.ok(!result.includes('<img'));
    assert.ok(result.includes('alt'));  // alt text remains as plain text
  });

  it('allows data:image URLs (inline images)', () => {
    const result = renderMd('![chart](data:image/png;base64,iVBOR)');
    assert.ok(result.includes('<img src="data:image/png;base64,iVBOR"'));
  });

  it('renders unordered lists', () => {
    const result = renderMd('- one\n- two\n- three');
    assert.ok(result.includes('<ul>'));
    assert.ok(result.includes('<li>one</li>'));
    assert.ok(result.includes('<li>three</li>'));
  });

  it('renders ordered lists', () => {
    const result = renderMd('1. first\n2. second');
    assert.ok(result.includes('<ol>'));
    assert.ok(result.includes('<li>first</li>'));
  });

  it('renders fenced code blocks', () => {
    const result = renderMd('```js\nconst x = 1;\n```');
    assert.ok(result.includes('<pre><code class="language-js">'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('strips on*= event handlers', () => {
    const result = renderMd('<a href="x" onclick="evil()">link</a>');
    assert.ok(!result.includes('onclick'));
    assert.ok(!result.includes('evil'));
    assert.ok(result.includes('href="x"'));
  });

  it('wraps plain text in paragraphs', () => {
    const result = renderMd('hello');
    assert.ok(result.startsWith('<p>'));
  });

  it('handles paragraph breaks', () => {
    const result = renderMd('first\n\nsecond');
    // Each paragraph wrapped individually now (joined by '\n'), not glued
    // with </p><p>. Check for two separate <p>...</p> blocks instead.
    const matches = result.match(/<p>[^<]*<\/p>/g) || [];
    assert.ok(matches.length >= 2);
    assert.ok(result.includes('first'));
    assert.ok(result.includes('second'));
  });

  it('handles empty string', () => {
    const result = renderMd('');
    assert.strictEqual(typeof result, 'string');
  });

  it('renders a simple table', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const result = renderMd(md);
    assert.ok(result.includes('<table>'));
    assert.ok(result.includes('<th>a</th>'));
    assert.ok(result.includes('<td>1</td>'));
    assert.ok(result.includes('<td>2</td>'));
  });

  it('renders table with bold in cells', () => {
    const md = '| feature | where |\n|---------|-------|\n| **SIMD** | cx.mul |';
    const result = renderMd(md);
    assert.ok(result.includes('<strong>SIMD</strong>'));
    assert.ok(result.includes('<td>cx.mul</td>'));
  });

  it('does not treat non-table pipes as table', () => {
    const result = renderMd('a | b');
    assert.ok(!result.includes('<table>'));
  });

  it('rejects javascript: URIs in links', () => {
    const result = renderMd('[click](javascript:alert("xss"))');
    assert.ok(!result.includes('href'));
    assert.ok(result.includes('click'));
  });

  it('rejects data: URIs in links', () => {
    const result = renderMd('[click](data:text/html,<img>)');
    assert.ok(!result.includes('href'));
  });

  it('rejects vbscript: URIs in links', () => {
    const result = renderMd('[click](vbscript:msgbox)');
    assert.ok(!result.includes('href'));
  });

  it('allows normal URLs in links', () => {
    const result = renderMd('[site](https://example.com)');
    assert.ok(result.includes('href="https://example.com"'));
  });

  it('allows relative URLs in links', () => {
    const result = renderMd('[page](./other.html)');
    assert.ok(result.includes('href="./other.html"'));
  });
});
