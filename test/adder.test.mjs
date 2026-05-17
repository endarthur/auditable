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
const { adderParse } = await import('../ext/adder/src/parse.js');

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

  it('string-literal import', () => {
    assert.deepStrictEqual(pythonParseNames('import "./utils.py" as utils'), new Set(['utils']));
  });

  it('string-literal from-import', () => {
    assert.deepStrictEqual(pythonParseNames('from "./utils.py" import foo, bar'), new Set(['foo', 'bar']));
  });

  it('string-literal from-import with aliases', () => {
    assert.deepStrictEqual(pythonParseNames('from "https://example.com/lib.py" import foo as f, bar'), new Set(['f', 'bar']));
  });

  it('string-literal import without alias throws', () => {
    // Use the raw parser — pythonParseNames falls back to regex on parse errors.
    assert.throws(() => adderParse('import "./utils.py"'), /path imports require 'as/);
  });

  it('string-literal import AST shape', () => {
    const ast = adderParse('import "./utils.py" as utils');
    assert.equal(ast.body[0].type, 'Import');
    assert.equal(ast.body[0].names[0].path, './utils.py');
    assert.equal(ast.body[0].names[0].alias, 'utils');
    assert.equal(ast.body[0].names[0].module, undefined);
  });

  it('string-literal from-import AST shape', () => {
    const ast = adderParse('from "./utils.py" import foo, bar as b');
    assert.equal(ast.body[0].type, 'ImportFrom');
    assert.equal(ast.body[0].path, './utils.py');
    assert.equal(ast.body[0].module, undefined);
    assert.deepStrictEqual(ast.body[0].names, [{ name: 'foo', alias: null }, { name: 'bar', alias: 'b' }]);
  });

  it('captures assignments inside if blocks', () => {
    const code = 'if True:\n    inner = 1\nx = 2';
    assert.deepStrictEqual(pythonParseNames(code), new Set(['inner', 'x']));
  });

  it('captures for loop variables', () => {
    assert.deepStrictEqual(pythonParseNames('for i in range(10):\n    pass'), new Set(['i']));
  });

  it('captures with-as variables', () => {
    assert.deepStrictEqual(pythonParseNames('with open("f") as f:\n    pass'), new Set(['f']));
  });

  it('captures assignments inside with blocks', () => {
    const code = 'with open("data.csv") as f:\n    header = f.readline()\n    rows = f.readlines()';
    const names = pythonParseNames(code);
    assert.ok(names.has('f'));
    assert.ok(names.has('header'));
    assert.ok(names.has('rows'));
  });

  it('does NOT capture assignments inside def', () => {
    const code = 'def foo():\n    local = 42\n    return local';
    assert.deepStrictEqual(pythonParseNames(code), new Set(['foo']));
  });

  it('does NOT capture assignments inside class', () => {
    const code = 'class Foo:\n    bar = 1';
    assert.deepStrictEqual(pythonParseNames(code), new Set(['Foo']));
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

  it('includes re-bound names that are also defined upstream', () => {
    // `x = 42; y = x + 1` — if x is also in allDefined (defined by an
    // upstream cell), the RHS read `x + 1` IS a use even though `x = 42`
    // also defines x locally. Excluding self-defines here breaks the
    // `df = df.rename(...)` rebind pattern because auditable's exec
    // builds the cell's upstream scope from cell.uses — omitting x
    // means the cell never receives the upstream value.
    const code = 'x = 42\ny = x + 1';
    const allDefined = new Set(['x', 'other']);
    const uses = pythonFindUses(code, allDefined);
    assert.ok(uses.has('x'), 'x is read on RHS AND in allDefined → use');
    assert.ok(!uses.has('other'), 'other never appears in code');
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

// ── filesystem tests ──

// Import evaluator components for fs tests
// (adderParse already imported above)
const { adderEval, AdderScope } = await import('../ext/adder/src/eval.js');
const { adderBuiltins, setAdderVFS, getAdderVFS } = await import('../ext/adder/src/builtins.js');

// Import VFS for test backend
let VFS, vfsPath;
try {
  ({ VFS } = await import('../ext/vfs/src/vfs.js'));
  ({ path: vfsPath } = await import('../ext/vfs/src/path.js'));
} catch (e) {
  console.log('VFS import failed, skipping fs tests:', e.message);
}

// Helper: execute Python code and return results
async function pyExec(code) {
  const ast = adderParse(code);
  const scope = new AdderScope();
  const output = [];
  const builtins = adderBuiltins((text) => output.push(text));
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  const lastExpr = await adderEval(ast, scope);
  const printOutput = output.join('');
  return {
    lastExpr, scope,
    output: printOutput.endsWith('\n') ? printOutput.slice(0, -1) : printOutput,
    get(name) { return scope.vars.get(name); },
  };
}

// Helper: fresh VFS before each test group
async function freshVFS() {
  const vfs = await VFS.create();
  await vfs.mkdir('/home/nb', { recursive: true });
  await vfs.mkdir('/usr/lib/python', { recursive: true });
  await vfs.mkdir('/tmp');
  setAdderVFS(vfs, vfsPath);
}

describe('float/int conversion', () => {
  it('float valid string', async () => {
    const r = await pyExec('x = float("3.14")');
    assert.strictEqual(r.get('x'), 3.14);
  });

  it('float invalid string raises ValueError', async () => {
    await assert.rejects(() => pyExec('x = float("fe")'), (e) => e.pyType === 'ValueError');
  });

  it('float empty string raises ValueError', async () => {
    await assert.rejects(() => pyExec('x = float("")'), (e) => e.pyType === 'ValueError');
  });

  it('float inf/nan', async () => {
    const r = await pyExec('a = float("inf")\nb = float("-inf")\nc = float("nan")');
    assert.strictEqual(r.get('a'), Infinity);
    assert.strictEqual(r.get('b'), -Infinity);
    assert.ok(Number.isNaN(r.get('c')));
  });

  it('float no args', async () => {
    const r = await pyExec('x = float()');
    assert.strictEqual(r.get('x'), 0.0);
  });

  it('int valid string', async () => {
    const r = await pyExec('x = int("42")');
    assert.strictEqual(r.get('x'), 42);
  });

  it('int invalid string raises ValueError', async () => {
    await assert.rejects(() => pyExec('x = int("hello")'), (e) => e.pyType === 'ValueError');
  });

  it('int with base', async () => {
    const r = await pyExec('x = int("ff", 16)');
    assert.strictEqual(r.get('x'), 255);
  });

  it('int invalid string with base raises ValueError', async () => {
    await assert.rejects(() => pyExec('x = int("zz", 16)'), (e) => e.pyType === 'ValueError');
  });
});

describe('arithmetic type safety', () => {
  it('str + str works', async () => {
    const r = await pyExec('x = "hello" + " world"');
    assert.strictEqual(r.get('x'), 'hello world');
  });

  it('num + num works', async () => {
    const r = await pyExec('x = 3 + 4');
    assert.strictEqual(r.get('x'), 7);
  });

  it('str + int raises TypeError', async () => {
    await assert.rejects(() => pyExec('x = "fe" + 2'), (e) => e.pyType === 'TypeError');
  });

  it('int + str raises TypeError', async () => {
    await assert.rejects(() => pyExec('x = 2 + "fe"'), (e) => e.pyType === 'TypeError');
  });

  it('str * int works (repeat)', async () => {
    const r = await pyExec('x = "ab" * 3');
    assert.strictEqual(r.get('x'), 'ababab');
  });

  it('str - int raises TypeError', async () => {
    await assert.rejects(() => pyExec('x = "a" - 1'), (e) => e.pyType === 'TypeError');
  });

  it('str / int raises TypeError', async () => {
    await assert.rejects(() => pyExec('x = "a" / 2'), (e) => e.pyType === 'TypeError');
  });

  it('list + list works', async () => {
    const r = await pyExec('x = [1, 2] + [3, 4]');
    assert.deepStrictEqual(r.get('x'), [1, 2, 3, 4]);
  });

  it('list + int raises TypeError', async () => {
    await assert.rejects(() => pyExec('x = [1] + 2'), (e) => e.pyType === 'TypeError');
  });
});

describe('slice assignment', () => {
  it('simple slice replace, same length', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\nx[1:3] = [98, 99]');
    assert.deepEqual(r.get('x'), [10, 98, 99, 40]);
  });

  it('simple slice replace, shrink', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\nx[1:3] = [99]');
    assert.deepEqual(r.get('x'), [10, 99, 40]);
  });

  it('simple slice replace, grow', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\nx[1:3] = [98, 99, 100]');
    assert.deepEqual(r.get('x'), [10, 98, 99, 100, 40]);
  });

  it('empty-slice insert', async () => {
    const r = await pyExec('x = [10, 20, 30]\nx[2:2] = [98, 99]');
    assert.deepEqual(r.get('x'), [10, 20, 98, 99, 30]);
  });

  it('full-replace via x[:]', async () => {
    const r = await pyExec('x = [10, 20, 30]\nx[:] = [1, 2, 3, 4]');
    assert.deepEqual(r.get('x'), [1, 2, 3, 4]);
  });

  it('negative bounds', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\nx[-2:] = [98, 99, 100]');
    assert.deepEqual(r.get('x'), [10, 20, 98, 99, 100]);
  });

  it('out-of-bounds upper clamps', async () => {
    const r = await pyExec('x = [10, 20, 30]\nx[10:20] = [99]');
    assert.deepEqual(r.get('x'), [10, 20, 30, 99]);
  });

  it('extended slice with step', async () => {
    const r = await pyExec('x = [10, 20, 30, 40, 50]\nx[::2] = [98, 99, 100]');
    assert.deepEqual(r.get('x'), [98, 20, 99, 40, 100]);
  });

  it('extended slice size mismatch raises ValueError', async () => {
    await assert.rejects(
      () => pyExec('x = [10, 20, 30, 40, 50]\nx[::2] = [98, 99]'),
      (e) => e.pyType === 'ValueError',
    );
  });

  it('step zero raises ValueError', async () => {
    await assert.rejects(
      () => pyExec('x = [1, 2, 3]\nx[::0] = [9]'),
      (e) => e.pyType === 'ValueError',
    );
  });

  it('string slice assignment raises TypeError', async () => {
    await assert.rejects(
      () => pyExec('s = "hello"\ns[1:3] = "x"'),
      (e) => e.pyType === 'TypeError',
    );
  });

  it('fannkuch reverse-in-place idiom', async () => {
    const r = await pyExec('p = [1, 2, 3, 4, 5]\np[:3] = p[2::-1]');
    assert.deepEqual(r.get('p'), [3, 2, 1, 4, 5]);
  });

  it('augmented slice assignment', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\nx[1:3] += [98]');
    assert.deepEqual(r.get('x'), [10, 20, 30, 98, 40]);
  });
});

