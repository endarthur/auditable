import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── shim DOM ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
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

// ── import modules under test ──
const { pythonParseNames, pythonFindUses } = await import('../ext/adder/src/cell.js');
const { tokenizePython, pythonCompletions, PYTHON_KEYWORDS, PYTHON_BUILTINS } = await import('../ext/adder/src/highlight.js');

// ── pythonParseNames ──

describe('pythonParseNames', () => {
  it('simple assignment', () => {
    assert.deepStrictEqual(pythonParseNames('x = 42'), new Set(['x']));
  });

  it('annotated assignment', () => {
    assert.deepStrictEqual(pythonParseNames('x: int = 42'), new Set(['x']));
  });

  it('tuple unpacking', () => {
    assert.deepStrictEqual(pythonParseNames('x, y = 1, 2'), new Set(['x', 'y']));
  });

  it('def', () => {
    assert.deepStrictEqual(pythonParseNames('def foo():\n    return 1'), new Set(['foo']));
  });

  it('async def', () => {
    assert.deepStrictEqual(pythonParseNames('async def bar():\n    await something()'), new Set(['bar']));
  });

  it('class', () => {
    assert.deepStrictEqual(pythonParseNames('class MyClass:\n    pass'), new Set(['MyClass']));
  });

  it('import', () => {
    assert.deepStrictEqual(pythonParseNames('import numpy'), new Set(['numpy']));
  });

  it('import as', () => {
    assert.deepStrictEqual(pythonParseNames('import numpy as np'), new Set(['np']));
  });

  it('from import', () => {
    assert.deepStrictEqual(pythonParseNames('from os import path, getcwd'), new Set(['path', 'getcwd']));
  });

  it('from import as', () => {
    assert.deepStrictEqual(pythonParseNames('from os import path as p, getcwd as cwd'), new Set(['p', 'cwd']));
  });

  it('skips indented assignments', () => {
    const code = 'if True:\n    inner = 1\nx = 2';
    assert.deepStrictEqual(pythonParseNames(code), new Set(['x']));
  });

  it('skips for loop variables', () => {
    assert.deepStrictEqual(pythonParseNames('for i in range(10):\n    pass'), new Set());
  });

  it('skips with-as variables', () => {
    assert.deepStrictEqual(pythonParseNames('with open("f") as f:\n    pass'), new Set());
  });

  it('multiple defines', () => {
    const code = 'x = 1\ny = 2\ndef greet():\n    pass\nclass Foo:\n    pass';
    assert.deepStrictEqual(pythonParseNames(code), new Set(['x', 'y', 'greet', 'Foo']));
  });

  it('skips comments', () => {
    assert.deepStrictEqual(pythonParseNames('# x = 1\ny = 2'), new Set(['y']));
  });

  it('skips keyword-starting lines', () => {
    // 'if' starts the line — should not be a define
    assert.ok(!pythonParseNames('if x > 0:').has('if'));
  });
});

// ── pythonFindUses ──

