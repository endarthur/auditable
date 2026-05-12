// Tests for adder → AIR → JS transpilation path.
// Runs Python code through the transpile pipeline end-to-end and asserts output.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adderParse } from '../ext/adder/src/parse.js';
import { lowerAdder, AirLowerError } from '../ext/adder/src/air-lower.js';
import { runPasses } from '../ext/air/src/passes.js';
import { emitJS } from '../ext/air/src/emit-js.js';
import { _py } from '../ext/adder/src/runtime.js';
import { adderBuiltins, pyStr } from '../ext/adder/src/builtins.js';

async function runTranspile(code) {
  const output = [];
  // adderBuiltins' print already formats and adds newline; we're the raw sink
  const printFn = (text) => { output.push(text); return null; };
  const ast = adderParse(code);
  const air = lowerAdder(ast, code);
  runPasses(air);
  const importNames = [...air.imports];
  const js = emitJS(air, importNames, [], { hinted: false, cellId: 'test' });
  const builtins = adderBuiltins(printFn);
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AF('_py', ...importNames, js);
  const args = importNames.map(n => builtins[n] !== undefined ? builtins[n] : undefined);
  const result = await fn(_py, ...args);
  return { result: result || {}, output: output.join('').trim() };
}

describe('adder transpile — arithmetic', () => {
  it('integer add', async () => {
    const r = await runTranspile('x = 1 + 2\nprint(x)');
    assert.equal(r.output, '3');
  });
  it('integer mul', async () => {
    const r = await runTranspile('x = 6 * 7\nprint(x)');
    assert.equal(r.output, '42');
  });
  it('float div', async () => {
    const r = await runTranspile('x = 10 / 4\nprint(x)');
    assert.equal(r.output, '2.5');
  });
  it('floor div', async () => {
    const r = await runTranspile('x = 10 // 3\nprint(x)');
    assert.equal(r.output, '3');
  });
  it('modulo', async () => {
    const r = await runTranspile('x = 10 % 3\nprint(x)');
    assert.equal(r.output, '1');
  });
  it('exponent', async () => {
    const r = await runTranspile('x = 2 ** 10\nprint(x)');
    assert.equal(r.output, '1024');
  });
  it('negative', async () => {
    const r = await runTranspile('x = -5\nprint(x)');
    assert.equal(r.output, '-5');
  });
  it('bitwise int and', async () => {
    const r = await runTranspile('print(0b1100 & 0b1010)');
    assert.equal(r.output, '8');
  });
  it('bitwise int or', async () => {
    const r = await runTranspile('print(0b1100 | 0b1010)');
    assert.equal(r.output, '14');
  });
  it('bitwise int xor', async () => {
    const r = await runTranspile('print(0b1100 ^ 0b1010)');
    assert.equal(r.output, '6');
  });
  it('bitwise & calls __and__ on objects', async () => {
    // Regression: lowerBinOp_ad fast-pathed `&` to native bitwise_and
    // unconditionally, which coerced sadpan's BooleanMask to 0 and
    // broke df[mask1 & mask2]. Now routes through _py.and_ which
    // checks for __and__ dunder before falling back to int bitwise.
    // Sanity: confirm the helper itself dispatches; the adder path
    // is exercised by example_adder_sadpan in the smoke sweep.
    const a = { __and__: (other) => `and-called:${a.v}&${other.v}`, v: 'a' };
    const b = { v: 'b' };
    assert.equal(_py.and_(a, b), 'and-called:a&b');
    // ints still fast-path
    assert.equal(_py.and_(0b1100, 0b1010), 8);
    assert.equal(_py.or_(0b1100, 0b1010), 14);
    assert.equal(_py.xor(0b1100, 0b1010), 6);
  });
});