describe('negative-index assignment', () => {
  it('arr[-1] = v writes to last slot', async () => {
    const r = await pyExec('x = [10, 20, 30]\nx[-1] = 99');
    assert.deepEqual(r.get('x'), [10, 20, 99]);
  });

  it('arr[-2] = v writes correctly', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\nx[-2] = 99');
    assert.deepEqual(r.get('x'), [10, 20, 99, 40]);
  });

  it('swap idiom: arr[i], arr[-j] = arr[-j], arr[i]', async () => {
    const r = await pyExec('x = [0, 1, 2, 3]\nj = 1\nx[2], x[-j] = x[-j], x[2]');
    assert.deepEqual(r.get('x'), [0, 1, 3, 2]);
  });

  it('del arr[-1] removes last element', async () => {
    const r = await pyExec('x = [10, 20, 30]\ndel x[-1]');
    assert.deepEqual(r.get('x'), [10, 20]);
  });
});

describe('slice deletion', () => {
  it('simple slice delete', async () => {
    const r = await pyExec('x = [10, 20, 30, 40]\ndel x[1:3]');
    assert.deepEqual(r.get('x'), [10, 40]);
  });

  it('full delete via x[:]', async () => {
    const r = await pyExec('x = [10, 20, 30]\ndel x[:]');
    assert.deepEqual(r.get('x'), []);
  });

  it('extended slice delete', async () => {
    const r = await pyExec('x = [10, 20, 30, 40, 50]\ndel x[::2]');
    assert.deepEqual(r.get('x'), [20, 40]);
  });

  it('reverse extended slice delete', async () => {
    const r = await pyExec('x = [10, 20, 30, 40, 50]\ndel x[::-2]');
    assert.deepEqual(r.get('x'), [20, 40]);
  });

  it('string slice delete raises TypeError', async () => {
    await assert.rejects(
      () => pyExec('s = "hello"\ndel s[1:3]'),
      (e) => e.pyType === 'TypeError',
    );
  });
});

