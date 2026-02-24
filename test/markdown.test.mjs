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

  it('escapes HTML entities', () => {
    const result = renderMd('<script>alert("xss")</script>');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });

  it('wraps plain text in paragraphs', () => {
    const result = renderMd('hello');
    assert.ok(result.startsWith('<p>'));
  });

  it('handles paragraph breaks', () => {
    const result = renderMd('first\n\nsecond');
    assert.ok(result.includes('</p><p>'));
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
});
