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

  it('compiles interpolated string as source inclusion', () => {
    const libSrc = `
      function helper(x: f64): f64
      begin
        helper := x * 2.0
      end
    `;
    const { main } = atra`
      ${libSrc}
      function main(x: f64): f64
      begin
        main := helper(x) + 1.0
      end
    `;
    assert.strictEqual(main(5.0), 11.0);
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

  it('compiles boolean equality (comparison == comparison)', () => {
    const { eqv } = atra`
      function eqv(a, b, c, d: f64): i32
      begin
        eqv := 0
        if ((a > b) == (c > d)) then
          eqv := 1
        end if
      end
    `;
    assert.strictEqual(eqv(2, 1, 4, 3), 1); // both true
    assert.strictEqual(eqv(1, 2, 3, 4), 1); // both false
    assert.strictEqual(eqv(2, 1, 3, 4), 0); // true vs false
    assert.strictEqual(eqv(1, 2, 4, 3), 0); // false vs true
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

// ═══════════════════════════════════════════════════════════════════════════
// SIMD (v128)
// ═══════════════════════════════════════════════════════════════════════════

describe('simd — highlight tokenizer', () => {
  it('tokenizes f64x2, i32x4 as type (const)', () => {
    const tokens = tokenizeAtra('f64x2 i32x4');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['const', 'const']);
  });

  it('tokenizes f64x2.splat as fn', () => {
    const tokens = tokenizeAtra('f64x2.splat');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['fn']);
  });

  it('tokenizes v128.and as fn', () => {
    const tokens = tokenizeAtra('v128.and');
    const types = tokens.filter(t => t.type).map(t => t.type);
    assert.deepStrictEqual(types, ['fn']);
  });
});

describe('simd — parser', () => {
  it('parses var declaration with vector type', () => {
    const ast = parse(lex('function f(x: f64): f64x2\nvar\n  v: f64x2\nbegin\n  f := f64x2.splat(x)\nend'));
    const fn = ast.body[0];
    assert.strictEqual(fn.locals[0].vtype, 'f64x2');
    assert.strictEqual(fn.retType, 'f64x2');
  });

  it('parses vector constructor with multiple args', () => {
    const ast = parse(lex('function f(): f64x2\nbegin\n  f := f64x2(1.0, 2.0)\nend'));
    const assign = ast.body[0].body[0];
    assert.strictEqual(assign.value.type, 'FuncCall');
    assert.strictEqual(assign.value.name, 'f64x2');
    assert.strictEqual(assign.value.args.length, 2);
  });

  it('parses vector arithmetic expression', () => {
    const ast = parse(lex('function f(a, b: f64x2): f64x2\nbegin\n  f := a + b\nend'));
    const assign = ast.body[0].body[0];
    assert.strictEqual(assign.value.type, 'BinOp');
    assert.strictEqual(assign.value.op, '+');
  });
});

describe('simd — end-to-end', () => {
  it('compiles f64x2.splat + arithmetic + extract_lane', () => {
    const { test } = atra`
      function test(a, b: f64): f64
      var
        va, vb, vc: f64x2
      begin
        va := f64x2.splat(a)
        vb := f64x2.splat(b)
        vc := va + vb
        test := f64x2.extract_lane(vc, 0)
      end
    `;
    assert.strictEqual(test(3.0, 4.0), 7.0);
  });

  it('compiles f64x2 constructor (constant)', () => {
    const { test } = atra`
      function test(): f64
      var
        v: f64x2
      begin
        v := f64x2(3.14, 2.71)
        test := f64x2.extract_lane(v, 0) + f64x2.extract_lane(v, 1)
      end
    `;
    assert.ok(Math.abs(test() - 5.85) < 1e-10);
  });

  it('compiles f64x2 constructor (non-constant)', () => {
    const { test } = atra`
      function test(a, b: f64): f64
      var
        v: f64x2
      begin
        v := f64x2(a, b)
        test := f64x2.extract_lane(v, 0) + f64x2.extract_lane(v, 1)
      end
    `;
    assert.strictEqual(test(10.0, 20.0), 30.0);
  });

  it('compiles f64x2 sub, mul, div', () => {
    const { test } = atra`
      function test(x: f64): f64
      var
        a, b, c: f64x2
      begin
        a := f64x2(6.0, 8.0)
        b := f64x2(2.0, 4.0)
        c := a - b
        c := c * f64x2(3.0, 3.0)
        c := c / f64x2(2.0, 2.0)
        test := f64x2.extract_lane(c, 0) + f64x2.extract_lane(c, 1)
      end
    `;
    // a-b = (4,4), *3 = (12,12), /2 = (6,6), sum = 12
    assert.strictEqual(test(0.0), 12.0);
  });

  it('compiles f64x2 negation', () => {
    const { test } = atra`
      function test(x: f64): f64
      var
        v: f64x2
      begin
        v := f64x2(x, x)
        v := -v
        test := f64x2.extract_lane(v, 0)
      end
    `;
    assert.strictEqual(test(5.0), -5.0);
  });

  it('compiles f64x2 replace_lane', () => {
    const { test } = atra`
      function test(x: f64): f64
      var
        v: f64x2
      begin
        v := f64x2.splat(0.0)
        v := f64x2.replace_lane(v, 1, x)
        test := f64x2.extract_lane(v, 1)
      end
    `;
    assert.strictEqual(test(42.0), 42.0);
  });

  it('compiles f32x4 splat + arithmetic', () => {
    const { test } = atra`
      function test(a, b: f32): f32
      var
        va, vb, vc: f32x4
      begin
        va := f32x4.splat(a)
        vb := f32x4.splat(b)
        vc := va + vb
        test := f32x4.extract_lane(vc, 0)
      end
    `;
    assert.ok(Math.abs(test(3.0, 4.0) - 7.0) < 1e-5);
  });

  it('compiles i32x4 splat + arithmetic', () => {
    const { test } = atra`
      function test(a, b: i32): i32
      var
        va, vb, vc: i32x4
      begin
        va := i32x4.splat(a)
        vb := i32x4.splat(b)
        vc := va + vb
        test := i32x4.extract_lane(vc, 0)
      end
    `;
    assert.strictEqual(test(10, 20), 30);
  });

  it('compiles v128.load / v128.store', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { roundtrip } = atra({ __memory: memory })`
      function roundtrip(src: i32; dst: i32): f64
      var
        v: f64x2
      begin
        v := v128.load(src, 0)
        call v128.store(dst, 0, v)
        roundtrip := f64x2.extract_lane(v, 0) + f64x2.extract_lane(v, 1)
      end
    `;
    const f64arr = new Float64Array(memory.buffer);
    f64arr[0] = 3.14;
    f64arr[1] = 2.71;
    const result = roundtrip(0, 32);
    assert.ok(Math.abs(result - 5.85) < 1e-10);
    // Check that store worked
    const dst = new Float64Array(memory.buffer, 32, 2);
    assert.ok(Math.abs(dst[0] - 3.14) < 1e-10);
    assert.ok(Math.abs(dst[1] - 2.71) < 1e-10);
  });

  it('compiles sqrt on f64x2', () => {
    const { test } = atra`
      function test(): f64
      var
        v, r: f64x2
      begin
        v := f64x2(4.0, 9.0)
        r := sqrt(v)
        test := f64x2.extract_lane(r, 0) + f64x2.extract_lane(r, 1)
      end
    `;
    assert.strictEqual(test(), 5.0); // sqrt(4) + sqrt(9) = 2 + 3
  });

  it('compiles v128.and bitwise', () => {
    const { test } = atra`
      function test(a, b: f64): f64
      var
        va, vb, mask, result: f64x2
      begin
        va := f64x2(a, b)
        vb := f64x2(a, b)
        mask := f64x2.eq(va, vb)
        result := v128.and(va, mask)
        test := f64x2.extract_lane(result, 0)
      end
    `;
    // eq returns all-1s mask, and with original = original
    assert.strictEqual(test(7.0, 3.0), 7.0);
  });

  it('produces valid Wasm binary with SIMD', () => {
    const bytes = compileSource(
      'function f(x: f64): f64\nvar\n  v: f64x2\nbegin\n  v := f64x2.splat(x)\n  f := f64x2.extract_lane(v, 0)\nend',
      null, null
    );
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(WebAssembly.validate(bytes));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bulk memory: memory_copy, memory_fill
// ═══════════════════════════════════════════════════════════════════════════

describe('bulk memory', () => {
  it('compiles memory_fill', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { test_fill } = atra({ memory })`
      subroutine test_fill(dest, val, n: i32)
      begin
        call memory_fill(dest, val, n)
      end
    `;
    test_fill(0, 42, 16);
    const buf = new Uint8Array(memory.buffer);
    for (let i = 0; i < 16; i++) assert.strictEqual(buf[i], 42);
    assert.strictEqual(buf[16], 0); // untouched
  });

  it('compiles memory_copy', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { test_copy } = atra({ memory })`
      subroutine test_copy(dest, src, n: i32)
      begin
        call memory_copy(dest, src, n)
      end
    `;
    const buf = new Uint8Array(memory.buffer);
    for (let i = 0; i < 8; i++) buf[i] = i + 1; // [1,2,3,4,5,6,7,8]
    test_copy(16, 0, 8);
    for (let i = 0; i < 8; i++) assert.strictEqual(buf[16 + i], i + 1);
  });

  it('memory_fill + memory_copy roundtrip', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { fill_and_copy } = atra({ memory })`
      subroutine fill_and_copy(dest, src, val, n: i32)
      begin
        call memory_fill(src, val, n)
        call memory_copy(dest, src, n)
      end
    `;
    fill_and_copy(64, 0, 0xff, 32);
    const buf = new Uint8Array(memory.buffer);
    for (let i = 0; i < 32; i++) {
      assert.strictEqual(buf[i], 0xff);     // source filled
      assert.strictEqual(buf[64 + i], 0xff); // dest copied
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// call_indirect — function references and indirect calls
// ═══════════════════════════════════════════════════════════════════════════

describe('call_indirect', () => {
  describe('parser', () => {
    it('parses function-typed parameter', () => {
      const ast = parse(lex(`
        function apply(f: function(x: f64): f64, x: f64): f64
        begin
          apply := f(x)
        end
      `));
      const fn = ast.body[0];
      assert.strictEqual(fn.params[0].name, 'f');
      assert.strictEqual(fn.params[0].vtype, 'i32'); // stored as i32 (table index)
      assert.ok(fn.params[0].funcSig);
      assert.strictEqual(fn.params[0].funcSig.retType, 'f64');
      assert.strictEqual(fn.params[0].funcSig.params.length, 1);
      assert.strictEqual(fn.params[0].funcSig.params[0].vtype, 'f64');
    });

    it('parses function-typed local variable', () => {
      const ast = parse(lex(`
        function test(x: f64): f64
        var cb: function(a: f64): f64
        begin
          test := x
        end
      `));
      const fn = ast.body[0];
      assert.strictEqual(fn.locals[0].name, 'cb');
      assert.ok(fn.locals[0].funcSig);
      assert.strictEqual(fn.locals[0].funcSig.retType, 'f64');
    });

    it('parses function-typed global variable', () => {
      const ast = parse(lex(`
        var strategy: function(a, b: f64): f64
        function dummy(): f64
        begin
          dummy := 0.0
        end
      `));
      assert.strictEqual(ast.body[0].type, 'VarDecl');
      assert.ok(ast.body[0].funcSig);
      assert.strictEqual(ast.body[0].funcSig.params.length, 2);
    });

    it('parses function type with no return (subroutine-style)', () => {
      const ast = parse(lex(`
        function test(cb: function(x: i32)): i32
        begin
          test := 0
        end
      `));
      const fn = ast.body[0];
      assert.strictEqual(fn.params[0].funcSig.retType, null);
    });
  });

  describe('end-to-end', () => {
    it('passes function as argument and calls it indirectly', () => {
      const { apply, double, triple } = atra`
        function double(x: f64): f64
        begin
          double := x * 2.0
        end

        function triple(x: f64): f64
        begin
          triple := x * 3.0
        end

        function apply(f: function(x: f64): f64, x: f64): f64
        begin
          apply := f(x)
        end
      `;
      assert.strictEqual(apply(0, 5.0), 10.0); // double(5) = 10
      assert.strictEqual(apply(1, 5.0), 15.0); // triple(5) = 15
    });

    it('@funcname emits table index', () => {
      const { get_double_idx, get_triple_idx } = atra`
        function double(x: f64): f64
        begin
          double := x * 2.0
        end

        function triple(x: f64): f64
        begin
          triple := x * 3.0
        end

        function get_double_idx(): i32
        begin
          get_double_idx := @double
        end

        function get_triple_idx(): i32
        begin
          get_triple_idx := @triple
        end
      `;
      // Table indices are 0-based in declaration order
      assert.strictEqual(get_double_idx(), 0);
      assert.strictEqual(get_triple_idx(), 1);
    });

    it('bare function name reads return accumulator (Fortran convention)', () => {
      const { accum } = atra`
        function accum(a, b, c: f64): f64
        begin
          accum := a
          accum := accum + b
          accum := accum + c
        end
      `;
      assert.strictEqual(accum(1.0, 2.0, 3.0), 6.0);
    });

    it('assigns function reference to local variable then calls', () => {
      const { test } = atra`
        function add1(x: f64): f64
        begin
          add1 := x + 1.0
        end

        function mul2(x: f64): f64
        begin
          mul2 := x * 2.0
        end

        function test(pick: i32, x: f64): f64
        var op: function(v: f64): f64
        begin
          if (pick == 0) then
            op := @add1
          else
            op := @mul2
          end if
          test := op(x)
        end
      `;
      assert.strictEqual(test(0, 10.0), 11.0); // add1(10) = 11
      assert.strictEqual(test(1, 10.0), 20.0); // mul2(10) = 20
    });

    it('call_indirect with multiple parameters', () => {
      const { test } = atra`
        function add(a, b: f64): f64
        begin
          add := a + b
        end

        function mul(a, b: f64): f64
        begin
          mul := a * b
        end

        function test(f: function(a, b: f64): f64, x, y: f64): f64
        begin
          test := f(x, y)
        end
      `;
      assert.strictEqual(test(0, 3.0, 4.0), 7.0);  // add(3,4)=7
      assert.strictEqual(test(1, 3.0, 4.0), 12.0);  // mul(3,4)=12
    });

    it('indirect call as statement (subroutine-style)', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { write42, write99, apply_writer } = atra({ memory })`
        subroutine write42(ptr: i32, arr: array i32)
        begin
          arr[ptr] := 42
        end

        subroutine write99(ptr: i32, arr: array i32)
        begin
          arr[ptr] := 99
        end

        subroutine apply_writer(writer: function(p: i32, a: array i32), ptr: i32, arr: array i32)
        begin
          call writer(ptr, arr)
        end
      `;
      const view = new Int32Array(memory.buffer);
      apply_writer(0, 0, 0); // write42(0, arr)
      assert.strictEqual(view[0], 42);
      apply_writer(1, 1, 0); // write99(1, arr)
      assert.strictEqual(view[1], 99);
    });

    it('call_indirect with imported function reference', () => {
      const { apply } = atra({
        userSqrt: Math.sqrt,
      })`
        import userSqrt(x: f64): f64 from host

        function identity(x: f64): f64
        begin
          identity := x
        end

        function apply(f: function(x: f64): f64, x: f64): f64
        begin
          apply := f(x)
        end
      `;
      // identity is table slot 0, userSqrt is table slot 1 (sorted by funcIndex; imports come first)
      // Actually, userSqrt has funcIndex=0 (import), identity has funcIndex=1 (local)
      // Table sorted by funcIndex: userSqrt=0, identity=1
      assert.strictEqual(apply(0, 25.0), 5.0);  // userSqrt(25) = 5
      assert.strictEqual(apply(1, 25.0), 25.0); // identity(25) = 25
    });

    it('wasm module validates with SIMD + call_indirect combined', () => {
      const bytes = compileSource(`
        function double(x: f64): f64
        begin
          double := x * 2.0
        end

        function apply(f: function(x: f64): f64, x: f64): f64
        begin
          apply := f(x)
        end
      `);
      assert.ok(WebAssembly.validate(bytes));
    });

    it('__table exposes function table indices', () => {
      const wasm = atra`
        function add(x: f64): f64
        begin
          add := x + 1.0
        end

        function mul(x: f64): f64
        begin
          mul := x * 2.0
        end

        function apply(f: function(x: f64): f64, x: f64): f64
        begin
          apply := f(x)
        end
      `;
      assert.ok(wasm.__table);
      assert.strictEqual(wasm.__table.add, 0);
      assert.strictEqual(wasm.__table.mul, 1);
      assert.strictEqual(wasm.__table.apply, 2);
      // use __table to call indirectly
      assert.strictEqual(wasm.apply(wasm.__table.add, 5.0), 6.0);
      assert.strictEqual(wasm.apply(wasm.__table.mul, 5.0), 10.0);
    });

    it('__table is absent when no indirect calls', () => {
      const wasm = atra`
        function add(a, b: f64): f64
        begin
          add := a + b
        end
      `;
      assert.strictEqual(wasm.__table, undefined);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Dotted names (namespaces by convention)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('dotted names', () => {
    it('lexes dotted identifiers as single tokens', () => {
      const tokens = lex('physics.gravity');
      const ids = tokens.filter(t => t.type === 'id');
      assert.strictEqual(ids.length, 1);
      assert.strictEqual(ids[0].value, 'physics.gravity');
    });

    it('lexes multi-level dotted names', () => {
      const tokens = lex('a.b.c');
      const ids = tokens.filter(t => t.type === 'id');
      assert.strictEqual(ids.length, 1);
      assert.strictEqual(ids[0].value, 'a.b.c');
    });

    it('does not consume trailing dot', () => {
      const tokens = lex('name.');
      const ids = tokens.filter(t => t.type === 'id');
      assert.strictEqual(ids.length, 1);
      assert.strictEqual(ids[0].value, 'name');
    });

    it('parses dotted function names', () => {
      const ast = parse(lex(`
        function math.double(x: f64): f64
        begin
          math.double := x * 2.0
        end
      `));
      assert.strictEqual(ast.body[0].name, 'math.double');
    });

    it('parses dotted variable names', () => {
      const ast = parse(lex(`
        function test(x: f64): f64
        var cfg.scale: f64
        begin
          cfg.scale := 2.0
          test := x * cfg.scale
        end
      `));
      const vars = ast.body[0].locals;
      assert.strictEqual(vars[0].name, 'cfg.scale');
    });

    it('compiles and runs dotted function names', () => {
      const wasm = atra`
        function math.double(x: f64): f64
        begin
          math.double := x * 2.0
        end

        function math.triple(x: f64): f64
        begin
          math.triple := x * 3.0
        end
      `;
      // Nested access
      assert.strictEqual(wasm.math.double(5.0), 10.0);
      assert.strictEqual(wasm.math.triple(5.0), 15.0);
      // Bracket access still works (via prototype)
      assert.strictEqual(wasm['math.double'](5.0), 10.0);
    });

    it('mixes dotted and flat names', () => {
      const wasm = atra`
        function plain(x: f64): f64
        begin
          plain := x
        end

        function ns.scaled(x: f64): f64
        begin
          ns.scaled := x * 10.0
        end
      `;
      assert.strictEqual(wasm.plain(3.0), 3.0);
      assert.strictEqual(wasm.ns.scaled(3.0), 30.0);
    });

    it('dotted names work with call_indirect', () => {
      const wasm = atra`
        function model.linear(x: f64): f64
        begin
          model.linear := x
        end

        function model.squared(x: f64): f64
        begin
          model.squared := x * x
        end

        function apply(fn: function(x: f64): f64, x: f64): f64
        begin
          apply := fn(x)
        end
      `;
      assert.strictEqual(wasm.apply(wasm.__table['model.linear'], 4.0), 4.0);
      assert.strictEqual(wasm.apply(wasm.__table['model.squared'], 4.0), 16.0);
    });

    it('dotted names in __table use flat keys', () => {
      const wasm = atra`
        function ns.add(a, b: f64): f64
        begin
          ns.add := a + b
        end

        function dispatch(fn: function(a, b: f64): f64, a, b: f64): f64
        begin
          dispatch := fn(a, b)
        end
      `;
      assert.ok('ns.add' in wasm.__table);
      assert.strictEqual(wasm.dispatch(wasm.__table['ns.add'], 3.0, 4.0), 7.0);
    });

    it('cross-calls between dotted functions', () => {
      const wasm = atra`
        function math.square(x: f64): f64
        begin
          math.square := x * x
        end

        function math.sum_of_squares(a, b: f64): f64
        begin
          math.sum_of_squares := math.square(a) + math.square(b)
        end
      `;
      assert.strictEqual(wasm.math.sum_of_squares(3.0, 4.0), 25.0);
    });

    it('deep nesting works', () => {
      const wasm = atra`
        function a.b.c(x: f64): f64
        begin
          a.b.c := x + 1.0
        end
      `;
      assert.strictEqual(wasm.a.b.c(9.0), 10.0);
    });

    it('atra output feeds as atra input (composability)', () => {
      // Compile a "library" with namespaced functions
      const lib = atra`
        function linalg.dot(a, b: f64): f64
        begin
          linalg.dot := a * b
        end

        function linalg.scale(x, s: f64): f64
        begin
          linalg.scale := x * s
        end
      `;
      // Verify library works standalone
      assert.strictEqual(lib.linalg.dot(3.0, 4.0), 12.0);

      // Pass library as imports to another atra compilation
      const app = atra({ ...lib })`
        function compute(a, b, s: f64): f64
        begin
          compute := linalg.scale(linalg.dot(a, b), s)
        end
      `;
      assert.strictEqual(app.compute(3.0, 4.0, 2.0), 24.0);
    });

    it('nested imports from plain JS objects', () => {
      const app = atra({ math: { lerp: (a, b, t) => a + (b - a) * t } })`
        function test(a, b, t: f64): f64
        begin
          test := math.lerp(a, b, t)
        end
      `;
      assert.strictEqual(app.test(0.0, 10.0, 0.5), 5.0);
    });

    it('flat dotted keys still work as imports', () => {
      const app = atra({ 'ns.add': (a, b) => a + b })`
        function test(a, b: f64): f64
        begin
          test := ns.add(a, b)
        end
      `;
      assert.strictEqual(app.test(3.0, 7.0), 10.0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// atra.run — string-based full pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe('atra.run', () => {
  it('compiles and runs a function from a string', () => {
    const { add } = atra.run(`
      function add(a, b: f64): f64
      begin
        add := a + b
      end
    `);
    assert.strictEqual(add(3.0, 4.0), 7.0);
  });

  it('accepts imports', () => {
    const { test } = atra.run(`
      function test(x: f64): f64
      begin
        test := myDouble(x) + 1.0
      end
    `, { myDouble: (x) => x * 2 });
    assert.strictEqual(test(5.0), 11.0);
  });

  it('nests dotted export names', () => {
    const wasm = atra.run(`
      function math.double(x: f64): f64
      begin
        math.double := x * 2.0
      end

      function math.triple(x: f64): f64
      begin
        math.triple := x * 3.0
      end
    `);
    assert.strictEqual(wasm.math.double(5.0), 10.0);
    assert.strictEqual(wasm.math.triple(5.0), 15.0);
  });

  it('composability: atra.run output feeds as imports to another atra.run', () => {
    const lib = atra.run(`
      function linalg.dot(a, b: f64): f64
      begin
        linalg.dot := a * b
      end
    `);
    const app = atra.run(`
      function compute(a, b: f64): f64
      begin
        compute := linalg.dot(a, b)
      end
    `, { ...lib });
    assert.strictEqual(app.compute(3.0, 4.0), 12.0);
  });

  it('includes __table when indirect calls are used', () => {
    const wasm = atra.run(`
      function double(x: f64): f64
      begin
        double := x * 2.0
      end

      function apply(f: function(x: f64): f64, x: f64): f64
      begin
        apply := f(x)
      end
    `);
    assert.ok(wasm.__table);
    assert.strictEqual(wasm.__table.double, 0);
    assert.strictEqual(wasm.apply(wasm.__table.double, 5.0), 10.0);
  });

  it('shared memory via { memory }', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { setelem, getelem } = atra.run(`
      function setelem(arr: array f64; i: i32; val: f64): f64
      begin
        arr[i] := val
        setelem := arr[i]
      end

      function getelem(arr: array f64; i: i32): f64
      begin
        getelem := arr[i]
      end
    `, { memory });
    assert.strictEqual(setelem(0, 0, 42.0), 42.0);
    assert.strictEqual(getelem(0, 0), 42.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tailcall — tail call optimization
// ═══════════════════════════════════════════════════════════════════════════

describe('tailcall', () => {
  describe('parser', () => {
    it('parses tailcall statement', () => {
      const ast = parse(lex(`
        function fact(n: i32, acc: i32): i32
        begin
          if (n <= 1) then
            fact := acc
          else
            tailcall fact(n - 1, acc * n)
          end if
        end
      `));
      const body = ast.body[0].body;
      const ifStmt = body[0];
      const tailcall = ifStmt.elseBody[0];
      assert.strictEqual(tailcall.type, 'TailCall');
      assert.strictEqual(tailcall.name, 'fact');
      assert.strictEqual(tailcall.args.length, 2);
    });
  });

  describe('end-to-end', () => {
    it('basic tail recursion: factorial', () => {
      const { factorial } = atra`
        function factorial(n, acc: i32): i32
        begin
          if (n <= 1) then
            factorial := acc
          else
            tailcall factorial(n - 1, acc * n)
          end if
        end
      `;
      assert.strictEqual(factorial(1, 1), 1);
      assert.strictEqual(factorial(5, 1), 120);
      assert.strictEqual(factorial(10, 1), 3628800);
    });

    it('deep recursion without stack overflow', () => {
      const { countdown } = atra`
        function countdown(n: i32): i32
        begin
          if (n <= 0) then
            countdown := 0
          else
            tailcall countdown(n - 1)
          end if
        end
      `;
      // Would stack overflow without tail calls
      assert.strictEqual(countdown(1000000), 0);
    });

    it('subroutine tail call', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { fill_recursive } = atra({ memory })`
        subroutine fill_recursive(arr: array i32; i, n, val: i32)
        begin
          if (i < n) then
            arr[i] := val
            tailcall fill_recursive(arr, i + 1, n, val)
          end if
        end
      `;
      fill_recursive(0, 0, 10, 42);
      const view = new Int32Array(memory.buffer);
      for (let i = 0; i < 10; i++) assert.strictEqual(view[i], 42);
    });

    it('indirect tail call via function-typed variable', () => {
      const { test } = atra`
        function add1(x: f64): f64
        begin
          add1 := x + 1.0
        end

        function test(f: function(x: f64): f64, x: f64): f64
        begin
          tailcall f(x)
        end
      `;
      assert.strictEqual(test(0, 5.0), 6.0); // add1(5) = 6
    });

    it('__table + tailcall', () => {
      const wasm = atra`
        function double(x: f64): f64
        begin
          double := x * 2.0
        end

        function triple(x: f64): f64
        begin
          triple := x * 3.0
        end

        function apply(f: function(x: f64): f64, x: f64): f64
        begin
          tailcall f(x)
        end
      `;
      assert.strictEqual(wasm.apply(wasm.__table.double, 5.0), 10.0);
      assert.strictEqual(wasm.apply(wasm.__table.triple, 5.0), 15.0);
    });

    it('type mismatch throws', () => {
      assert.throws(() => {
        atra`
          function returns_f64(x: f64): f64
          begin
            returns_f64 := x
          end

          function returns_i32(x: i32): i32
          begin
            tailcall returns_f64(f64(x))
          end
        `;
      }, /tailcall type mismatch/);
    });

    it('bytecode contains return_call opcode (0x12)', () => {
      const bytes = compileSource(`
        function countdown(n: i32): i32
        begin
          if (n <= 0) then
            countdown := 0
          else
            tailcall countdown(n - 1)
          end if
        end
      `);
      assert.ok(bytes.includes(0x12));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// call return() — early return
// ═══════════════════════════════════════════════════════════════════════════

describe('call return()', () => {
  describe('end-to-end', () => {
    it('early return from function (guard clause)', () => {
      const { safediv } = atra`
        function safediv(a, b: f64): f64
        begin
          if (b == 0.0) then
            call return(0.0)
          end if
          safediv := a / b
        end
      `;
      assert.strictEqual(safediv(10.0, 2.0), 5.0);
      assert.strictEqual(safediv(10.0, 0.0), 0.0);
    });

    it('early return from subroutine', () => {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { safe_write } = atra({ memory })`
        subroutine safe_write(arr: array i32; i, n, val: i32)
        begin
          if (i >= n) then
            call return()
          end if
          arr[i] := val
        end
      `;
      const view = new Int32Array(memory.buffer);
      view[5] = 0;
      safe_write(0, 5, 3, 99); // i=5 >= n=3, should not write
      assert.strictEqual(view[5], 0);
      safe_write(0, 1, 3, 99); // i=1 < n=3, should write
      assert.strictEqual(view[1], 99);
    });

    it('multiple guard clauses', () => {
      const { classify } = atra`
        function classify(x: f64): i32
        begin
          if (x < 0.0) then
            call return(0 - 1)
          end if
          if (x == 0.0) then
            call return(0)
          end if
          classify := 1
        end
      `;
      assert.strictEqual(classify(-5.0), -1);
      assert.strictEqual(classify(0.0), 0);
      assert.strictEqual(classify(5.0), 1);
    });

    it('return() in function with wrong arg count throws', () => {
      assert.throws(() => {
        atra`
          function f(x: f64): f64
          begin
            call return()
          end
        `;
      }, /return\(\) in a function requires exactly one argument/);
    });

    it('return(x) in subroutine throws', () => {
      assert.throws(() => {
        atra`
          subroutine s(x: i32)
          begin
            call return(x)
          end
        `;
      }, /return\(\) in a subroutine takes no arguments/);
    });

    it('bytecode contains return opcode (0x0F)', () => {
      const bytes = compileSource(`
        function f(x: f64): f64
        begin
          if (x == 0.0) then
            call return(0.0)
          end if
          f := x
        end
      `);
      // Find 0x0F that is the return opcode (not just part of another instruction)
      assert.ok(bytes.includes(0x0f));
    });
  });
});
