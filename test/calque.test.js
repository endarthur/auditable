import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { calque } = await import('../ext/calque/index.js');

const lex = calque._lex;
const parse = calque._parse;
const evaluate = calque._evaluate;
const stdlib = calque._stdlib;

// ═════════════════════════════════════════════════════════════════════
// Lexer
// ═════════════════════════════════════════════════════════════════════

describe('lex', () => {
  it('numbers', () => {
    const tokens = lex('42 3.14 1e5');
    const nums = tokens.filter(t => t.type === 'num');
    assert.equal(nums.length, 3);
    assert.equal(nums[0].value, 42);
    assert.equal(nums[1].value, 3.14);
    assert.equal(nums[2].value, 1e5);
  });

  it('strings', () => {
    const tokens = lex('"hello" "world"');
    const strs = tokens.filter(t => t.type === 'str');
    assert.equal(strs.length, 2);
    assert.equal(strs[0].value, 'hello');
    assert.equal(strs[1].value, 'world');
  });

  it('string escape sequences', () => {
    const tokens = lex('"line\\n\\ttab"');
    const strs = tokens.filter(t => t.type === 'str');
    assert.equal(strs[0].value, 'line\n\ttab');
  });

  it('identifiers and keywords', () => {
    const tokens = lex('revenue if then else true false null');
    assert.equal(tokens.filter(t => t.type === 'id').length, 1);
    assert.equal(tokens.filter(t => t.type === 'kw').length, 6);
  });

  it('operators', () => {
    const tokens = lex('+ - * / ^ & == /= != < > <= >= ->');
    const ops = tokens.filter(t => t.type === 'op');
    assert.equal(ops.length, 14);
    assert.equal(ops[7].value, '/=');
    assert.equal(ops[8].value, '!=');
    assert.equal(ops[13].value, '->');
  });

  it('range operator', () => {
    const tokens = lex('1..10');
    assert.equal(tokens.filter(t => t.type === 'range').length, 1);
  });

  it('comments', () => {
    const tokens = lex('x = 42 -- this is a comment\ny = 10');
    // comment should not produce tokens
    assert.ok(!tokens.some(t => t.value && typeof t.value === 'string' && t.value.includes('comment')));
    const ids = tokens.filter(t => t.type === 'id');
    assert.equal(ids.length, 2);
  });

  it('significant newlines', () => {
    const tokens = lex('x = 42\ny = 10');
    assert.ok(tokens.some(t => t.type === 'nl'));
  });

  it('newlines suppressed inside brackets', () => {
    const tokens = lex('[\n1,\n2,\n3\n]');
    // Only a trailing NL after ] is allowed (statement ender); no NL inside brackets
    const nlTokens = tokens.filter(t => t.type === 'nl');
    assert.ok(nlTokens.length <= 1); // at most the trailing one
  });

  it('template strings', () => {
    const tokens = lex('`hello ${x} world`');
    const tmpls = tokens.filter(t => t.type === 'tmpl');
    assert.equal(tmpls.length, 1);
    assert.ok(Array.isArray(tmpls[0].value));
  });

  it('template strings with format', () => {
    const tokens = lex('`${revenue:$#,##0.00}`');
    const tmpl = tokens.find(t => t.type === 'tmpl');
    const exprPart = tmpl.value.find(p => typeof p === 'object');
    assert.equal(exprPart.expr, 'revenue');
    assert.equal(exprPart.format, '$#,##0.00');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Parser
// ═════════════════════════════════════════════════════════════════════

describe('parse', () => {
  function parseStr(src) {
    return parse(lex(src));
  }

  it('simple binding', () => {
    const ast = parseStr('x = 42');
    assert.equal(ast.body.length, 1);
    assert.equal(ast.body[0].type, 'Binding');
    assert.equal(ast.body[0].name, 'x');
    assert.equal(ast.body[0].expr.type, 'NumberLit');
    assert.equal(ast.body[0].expr.value, 42);
  });

  it('multiple bindings', () => {
    const ast = parseStr('x = 1\ny = 2\nz = 3');
    assert.equal(ast.body.length, 3);
  });

  it('binary expression', () => {
    const ast = parseStr('x = 1 + 2 * 3');
    const expr = ast.body[0].expr;
    assert.equal(expr.type, 'BinOp');
    assert.equal(expr.op, '+');
    assert.equal(expr.right.type, 'BinOp');
    assert.equal(expr.right.op, '*');
  });

  it('operator precedence: power right-associative', () => {
    const ast = parseStr('x = 2 ^ 3 ^ 4');
    const expr = ast.body[0].expr;
    assert.equal(expr.op, '^');
    assert.equal(expr.right.type, 'BinOp');
    assert.equal(expr.right.op, '^');
  });

  it('unary minus', () => {
    const ast = parseStr('x = -5');
    assert.equal(ast.body[0].expr.type, 'UnaryOp');
    assert.equal(ast.body[0].expr.op, '-');
  });

  it('array literal', () => {
    const ast = parseStr('x = [1, 2, 3]');
    assert.equal(ast.body[0].expr.type, 'ArrayLit');
    assert.equal(ast.body[0].expr.elements.length, 3);
  });

  it('function call', () => {
    const ast = parseStr('x = sum(col)');
    assert.equal(ast.body[0].expr.type, 'FuncCall');
    assert.equal(ast.body[0].expr.name, 'sum');
    assert.equal(ast.body[0].expr.args.length, 1);
  });

  it('function call with kwargs', () => {
    const ast = parseStr('x = lookup(needle, keys, vals, nearest: "below")');
    const call = ast.body[0].expr;
    assert.equal(call.kwargs.length, 1);
    assert.equal(call.kwargs[0].name, 'nearest');
  });

  it('sheet block', () => {
    const ast = parseStr('Sales {\n  name = [1, 2]\n  total = sum(name)\n}');
    assert.equal(ast.body[0].type, 'SheetBlock');
    assert.equal(ast.body[0].name, 'Sales');
    assert.equal(ast.body[0].body.length, 2);
  });

  it('function definition', () => {
    const ast = parseStr('tax(amount, rate) = amount * rate');
    assert.equal(ast.body[0].type, 'FuncDef');
    assert.equal(ast.body[0].name, 'tax');
    assert.equal(ast.body[0].params.length, 2);
  });

  it('lambda', () => {
    const ast = parseStr('x = (a, b) -> a + b');
    assert.equal(ast.body[0].expr.type, 'Lambda');
    assert.equal(ast.body[0].expr.params.length, 2);
  });

  it('if expression', () => {
    const ast = parseStr('x = if a > 0 then "pos" else "neg"');
    assert.equal(ast.body[0].expr.type, 'IfExpr');
  });

  it('range expression', () => {
    const ast = parseStr('x = 1..100');
    assert.equal(ast.body[0].expr.type, 'Range');
  });

  it('member access', () => {
    const ast = parseStr('x = table.column');
    assert.equal(ast.body[0].expr.type, 'MemberAccess');
    assert.equal(ast.body[0].expr.field, 'column');
  });

  it('subscript / filter', () => {
    const ast = parseStr('x = col[col > 0]');
    assert.equal(ast.body[0].expr.type, 'Subscript');
  });

  it('table literal', () => {
    const ast = parseStr('x = { Name: ["a", "b"], Value: [1, 2] }');
    assert.equal(ast.body[0].expr.type, 'TableLit');
    assert.equal(ast.body[0].expr.columns.length, 2);
  });

  it('import expression', () => {
    const ast = parseStr('data = import "sales.xlsx"');
    assert.equal(ast.body[0].expr.type, 'Import');
    assert.equal(ast.body[0].expr.path, 'sales.xlsx');
  });

  it('import with sheet name', () => {
    const ast = parseStr('data = import "sales.xlsx" sheet "Q3 Data"');
    assert.equal(ast.body[0].expr.sheetName, 'Q3 Data');
  });

  it('non-exported binding (underscore prefix)', () => {
    const ast = parseStr('_temp = 42');
    assert.equal(ast.body[0].exported, false);
  });

  it('exported binding', () => {
    const ast = parseStr('result = 42');
    assert.equal(ast.body[0].exported, true);
  });

  it('string concatenation &', () => {
    const ast = parseStr('x = "hello" & " " & "world"');
    assert.equal(ast.body[0].expr.type, 'BinOp');
    assert.equal(ast.body[0].expr.op, '&');
  });

  it('grouped expression', () => {
    const ast = parseStr('x = (1 + 2) * 3');
    assert.equal(ast.body[0].expr.type, 'BinOp');
    assert.equal(ast.body[0].expr.op, '*');
    // left should be the sum 1+2
    assert.equal(ast.body[0].expr.left.type, 'BinOp');
    assert.equal(ast.body[0].expr.left.op, '+');
  });

  it('boolean literals', () => {
    const ast = parseStr('x = true\ny = false');
    assert.equal(ast.body[0].expr.type, 'BoolLit');
    assert.equal(ast.body[0].expr.value, true);
    assert.equal(ast.body[1].expr.type, 'BoolLit');
    assert.equal(ast.body[1].expr.value, false);
  });

  it('null literal', () => {
    const ast = parseStr('x = null');
    assert.equal(ast.body[0].expr.type, 'NullLit');
  });

  it('and/or/not operators', () => {
    const ast = parseStr('x = true and false or not true');
    // should parse as: (true and false) or (not true) due to precedence
    assert.equal(ast.body[0].expr.type, 'BinOp');
    assert.equal(ast.body[0].expr.op, 'or');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Standard Library
// ═════════════════════════════════════════════════════════════════════

describe('stdlib', () => {
  it('sum', () => {
    assert.equal(stdlib.sum(Float64Array.from([1, 2, 3, 4])), 10);
  });

  it('mean', () => {
    assert.equal(stdlib.mean(Float64Array.from([2, 4, 6])), 4);
  });

  it('count', () => {
    assert.equal(stdlib.count([1, null, 3, null, 5]), 3);
  });

  it('min/max', () => {
    assert.equal(stdlib.min(Float64Array.from([5, 2, 8, 1])), 1);
    assert.equal(stdlib.max(Float64Array.from([5, 2, 8, 1])), 8);
  });

  it('unique', () => {
    const result = stdlib.unique(['a', 'b', 'a', 'c', 'b']);
    assert.deepEqual(result, ['a', 'b', 'c']);
  });

  it('round', () => {
    assert.equal(stdlib.round(3.14159, 2), 3.14);
    assert.equal(stdlib.round(3.5), 4);
  });

  it('abs', () => {
    assert.equal(stdlib.abs(-5), 5);
    assert.equal(stdlib.abs(5), 5);
  });

  it('sqrt', () => {
    assert.equal(stdlib.sqrt(9), 3);
    assert.equal(stdlib.sqrt(0), 0);
  });

  it('mod', () => {
    assert.equal(stdlib.mod(10, 3), 1);
  });

  it('len', () => {
    assert.equal(stdlib.len('hello'), 5);
  });

  it('trim', () => {
    assert.equal(stdlib.trim('  hello  '), 'hello');
  });

  it('left/right/mid', () => {
    assert.equal(stdlib.left('hello', 3), 'hel');
    assert.equal(stdlib.right('hello', 3), 'llo');
    assert.equal(stdlib.mid('hello', 2, 3), 'ell'); // 1-indexed
  });

  it('str', () => {
    assert.equal(stdlib.str(42), '42');
  });

  it('iferror', () => {
    assert.equal(stdlib.iferror(NaN, 0), 0);
    assert.equal(stdlib.iferror(42, 0), 42);
    assert.equal(stdlib.iferror(null, 'default'), 'default');
  });

  it('ifna', () => {
    assert.equal(stdlib.ifna(null, 'fallback'), 'fallback');
    assert.equal(stdlib.ifna(42, 'fallback'), 42);
  });

  it('scan', () => {
    const result = stdlib.scan(Float64Array.from([10, 20, 30, 40]), 0, (acc, x) => acc + x);
    assert.deepEqual(Array.from(result), [10, 30, 60, 100]);
  });

  it('date/year/month/day', () => {
    const serial = stdlib.date(2025, 3, 3);
    assert.equal(stdlib.year(serial), 2025);
    assert.equal(stdlib.month(serial), 3);
    assert.equal(stdlib.day(serial), 3);
  });

  it('log', () => {
    // log base 10
    assert.ok(Math.abs(stdlib.log(100) - 2) < 1e-10);
    // log base 2
    assert.ok(Math.abs(stdlib.log(8, 2) - 3) < 1e-10);
  });

  it('exp', () => {
    assert.ok(Math.abs(stdlib.exp(0) - 1) < 1e-10);
    assert.ok(Math.abs(stdlib.exp(1) - Math.E) < 1e-10);
  });

  it('floor/ceil', () => {
    assert.equal(stdlib.floor(3.7), 3);
    assert.equal(stdlib.ceil(3.2), 4);
  });

  it('rolling', () => {
    const col = Float64Array.from([1, 2, 3, 4, 5]);
    const result = stdlib.rolling(col, 3, 'mean');
    // window of 3: [1], [1,2], [1,2,3], [2,3,4], [3,4,5]
    assert.ok(Math.abs(result[0] - 1) < 1e-10);
    assert.ok(Math.abs(result[1] - 1.5) < 1e-10);
    assert.ok(Math.abs(result[2] - 2) < 1e-10);
    assert.ok(Math.abs(result[3] - 3) < 1e-10);
    assert.ok(Math.abs(result[4] - 4) < 1e-10);
  });

  it('lookup exact match', () => {
    const keys = ['a', 'b', 'c'];
    const vals = Float64Array.from([10, 20, 30]);
    assert.equal(stdlib.lookup('b', keys, vals), 20);
    assert.equal(stdlib.lookup('z', keys, vals), null);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Evaluator
// ═════════════════════════════════════════════════════════════════════

describe('evaluate', () => {
  function run(src) {
    return calque.run(src);
  }

  it('scalar arithmetic', () => {
    const r = run('x = 1 + 2 * 3');
    assert.equal(r.bindings.x, 7);
  });

  it('power', () => {
    const r = run('x = 2 ^ 10');
    assert.equal(r.bindings.x, 1024);
  });

  it('array literal', () => {
    const r = run('x = [1, 2, 3]');
    assert.deepEqual(Array.from(r.bindings.x), [1, 2, 3]);
    assert.ok(r.bindings.x instanceof Float64Array);
  });

  it('string array', () => {
    const r = run('x = ["a", "b", "c"]');
    assert.deepEqual(r.bindings.x, ['a', 'b', 'c']);
  });

  it('column arithmetic (broadcasting)', () => {
    const r = run('x = [1, 2, 3]\ny = x * 2');
    assert.deepEqual(Array.from(r.bindings.y), [2, 4, 6]);
  });

  it('column + column', () => {
    const r = run('a = [1, 2, 3]\nb = [10, 20, 30]\nc = a + b');
    assert.deepEqual(Array.from(r.bindings.c), [11, 22, 33]);
  });

  it('sum reduction', () => {
    const r = run('x = [1, 2, 3, 4]\ny = sum(x)');
    assert.equal(r.bindings.y, 10);
  });

  it('mean', () => {
    const r = run('x = [2, 4, 6]\ny = mean(x)');
    assert.equal(r.bindings.y, 4);
  });

  it('range', () => {
    const r = run('x = 1..5');
    assert.deepEqual(Array.from(r.bindings.x), [1, 2, 3, 4, 5]);
  });

  it('range with arithmetic', () => {
    const r = run('n = 5\nx = 1..n\ny = x * x');
    assert.deepEqual(Array.from(r.bindings.y), [1, 4, 9, 16, 25]);
  });

  it('string concatenation', () => {
    const r = run('x = "hello" & " " & "world"');
    assert.equal(r.bindings.x, 'hello world');
  });

  it('string concat with column', () => {
    const r = run('idx = [1, 2, 3]\nx = "Row " & str(idx)');
    assert.deepEqual(r.bindings.x, ['Row 1', 'Row 2', 'Row 3']);
  });

  it('if expression scalar', () => {
    const r = run('x = if 5 > 3 then "yes" else "no"');
    assert.equal(r.bindings.x, 'yes');
  });

  it('if expression broadcast', () => {
    const r = run('x = [10, 5, 20]\ny = if x > 8 then "big" else "small"');
    assert.deepEqual(r.bindings.y, ['big', 'small', 'big']);
  });

  it('user-defined function', () => {
    const r = run('double(x) = x * 2\ny = double(21)');
    assert.equal(r.bindings.y, 42);
  });

  it('user-defined function with column', () => {
    const r = run('tax(amount, rate) = amount * rate\nrev = [100, 200, 300]\nt = tax(rev, 0.15)');
    assert.deepEqual(Array.from(r.bindings.t), [15, 30, 45]);
  });

  it('lambda with scan', () => {
    const r = run('x = [10, 20, 30]\ny = scan(x, 0, (acc, v) -> acc + v)');
    assert.deepEqual(Array.from(r.bindings.y), [10, 30, 60]);
  });

  it('sheet block', () => {
    const r = run('Sales {\n  revenue = [100, 200, 300]\n  tax = revenue * 0.1\n}');
    assert.ok('Sales' in r.sheets);
    const sales = r.bindings.Sales;
    assert.ok(sales.__table);
    assert.deepEqual(Array.from(sales.columns.revenue), [100, 200, 300]);
    assert.deepEqual(Array.from(sales.columns.tax), [10, 20, 30]);
  });

  it('cross-sheet reference', () => {
    const r = run('Sales {\n  revenue = [100, 200, 300]\n}\nSummary {\n  total = sum(Sales.revenue)\n}');
    const summary = r.bindings.Summary;
    assert.equal(summary.columns.total, 600);
  });

  it('table literal', () => {
    const r = run('t = { Name: ["a", "b"], Value: [1, 2] }');
    assert.ok(r.bindings.t.__table);
    assert.deepEqual(r.bindings.t.columns.Name, ['a', 'b']);
  });

  it('member access on table', () => {
    const r = run('t = { Name: ["a", "b"], Value: [1, 2] }\nx = t.Value');
    assert.deepEqual(Array.from(r.bindings.x), [1, 2]);
  });

  it('filter (subscript with boolean)', () => {
    const r = run('x = [1, 2, 3, 4, 5]\ny = x[x > 3]');
    assert.deepEqual(Array.from(r.bindings.y), [4, 5]);
  });

  it('non-exported binding', () => {
    const r = run('_temp = 42\nresult = _temp * 2');
    assert.ok(!r.exports.has || !('_temp' in r.exports));
    assert.equal(r.bindings.result, 84);
  });

  it('boolean operations', () => {
    const r = run('x = true and false\ny = true or false\nz = not true');
    assert.equal(r.bindings.x, false);
    assert.equal(r.bindings.y, true);
    assert.equal(r.bindings.z, false);
  });

  it('comparison operators', () => {
    const r = run('a = 5 == 5\nb = 5 /= 3\nc = 5 != 3');
    assert.equal(r.bindings.a, true);
    assert.equal(r.bindings.b, true);
    assert.equal(r.bindings.c, true);
  });

  it('nested function calls', () => {
    const r = run('x = [1, -2, 3, -4]\ny = sum(abs(x))');
    assert.equal(r.bindings.y, 10);
  });

  it('unary minus on column', () => {
    const r = run('x = [1, 2, 3]\ny = -x');
    assert.deepEqual(Array.from(r.bindings.y), [-1, -2, -3]);
  });

  it('division by zero', () => {
    const r = run('x = 1 / 0');
    assert.ok(isNaN(r.bindings.x)); // #DIV/0!
  });

  it('unique function', () => {
    const r = run('x = ["a", "b", "a", "c"]\ny = unique(x)');
    assert.deepEqual(r.bindings.y, ['a', 'b', 'c']);
  });

  it('spec example: Sales + Summary', () => {
    const r = run(`
      Sales {
        name = ["Alice", "Bob", "Carol"]
        revenue = [42000, 38000, 55000]
        tax = revenue * 0.15
        net = revenue - tax
      }
      Summary {
        grand = sum(Sales.revenue)
        avg = mean(Sales.revenue)
        headcount = count(Sales.name)
      }
    `);
    assert.equal(r.bindings.Summary.columns.grand, 135000);
    assert.equal(r.bindings.Summary.columns.avg, 45000);
    assert.equal(r.bindings.Summary.columns.headcount, 3);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════════════

describe('calque API', () => {
  it('calque.run returns bindings', () => {
    const r = calque.run('x = 42');
    assert.equal(r.bindings.x, 42);
  });

  it('calque.parse returns AST', () => {
    const ast = calque.parse('x = 1 + 2');
    assert.equal(ast.type, 'Program');
    assert.equal(ast.body.length, 1);
  });

  it('calque.lex returns tokens', () => {
    const tokens = calque.lex('x = 42');
    assert.ok(tokens.length > 0);
    assert.equal(tokens[tokens.length - 1].type, 'eof');
  });

  it('tagged template', () => {
    const r = calque`x = [1, 2, 3]\ny = sum(x)`;
    assert.equal(r.bindings.y, 6);
  });

  it('direct call with string', () => {
    const r = calque('x = 10\ny = x * 2');
    assert.equal(r.bindings.y, 20);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Highlighting tokenizer
// ═════════════════════════════════════════════════════════════════════

describe('tokenizeCalque (highlight)', () => {
  const tokenize = calque._tokenize;

  it('tokenizes keywords', () => {
    const tokens = tokenize('if then else');
    assert.equal(tokens.filter(t => t.type === 'kw').length, 3);
  });

  it('tokenizes builtins', () => {
    const tokens = tokenize('sum(x)');
    assert.equal(tokens[0].type, 'fn');
    assert.equal(tokens[0].text, 'sum');
  });

  it('tokenizes comments', () => {
    const tokens = tokenize('x = 1 -- comment');
    assert.ok(tokens.some(t => t.type === 'cmt'));
  });

  it('tokenizes operators', () => {
    const tokens = tokenize('.. -> == /= !=');
    const ops = tokens.filter(t => t.type === 'op');
    assert.ok(ops.length >= 4);
  });
});
