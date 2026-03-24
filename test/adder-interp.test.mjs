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

const { adderTokenize, adderParse } = await import('../ext/adder/src/parse.js');
const { adderEval, AdderScope } = await import('../ext/adder/src/eval.js');
const { adderBuiltins, pyBool, pyStr, pyFormatValue, AdderRange, Complex } = await import('../ext/adder/src/builtins.js');
const { pythonExecute } = await import('../ext/adder/src/cell.js');
const { adderTag } = await import('../ext/adder/src/tag.js');

// ── helper: eval Python code and return result ──
async function pyEval(code) {
  const result = await pythonExecute(code, {}, { id: 'test' });
  return result;
}

// ── tokenizer ──

describe('adderTokenize', () => {
  it('tokenizes simple expression', () => {
    const tokens = adderTokenize('x = 1\n');
    assert.ok(tokens.some(t => t.type === 'NAME' && t.value === 'x'));
    assert.ok(tokens.some(t => t.type === 'NUMBER' && t.value === 1));
    assert.ok(tokens.some(t => t.type === 'OP' && t.value === '='));
  });

  it('emits INDENT/DEDENT', () => {
    const tokens = adderTokenize('if True:\n    x = 1\ny = 2\n');
    assert.ok(tokens.some(t => t.type === 'INDENT'));
    assert.ok(tokens.some(t => t.type === 'DEDENT'));
  });

  it('handles implicit line continuation', () => {
    const tokens = adderTokenize('x = (\n  1 +\n  2\n)\n');
    const nums = tokens.filter(t => t.type === 'NUMBER');
    assert.strictEqual(nums.length, 2);
    // no INDENT inside brackets
    assert.ok(!tokens.some(t => t.type === 'INDENT'));
  });

  it('tokenizes hex/oct/bin numbers', () => {
    const tok = adderTokenize('0xFF 0o17 0b1010\n');
    const nums = tok.filter(t => t.type === 'NUMBER');
    assert.strictEqual(nums[0].value, 255);
    assert.strictEqual(nums[1].value, 15);
    assert.strictEqual(nums[2].value, 10);
  });

  it('tokenizes underscore in numbers', () => {
    const tok = adderTokenize('1_000_000\n');
    assert.strictEqual(tok[0].value, 1000000);
  });

  it('tokenizes triple-quoted string', () => {
    const tok = adderTokenize('"""hello\nworld"""\n');
    assert.ok(tok.some(t => t.type === 'STRING' && t.value === 'hello\nworld'));
  });

  it('tokenizes f-string', () => {
    const tok = adderTokenize('f"hello {name}"\n');
    assert.ok(tok.some(t => t.type === 'FSTRING'));
    const fs = tok.find(t => t.type === 'FSTRING');
    assert.ok(fs.value.some(p => typeof p === 'string' && p === 'hello '));
    assert.ok(fs.value.some(p => typeof p === 'object' && p.expr === 'name'));
  });

  it('tokenizes f-string with format spec', () => {
    const tok = adderTokenize('f"{x:.3f}"\n');
    const fs = tok.find(t => t.type === 'FSTRING');
    const expr = fs.value.find(p => typeof p === 'object');
    assert.strictEqual(expr.expr, 'x');
    assert.strictEqual(expr.spec, '.3f');
  });

  it('tokenizes raw string', () => {
    const tok = adderTokenize('r"no\\escape"\n');
    const s = tok.find(t => t.type === 'STRING');
    assert.strictEqual(s.value, 'no\\escape');
  });

  it('tokenizes escape sequences', () => {
    const tok = adderTokenize('"hello\\nworld"\n');
    const s = tok.find(t => t.type === 'STRING');
    assert.strictEqual(s.value, 'hello\nworld');
  });

  it('handles multi-char operators', () => {
    const tok = adderTokenize('x **= 2\n');
    assert.ok(tok.some(t => t.type === 'OP' && t.value === '**='));
  });

  it('handles ellipsis', () => {
    const tok = adderTokenize('...\n');
    assert.ok(tok.some(t => t.type === 'OP' && t.value === '...'));
  });
});

// ── parser ──