if (VFS) {

describe('open() builtin', () => {
  it('write and read text file', async () => {
    await freshVFS();
    const r = await pyExec(`
f = open('/hello.txt', 'w')
f.write('hello world')
f.close()
f2 = open('/hello.txt', 'r')
content = f2.read()
f2.close()
`);
    assert.strictEqual(r.get('content'), 'hello world');
  });

  it('write and read binary file', async () => {
    await freshVFS();
    const r = await pyExec(`
f = open('/data.bin', 'wb')
f.write('HI')
f.close()
f2 = open('/data.bin', 'rb')
data = f2.read()
f2.close()
size = len(data)
`);
    assert.strictEqual(r.get('size'), 2);
    assert.strictEqual(r.get('data')[0], 72);
    assert.strictEqual(r.get('data')[1], 73);
  });

  it('append to existing file', async () => {
    await freshVFS();
    const r = await pyExec(`
f = open('/log.txt', 'w')
f.write('line1')
f.close()
f2 = open('/log.txt', 'a')
f2.write('line2')
f2.close()
f3 = open('/log.txt', 'r')
content = f3.read()
f3.close()
`);
    assert.strictEqual(r.get('content'), 'line1line2');
  });

  it('FileNotFoundError for missing file', async () => {
    await freshVFS();
    await assert.rejects(
      () => pyExec(`f = open('/missing.txt', 'r')`),
      (e) => e.pyType === 'FileNotFoundError'
    );
  });

  it('readline()', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/lines.txt', 'first\nsecond\nthird');
    const r = await pyExec(`
f = open('/lines.txt', 'r')
a = f.readline()
b = f.readline()
c = f.readline()
f.close()
`);
    assert.strictEqual(r.get('a'), 'first\n');
    assert.strictEqual(r.get('b'), 'second\n');
    assert.strictEqual(r.get('c'), 'third');
  });

  it('readlines()', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/lines.txt', 'a\nb\nc');
    const r = await pyExec(`
f = open('/lines.txt', 'r')
lines = f.readlines()
f.close()
count = len(lines)
`);
    assert.strictEqual(r.get('count'), 3);
  });

  it('context manager (with)', async () => {
    await freshVFS();
    const r = await pyExec(`
with open('/ctx.txt', 'w') as f:
    f.write('context managed')
with open('/ctx.txt', 'r') as f:
    content = f.read()
`);
    assert.strictEqual(r.get('content'), 'context managed');
  });

  it('for line in file', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/iter.txt', 'x\ny\nz');
    const r = await pyExec(`
f = open('/iter.txt', 'r')
lines = []
for line in f:
    lines.append(line)
f.close()
count = len(lines)
`);
    assert.strictEqual(r.get('count'), 3);
  });

  it('readline then iterate skips read lines', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/skip.txt', 'header\nrow1\nrow2\nrow3');
    const r = await pyExec(`
f = open('/skip.txt', 'r')
header = f.readline()
rows = []
for line in f:
    rows.append(line.strip())
f.close()
count = len(rows)
`);
    assert.strictEqual(r.get('header'), 'header\n');
    assert.strictEqual(r.get('count'), 3);
    assert.deepStrictEqual(r.get('rows'), ['row1', 'row2', 'row3']);
  });

  it('read(size) partial read', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/partial.txt', 'abcdef');
    const r = await pyExec(`
f = open('/partial.txt', 'r')
chunk = f.read(3)
rest = f.read()
f.close()
`);
    assert.strictEqual(r.get('chunk'), 'abc');
    assert.strictEqual(r.get('rest'), 'def');
  });

  it('write returns length', async () => {
    await freshVFS();
    const r = await pyExec(`
f = open('/ret.txt', 'w')
n = f.write('hello')
f.close()
`);
    assert.strictEqual(r.get('n'), 5);
  });

  it('append to new file', async () => {
    await freshVFS();
    const r = await pyExec(`
f = open('/new.txt', 'a')
f.write('appended')
f.close()
f2 = open('/new.txt', 'r')
content = f2.read()
f2.close()
`);
    assert.strictEqual(r.get('content'), 'appended');
  });

  it('accepts Path objects', async () => {
    await freshVFS();
    const r = await pyExec(`
from pathlib import Path
p = Path('/pathfile.txt')
f = open(p, 'w')
f.write('via path')
f.close()
f2 = open(p, 'r')
content = f2.read()
f2.close()
`);
    assert.strictEqual(r.get('content'), 'via path');
  });
});

