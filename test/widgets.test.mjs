// shim document for state.js import
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtmlDefines } from '../src/js/dag.js';

// ── parseHtmlDefines ──

describe('parseHtmlDefines', () => {
  it('extracts name from audit-slider', () => {
    const defines = parseHtmlDefines('<audit-slider name="x" min="0" max="10"></audit-slider>');
    assert.ok(defines.has('x'));
    assert.strictEqual(defines.size, 1);
  });

  it('extracts name from audit-dropdown', () => {
    const defines = parseHtmlDefines('<audit-dropdown name="mode" options="a,b,c"></audit-dropdown>');
    assert.ok(defines.has('mode'));
  });

  it('extracts name from audit-checkbox', () => {
    const defines = parseHtmlDefines('<audit-checkbox name="enabled" label="Enable"></audit-checkbox>');
    assert.ok(defines.has('enabled'));
  });

  it('extracts name from audit-text-input', () => {
    const defines = parseHtmlDefines('<audit-text-input name="query"></audit-text-input>');
    assert.ok(defines.has('query'));
  });

  it('returns empty set for no widgets', () => {
    const defines = parseHtmlDefines('<p>hello world</p>');
    assert.strictEqual(defines.size, 0);
  });

  it('extracts multiple widget names', () => {
    const html = '<audit-slider name="x"></audit-slider><audit-slider name="y"></audit-slider>';
    const defines = parseHtmlDefines(html);
    assert.ok(defines.has('x'));
    assert.ok(defines.has('y'));
    assert.strictEqual(defines.size, 2);
  });

  it('skips widgets without name attribute', () => {
    const defines = parseHtmlDefines('<audit-slider min="0" max="10"></audit-slider>');
    assert.strictEqual(defines.size, 0);
  });

  it('handles mixed content with widgets', () => {
    const html = '<p>Power: ${power}</p>\n<audit-slider name="power" min="0" max="100"></audit-slider>';
    const defines = parseHtmlDefines(html);
    assert.ok(defines.has('power'));
    assert.strictEqual(defines.size, 1);
  });

  it('does not match non-audit elements with name attribute', () => {
    const defines = parseHtmlDefines('<input name="x"><div name="y"></div>');
    assert.strictEqual(defines.size, 0);
  });

  it('handles self-closing style', () => {
    const defines = parseHtmlDefines('<audit-slider name="val" />');
    assert.ok(defines.has('val'));
  });
});
