// shim document for state.js import
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseNames, findUses, findHtmlUses, isManual } from '../src/js/dag.js';

// ── isManual ──

describe('isManual', () => {
  it('detects // %manual at start', () => {
    assert.ok(isManual('// %manual\nconst x = 1;'));
  });
  it('detects with leading whitespace', () => {
    assert.ok(isManual('  // %manual'));
  });
  it('rejects without directive', () => {
    assert.ok(!isManual('const x = 1;'));
  });
  it('rejects %manual in middle of code', () => {
    assert.ok(!isManual('const x = 1;\n// %manual'));
  });
});

// ── parseNames ──

describe('parseNames', () => {
  it('simple const', () => {
    const { defines } = parseNames('const x = 1;');
    assert.ok(defines.has('x'));
    assert.strictEqual(defines.size, 1);
  });

  it('simple let', () => {
    const { defines } = parseNames('let y = 2;');
    assert.ok(defines.has('y'));
  });

  it('simple var', () => {
    const { defines } = parseNames('var z = 3;');
    assert.ok(defines.has('z'));
  });

  it('function declaration', () => {
    const { defines } = parseNames('function foo() { return 1; }');
    assert.ok(defines.has('foo'));
    assert.strictEqual(defines.size, 1);
  });

  it('comma-separated declarations', () => {
    const { defines } = parseNames('const a = 1, b = 2, c = 3;');
    assert.ok(defines.has('a'));
    assert.ok(defines.has('b'));
    assert.ok(defines.has('c'));
    assert.strictEqual(defines.size, 3);
  });

  it('object destructuring', () => {
    const { defines } = parseNames('const { a, b } = obj;');
    assert.ok(defines.has('a'));
    assert.ok(defines.has('b'));
    assert.strictEqual(defines.size, 2);
  });

  it('object destructuring with rename', () => {
    const { defines } = parseNames('const { x: localX, y: localY } = point;');
    assert.ok(defines.has('localX'));
    assert.ok(defines.has('localY'));
    assert.ok(!defines.has('x'));
    assert.ok(!defines.has('y'));
  });

  it('array destructuring', () => {
    const { defines } = parseNames('const [first, second] = arr;');
    assert.ok(defines.has('first'));
    assert.ok(defines.has('second'));
  });

  it('does NOT capture inner declarations', () => {
    const { defines } = parseNames('function outer() { const inner = 1; }');
    assert.ok(defines.has('outer'));
    assert.ok(!defines.has('inner'));
  });

  it('does NOT capture declarations inside blocks', () => {
    const { defines } = parseNames('if (true) { const inside = 1; }');
    assert.ok(!defines.has('inside'));
  });

  it('handles multiple top-level declarations', () => {
    const code = 'const x = 1;\nlet y = 2;\nfunction f() {}';
    const { defines } = parseNames(code);
    assert.ok(defines.has('x'));
    assert.ok(defines.has('y'));
    assert.ok(defines.has('f'));
    assert.strictEqual(defines.size, 3);
  });

  it('ignores declarations in strings', () => {
    const { defines } = parseNames('const msg = "const y = 2";');
    assert.ok(defines.has('msg'));
    assert.ok(!defines.has('y'));
  });

  it('ignores declarations in comments', () => {
    const { defines } = parseNames('// const y = 2\nconst x = 1;');
    assert.ok(defines.has('x'));
    assert.ok(!defines.has('y'));
  });

  it('handles empty code', () => {
    const { defines } = parseNames('');
    assert.strictEqual(defines.size, 0);
  });

  it('comma-separated with complex initializers', () => {
    const { defines } = parseNames('const W = 80, H = 60;');
    assert.ok(defines.has('W'));
    assert.ok(defines.has('H'));
  });
});

// ── findUses ──

describe('findUses', () => {
  it('finds references to defined names', () => {
    const allDefined = new Set(['x', 'y']);
    const uses = findUses('const z = x + y;', allDefined);
    assert.ok(uses.has('x'));
    assert.ok(uses.has('y'));
    assert.ok(!uses.has('z'));
  });

  it('does not include self-defined names', () => {
    const allDefined = new Set(['x']);
    const uses = findUses('const x = 1;', allDefined);
    assert.ok(!uses.has('x'));
  });

  it('ignores names in strings', () => {
    const allDefined = new Set(['x']);
    const uses = findUses('const msg = "x is here";', allDefined);
    assert.ok(!uses.has('x'));
  });

  it('ignores names in comments', () => {
    const allDefined = new Set(['x']);
    const uses = findUses('// use x here\nconst z = 1;', allDefined);
    assert.ok(!uses.has('x'));
  });

  it('returns empty for no matches', () => {
    const allDefined = new Set(['x']);
    const uses = findUses('const z = 1;', allDefined);
    assert.strictEqual(uses.size, 0);
  });
});

// ── findHtmlUses ──

describe('findHtmlUses', () => {
  it('finds variables in template expressions', () => {
    const allDefined = new Set(['name', 'age']);
    const uses = findHtmlUses('<p>${name} is ${age}</p>', allDefined);
    assert.ok(uses.has('name'));
    assert.ok(uses.has('age'));
  });

  it('finds variables in complex expressions', () => {
    const allDefined = new Set(['value', 'unit']);
    const uses = findHtmlUses('<span>${value.toFixed(2)} ${unit}</span>', allDefined);
    assert.ok(uses.has('value'));
    assert.ok(uses.has('unit'));
  });

  it('ignores text outside expressions', () => {
    const allDefined = new Set(['name']);
    const uses = findHtmlUses('<p>name is not referenced</p>', allDefined);
    assert.strictEqual(uses.size, 0);
  });

  it('returns empty for no expressions', () => {
    const allDefined = new Set(['x']);
    const uses = findHtmlUses('<p>hello</p>', allDefined);
    assert.strictEqual(uses.size, 0);
  });
});
