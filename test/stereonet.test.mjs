// @gcu/stereonet — pure parser unit tests (parseCell + scope-name extraction).
// The host-facing half (cell registration, render, arcball, ctx.display, the
// reactive handle) is exercised end-to-end in test/works-smoke.mjs.
//
// index.js's registration block is guarded by `typeof window !== 'undefined'`,
// so importing it in Node is side-effect-free.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCell, stereonetParseNames, stereonetFindUses } from '../ext/stereonet/index.js';

describe('stereonet parseCell', () => {
  it('defaults: equal-area, name "stereonet", no contour, no items', () => {
    const s = parseCell('');
    assert.equal(s.projection, 'equal-area');
    assert.equal(s.name, 'stereonet');
    assert.equal(s.contour, false);
    assert.equal(s.view, null);
    assert.deepEqual(s.items, []);
  });

  it('name directive sets the scope name', () => {
    assert.equal(parseCell('name bedding').name, 'bedding');
  });

  it('proj: equal-angle / wulff map to equal-angle, else equal-area', () => {
    assert.equal(parseCell('proj equal-angle').projection, 'equal-angle');
    assert.equal(parseCell('proj wulff').projection, 'equal-angle');
    assert.equal(parseCell('proj equal-area').projection, 'equal-area');
    assert.equal(parseCell('projection schmidt').projection, 'equal-area');
  });

  it('view sets the centre [trend, plunge]', () => {
    assert.deepEqual(parseCell('view 120 30').view, [120, 30]);
  });

  it('plane / pole / line push typed items with a + b', () => {
    const s = parseCell('plane 120 35\npole 210 65\nline 30 12');
    assert.equal(s.items.length, 3);
    assert.deepEqual(s.items[0], { kind: 'plane', a: 120, b: 35, color: undefined, group: null });
    assert.equal(s.items[1].kind, 'pole');
    assert.equal(s.items[2].kind, 'line');
    assert.equal(s.items[2].a, 30);
    assert.equal(s.items[2].b, 12);
  });

  it('captures a hex colour on an item', () => {
    const s = parseCell('pole 210 65 #cc3333');
    assert.equal(s.items[0].color, '#cc3333');
  });

  it('group (g) applies to subsequent items until changed', () => {
    const s = parseCell('g foliation\nplane 120 35\ng faults\npole 210 65');
    assert.equal(s.items[0].group, 'foliation');
    assert.equal(s.items[1].group, 'faults');
  });

  it('contour directive sets the flag', () => {
    assert.equal(parseCell('contour').contour, true);
  });

  it('skips blank lines and ; / // comments', () => {
    const s = parseCell('\n; a comment\n// another\nplane 120 35\n   \n');
    assert.equal(s.items.length, 1);
  });

  it('ignores unknown directives (forward-compatible)', () => {
    const s = parseCell('wibble 1 2 3\nplane 120 35');
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].kind, 'plane');
  });

  it('a full cell parses coherently', () => {
    const code = [
      'name bedding', 'proj equal-area', 'view 120 30',
      'g foliation', 'plane 120 35', 'plane 125 40',
      'pole 210 65 #cc3333', 'contour',
    ].join('\n');
    const s = parseCell(code);
    assert.equal(s.name, 'bedding');
    assert.deepEqual(s.view, [120, 30]);
    assert.equal(s.items.length, 3);
    assert.equal(s.items.filter((i) => i.group === 'foliation').length, 3);
    assert.equal(s.items[2].color, '#cc3333');
    assert.equal(s.contour, true);
  });
});

describe('stereonet scope wiring', () => {
  it('parseNames returns the single defined name', () => {
    assert.deepEqual([...stereonetParseNames('name bedding\nplane 1 2')], ['bedding']);
    assert.deepEqual([...stereonetParseNames('plane 1 2')], ['stereonet']);   // default
  });
  it('findUses is empty (self-contained data, no upstream refs)', () => {
    assert.equal(stereonetFindUses().size, 0);
  });
});