describe('adderParse', () => {
  it('parses simple assignment', () => {
    const ast = adderParse('x = 42');
    assert.strictEqual(ast.type, 'Module');
    assert.strictEqual(ast.body[0].type, 'Assign');
    assert.strictEqual(ast.body[0].targets[0].id, 'x');
    assert.strictEqual(ast.body[0].value.value, 42);
  });

  it('parses function definition', () => {
    const ast = adderParse('def foo(a, b):\n    return a + b');
    const fn = ast.body[0];
    assert.strictEqual(fn.type, 'FunctionDef');
    assert.strictEqual(fn.name, 'foo');
    assert.strictEqual(fn.params.length, 2);
  });

  it('parses class definition', () => {
    const ast = adderParse('class Foo:\n    pass');
    assert.strictEqual(ast.body[0].type, 'ClassDef');
    assert.strictEqual(ast.body[0].name, 'Foo');
  });

  it('parses if/elif/else', () => {
    const ast = adderParse('if True:\n    x = 1\nelif False:\n    x = 2\nelse:\n    x = 3');
    const ifNode = ast.body[0];
    assert.strictEqual(ifNode.type, 'If');
    assert.strictEqual(ifNode.orelse[0].type, 'If'); // elif
    assert.strictEqual(ifNode.orelse[0].orelse.length, 1); // else
  });

  it('parses for loop', () => {
    const ast = adderParse('for i in range(10):\n    pass');
    assert.strictEqual(ast.body[0].type, 'For');
    assert.strictEqual(ast.body[0].target.id, 'i');
  });

  it('parses while loop', () => {
    const ast = adderParse('while True:\n    break');
    assert.strictEqual(ast.body[0].type, 'While');
  });

  it('parses try/except', () => {
    const ast = adderParse('try:\n    x = 1\nexcept:\n    x = 2');
    assert.strictEqual(ast.body[0].type, 'Try');
    assert.strictEqual(ast.body[0].handlers.length, 1);
  });

  it('parses list comprehension', () => {
    const ast = adderParse('[x * 2 for x in range(5)]');
    const expr = ast.body[0].value;
    assert.strictEqual(expr.type, 'ListComp');
    assert.strictEqual(expr.generators.length, 1);
  });

  it('parses dict literal', () => {
    const ast = adderParse('{"a": 1, "b": 2}');
    const expr = ast.body[0].value;
    assert.strictEqual(expr.type, 'Dict');
    assert.strictEqual(expr.keys.length, 2);
  });

  it('parses f-string', () => {
    const ast = adderParse('f"hello {name}"');
    const expr = ast.body[0].value;
    assert.strictEqual(expr.type, 'JoinedStr');
  });

  it('parses lambda', () => {
    const ast = adderParse('f = lambda x, y: x + y');
    const assign = ast.body[0];
    assert.strictEqual(assign.value.type, 'Lambda');
  });

  it('parses starred unpacking', () => {
    const ast = adderParse('a, *b, c = [1, 2, 3, 4]');
    const target = ast.body[0].targets[0];
    assert.strictEqual(target.type, 'Tuple');
    assert.ok(target.elts.some(e => e.type === 'Starred'));
  });

  it('parses decorators', () => {
    const ast = adderParse('@dec\ndef foo():\n    pass');
    assert.strictEqual(ast.body[0].decorators.length, 1);
  });

  it('parses augmented assignment', () => {
    const ast = adderParse('x += 1');
    assert.strictEqual(ast.body[0].type, 'AugAssign');
    assert.strictEqual(ast.body[0].op, '+');
  });

  it('parses chained comparison', () => {
    const ast = adderParse('1 < x < 10');
    const comp = ast.body[0].value;
    assert.strictEqual(comp.type, 'Compare');
    assert.strictEqual(comp.ops.length, 2);
  });

  it('parses import', () => {
    const ast = adderParse('import math');
    assert.strictEqual(ast.body[0].type, 'Import');
  });

  it('parses from import', () => {
    const ast = adderParse('from math import sqrt, pi');
    assert.strictEqual(ast.body[0].type, 'ImportFrom');
    assert.strictEqual(ast.body[0].names.length, 2);
  });

  it('parses async def', () => {
    const ast = adderParse('async def foo():\n    await bar()');
    assert.strictEqual(ast.body[0].type, 'AsyncFunctionDef');
  });

  it('parses slicing', () => {
    const ast = adderParse('x[1:3]');
    const sub = ast.body[0].value;
    assert.strictEqual(sub.type, 'Subscript');
    assert.strictEqual(sub.slice.type, 'Slice');
  });

  it('parses *args and **kwargs in def', () => {
    const ast = adderParse('def f(a, *args, b=1, **kwargs):\n    pass');
    const fn = ast.body[0];
    assert.strictEqual(fn.vararg, 'args');
    assert.strictEqual(fn.kwarg, 'kwargs');
    assert.strictEqual(fn.kwonly.length, 1);
  });
});

// ── evaluator ──

describe('adderEval — arithmetic', () => {
  it('addition', async () => {
    const { output } = await pyEval('3 + 4');
    assert.strictEqual(output, '7');
  });

  it('floor division (Python semantics)', async () => {
    const { output } = await pyEval('-7 // 2');
    assert.strictEqual(output, '-4');
  });

  it('modulo (Python semantics)', async () => {
    const { output } = await pyEval('-7 % 3');
    assert.strictEqual(output, '2');
  });

  it('power', async () => {
    const { output } = await pyEval('2 ** 10');
    assert.strictEqual(output, '1024');
  });

  it('string multiply', async () => {
    const { defines } = await pyEval('x = "ab" * 3');
    assert.strictEqual(defines.x, 'ababab');
  });

  it('list multiply', async () => {
    const { defines } = await pyEval('x = [0] * 3');
    assert.deepStrictEqual(defines.x, [0, 0, 0]);
  });

  it('list concatenation', async () => {
    const { defines } = await pyEval('x = [1, 2] + [3, 4]');
    assert.deepStrictEqual(defines.x, [1, 2, 3, 4]);
  });
});

describe('adderEval — truthiness', () => {
  it('empty list is falsy', async () => {
    const { output } = await pyEval('bool([])');
    assert.strictEqual(output, 'False');
  });

  it('non-empty list is truthy', async () => {
    const { output } = await pyEval('bool([1])');
    assert.strictEqual(output, 'True');
  });

  it('zero is falsy', async () => {
    const { output } = await pyEval('bool(0)');
    assert.strictEqual(output, 'False');
  });

  it('empty string is falsy', async () => {
    const { output } = await pyEval('bool("")');
    assert.strictEqual(output, 'False');
  });

  it('None is falsy', async () => {
    const { output } = await pyEval('bool(None)');
    assert.strictEqual(output, 'False');
  });
});

describe('adderEval — control flow', () => {
  it('if/else', async () => {
    const { defines } = await pyEval('x = 1 if True else 2');
    assert.strictEqual(defines.x, 1);
  });

  it('for loop', async () => {
    const { defines } = await pyEval('total = 0\nfor i in range(5):\n    total += i');
    assert.strictEqual(defines.total, 10);
  });

  it('while loop', async () => {
    const { defines } = await pyEval('x = 0\nwhile x < 5:\n    x += 1');
    assert.strictEqual(defines.x, 5);
  });

  it('for/else (no break)', async () => {
    const { defines } = await pyEval('result = ""\nfor i in range(3):\n    result += str(i)\nelse:\n    result += "done"');
    assert.strictEqual(defines.result, '012done');
  });

  it('for/else (with break)', async () => {
    const { defines } = await pyEval('result = ""\nfor i in range(5):\n    if i == 2:\n        break\n    result += str(i)\nelse:\n    result += "done"');
    assert.strictEqual(defines.result, '01');
  });

  it('break and continue', async () => {
    const { defines } = await pyEval('result = []\nfor i in range(10):\n    if i == 7:\n        break\n    if i % 2 == 0:\n        continue\n    result.append(i)');
    assert.deepStrictEqual(defines.result, [1, 3, 5]);
  });
});