describe('os module', () => {
  it('listdir', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/home/nb/a.txt', 'a');
    await vfs.writeFile('/home/nb/b.txt', 'b');
    const r = await pyExec(`
import os
files = os.listdir('.')
count = len(files)
`);
    assert.strictEqual(r.get('count'), 2);
  });

  it('mkdir', async () => {
    await freshVFS();
    const r = await pyExec(`
import os
os.mkdir('/mydir')
exists = os.path.isdir('/mydir')
`);
    assert.strictEqual(r.get('exists'), true);
  });

  it('makedirs with exist_ok', async () => {
    await freshVFS();
    const r = await pyExec(`
import os
os.makedirs('/a/b/c')
os.makedirs('/a/b/c', exist_ok=True)
exists = os.path.isdir('/a/b/c')
`);
    assert.strictEqual(r.get('exists'), true);
  });

  it('makedirs without exist_ok raises FileExistsError', async () => {
    await freshVFS();
    await assert.rejects(
      () => pyExec(`
import os
os.makedirs('/exists')
os.makedirs('/exists')
`),
      (e) => e.pyType === 'FileExistsError'
    );
  });

  it('remove/unlink', async () => {
    await freshVFS();
    const r = await pyExec(`
import os
with open('/del.txt', 'w') as f:
    f.write('delete me')
os.remove('/del.txt')
exists = os.path.exists('/del.txt')
`);
    assert.strictEqual(r.get('exists'), false);
  });

  it('rename', async () => {
    await freshVFS();
    const r = await pyExec(`
import os
with open('/old.txt', 'w') as f:
    f.write('data')
os.rename('/old.txt', '/new.txt')
old_exists = os.path.exists('/old.txt')
new_exists = os.path.exists('/new.txt')
`);
    assert.strictEqual(r.get('old_exists'), false);
    assert.strictEqual(r.get('new_exists'), true);
  });

  it('stat', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/stat.txt', 'hello');
    const r = await pyExec(`
import os
info = os.stat('/stat.txt')
size = info['st_size']
ftype = info['st_type']
`);
    assert.strictEqual(r.get('size'), 5);
    assert.strictEqual(r.get('ftype'), 'file');
  });

  it('getcwd and chdir', async () => {
    await freshVFS();
    const r = await pyExec(`
import os
os.makedirs('/work/sub')
initial = os.getcwd()
os.chdir('/work')
after = os.getcwd()
os.chdir('sub')
nested = os.getcwd()
`);
    assert.strictEqual(r.get('initial'), '/home/nb');
    assert.strictEqual(r.get('after'), '/work');
    assert.strictEqual(r.get('nested'), '/work/sub');
  });

  it('walk', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/root');
    await vfs.writeFile('/root/a.txt', 'a');
    await vfs.mkdir('/root/sub');
    await vfs.writeFile('/root/sub/b.txt', 'b');
    const r = await pyExec(`
import os
result = []
for dirpath, dirnames, filenames in os.walk('/root'):
    result.append([dirpath, dirnames, filenames])
count = len(result)
`);
    assert.strictEqual(r.get('count'), 2);
  });
});