describe('adder transpile — strings', () => {
  it('concat', async () => {
    const r = await runTranspile('x = "hello" + " " + "world"\nprint(x)');
    assert.equal(r.output, 'hello world');
  });
  it('repeat', async () => {
    const r = await runTranspile('x = "ab" * 3\nprint(x)');
    assert.equal(r.output, 'ababab');
  });
  it('len', async () => {
    const r = await runTranspile('print(len("hello"))');
    assert.equal(r.output, '5');
  });
  it('f-string', async () => {
    const r = await runTranspile('name = "world"\nprint(f"hello {name}!")');
    assert.equal(r.output, 'hello world!');
  });
  it('f-string with expression', async () => {
    const r = await runTranspile('x = 5\nprint(f"{x * 2}")');
    assert.equal(r.output, '10');
  });
  it('f-string with format spec', async () => {
    // adder parser emits formatSpec as a raw string (".2f"); lowerer must
    // handle that path, not just the JoinedStr-shaped one.
    const r = await runTranspile('x = 3.14159\nprint(f"{x:.2f}")');
    assert.equal(r.output, '3.14');
  });
});

describe('adder transpile — comparison and bool', () => {
  it('simple compare', async () => {
    const r = await runTranspile('print(5 > 3)');
    assert.equal(r.output, 'True');
  });
  it('chained compare', async () => {
    const r = await runTranspile('x = 10\nprint(5 < x < 15)');
    assert.equal(r.output, 'True');
  });
  it('and', async () => {
    const r = await runTranspile('print(True and False)');
    assert.equal(r.output, 'False');
  });
  it('or', async () => {
    const r = await runTranspile('print(True or False)');
    assert.equal(r.output, 'True');
  });
  it('not', async () => {
    const r = await runTranspile('print(not True)');
    assert.equal(r.output, 'False');
  });
});

describe('adder transpile — control flow', () => {
  it('if / else', async () => {
    const r = await runTranspile('x = 5\nif x > 3:\n    print("big")\nelse:\n    print("small")');
    assert.equal(r.output, 'big');
  });
  it('if / elif / else', async () => {
    const r = await runTranspile('x = 5\nif x > 10:\n    print("a")\nelif x > 3:\n    print("b")\nelse:\n    print("c")');
    assert.equal(r.output, 'b');
  });
  it('for loop', async () => {
    const r = await runTranspile('total = 0\nfor i in range(10):\n    total = total + i\nprint(total)');
    assert.equal(r.output, '45');
  });
  it('while loop', async () => {
    const r = await runTranspile('n = 5\nwhile n > 0:\n    n = n - 1\nprint(n)');
    assert.equal(r.output, '0');
  });
  it('break', async () => {
    const r = await runTranspile('for i in range(10):\n    if i == 3:\n        break\nprint(i)');
    assert.equal(r.output, '3');
  });
  it('continue', async () => {
    const r = await runTranspile('total = 0\nfor i in range(10):\n    if i % 2 == 0:\n        continue\n    total = total + i\nprint(total)');
    assert.equal(r.output, '25');
  });
});

describe('adder transpile — functions', () => {
  it('simple def', async () => {
    const r = await runTranspile('def add(a, b):\n    return a + b\nprint(add(3, 4))');
    assert.equal(r.output, '7');
  });
  it('recursive', async () => {
    const r = await runTranspile('def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nprint(fact(5))');
    assert.equal(r.output, '120');
  });
  it('lambda', async () => {
    const r = await runTranspile('sq = lambda x: x * x\nprint(sq(7))');
    assert.equal(r.output, '49');
  });
  it('closure', async () => {
    const r = await runTranspile('def make_adder(n):\n    return lambda x: x + n\nadd5 = make_adder(5)\nprint(add5(10))');
    assert.equal(r.output, '15');
  });
});