describe('adderEval — functions', () => {
  it('simple function', async () => {
    const { defines } = await pyEval('def add(a, b):\n    return a + b\nresult = add(3, 4)');
    assert.strictEqual(defines.result, 7);
  });

  it('default arguments', async () => {
    const { defines } = await pyEval('def greet(name, greeting="hello"):\n    return greeting + " " + name\nresult = greet("world")');
    assert.strictEqual(defines.result, 'hello world');
  });

  it('closures', async () => {
    const { defines } = await pyEval('def make_adder(n):\n    def adder(x):\n        return x + n\n    return adder\nadd5 = make_adder(5)\nresult = add5(3)');
    assert.strictEqual(defines.result, 8);
  });

  it('lambda', async () => {
    const { defines } = await pyEval('f = lambda x: x * 2\nresult = f(5)');
    assert.strictEqual(defines.result, 10);
  });

  it('*args', async () => {
    const { defines } = await pyEval('def f(*args):\n    return len(args)\nresult = f(1, 2, 3)');
    assert.strictEqual(defines.result, 3);
  });

  it('recursion', async () => {
    const { defines } = await pyEval('def fib(n):\n    if n <= 1:\n        return n\n    return fib(n - 1) + fib(n - 2)\nresult = fib(10)');
    assert.strictEqual(defines.result, 55);
  });
});

describe('adderEval — data structures', () => {
  it('list literal', async () => {
    const { defines } = await pyEval('x = [1, 2, 3]');
    assert.deepStrictEqual(defines.x, [1, 2, 3]);
  });

  it('dict literal (string keys)', async () => {
    const { defines } = await pyEval('x = {"a": 1, "b": 2}');
    assert.deepStrictEqual(defines.x, { a: 1, b: 2 });
  });

  it('list comprehension', async () => {
    const { defines } = await pyEval('x = [i * 2 for i in range(5)]');
    assert.deepStrictEqual(defines.x, [0, 2, 4, 6, 8]);
  });

  it('list comprehension with filter', async () => {
    const { defines } = await pyEval('x = [i for i in range(10) if i % 2 == 0]');
    assert.deepStrictEqual(defines.x, [0, 2, 4, 6, 8]);
  });

  it('nested list comprehension', async () => {
    const { defines } = await pyEval('x = [i * j for i in range(3) for j in range(3)]');
    assert.deepStrictEqual(defines.x, [0, 0, 0, 0, 1, 2, 0, 2, 4]);
  });

  it('dict comprehension', async () => {
    const { defines } = await pyEval('x = {str(i): i * i for i in range(4)}');
    assert.deepStrictEqual(defines.x, { '0': 0, '1': 1, '2': 4, '3': 9 });
  });

  it('set literal', async () => {
    const { defines } = await pyEval('x = {1, 2, 3}');
    assert.ok(defines.x instanceof Set);
    assert.strictEqual(defines.x.size, 3);
  });

  it('tuple unpacking', async () => {
    const { defines } = await pyEval('x, y = 1, 2');
    assert.strictEqual(defines.x, 1);
    assert.strictEqual(defines.y, 2);
  });

  it('starred unpacking', async () => {
    const { defines } = await pyEval('a, *b, c = [1, 2, 3, 4, 5]');
    assert.strictEqual(defines.a, 1);
    assert.deepStrictEqual(defines.b, [2, 3, 4]);
    assert.strictEqual(defines.c, 5);
  });

  it('slicing', async () => {
    const { defines } = await pyEval('x = [0, 1, 2, 3, 4]\ny = x[1:3]');
    assert.deepStrictEqual(defines.y, [1, 2]);
  });

  it('negative indexing', async () => {
    const { defines } = await pyEval('x = [0, 1, 2, 3]\ny = x[-1]');
    assert.strictEqual(defines.y, 3);
  });

  it('step slicing', async () => {
    const { defines } = await pyEval('x = [0, 1, 2, 3, 4, 5]\ny = x[::2]');
    assert.deepStrictEqual(defines.y, [0, 2, 4]);
  });

  it('reverse slicing', async () => {
    const { defines } = await pyEval('x = [1, 2, 3]\ny = x[::-1]');
    assert.deepStrictEqual(defines.y, [3, 2, 1]);
  });
});

describe('adderEval — strings', () => {
  it('f-string basic', async () => {
    const { defines } = await pyEval('name = "world"\nx = f"hello {name}"');
    assert.strictEqual(defines.x, 'hello world');
  });

  it('f-string with format spec', async () => {
    const { defines } = await pyEval('x = f"{3.14159:.2f}"');
    assert.strictEqual(defines.x, '3.14');
  });

  it('string methods', async () => {
    const { defines } = await pyEval('x = "hello world".upper()');
    assert.strictEqual(defines.x, 'HELLO WORLD');
  });

  it('string split', async () => {
    const { defines } = await pyEval('x = "a,b,c".split(",")');
    assert.deepStrictEqual(defines.x, ['a', 'b', 'c']);
  });

  it('string join', async () => {
    const { defines } = await pyEval('x = ", ".join(["a", "b", "c"])');
    assert.strictEqual(defines.x, 'a, b, c');
  });

  it('string in operator', async () => {
    const { output } = await pyEval('"ell" in "hello"');
    assert.strictEqual(output, 'True');
  });

  it('string slicing', async () => {
    const { defines } = await pyEval('x = "hello"[1:4]');
    assert.strictEqual(defines.x, 'ell');
  });
});