describe('os.path module', () => {
  it('join', async () => {
    const r = await pyExec(`
import os
result = os.path.join('/data', 'file.txt')
`);
    assert.strictEqual(r.get('result'), '/data/file.txt');
  });

  it('dirname and basename', async () => {
    const r = await pyExec(`
import os
d = os.path.dirname('/data/file.txt')
b = os.path.basename('/data/file.txt')
`);
    assert.strictEqual(r.get('d'), '/data');
    assert.strictEqual(r.get('b'), 'file.txt');
  });

  it('splitext', async () => {
    const r = await pyExec(`
import os
root, ext = os.path.splitext('/data/file.txt')
`);
    assert.strictEqual(r.get('root'), '/data/file');
    assert.strictEqual(r.get('ext'), '.txt');
  });

  it('exists, isfile, isdir', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/check.txt', 'data');
    await vfs.mkdir('/checkdir');
    const r = await pyExec(`
import os
e = os.path.exists('/check.txt')
f = os.path.isfile('/check.txt')
d = os.path.isdir('/checkdir')
ne = os.path.exists('/nope.txt')
`);
    assert.strictEqual(r.get('e'), true);
    assert.strictEqual(r.get('f'), true);
    assert.strictEqual(r.get('d'), true);
    assert.strictEqual(r.get('ne'), false);
  });

  it('isabs and normpath', async () => {
    const r = await pyExec(`
import os
a = os.path.isabs('/foo')
b = os.path.isabs('foo')
n = os.path.normpath('/foo/../bar')
`);
    assert.strictEqual(r.get('a'), true);
    assert.strictEqual(r.get('b'), false);
    assert.strictEqual(r.get('n'), '/bar');
  });

  it('from os.path import join', async () => {
    const r = await pyExec(`
from os.path import join, basename
result = join('/a', 'b')
name = basename('/a/b/c.txt')
`);
    assert.strictEqual(r.get('result'), '/a/b');
    assert.strictEqual(r.get('name'), 'c.txt');
  });

  it('getsize', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/sized.txt', 'hello');
    const r = await pyExec(`
import os
size = os.path.getsize('/sized.txt')
`);
    assert.strictEqual(r.get('size'), 5);
  });
});