describe('adder transpile — collections', () => {
  it('list literal', async () => {
    const r = await runTranspile('x = [1, 2, 3]\nprint(x)');
    assert.equal(r.output, '[1, 2, 3]');
  });
  it('list indexing', async () => {
    const r = await runTranspile('x = [10, 20, 30]\nprint(x[1])');
    assert.equal(r.output, '20');
  });
  it('list negative index', async () => {
    const r = await runTranspile('x = [10, 20, 30]\nprint(x[-1])');
    assert.equal(r.output, '30');
  });
  it('list slice', async () => {
    const r = await runTranspile('x = [1, 2, 3, 4, 5]\nprint(x[1:4])');
    assert.equal(r.output, '[2, 3, 4]');
  });
  it('list comprehension', async () => {
    const r = await runTranspile('x = [i * 2 for i in range(5)]\nprint(x)');
    assert.equal(r.output, '[0, 2, 4, 6, 8]');
  });
  it('list comprehension with filter', async () => {
    const r = await runTranspile('x = [i for i in range(10) if i % 2 == 0]\nprint(x)');
    assert.equal(r.output, '[0, 2, 4, 6, 8]');
  });
  it('sum', async () => {
    const r = await runTranspile('print(sum([1, 2, 3, 4]))');
    assert.equal(r.output, '10');
  });
  it('dict with string keys', async () => {
    const r = await runTranspile('d = {"a": 1, "b": 2}\nprint(d["a"] + d["b"])');
    assert.equal(r.output, '3');
  });
});

describe('adder transpile — slice assignment', () => {
  it('replace same length', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40]\nx[1:3] = [98, 99]\nprint(x)');
    assert.equal(r.output, '[10, 98, 99, 40]');
  });
  it('shrink', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40]\nx[1:3] = [99]\nprint(x)');
    assert.equal(r.output, '[10, 99, 40]');
  });
  it('grow', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40]\nx[1:3] = [98, 99, 100]\nprint(x)');
    assert.equal(r.output, '[10, 98, 99, 100, 40]');
  });
  it('full replace via x[:]', async () => {
    const r = await runTranspile('x = [10, 20, 30]\nx[:] = [1, 2, 3, 4]\nprint(x)');
    assert.equal(r.output, '[1, 2, 3, 4]');
  });
  it('extended step', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40, 50]\nx[::2] = [98, 99, 100]\nprint(x)');
    assert.equal(r.output, '[98, 20, 99, 40, 100]');
  });
  it('fannkuch reverse-in-place idiom', async () => {
    const r = await runTranspile('p = [1, 2, 3, 4, 5]\np[:3] = p[2::-1]\nprint(p)');
    assert.equal(r.output, '[3, 2, 1, 4, 5]');
  });
  it('extended slice size mismatch raises ValueError', async () => {
    await assert.rejects(
      () => runTranspile('x = [10, 20, 30, 40, 50]\nx[::2] = [98, 99]'),
      (e) => e.pyType === 'ValueError',
    );
  });
  it('string slice assign raises TypeError', async () => {
    await assert.rejects(
      () => runTranspile('s = "hi"\ns[0:1] = "x"'),
      (e) => e.pyType === 'TypeError',
    );
  });
  it('augmented slice += list', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40]\nx[1:3] += [98]\nprint(x)');
    assert.equal(r.output, '[10, 20, 30, 98, 40]');
  });
  it('augmented slice *= int (list repetition)', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40]\nx[1:3] *= 2\nprint(x)');
    assert.equal(r.output, '[10, 20, 30, 20, 30, 40]');
  });
  it('augmented slice x[:] += [..]', async () => {
    const r = await runTranspile('x = [10, 20, 30]\nx[:] += [40, 50]\nprint(x)');
    assert.equal(r.output, '[10, 20, 30, 40, 50]');
  });
});

describe('adder transpile — slice deletion', () => {
  it('simple delete', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40]\ndel x[1:3]\nprint(x)');
    assert.equal(r.output, '[10, 40]');
  });
  it('extended step delete', async () => {
    const r = await runTranspile('x = [10, 20, 30, 40, 50]\ndel x[::2]\nprint(x)');
    assert.equal(r.output, '[20, 40]');
  });
  it('delete all via x[:]', async () => {
    const r = await runTranspile('x = [1, 2, 3]\ndel x[:]\nprint(x)');
    assert.equal(r.output, '[]');
  });
});

