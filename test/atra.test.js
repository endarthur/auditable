import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { atra } from '../ext/atra/index.js';
const tokenizeAtra = atra._tokenize;
const lex = atra._lex;
const parse = atra._parse;
const compileSource = atra.compile;

// ═══════════════════════════════════════════════════════════════════════════
// Highlight tokenizer
// ═══════════════════════════════════════════════════════════════════════════

describe('tokenizeAtra (highlight)', () => {
  it('tokenizes keywords', () => {
    const tokens = tokenizeAtra('function begin end');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['kw', 'kw', 'kw']);
  });

  it('tokenizes types as const', () => {
    const tokens = tokenizeAtra('i32 f64');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['const', 'const']);
  });

  it('tokenizes type conversions as fn', () => {
    const tokens = tokenizeAtra('f64(');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['fn', 'punc']);
  });

  it('tokenizes builtins', () => {
    const tokens = tokenizeAtra('sin cos sqrt abs');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['fn', 'fn', 'fn', 'fn']);
  });

  it('tokenizes comments', () => {
    const tokens = tokenizeAtra('x ! comment');
    const cmt = tokens.find(t => t.type === 'cmt');
    assert.ok(cmt);
    assert.ok(cmt.text.includes('comment'));
  });

  it('tokenizes multi-char operators', () => {
    const tokens = tokenizeAtra(':= ** == <= >=');
    const ops = tokens.filter(t => t.type === 'op').map(t => t.text);
    assert.deepStrictEqual(ops, [':=', '**', '==', '<=', '>=']);
  });

  it('tokenizes numbers with type suffix', () => {
    const tokens = tokenizeAtra('3.14_f32 42_i64');
    const nums = tokens.filter(t => t.type === 'num').map(t => t.text);
    assert.deepStrictEqual(nums, ['3.14_f32', '42_i64']);
  });

  it('tokenizes wasm.xxx as fn', () => {
    const tokens = tokenizeAtra('wasm.div_u');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['fn']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Compiler lexer
// ═══════════════════════════════════════════════════════════════════════════

describe('lex', () => {
  it('produces keyword tokens', () => {
    const tokens = lex('function begin end');
    assert.strictEqual(tokens[0].type, 'kw');
    assert.strictEqual(tokens[0].value, 'function');
    assert.strictEqual(tokens[1].value, 'begin');
    assert.strictEqual(tokens[2].value, 'end');
  });

  it('skips semicolons', () => {
    const tokens = lex('x; y;');
    const ids = tokens.filter(t => t.type === 'id');
    assert.strictEqual(ids.length, 2);
  });

  it('skips comments', () => {
    const tokens = lex('x ! comment\ny');
    const ids = tokens.filter(t => t.type === 'id');
    assert.strictEqual(ids.length, 2);
  });

  it('lexes multi-char operators', () => {
    const tokens = lex(':= ** += -= *= ==');
    const ops = tokens.filter(t => t.type === 'op').map(t => t.value);
    assert.deepStrictEqual(ops, [':=', '**', '+=', '-=', '*=', '==']);
  });

  it('lexes number with type suffix', () => {
    const tokens = lex('3.14_f32');
    assert.strictEqual(tokens[0].type, 'num');
    assert.strictEqual(tokens[0].typeSuffix, 'f32');
  });

  it('lexes float detection', () => {
    const t1 = lex('42')[0];
    assert.strictEqual(t1.isFloat, false);
    const t2 = lex('3.14')[0];
    assert.strictEqual(t2.isFloat, true);
    const t3 = lex('1e5')[0];
    assert.strictEqual(t3.isFloat, true);
  });

  it('recognizes interpolation markers', () => {
    const tokens = lex('__INTERP_0__');
    assert.strictEqual(tokens[0].interp, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

describe('parse', () => {
  it('parses a simple function', () => {
    const ast = parse(lex('function add(a, b: f64): f64\nbegin\n  add := a + b\nend'));
    assert.strictEqual(ast.type, 'Program');
    assert.strictEqual(ast.body.length, 1);
    const fn = ast.body[0];
    assert.strictEqual(fn.type, 'Function');
    assert.strictEqual(fn.name, 'add');
    assert.strictEqual(fn.params.length, 2);
    assert.strictEqual(fn.retType, 'f64');
  });

  it('parses a subroutine', () => {
    const ast = parse(lex('subroutine inc(x: i32)\nbegin\n  x := x + 1\nend'));
    assert.strictEqual(ast.body[0].type, 'Subroutine');
    assert.strictEqual(ast.body[0].name, 'inc');
  });

  it('parses local variables', () => {
    const ast = parse(lex('function f(x: f64): f64\nvar\n  i, j: i32;\n  sum: f64;\nbegin\n  f := x\nend'));
    const fn = ast.body[0];
    assert.strictEqual(fn.locals.length, 3);
    assert.strictEqual(fn.locals[0].name, 'i');
    assert.strictEqual(fn.locals[0].vtype, 'i32');
  });

  it('parses global const', () => {
    const ast = parse(lex('const pi: f64 = 3.14159'));
    assert.strictEqual(ast.body[0].type, 'ConstDecl');
    assert.strictEqual(ast.body[0].name, 'pi');
  });

  it('parses if/else', () => {
    const src = 'function f(x: f64): f64\nbegin\n  if (x > 0.0) then\n    f := x\n  else\n    f := 0.0 - x\n  end if\nend';
    const ast = parse(lex(src));
    const body = ast.body[0].body;
    assert.strictEqual(body[0].type, 'If');
    assert.ok(body[0].elseBody);
  });

  it('parses for loop', () => {
    const src = 'function f(n: i32): i32\nvar\n  i: i32;\nbegin\n  for i := 0, n\n    f := f + i\n  end for\nend';
    const ast = parse(lex(src));
    const forStmt = ast.body[0].body[0];
    assert.strictEqual(forStmt.type, 'For');
    assert.strictEqual(forStmt.varName, 'i');
  });

  it('parses while loop', () => {
    const src = 'function f(x: f64): f64\nbegin\n  while (x > 1.0)\n    x := x / 2.0\n  end while\n  f := x\nend';
    const ast = parse(lex(src));
    assert.strictEqual(ast.body[0].body[0].type, 'While');
  });

  it('parses operator precedence (** is right-assoc)', () => {
    const src = 'function f(x: f64): f64\nbegin\n  f := x ** 2 ** 3\nend';
    const ast = parse(lex(src));
    const assign = ast.body[0].body[0];
    // right-assoc: x ** (2 ** 3)
    assert.strictEqual(assign.value.type, 'BinOp');
    assert.strictEqual(assign.value.op, '**');
    assert.strictEqual(assign.value.right.type, 'BinOp');
    assert.strictEqual(assign.value.right.op, '**');
  });

  it('parses if-expression (ternary)', () => {
    const src = 'function f(x: f64): f64\nbegin\n  f := if (x > 0.0) then x else 0.0 - x\nend';
    const ast = parse(lex(src));
    const assign = ast.body[0].body[0];
    assert.strictEqual(assign.value.type, 'IfExpr');
  });

  it('parses compound assignment', () => {
    const src = 'function f(x: f64): f64\nbegin\n  x += 1.0\n  f := x\nend';
    const ast = parse(lex(src));
    const assign = ast.body[0].body[0];
    assert.strictEqual(assign.type, 'Assign');
    assert.strictEqual(assign.value.type, 'BinOp');
    assert.strictEqual(assign.value.op, '+');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end: compile + instantiate + run
// ═══════════════════════════════════════════════════════════════════════════

describe('end-to-end', () => {
  it('compiles and runs simple add', () => {
    const { add } = atra`
      function add(a, b: f64): f64
      begin
        add := a + b
      end
    `;
    assert.strictEqual(add(3.0, 4.0), 7.0);
  });

  it('compiles subtraction', () => {
    const { sub } = atra`
      function sub(a, b: f64): f64
      begin
        sub := a - b
      end
    `;
    assert.strictEqual(sub(10.0, 3.0), 7.0);
  });

  it('compiles multiplication and division', () => {
    const { calc } = atra`
      function calc(a, b: f64): f64
      begin
        calc := a * b / 2.0
      end
    `;
    assert.strictEqual(calc(6.0, 4.0), 12.0);
  });

  it('compiles i32 arithmetic', () => {
    const { addi } = atra`
      function addi(a, b: i32): i32
      begin
        addi := a + b
      end
    `;
    assert.strictEqual(addi(3, 4), 7);
  });

  it('compiles if/else', () => {
    const { absval } = atra`
      function absval(x: f64): f64
      begin
        if (x >= 0.0) then
          absval := x
        else
          absval := 0.0 - x
        end if
      end
    `;
    assert.strictEqual(absval(5.0), 5.0);
    assert.strictEqual(absval(-3.0), 3.0);
  });

  it('compiles if-expression (ternary)', () => {
    const { myabs } = atra`
      function myabs(x: f64): f64
      begin
        myabs := if (x >= 0.0) then x else 0.0 - x
      end
    `;
    assert.strictEqual(myabs(5.0), 5.0);
    assert.strictEqual(myabs(-3.0), 3.0);
  });

  it('compiles for loop', () => {
    const { sum } = atra`
      function sum(n: i32): i32
      var
        i, s: i32;
      begin
        s := 0
        for i := 0, n
          s := s + i
        end for
        sum := s
      end
    `;
    assert.strictEqual(sum(5), 10); // 0+1+2+3+4
    assert.strictEqual(sum(10), 45);
  });

  it('compiles while loop', () => {
    const { halve } = atra`
      function halve(x: f64): f64
      begin
        while (x > 1.0)
          x := x / 2.0
        end while
        halve := x
      end
    `;
    assert.ok(halve(16.0) <= 1.0);
    assert.ok(halve(16.0) > 0.5);
  });

  it('compiles do...while loop', () => {
    const { atleastonce } = atra`
      function atleastonce(x: i32): i32
      var
        count: i32;
      begin
        count := 0
        do
          count := count + 1
          x := x - 1
        while (x > 0)
        atleastonce := count
      end
    `;
    assert.strictEqual(atleastonce(3), 3);
    assert.strictEqual(atleastonce(0), 1); // executes at least once
  });

  it('compiles break', () => {
    const { findbreak } = atra`
      function findbreak(n: i32): i32
      var
        i: i32;
      begin
        findbreak := 0
        for i := 0, n
          if (i == 5) then
            break
          end if
          findbreak := i
        end for
      end
    `;
    assert.strictEqual(findbreak(10), 4);
    assert.strictEqual(findbreak(3), 2);
  });

  it('compiles sqrt (native builtin)', () => {
    const { root } = atra`
      function root(x: f64): f64
      begin
        root := sqrt(x)
      end
    `;
    assert.strictEqual(root(4.0), 2.0);
    assert.strictEqual(root(9.0), 3.0);
  });

  it('compiles Math imports (sin, cos)', () => {
    const { sn } = atra`
      function sn(x: f64): f64
      begin
        sn := sin(x)
      end
    `;
    assert.ok(Math.abs(sn(0.0)) < 1e-10);
    assert.ok(Math.abs(sn(Math.PI / 2) - 1.0) < 1e-10);
  });

  it('compiles exponentiation **', () => {
    const { cube } = atra`
      function cube(x: f64): f64
      begin
        cube := x ** 3
      end
    `;
    assert.strictEqual(cube(2.0), 8.0);
  });

  it('compiles **0.5 as sqrt', () => {
    const { sqrtvia } = atra`
      function sqrtvia(x: f64): f64
      begin
        sqrtvia := x ** 0.5
      end
    `;
    assert.strictEqual(sqrtvia(4.0), 2.0);
    assert.strictEqual(sqrtvia(9.0), 3.0);
  });

  it('compiles type conversion', () => {
    const { convert } = atra`
      function convert(x: i32): f64
      begin
        convert := f64(x) + 0.5
      end
    `;
    assert.strictEqual(convert(3), 3.5);
  });

  it('compiles curried imports', () => {
    function myDouble(x) { return x * 2; }
    const { test } = atra({ myDouble })`
      function test(x: f64): f64
      begin
        test := myDouble(x) + 1.0
      end
    `;
    assert.strictEqual(test(5.0), 11.0);
  });

  it('compiles interpolated constants', () => {
    const SIZE = 100;
    const { getsize } = atra`
      function getsize(): f64
      begin
        getsize := ${SIZE}.0
      end
    `;
    assert.strictEqual(getsize(), 100.0);
  });

  it('compiles globals', () => {
    const { getval, setval } = atra`
      var counter: i32

      function setval(x: i32): i32
      begin
        counter := x
        setval := counter
      end

      function getval(): i32
      begin
        getval := counter
      end
    `;
    setval(42);
    assert.strictEqual(getval(), 42);
  });

  it('compiles min/max builtins', () => {
    const { minmax } = atra`
      function minmax(a, b: f64): f64
      begin
        minmax := min(a, b) + max(a, b)
      end
    `;
    assert.strictEqual(minmax(3.0, 7.0), 10.0);
  });

  it('compiles select builtin', () => {
    const { sel } = atra`
      function sel(a, b, c: f64): f64
      var
        cond: i32;
      begin
        cond := if (c > 0.0) then 1 else 0
        sel := select(a, b, cond)
      end
    `;
    assert.strictEqual(sel(10.0, 20.0, 1.0), 10.0);
    assert.strictEqual(sel(10.0, 20.0, -1.0), 20.0);
  });

  it('compiles mod operator', () => {
    const { modtest } = atra`
      function modtest(a, b: i32): i32
      begin
        modtest := a mod b
      end
    `;
    assert.strictEqual(modtest(7, 3), 1);
    assert.strictEqual(modtest(10, 5), 0);
  });

  it('compiles abs (native)', () => {
    const { absf } = atra`
      function absf(x: f64): f64
      begin
        absf := abs(x)
      end
    `;
    assert.strictEqual(absf(-5.0), 5.0);
    assert.strictEqual(absf(3.0), 3.0);
  });

  it('compiles floor/ceil', () => {
    const { fl, ce } = atra`
      function fl(x: f64): f64
      begin
        fl := floor(x)
      end
      function ce(x: f64): f64
      begin
        ce := ceil(x)
      end
    `;
    assert.strictEqual(fl(3.7), 3.0);
    assert.strictEqual(ce(3.2), 4.0);
  });

  it('compiles multiple functions with cross-calls', () => {
    const { double, quadruple } = atra`
      function double(x: f64): f64
      begin
        double := x * 2.0
      end

      function quadruple(x: f64): f64
      begin
        quadruple := double(double(x))
      end
    `;
    assert.strictEqual(double(3.0), 6.0);
    assert.strictEqual(quadruple(3.0), 12.0);
  });

  it('compiles compound assignment +=', () => {
    const { accum } = atra`
      function accum(n: i32): i32
      var
        i, s: i32;
      begin
        s := 0
        for i := 0, n
          s += i
        end for
        accum := s
      end
    `;
    assert.strictEqual(accum(5), 10);
  });

  it('compiles nested if/else if', () => {
    const { classify } = atra`
      function classify(x: f64): i32
      begin
        if (x < 0.0) then
          classify := 0 - 1
        else if (x == 0.0) then
          classify := 0
        else
          classify := 1
        end if
      end
    `;
    assert.strictEqual(classify(-5.0), -1);
    assert.strictEqual(classify(0.0), 0);
    assert.strictEqual(classify(5.0), 1);
  });

  it('produces valid Wasm binary', () => {
    const bytes = compileSource(
      'function add(a, b: f64): f64\nbegin\n  add := a + b\nend',
      null, null
    );
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(WebAssembly.validate(bytes));
  });

  it('atra.dump returns hex string', () => {
    const hex = atra.dump('function f(x: f64): f64\nbegin\n  f := x\nend');
    assert.ok(typeof hex === 'string');
    assert.ok(hex.startsWith('00 61 73 6d')); // \0asm magic
  });

  it('atra.parse returns AST', () => {
    const ast = atra.parse('function f(x: f64): f64\nbegin\n  f := x\nend');
    assert.strictEqual(ast.type, 'Program');
    assert.strictEqual(ast.body[0].type, 'Function');
  });

  it('compiles for loop with step', () => {
    const { countdown } = atra`
      function countdown(n: i32): i32
      var
        i, s: i32;
      begin
        s := 0
        for i := n - 1, -1, -1
          s := s + 1
        end for
        countdown := s
      end
    `;
    assert.strictEqual(countdown(5), 5);
  });

  it('compiles logical operators', () => {
    const { logic } = atra`
      function logic(a, b: i32): i32
      begin
        if (a > 0 and b > 0) then
          logic := 1
        else
          logic := 0
        end if
      end
    `;
    assert.strictEqual(logic(1, 1), 1);
    assert.strictEqual(logic(1, 0), 0);
    assert.strictEqual(logic(0, 1), 0);
  });

  it('compiles unary negation', () => {
    const { neg } = atra`
      function neg(x: f64): f64
      begin
        neg := -x
      end
    `;
    assert.strictEqual(neg(5.0), -5.0);
    assert.strictEqual(neg(-3.0), 3.0);
  });

  it('compiles parenthesized expressions', () => {
    const { paren } = atra`
      function paren(a, b, c: f64): f64
      begin
        paren := (a + b) * c
      end
    `;
    assert.strictEqual(paren(2.0, 3.0, 4.0), 20.0);
  });

  it('compiles array access (1D)', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { getelem } = atra({ __memory: memory })`
      function getelem(arr: array f64; i: i32): f64
      begin
        getelem := arr[i]
      end
    `;
    const f64arr = new Float64Array(memory.buffer, 0, 4);
    f64arr[0] = 10.0;
    f64arr[1] = 20.0;
    f64arr[2] = 30.0;
    assert.strictEqual(getelem(0, 0), 10.0);
    assert.strictEqual(getelem(0, 1), 20.0);
    assert.strictEqual(getelem(0, 2), 30.0);
  });

  it('compiles array store', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { setelem, getelem } = atra({ __memory: memory })`
      function setelem(arr: array f64; i: i32; val: f64): f64
      begin
        arr[i] := val
        setelem := arr[i]
      end

      function getelem(arr: array f64; i: i32): f64
      begin
        getelem := arr[i]
      end
    `;
    assert.strictEqual(setelem(0, 0, 42.0), 42.0);
    assert.strictEqual(getelem(0, 0), 42.0);
  });
});