describe('adderEval — builtins', () => {
  it('len', async () => {
    const { output } = await pyEval('len([1, 2, 3])');
    assert.strictEqual(output, '3');
  });

  it('range', async () => {
    const { defines } = await pyEval('x = list(range(5))');
    assert.deepStrictEqual(defines.x, [0, 1, 2, 3, 4]);
  });

  it('range with step', async () => {
    const { defines } = await pyEval('x = list(range(0, 10, 2))');
    assert.deepStrictEqual(defines.x, [0, 2, 4, 6, 8]);
  });

  it('enumerate', async () => {
    const { defines } = await pyEval('x = list(enumerate(["a", "b", "c"]))');
    assert.deepStrictEqual(defines.x, [[0, 'a'], [1, 'b'], [2, 'c']]);
  });

  it('zip', async () => {
    const { defines } = await pyEval('x = list(zip([1, 2], [3, 4]))');
    assert.deepStrictEqual(defines.x, [[1, 3], [2, 4]]);
  });

  it('sorted', async () => {
    const { defines } = await pyEval('x = sorted([3, 1, 2])');
    assert.deepStrictEqual(defines.x, [1, 2, 3]);
  });

  it('sum', async () => {
    const { output } = await pyEval('sum([1, 2, 3, 4])');
    assert.strictEqual(output, '10');
  });

  it('map', async () => {
    const { defines } = await pyEval('x = list(map(lambda v: v * 2, [1, 2, 3]))');
    assert.deepStrictEqual(defines.x, [2, 4, 6]);
  });

  it('filter', async () => {
    const { defines } = await pyEval('x = list(filter(lambda v: v > 2, [1, 2, 3, 4]))');
    assert.deepStrictEqual(defines.x, [3, 4]);
  });

  it('isinstance (string)', async () => {
    const { output } = await pyEval('isinstance(42, "int")');
    assert.strictEqual(output, 'True');
  });

  it('isinstance (type object)', async () => {
    const { output } = await pyEval('isinstance(42, int)');
    assert.strictEqual(output, 'True');
  });

  it('type', async () => {
    const { output } = await pyEval('type([])');
    assert.strictEqual(output, "<class 'list'>");
  });

  it('abs', async () => {
    const { output } = await pyEval('abs(-5)');
    assert.strictEqual(output, '5');
  });

  it('chr/ord', async () => {
    const { defines } = await pyEval('x = chr(65)\ny = ord("A")');
    assert.strictEqual(defines.x, 'A');
    assert.strictEqual(defines.y, 65);
  });

  it('hex/oct/bin', async () => {
    const { defines } = await pyEval('x = hex(255)\ny = oct(8)\nz = bin(10)');
    assert.strictEqual(defines.x, '0xff');
    assert.strictEqual(defines.y, '0o10');
    assert.strictEqual(defines.z, '0b1010');
  });
});