describe('pathlib module', () => {
  it('name, stem, suffix, parent, parts', async () => {
    const r = await pyExec(`
from pathlib import Path
p = Path('/data/file.txt')
n = p.name
s = p.stem
x = p.suffix
pr = str(p.parent)
parts = p.parts
`);
    assert.strictEqual(r.get('n'), 'file.txt');
    assert.strictEqual(r.get('s'), 'file');
    assert.strictEqual(r.get('x'), '.txt');
    assert.strictEqual(r.get('pr'), '/data');
    assert.deepStrictEqual(r.get('parts'), ['/', 'data', 'file.txt']);
  });

  it('/ operator (truediv)', async () => {
    const r = await pyExec(`
from pathlib import Path
p = Path('/data') / 'sub' / 'file.txt'
result = str(p)
`);
    assert.strictEqual(r.get('result'), '/data/sub/file.txt');
  });

  it('read_text and write_text', async () => {
    await freshVFS();
    const r = await pyExec(`
from pathlib import Path
p = Path('/pathlib.txt')
p.write_text('pathlib content')
content = p.read_text()
`);
    assert.strictEqual(r.get('content'), 'pathlib content');
  });

  it('exists, is_file, is_dir', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/pcheck.txt', 'data');
    await vfs.mkdir('/pdir');
    const r = await pyExec(`
from pathlib import Path
e = Path('/pcheck.txt').exists()
f = Path('/pcheck.txt').is_file()
d = Path('/pdir').is_dir()
ne = Path('/nope').exists()
`);
    assert.strictEqual(r.get('e'), true);
    assert.strictEqual(r.get('f'), true);
    assert.strictEqual(r.get('d'), true);
    assert.strictEqual(r.get('ne'), false);
  });

  it('mkdir', async () => {
    await freshVFS();
    const r = await pyExec(`
from pathlib import Path
Path('/pdir2').mkdir()
exists = Path('/pdir2').is_dir()
`);
    assert.strictEqual(r.get('exists'), true);
  });

  it('iterdir', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/idir');
    await vfs.writeFile('/idir/a.txt', 'a');
    await vfs.writeFile('/idir/b.txt', 'b');
    const r = await pyExec(`
from pathlib import Path
entries = Path('/idir').iterdir()
names = sorted([str(e.name) for e in entries])
`);
    assert.deepStrictEqual(r.get('names'), ['a.txt', 'b.txt']);
  });

  it('with_suffix and with_name', async () => {
    const r = await pyExec(`
from pathlib import Path
p = Path('/data/file.txt')
s = str(p.with_suffix('.csv'))
n = str(p.with_name('other.txt'))
`);
    assert.strictEqual(r.get('s'), '/data/file.csv');
    assert.strictEqual(r.get('n'), '/data/other.txt');
  });

  it('str() and repr()', async () => {
    const r = await pyExec(`
from pathlib import Path
p = Path('/test.txt')
s = str(p)
r = repr(p)
`);
    assert.strictEqual(r.get('s'), '/test.txt');
    assert.strictEqual(r.get('r'), "PosixPath('/test.txt')");
  });
});

describe('shutil module', () => {
  it('copy', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/src.txt', 'source');
    const r = await pyExec(`
import shutil
shutil.copy('/src.txt', '/dst.txt')
f = open('/dst.txt', 'r')
content = f.read()
f.close()
`);
    assert.strictEqual(r.get('content'), 'source');
  });

  it('copytree', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/srcdir');
    await vfs.writeFile('/srcdir/a.txt', 'a');
    const r = await pyExec(`
import shutil, os
shutil.copytree('/srcdir', '/dstdir')
exists = os.path.exists('/dstdir/a.txt')
`);
    assert.strictEqual(r.get('exists'), true);
  });

  it('rmtree', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/rmdir');
    await vfs.writeFile('/rmdir/a.txt', 'a');
    const r = await pyExec(`
import shutil, os
shutil.rmtree('/rmdir')
exists = os.path.exists('/rmdir')
`);
    assert.strictEqual(r.get('exists'), false);
  });

  it('move', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/mv.txt', 'move me');
    const r = await pyExec(`
import shutil, os
shutil.move('/mv.txt', '/moved.txt')
old = os.path.exists('/mv.txt')
new = os.path.exists('/moved.txt')
`);
    assert.strictEqual(r.get('old'), false);
    assert.strictEqual(r.get('new'), true);
  });
});

describe('glob module', () => {
  it('pattern matching', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/g1.txt', '1');
    await vfs.writeFile('/g2.txt', '2');
    await vfs.writeFile('/g3.csv', '3');
    const r = await pyExec(`
import glob
matches = glob.glob('/*.txt')
count = len(matches)
`);
    assert.strictEqual(r.get('count'), 2);
  });

  it('recursive pattern', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/deep');
    await vfs.writeFile('/deep/a.txt', 'a');
    await vfs.mkdir('/deep/sub');
    await vfs.writeFile('/deep/sub/b.txt', 'b');
    const r = await pyExec(`
import glob
matches = glob.glob('/deep/**/*.txt')
count = len(matches)
`);
    assert.ok(r.get('count') >= 2);
  });
});

describe('filesystem error hierarchy', () => {
  it('ENOENT maps to FileNotFoundError', async () => {
    await freshVFS();
    await assert.rejects(
      () => pyExec(`f = open('/nonexistent.txt', 'r')`),
      (e) => e.pyType === 'FileNotFoundError'
    );
  });

  it('except OSError catches FileNotFoundError', async () => {
    await freshVFS();
    const r = await pyExec(`
caught = False
try:
    f = open('/missing.txt', 'r')
except OSError:
    caught = True
`);
    assert.strictEqual(r.get('caught'), true);
  });

  it('except FileNotFoundError catches specifically', async () => {
    await freshVFS();
    const r = await pyExec(`
caught = False
try:
    f = open('/missing.txt', 'r')
except FileNotFoundError:
    caught = True
`);
    assert.strictEqual(r.get('caught'), true);
  });
});

