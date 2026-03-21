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
const { adderBuiltins, pyBool, pyStr, pyFormatValue, AdderRange } = await import('../ext/adder/src/builtins.js');
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

  it('isinstance', async () => {
    const { output } = await pyEval('isinstance(42, "int")');
    assert.strictEqual(output, 'True');
  });

  it('type', async () => {
    const { output } = await pyEval('type([])');
    assert.strictEqual(output, "'list'");
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
    const { defines } = await pyEval('from itertools import chain\nx = chain([1, 2], [3, 4])');
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