describe('adder transpile — full coverage', () => {
  // Most Python features now lower successfully. This suite runs them end-to-end.
  it('default arguments', async () => {
    const r = await runTranspile('def greet(name, greeting="hello"):\n    return greeting + " " + name\nprint(greet("world"))\nprint(greet("world", greeting="hi"))');
    assert.equal(r.output, 'hello world\nhi world');
  });
  it('*args', async () => {
    const r = await runTranspile('def sum_all(*nums):\n    t = 0\n    for n in nums:\n        t = t + n\n    return t\nprint(sum_all(1, 2, 3, 4))');
    assert.equal(r.output, '10');
  });
  it('**kwargs', async () => {
    const r = await runTranspile('def greet(**kw):\n    return kw["greeting"] + " " + kw["name"]\nprint(greet(greeting="hi", name="friend"))');
    assert.equal(r.output, 'hi friend');
  });
  it('decorator', async () => {
    const r = await runTranspile('def twice(fn):\n    def w(x):\n        return fn(fn(x))\n    return w\n@twice\ndef inc(x):\n    return x + 1\nprint(inc(5))');
    assert.equal(r.output, '7');
  });
  it('tuple destructuring in for', async () => {
    const r = await runTranspile('pairs = [(1, 2), (3, 4)]\ntotal = 0\nfor a, b in pairs:\n    total = total + a + b\nprint(total)');
    assert.equal(r.output, '10');
  });
  it('set literal', async () => {
    const r = await runTranspile('s = {1, 2, 3, 2, 1}\nprint(len(s))');
    assert.equal(r.output, '3');
  });
  it('dict comprehension', async () => {
    const r = await runTranspile('d = {i: i*i for i in range(4)}\nprint(d[3])');
    assert.equal(r.output, '9');
  });
  it('set comprehension', async () => {
    const r = await runTranspile('s = {i % 3 for i in range(10)}\nprint(len(s))');
    assert.equal(r.output, '3');
  });
  it('try/except basic', async () => {
    const r = await runTranspile('try:\n    x = 1 / 0\nexcept:\n    x = -1\nprint(x)');
    assert.equal(r.output, '-1');
  });
  it('try/except with type', async () => {
    const r = await runTranspile('try:\n    x = 1 / 0\nexcept ZeroDivisionError:\n    x = "zdiv"\nprint(x)');
    assert.equal(r.output, 'zdiv');
  });
  it('try/finally', async () => {
    const r = await runTranspile('log = []\ntry:\n    log.append("a")\nfinally:\n    log.append("b")\nprint(log)');
    assert.equal(r.output, "['a', 'b']");
  });
  it('class simple', async () => {
    const r = await runTranspile('class Point:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\n    def dist_sq(self):\n        return self.x * self.x + self.y * self.y\np = Point(3, 4)\nprint(p.dist_sq())');
    assert.equal(r.output, '25');
  });
  it('class inheritance', async () => {
    const r = await runTranspile('class Animal:\n    def speak(self):\n        return "noise"\nclass Dog(Animal):\n    def speak(self):\n        return "woof"\nprint(Dog().speak())');
    assert.equal(r.output, 'woof');
  });
  it('yield generator', async () => {
    const r = await runTranspile('def counter(n):\n    i = 0\n    while i < n:\n        yield i\n        i = i + 1\nprint(list(counter(3)))');
    assert.equal(r.output, '[0, 1, 2]');
  });
  it('starred call', async () => {
    const r = await runTranspile('def add3(a, b, c):\n    return a + b + c\nargs = [1, 2, 3]\nprint(add3(*args))');
    assert.equal(r.output, '6');
  });
  it('starred unpacking', async () => {
    const r = await runTranspile('a, *rest = [1, 2, 3, 4]\nprint(a)\nprint(rest)');
    assert.equal(r.output, '1\n[2, 3, 4]');
  });
});