describe('sys module', () => {
  it('import sys and read attributes', async () => {
    const r = await pyExec(`
import sys
v = sys.version
p = sys.platform
m = sys.maxsize
`);
    assert.ok(r.get('v').includes('adder'));
    assert.strictEqual(r.get('p'), 'auditable');
    assert.strictEqual(r.get('m'), Number.MAX_SAFE_INTEGER);
  });

  it('sys.path defaults and is mutable', async () => {
    const r = await pyExec(`
import sys
has_dot = '.' in sys.path
has_lib = 'lib' in sys.path
has_sys = '/usr/lib/python' in sys.path
sys.path.append('/custom')
has_custom = '/custom' in sys.path
`);
    assert.strictEqual(r.get('has_dot'), true);
    assert.strictEqual(r.get('has_lib'), true);
    assert.strictEqual(r.get('has_sys'), true);
    assert.strictEqual(r.get('has_custom'), true);
  });

  it('sys.exit raises SystemExit', async () => {
    await assert.rejects(
      () => pyExec(`
import sys
sys.exit(1)
`),
      (e) => e.pyType === 'SystemExit'
    );
  });

  it('sys.argv exists', async () => {
    const r = await pyExec(`
import sys
n = len(sys.argv)
`);
    assert.ok(r.get('n') >= 1);
  });
});

describe('VFS imports', () => {
  it('import module from lib/', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/lib', { recursive: true });
    await vfs.writeFile('/home/nb/lib/myutil.py', `
PI = 3.14159
def double(x):
    return x * 2
`);
    const r = await pyExec(`
import myutil
pi = myutil.PI
d = myutil.double(21)
`);
    assert.strictEqual(r.get('pi'), 3.14159);
    assert.strictEqual(r.get('d'), 42);
  });

  it('from module import names', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/lib', { recursive: true });
    await vfs.writeFile('/home/nb/lib/helpers.py', `
def greet(name):
    return "hello " + name

VERSION = 2
`);
    const r = await pyExec(`
from helpers import greet, VERSION
msg = greet("world")
v = VERSION
`);
    assert.strictEqual(r.get('msg'), 'hello world');
    assert.strictEqual(r.get('v'), 2);
  });

  it('import from cwd (.) fallback', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/home/nb/cwdmod.py', `X = 99`);
    const r = await pyExec(`
import cwdmod
x = cwdmod.X
`);
    assert.strictEqual(r.get('x'), 99);
  });

  it('import from /usr/lib/python (system modules)', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/usr/lib/python/sysmod.py', `VAL = 77`);
    const r = await pyExec(`
import sysmod
v = sysmod.VAL
`);
    assert.strictEqual(r.get('v'), 77);
  });

  it('module cache (sys.modules)', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/lib', { recursive: true });
    await vfs.writeFile('/home/nb/lib/counter.py', `count = 0`);
    const r = await pyExec(`
import sys
import counter
counter.count = 42
import counter as c2
val = c2.count
`);
    // second import returns cached module — same object
    assert.strictEqual(r.get('val'), 42);
  });

  it('module has __name__ and __file__', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/lib', { recursive: true });
    await vfs.writeFile('/home/nb/lib/meta.py', `pass`);
    const r = await pyExec(`
import meta
name = meta.__name__
file = meta.__file__
`);
    assert.strictEqual(r.get('name'), 'meta');
    assert.strictEqual(r.get('file'), '/home/nb/lib/meta.py');
  });

  it('ModuleNotFoundError for missing module', async () => {
    await freshVFS();
    await assert.rejects(
      () => pyExec(`import nonexistent_module`),
      (e) => e.pyType === 'ModuleNotFoundError'
    );
  });

  it('transitive VFS imports', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/lib', { recursive: true });
    await vfs.writeFile('/home/nb/lib/base.py', `BASE = 10`);
    await vfs.writeFile('/home/nb/lib/derived.py', `
import base
VALUE = base.BASE * 2
`);
    const r = await pyExec(`
import derived
v = derived.VALUE
`);
    assert.strictEqual(r.get('v'), 20);
  });
});