describe('adderEval — modules', () => {
  it('import math', async () => {
    const { defines } = await pyEval('import math\nx = math.sqrt(16)');
    assert.strictEqual(defines.x, 4);
  });

  it('from math import', async () => {
    const { defines } = await pyEval('from math import pi, sqrt\nx = sqrt(4)');
    assert.strictEqual(defines.x, 2);
  });

  it('import json', async () => {
    const { defines } = await pyEval('import json\nx = json.loads(\'{"a": 1}\')');
    assert.deepStrictEqual(defines.x, { a: 1 });
  });

  it('itertools.chain', async () => {
    const { defines } = await pyEval('from itertools import chain\nx = list(chain([1, 2], [3, 4]))');
    assert.deepStrictEqual(defines.x, [1, 2, 3, 4]);
  });

  it('itertools.product', async () => {
    const { defines } = await pyEval('from itertools import product\nx = list(product([1, 2], ["a", "b"]))');
    assert.deepStrictEqual(defines.x, [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']]);
  });

  it('itertools.combinations', async () => {
    const { defines } = await pyEval('from itertools import combinations\nx = list(combinations([1, 2, 3], 2))');
    assert.deepStrictEqual(defines.x, [[1, 2], [1, 3], [2, 3]]);
  });

  it('functools.reduce', async () => {
    const { defines } = await pyEval('from functools import reduce\nx = reduce(lambda a, b: a + b, [1, 2, 3, 4])');
    assert.strictEqual(defines.x, 10);
  });

  it('collections.Counter', async () => {
    const { defines } = await pyEval('from collections import Counter\nc = Counter([1, 1, 2, 2, 2, 3])\nx = c[2]');
    assert.strictEqual(defines.x, 3);
  });

  it('import string', async () => {
    const { defines } = await pyEval('import string\nx = string.digits');
    assert.strictEqual(defines.x, '0123456789');
  });
});

describe('adderEval — print', () => {
  it('basic print', async () => {
    const { output } = await pyEval('print("hello")');
    assert.strictEqual(output, 'hello');
  });

  it('print multiple args', async () => {
    const { output } = await pyEval('print(1, 2, 3)');
    assert.strictEqual(output, '1 2 3');
  });

  it('print loop output', async () => {
    const { output } = await pyEval('for i in range(3):\n    print(i)');
    assert.strictEqual(output, '0\n1\n2');
  });

  it('last expression return', async () => {
    const { output } = await pyEval('x = 42\nx');
    assert.strictEqual(output, '42');
  });
});

describe('adderEval — comparison', () => {
  it('chained comparison', async () => {
    const { output } = await pyEval('1 < 2 < 3');
    assert.strictEqual(output, 'True');
  });

  it('chained comparison (false)', async () => {
    const { output } = await pyEval('1 < 2 > 3');
    assert.strictEqual(output, 'False');
  });

  it('in operator on list', async () => {
    const { output } = await pyEval('2 in [1, 2, 3]');
    assert.strictEqual(output, 'True');
  });

  it('not in operator', async () => {
    const { output } = await pyEval('5 not in [1, 2, 3]');
    assert.strictEqual(output, 'True');
  });

  it('is/is not None', async () => {
    const { output } = await pyEval('None is None');
    assert.strictEqual(output, 'True');
  });
});

describe('adderEval — scope', () => {
  it('global statement', async () => {
    const { defines } = await pyEval('x = 0\ndef f():\n    global x\n    x = 42\nf()');
    assert.strictEqual(defines.x, 42);
  });

  it('list methods (append)', async () => {
    const { defines } = await pyEval('x = []\nx.append(1)\nx.append(2)');
    assert.deepStrictEqual(defines.x, [1, 2]);
  });

  it('dict methods (get)', async () => {
    const { defines } = await pyEval('d = {"a": 1}\nx = d.get("a")\ny = d.get("b", 0)');
    assert.strictEqual(defines.x, 1);
    assert.strictEqual(defines.y, 0);
  });
});

describe('adderEval — try/except', () => {
  it('catches exception', async () => {
    const { defines } = await pyEval('x = 0\ntry:\n    x = 1 / 0\nexcept:\n    x = -1');
    assert.strictEqual(defines.x, -1);
  });

  it('try/else runs on success', async () => {
    const { defines } = await pyEval('x = 0\ntry:\n    x = 1\nexcept:\n    x = -1\nelse:\n    x = 2');
    assert.strictEqual(defines.x, 2);
  });
});

describe('adderEval — classes', () => {
  it('basic class', async () => {
    const { defines } = await pyEval('class Point:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\np = Point(3, 4)');
    assert.strictEqual(defines.p.x, 3);
    assert.strictEqual(defines.p.y, 4);
  });

  it('class method', async () => {
    const { defines } = await pyEval('class Counter:\n    def __init__(self):\n        self.n = 0\n    def inc(self):\n        self.n += 1\n        return self.n\nc = Counter()\nresult = c.inc()');
    assert.strictEqual(defines.result, 1);
  });
});

describe('adderEval — generators', () => {
  it('basic yield', async () => {
    const { defines } = await pyEval('def gen():\n    yield 1\n    yield 2\n    yield 3\nresult = list(gen())');
    assert.deepStrictEqual(defines.result, [1, 2, 3]);
  });

  it('yield in for loop', async () => {
    const { defines } = await pyEval('def squares(n):\n    for i in range(n):\n        yield i * i\nresult = list(squares(5))');
    assert.deepStrictEqual(defines.result, [0, 1, 4, 9, 16]);
  });

  it('yield from', async () => {
    const { defines } = await pyEval('def chain(a, b):\n    yield from a\n    yield from b\nresult = list(chain([1, 2], [3, 4]))');
    assert.deepStrictEqual(defines.result, [1, 2, 3, 4]);
  });

  it('generator in for loop', async () => {
    const { defines } = await pyEval('def gen():\n    yield 10\n    yield 20\ntotal = 0\nfor v in gen():\n    total += v');
    assert.strictEqual(defines.total, 30);
  });

  it('generator with sum()', async () => {
    const { defines } = await pyEval('def gen(n):\n    for i in range(n):\n        yield i\nresult = sum(gen(5))');
    assert.strictEqual(defines.result, 10);
  });

  it('generator expression in sum()', async () => {
    const { defines } = await pyEval('result = sum(x * x for x in range(5))');
    assert.strictEqual(defines.result, 30);
  });

  it('generator with conditional yield', async () => {
    const { defines } = await pyEval('def evens(n):\n    for i in range(n):\n        if i % 2 == 0:\n            yield i\nresult = list(evens(10))');
    assert.deepStrictEqual(defines.result, [0, 2, 4, 6, 8]);
  });

  it('fibonacci generator', async () => {
    const { defines } = await pyEval('def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        yield a\n        a, b = b, a + b\nresult = list(fib(8))');
    assert.deepStrictEqual(defines.result, [0, 1, 1, 2, 3, 5, 8, 13]);
  });

  it('user function consumes genexpr lazily', async () => {
    const { defines } = await pyEval('def my_sum(a):\n    x = 0\n    for y in a:\n        x += y\n    return x\nresult = my_sum(z**2 for z in range(10))');
    assert.strictEqual(defines.result, 285);
  });

  it('generator is truly lazy', async () => {
    const { defines } = await pyEval('log = []\ndef tracked(n):\n    for i in range(n):\n        log.append(i)\n        yield i\nresult = []\nfor x in tracked(1000):\n    result.append(x)\n    if len(result) >= 3:\n        break\nconsumed = len(log)');
    assert.deepStrictEqual(defines.result, [0, 1, 2]);
    assert.strictEqual(defines.consumed, 3);
  });
});

describe('adderEval — walrus operator', () => {
  it('basic walrus in if', async () => {
    const { defines } = await pyEval('result = 0\nif (n := 10) > 5:\n    result = n');
    assert.strictEqual(defines.result, 10);
  });

  it('walrus in comprehension filter', async () => {
    const { defines } = await pyEval('result = [y for x in range(10) if (y := x * x) > 20]');
    assert.deepStrictEqual(defines.result, [25, 36, 49, 64, 81]);
  });

  it('walrus in while', async () => {
    const { defines } = await pyEval('items = [3, 1, 4, 0, 5]\ni = 0\nresult = []\nwhile (v := items[i]) != 0:\n    result.append(v)\n    i += 1');
    assert.deepStrictEqual(defines.result, [3, 1, 4]);
  });
});

describe('adderEval — format specs', () => {
  it('format d', () => {
    assert.strictEqual(pyFormatValue(42, 'd'), '42');
  });
  it('format .3f', () => {
    assert.strictEqual(pyFormatValue(3.14159, '.3f'), '3.142');
  });
  it('format >10', () => {
    assert.strictEqual(pyFormatValue('hello', '>10'), '     hello');
  });
  it('format 08d', () => {
    assert.strictEqual(pyFormatValue(42, '08d'), '00000042');
  });
  it('format ,', () => {
    assert.strictEqual(pyFormatValue(1234567, ',d'), '1,234,567');
  });
});

describe('adderEval — cross-language', () => {
  it('upstream JS values accessible', async () => {
    const scope = { data: [1, 2, 3, 4, 5] };
    const result = await pythonExecute('total = sum(data)\nmean = total / len(data)', scope, { id: 'test' });
    assert.strictEqual(result.defines.total, 15);
    assert.strictEqual(result.defines.mean, 3);
  });

  it('defines are native JS values', async () => {
    const result = await pythonExecute('x = [1, 2, 3]', {}, { id: 'test' });
    assert.ok(Array.isArray(result.defines.x));
    assert.strictEqual(result.defines.x.length, 3);
  });

  it('dict defines are plain objects', async () => {
    const result = await pythonExecute('x = {"a": 1, "b": 2}', {}, { id: 'test' });
    assert.strictEqual(typeof result.defines.x, 'object');
    assert.strictEqual(result.defines.x.a, 1);
  });

  it('functions are callable from JS', async () => {
    const result = await pythonExecute('def add(a, b):\n    return a + b', {}, { id: 'test' });
    const sum = await result.defines.add(3, 4);
    assert.strictEqual(sum, 7);
  });
});

describe('adderTag', () => {
  it('basic tag', async () => {
    const result = await adderTag`
      x = 42
      y = x + 8
    `;
    assert.strictEqual(result.x, 42);
    assert.strictEqual(result.y, 50);
  });

  it('tag with interpolation', async () => {
    const base = 100;
    const result = await adderTag`
      x = ${base} * 3
    `;
    assert.strictEqual(result.x, 300);
  });

  it('filters underscore-prefixed names', async () => {
    const result = await adderTag`
      _internal = 1
      public = 2
    `;
    assert.strictEqual(result.public, 2);
    assert.strictEqual(result._internal, undefined);
  });
});

// ── Phase 1a: regex named groups ──

describe('adderEval — regex named groups', () => {
  it('(?P<name>...) translates to JS named groups', async () => {
    const { defines } = await pyEval('import re\nm = re.search(r"(?P<year>\\d{4})-(?P<month>\\d{2})", "date: 2024-03")\ny = m.group("year")\nmo = m.group("month")');
    assert.strictEqual(defines.y, '2024');
    assert.strictEqual(defines.mo, '03');
  });

  it('groupdict returns named groups', async () => {
    const { defines } = await pyEval('import re\nm = re.search(r"(?P<a>\\w+)@(?P<b>\\w+)", "user@host")\nd = m.groupdict()');
    assert.strictEqual(defines.d.a, 'user');
    assert.strictEqual(defines.d.b, 'host');
  });

  it('compile with named groups', async () => {
    const { defines } = await pyEval('import re\np = re.compile(r"(?P<key>\\w+)=(?P<val>\\w+)")\nm = p.search("foo=bar")\nk = m.group("key")\nv = m.group("val")');
    assert.strictEqual(defines.k, 'foo');
    assert.strictEqual(defines.v, 'bar');
  });
});

// ── Phase 1b: augmented assignment dunders ──

describe('adderEval — __iadd__ etc.', () => {
  it('__iadd__ on custom class', async () => {
    const { defines } = await pyEval(`
class Vec:
    def __init__(self, x, y):
        self.x = x
        self.y = y
    def __iadd__(self, other):
        return Vec(self.x + other.x, self.y + other.y)
v = Vec(1, 2)
v += Vec(3, 4)
rx = v.x
ry = v.y`);
    assert.strictEqual(defines.rx, 4);
    assert.strictEqual(defines.ry, 6);
  });

  it('falls back to __add__ when __iadd__ is missing', async () => {
    const { defines } = await pyEval('x = 5\nx += 3');
    assert.strictEqual(defines.x, 8);
  });
});

// ── Phase 1c: @property setter ──

describe('adderEval — @property setter', () => {
  it('property getter and setter', async () => {
    const { defines } = await pyEval(`
class Circle:
    def __init__(self, r):
        self._r = r
    @property
    def radius(self):
        return self._r
    @radius.setter
    def radius(self, value):
        self._r = max(0, value)
c = Circle(5)
r1 = c.radius
c.radius = -3
r2 = c.radius`);
    assert.strictEqual(defines.r1, 5);
    assert.strictEqual(defines.r2, 0);
  });
});

// ── Phase 1d: while loop limit directive ──

describe('adderEval — loop limit directive', () => {
  it('# %loop-limit overrides default', async () => {
    await assert.rejects(
      () => pyEval('# %loop-limit 10\ni = 0\nwhile True:\n    i += 1'),
      e => e instanceof Error && /maximum loop iterations/.test(e.message)
    );
  });

  it('# %noloop-limit disables limit', async () => {
    // verify the directive sets __loop_limit__ to 0
    const { defines } = await pyEval('# %noloop-limit\nlimit = __loop_limit__');
    assert.strictEqual(defines.limit, 0);
  });
});

// ── Phase 2a: isinstance improvements ──

describe('adderEval — isinstance improvements', () => {
  it('isinstance with builtin type objects', async () => {
    const { defines } = await pyEval(`
a = isinstance("hello", str)
b = isinstance(3.14, float)
c = isinstance([1,2], list)
d = isinstance(True, bool)`);
    assert.strictEqual(defines.a, true);
    assert.strictEqual(defines.b, true);
    assert.strictEqual(defines.c, true);
    assert.strictEqual(defines.d, true);
  });

  it('isinstance with tuple of types', async () => {
    const { defines } = await pyEval('x = isinstance(42, (str, int, float))');
    assert.strictEqual(defines.x, true);
  });

  it('isinstance with custom class inheritance', async () => {
    const { defines } = await pyEval(`
class Animal:
    pass
class Dog(Animal):
    pass
d = Dog()
a = isinstance(d, Dog)
b = isinstance(d, Animal)`);
    assert.strictEqual(defines.a, true);
    assert.strictEqual(defines.b, true);
  });

  it('isinstance with exception hierarchy', async () => {
    const { defines } = await pyEval(`
try:
    raise FileNotFoundError("missing")
except OSError:
    a = True
except:
    a = False
b = isinstance(FileNotFoundError("x"), OSError)`);
    assert.strictEqual(defines.a, true);
    assert.strictEqual(defines.b, true);
  });
});

// ── Phase 2b: type() returns type objects ──

describe('adderEval — type() returns type objects', () => {
  it('type returns callable type object', async () => {
    const { defines } = await pyEval('t = type(42)\nname = t.__name__');
    assert.strictEqual(defines.name, 'int');
  });

  it('type(x) == type(y) for same types', async () => {
    const { output } = await pyEval('type(1) == type(2)');
    assert.strictEqual(output, 'True');
  });

  it('type for custom class', async () => {
    const { defines } = await pyEval(`
class Foo:
    pass
f = Foo()
t = type(f)
same = t is Foo`);
    assert.strictEqual(defines.same, true);
  });
});

// ── Phase 3: exec() / eval() ──

describe('adderEval — exec/eval', () => {
  it('eval evaluates expression', async () => {
    const { defines } = await pyEval('x = eval("2 + 3")');
    assert.strictEqual(defines.x, 5);
  });

  it('eval sees enclosing scope', async () => {
    const { defines } = await pyEval('a = 10\nx = eval("a * 2")');
    assert.strictEqual(defines.x, 20);
  });

  it('exec executes statements', async () => {
    const { defines } = await pyEval('y = 0\nexec("y = 42")');
    assert.strictEqual(defines.y, 42);
  });

  it('exec modifies caller scope', async () => {
    const { defines } = await pyEval('x = 1\nexec("x = 99")');
    assert.strictEqual(defines.x, 99);
  });
});

// ── Phase 4: complex numbers ──

describe('adderEval — complex numbers', () => {
  it('complex literal', async () => {
    const { defines } = await pyEval('x = 3j');
    assert.ok(defines.x instanceof Complex);
    assert.strictEqual(defines.x.real, 0);
    assert.strictEqual(defines.x.imag, 3);
  });

  it('complex arithmetic', async () => {
    const { defines } = await pyEval('x = (1 + 2j) + (3 + 4j)');
    assert.ok(defines.x instanceof Complex);
    assert.strictEqual(defines.x.real, 4);
    assert.strictEqual(defines.x.imag, 6);
  });

  it('complex multiplication', async () => {
    const { defines } = await pyEval('x = (1 + 2j) * (3 + 4j)');
    assert.strictEqual(defines.x.real, -5);
    assert.strictEqual(defines.x.imag, 10);
  });

  it('complex division', async () => {
    const { defines } = await pyEval('x = (1 + 2j) / (1 + 0j)');
    assert.strictEqual(defines.x.real, 1);
    assert.strictEqual(defines.x.imag, 2);
  });

  it('abs of complex', async () => {
    const { defines } = await pyEval('x = abs(3 + 4j)');
    assert.strictEqual(defines.x, 5);
  });

  it('complex() builtin', async () => {
    const { defines } = await pyEval('x = complex(3, 4)');
    assert.strictEqual(defines.x.real, 3);
    assert.strictEqual(defines.x.imag, 4);
  });

  it('complex conjugate', async () => {
    const { defines } = await pyEval('x = (3 + 4j).conjugate()');
    assert.strictEqual(defines.x.real, 3);
    assert.strictEqual(defines.x.imag, -4);
  });

  it('complex repr', async () => {
    const { output } = await pyEval('3 + 4j');
    assert.strictEqual(output, '(3+4j)');
  });

  it('complex type', async () => {
    const { output } = await pyEval('type(1j)');
    assert.strictEqual(output, "<class 'complex'>");
  });

  it('isinstance complex', async () => {
    const { output } = await pyEval('isinstance(1j, complex)');
    assert.strictEqual(output, 'True');
  });

  it('number + complex', async () => {
    const { defines } = await pyEval('x = 5 + 3j');
    assert.strictEqual(defines.x.real, 5);
    assert.strictEqual(defines.x.imag, 3);
  });

  it('complex negation', async () => {
    const { defines } = await pyEval('x = -(3 + 4j)');
    assert.strictEqual(defines.x.real, -3);
    assert.strictEqual(defines.x.imag, -4);
  });

  it('complex bool', async () => {
    const { defines } = await pyEval('a = bool(0j)\nb = bool(1j)');
    assert.strictEqual(defines.a, false);
    assert.strictEqual(defines.b, true);
  });
});

// ── Phase 5: MRO / multiple inheritance ──

describe('adderEval — MRO and multiple inheritance', () => {
  it('single inheritance', async () => {
    const { defines } = await pyEval(`
class A:
    def who(self):
        return "A"
class B(A):
    pass
b = B()
result = b.who()`);
    assert.strictEqual(defines.result, 'A');
  });

  it('method override', async () => {
    const { defines } = await pyEval(`
class A:
    def who(self):
        return "A"
class B(A):
    def who(self):
        return "B"
result = B().who()`);
    assert.strictEqual(defines.result, 'B');
  });

  it('multiple inheritance — diamond', async () => {
    const { defines } = await pyEval(`
class A:
    def who(self):
        return "A"
class B(A):
    pass
class C(A):
    def who(self):
        return "C"
class D(B, C):
    pass
result = D().who()`);
    assert.strictEqual(defines.result, 'C');
  });

  it('super() basic', async () => {
    const { defines } = await pyEval(`
class Base:
    def __init__(self):
        self.x = 10
class Child(Base):
    def __init__(self):
        super().__init__()
        self.y = 20
c = Child()
rx = c.x
ry = c.y`);
    assert.strictEqual(defines.rx, 10);
    assert.strictEqual(defines.ry, 20);
  });

  it('super() method call', async () => {
    const { defines } = await pyEval(`
class A:
    def greet(self):
        return "hello"
class B(A):
    def greet(self):
        return super().greet() + " world"
result = B().greet()`);
    assert.strictEqual(defines.result, 'hello world');
  });

  it('isinstance with inheritance chain', async () => {
    const { defines } = await pyEval(`
class A:
    pass
class B(A):
    pass
class C(B):
    pass
c = C()
a = isinstance(c, A)
b = isinstance(c, B)`);
    assert.strictEqual(defines.a, true);
    assert.strictEqual(defines.b, true);
  });
});

// ── Phase 6: lazy itertools ──

describe('adderEval — lazy itertools', () => {
  it('chain is lazy', async () => {
    const { defines } = await pyEval(`
from itertools import chain
result = []
for x in chain([1, 2], [3]):
    result.append(x)
    if len(result) >= 2:
        break`);
    assert.deepStrictEqual(defines.result, [1, 2]);
  });

  it('count is infinite', async () => {
    const { defines } = await pyEval(`
from itertools import count, islice
result = list(islice(count(10, 5), 4))`);
    assert.deepStrictEqual(defines.result, [10, 15, 20, 25]);
  });

  it('repeat infinite until break', async () => {
    const { defines } = await pyEval(`
from itertools import repeat
result = []
for x in repeat(42):
    result.append(x)
    if len(result) >= 3:
        break`);
    assert.deepStrictEqual(defines.result, [42, 42, 42]);
  });

  it('cycle repeats', async () => {
    const { defines } = await pyEval(`
from itertools import cycle, islice
result = list(islice(cycle([1, 2, 3]), 7))`);
    assert.deepStrictEqual(defines.result, [1, 2, 3, 1, 2, 3, 1]);
  });

  it('pairwise', async () => {
    const { defines } = await pyEval(`
from itertools import pairwise
result = list(pairwise([1, 2, 3, 4]))`);
    assert.deepStrictEqual(defines.result, [[1, 2], [2, 3], [3, 4]]);
  });

  it('accumulate lazy', async () => {
    const { defines } = await pyEval(`
from itertools import accumulate
result = list(accumulate([1, 2, 3, 4]))`);
    assert.deepStrictEqual(defines.result, [1, 3, 6, 10]);
  });

  it('islice on infinite', async () => {
    const { defines } = await pyEval(`
from itertools import count, islice
result = list(islice(count(), 5))`);
    assert.deepStrictEqual(defines.result, [0, 1, 2, 3, 4]);
  });

  it('groupby lazy', async () => {
    const { defines } = await pyEval(`
from itertools import groupby
result = list(groupby([1, 1, 2, 2, 3]))`);
    assert.strictEqual(defines.result.length, 3);
    assert.strictEqual(defines.result[0][0], 1);
  });

  it('starmap lazy', async () => {
    const { defines } = await pyEval(`
from itertools import starmap
result = list(starmap(lambda a, b: a + b, [(1, 2), (3, 4)]))`);
    assert.deepStrictEqual(defines.result, [3, 7]);
  });
});

// ── @staticmethod / @classmethod ──

describe('adderEval — staticmethod / classmethod', () => {
  it('@staticmethod has no self', async () => {
    const { defines } = await pyEval(`
class MathUtils:
    @staticmethod
    def add(a, b):
        return a + b
result = MathUtils.add(3, 4)
result2 = MathUtils().add(3, 4)`);
    assert.strictEqual(defines.result, 7);
    assert.strictEqual(defines.result2, 7);
  });

  it('@classmethod receives cls', async () => {
    const { defines } = await pyEval(`
class Animal:
    species = "unknown"
    def __init__(self, name):
        self.name = name
    @classmethod
    def create(cls, name):
        return cls(name)
a = Animal.create("Rex")
result = a.name`);
    assert.strictEqual(defines.result, 'Rex');
  });

  it('@classmethod on instance also works', async () => {
    const { defines } = await pyEval(`
class Counter:
    count = 0
    @classmethod
    def increment(cls):
        cls.count += 1
        return cls.count
c = Counter()
r1 = c.increment()
r2 = Counter.increment()`);
    assert.strictEqual(defines.r1, 1);
    assert.strictEqual(defines.r2, 2);
  });

  it('@staticmethod inherited', async () => {
    const { defines } = await pyEval(`
class Base:
    @staticmethod
    def helper(x):
        return x * 2
class Child(Base):
    pass
result = Child.helper(5)`);
    assert.strictEqual(defines.result, 10);
  });
});

// ── Phase 7: tracebacks ──

describe('adderEval — tracebacks', () => {
  it('error has traceback', async () => {
    try {
      await pyEval(`
def inner():
    return 1 / 0
def outer():
    return inner()
outer()`);
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e._traceback, 'error should have _traceback');
      assert.ok(e._traceback.length > 0, 'traceback should have entries');
      assert.ok(e._traceback.some(f => f.name === 'inner'), 'should include inner');
    }
  });

  it('traceback includes call chain', async () => {
    try {
      await pyEval(`
def a():
    raise ValueError("boom")
def b():
    return a()
def c():
    return b()
c()`);
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e._traceback.some(f => f.name === 'a'));
      assert.ok(e._traceback.some(f => f.name === 'b'));
      assert.ok(e._traceback.some(f => f.name === 'c'));
    }
  });
});