describe('pythonFindUses', () => {
  it('finds upstream references', () => {
    const code = 'y = x + 1';
    const allDefined = new Set(['x', 'z']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(uses.has('x'));
    assert.ok(!uses.has('z'));
  });

  it('excludes self-defines', () => {
    const code = 'x = 42\ny = x + 1';
    const allDefined = new Set(['x', 'other']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(!uses.has('x')); // x is self-defined
    assert.ok(!uses.has('other'));
  });

  it('ignores names in strings', () => {
    const code = 'y = "x is a string"';
    const allDefined = new Set(['x']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(!uses.has('x'));
  });

  it('ignores names in comments', () => {
    const code = '# using x here\ny = 42';
    const allDefined = new Set(['x']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(!uses.has('x'));
  });

  it('finds function call references', () => {
    const code = 'result = compute(data)';
    const allDefined = new Set(['compute', 'data', 'other']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(uses.has('compute'));
    assert.ok(uses.has('data'));
    assert.ok(!uses.has('other'));
  });

  it('handles triple-quoted strings', () => {
    const code = '"""x = 1"""\ny = 2';
    const allDefined = new Set(['x']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(!uses.has('x'));
  });
});

// ── tokenizePython ──

describe('tokenizePython', () => {
  it('tokenizes keywords', () => {
    const tokens = tokenizePython('def foo');
    const kw = tokens.find(t => t.type === 'kw');
    assert.ok(kw);
    assert.strictEqual(kw.text, 'def');
  });

  it('tokenizes builtin functions', () => {
    const tokens = tokenizePython('print("hi")');
    const fn = tokens.find(t => t.type === 'fn');
    assert.ok(fn);
    assert.strictEqual(fn.text, 'print');
  });

  it('tokenizes strings', () => {
    const tokens = tokenizePython('"hello"');
    const str = tokens.find(t => t.type === 'str');
    assert.ok(str);
    assert.strictEqual(str.text, '"hello"');
  });

  it('tokenizes single-quoted strings', () => {
    const tokens = tokenizePython("'world'");
    const str = tokens.find(t => t.type === 'str');
    assert.ok(str);
  });

  it('tokenizes triple-quoted strings', () => {
    const code = '"""multi\nline"""';
    const tokens = tokenizePython(code);
    const str = tokens.find(t => t.type === 'str');
    assert.ok(str);
    assert.strictEqual(str.text, code);
  });

  it('tokenizes f-strings', () => {
    const code = 'f"hello {name}"';
    const tokens = tokenizePython(code);
    const str = tokens.find(t => t.type === 'str');
    assert.ok(str);
  });

  it('tokenizes numbers', () => {
    const tokens = tokenizePython('42');
    const num = tokens.find(t => t.type === 'num');
    assert.ok(num);
    assert.strictEqual(num.text, '42');
  });

  it('tokenizes hex numbers', () => {
    const tokens = tokenizePython('0xFF');
    const num = tokens.find(t => t.type === 'num');
    assert.ok(num);
  });

  it('tokenizes floats', () => {
    const tokens = tokenizePython('3.14');
    const num = tokens.find(t => t.type === 'num');
    assert.ok(num);
    assert.strictEqual(num.text, '3.14');
  });

  it('tokenizes comments', () => {
    const tokens = tokenizePython('# a comment');
    const cmt = tokens.find(t => t.type === 'cmt');
    assert.ok(cmt);
  });

  it('tokenizes decorators', () => {
    const code = '@property\ndef x(): pass';
    const tokens = tokenizePython(code);
    const dec = tokens.find(t => t.type === 'dec');
    assert.ok(dec);
    assert.strictEqual(dec.text, '@property');
  });

  it('tokenizes operators', () => {
    const tokens = tokenizePython('x + y');
    const op = tokens.find(t => t.type === 'op');
    assert.ok(op);
  });

  it('handles empty input', () => {
    const tokens = tokenizePython('');
    assert.strictEqual(tokens.length, 0);
  });

  it('handles complex code', () => {
    const code = 'def greet(name):\n    print(f"Hello, {name}!")\n    return True';
    const tokens = tokenizePython(code);
    assert.ok(tokens.length > 0);
    // should have keywords (def, return, True), builtins (print), strings, identifiers
    assert.ok(tokens.some(t => t.type === 'kw'));
    assert.ok(tokens.some(t => t.type === 'fn'));
    assert.ok(tokens.some(t => t.type === 'str'));
    assert.ok(tokens.some(t => t.type === 'id'));
  });
});

// ── pythonCompletions ──

describe('pythonCompletions', () => {
  it('returns matching keywords', () => {
    const results = pythonCompletions('de');
    assert.ok(results.includes('def'));
    assert.ok(results.includes('del'));
  });

  it('returns matching builtins', () => {
    const results = pythonCompletions('pri');
    assert.ok(results.includes('print'));
  });

  it('case insensitive', () => {
    const results = pythonCompletions('TRUE');
    assert.ok(results.includes('True'));
  });

  it('returns empty for no matches', () => {
    const results = pythonCompletions('zzzzz');
    assert.strictEqual(results.length, 0);
  });
});