describe('string-literal (path) imports', () => {
  it('import absolute VFS path as alias', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/extras', { recursive: true });
    await vfs.writeFile('/home/nb/extras/util.py', `Q = 7\ndef sq(x): return x * x`);
    const r = await pyExec(`
import "/home/nb/extras/util.py" as util
q = util.Q
sq3 = util.sq(3)
`);
    assert.strictEqual(r.get('q'), 7);
    assert.strictEqual(r.get('sq3'), 9);
  });

  it('from absolute VFS path import names', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.mkdir('/home/nb/extras', { recursive: true });
    await vfs.writeFile('/home/nb/extras/helpers.py', `A = 1\nB = 2`);
    const r = await pyExec(`
from "/home/nb/extras/helpers.py" import A, B as beta
a = A
b = beta
`);
    assert.strictEqual(r.get('a'), 1);
    assert.strictEqual(r.get('b'), 2);
  });

  it('path import missing file raises ModuleNotFoundError', async () => {
    await freshVFS();
    await assert.rejects(
      () => pyExec(`import "/no/such/file.py" as x`),
      (e) => e.pyType === 'ModuleNotFoundError'
    );
  });

  it('path import cache: two imports of same path share module', async () => {
    await freshVFS();
    const vfs = getAdderVFS();
    await vfs.writeFile('/home/nb/shared.py', `count = 0`);
    const r = await pyExec(`
import "/home/nb/shared.py" as m1
m1.count = 42
import "/home/nb/shared.py" as m2
val = m2.count
`);
    assert.strictEqual(r.get('val'), 42);
  });
});

describe('HTTP module loading', () => {
  // Restore globalThis.fetch after each test block.
  const realFetch = globalThis.fetch;

  function mockFetch(responses) {
    globalThis.fetch = async (url) => {
      if (url in responses) return { ok: true, text: async () => responses[url] };
      return { ok: false, status: 404, text: async () => 'not found' };
    };
  }

  function restoreFetch() {
    if (realFetch) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  }

  it('import via sys.path URL base', async () => {
    await freshVFS();
    mockFetch({
      'https://cdn.example.com/httpmod.py': `K = 123\ndef triple(x): return x * 3`,
    });
    try {
      const r = await pyExec(`
import sys
sys.path.append('https://cdn.example.com/')
import httpmod
k = httpmod.K
t = httpmod.triple(4)
`);
      assert.strictEqual(r.get('k'), 123);
      assert.strictEqual(r.get('t'), 12);
    } finally {
      restoreFetch();
    }
  });

  it('from import via sys.path URL base', async () => {
    await freshVFS();
    mockFetch({
      'https://cdn.example.com/mathy.py': `TAU = 6.283\ndef half(x): return x / 2`,
    });
    try {
      const r = await pyExec(`
import sys
sys.path.append('https://cdn.example.com/')
from mathy import TAU, half
t = TAU
h = half(10)
`);
      assert.strictEqual(r.get('t'), 6.283);
      assert.strictEqual(r.get('h'), 5);
    } finally {
      restoreFetch();
    }
  });

  it('tries __init__.py when name.py missing', async () => {
    await freshVFS();
    mockFetch({
      'https://cdn.example.com/pkg/__init__.py': `PKGVAL = 'init'`,
    });
    try {
      const r = await pyExec(`
import sys
sys.path.append('https://cdn.example.com/')
import pkg
v = pkg.PKGVAL
`);
      assert.strictEqual(r.get('v'), 'init');
    } finally {
      restoreFetch();
    }
  });

  it('direct URL import via string literal', async () => {
    await freshVFS();
    mockFetch({
      'https://example.com/direct.py': `ANSWER = 42`,
    });
    try {
      const r = await pyExec(`
import "https://example.com/direct.py" as d
a = d.ANSWER
`);
      assert.strictEqual(r.get('a'), 42);
    } finally {
      restoreFetch();
    }
  });

  it('page-relative sys.path base resolves against document.baseURI', async () => {
    await freshVFS();
    const realBaseURI = globalThis.document.baseURI;
    globalThis.document.baseURI = 'https://app.example.com/notebooks/';
    mockFetch({
      'https://app.example.com/notebooks/lib/relmod.py': `REL = 'ok'`,
    });
    try {
      const r = await pyExec(`
import sys
sys.path.append('./lib/')
import relmod
v = relmod.REL
`);
      assert.strictEqual(r.get('v'), 'ok');
    } finally {
      restoreFetch();
      globalThis.document.baseURI = realBaseURI;
    }
  });

  it('page-relative string-literal import resolves against document.baseURI', async () => {
    await freshVFS();
    const realBaseURI = globalThis.document.baseURI;
    globalThis.document.baseURI = 'https://app.example.com/nbs/';
    mockFetch({
      'https://app.example.com/nbs/utils.py': `MARK = 'rel'`,
    });
    try {
      const r = await pyExec(`
import "./utils.py" as u
m = u.MARK
`);
      assert.strictEqual(r.get('m'), 'rel');
    } finally {
      restoreFetch();
      globalThis.document.baseURI = realBaseURI;
    }
  });
});

} // end if (VFS)
