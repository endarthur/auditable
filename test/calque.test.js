import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { calque } = await import('../ext/calque/index.js');

const lex = calque._lex;
const parse = calque._parse;
const evaluate = calque._evaluate;
const stdlib = calque._stdlib;
const layout = calque._layout;
const codegen = calque._codegen;

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

  it('template string scalar', () => {
    const src = 'name = "Alice"\nmsg = \x60hello \x24{name}\x60';
    const r = run(src);
    assert.equal(r.bindings.msg, 'hello Alice');
  });

  it('template string with column', () => {
    const src = 'names = ["Alice", "Bob"]\nmsg = \x60hi \x24{names}\x60';
    const r = run(src);
    assert.deepEqual(r.bindings.msg, ['hi Alice', 'hi Bob']);
  });

  it('import with array of objects', () => {
    const data = [{ Name: 'Alice', Revenue: 100 }, { Name: 'Bob', Revenue: 200 }];
    const r = calque.run('data = import "sales.csv"\ntotal = sum(data.Revenue)', { imports: { 'sales.csv': data } });
    assert.ok(r.bindings.data.__table);
    assert.equal(r.bindings.total, 300);
  });

  it('import with calque table', () => {
    const table = { __table: true, columns: { x: Float64Array.from([1, 2, 3]) }, headers: ['x'], rows: 3 };
    const r = calque.run('d = import "data.csv"\ny = sum(d.x)', { imports: { 'data.csv': table } });
    assert.equal(r.bindings.y, 6);
  });

  it('import with multi-sheet and sheet selector', () => {
    const data = {
      Q1: [{ val: 10 }, { val: 20 }],
      Q2: [{ val: 30 }, { val: 40 }],
    };
    const r = calque.run('d = import "report.xlsx" sheet "Q2"\ntotal = sum(d.val)', { imports: { 'report.xlsx': data } });
    assert.equal(r.bindings.total, 70);
  });

  it('import without data throws', () => {
    assert.throws(() => calque.run('d = import "missing.csv"'), /no data provided/);
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

  it('curried with imports', () => {
    const data = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const r = calque({ imports: { 'data.csv': data } })`d = import "data.csv"\ntotal = sum(d.a)`;
    assert.equal(r.bindings.total, 6);
  });

  it('result.compile() returns workbook', () => {
    const r = calque.run('Sales {\n  revenue = [100, 200, 300]\n  tax = revenue * 0.15\n}');
    assert.ok(r.bindings.Sales);
    const { workbook, warnings } = r.compile();
    assert.ok(workbook.sheets.length > 0);
    const sales = workbook.sheets.find(s => s.name === 'Sales');
    assert.ok(sales.columns.tax.formulas);
    assert.equal(sales.columns.tax.formulas[0], '=A2*0.15');
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

// ═════════════════════════════════════════════════════════════════════
// Layout
// ═════════════════════════════════════════════════════════════════════

describe('layout', () => {
  function lay(src) {
    const ast = parse(lex(src));
    const result = evaluate(ast);
    return layout(ast, result);
  }

  it('3 columns get positions A, B, C', () => {
    const l = lay('Sales {\n  a = [1,2,3]\n  b = [4,5,6]\n  c = [7,8,9]\n}');
    const s = l.sheets.Sales.bindings;
    assert.equal(s.a.col, 0);
    assert.equal(s.b.col, 1);
    assert.equal(s.c.col, 2);
  });

  it('scalar gets own column with rows=1', () => {
    const l = lay('Sales {\n  total = 42\n}');
    const s = l.sheets.Sales.bindings;
    assert.equal(s.total.rows, 1);
    assert.equal(s.total.isColumn, false);
  });

  it('_ prefix excluded from layout', () => {
    const l = lay('Sales {\n  _temp = [1,2]\n  result = [3,4]\n}');
    const s = l.sheets.Sales.bindings;
    assert.ok(!('_temp' in s));
    assert.ok('result' in s);
    assert.equal(s.result.col, 0); // first column since _temp excluded
  });

  it('FuncDef excluded from layout, collected in functions', () => {
    const l = lay('tax(a, r) = a * r\nx = 42');
    assert.equal(l.functions.length, 1);
    assert.equal(l.functions[0].name, 'tax');
    // x should be in Sheet1
    assert.ok(l.sheets.Sheet1.bindings.x);
  });

  it('two sheet blocks produce two layouts', () => {
    const l = lay('S1 {\n  a = [1,2]\n}\nS2 {\n  b = [3,4,5]\n}');
    assert.ok(l.sheets.S1);
    assert.ok(l.sheets.S2);
    assert.equal(l.sheets.S1.bindings.a.col, 0);
    assert.equal(l.sheets.S2.bindings.b.col, 0);
  });

  it('mixed columns + scalars', () => {
    const l = lay('Sales {\n  name = ["a","b","c"]\n  total = sum(name)\n}');
    const s = l.sheets.Sales.bindings;
    assert.equal(s.name.isColumn, true);
    assert.equal(s.name.rows, 3);
    // total is a scalar (sum returns number)
    assert.equal(s.total.isColumn, false);
    assert.equal(s.total.rows, 1);
  });

  it('maxRows matches longest column', () => {
    const l = lay('Sales {\n  a = [1,2,3,4,5]\n  b = [1,2]\n  c = 42\n}');
    assert.equal(l.sheets.Sales.maxRows, 5);
  });

  it('bare bindings go to Sheet1', () => {
    const l = lay('x = [1,2,3]\ny = x * 2');
    assert.ok(l.sheets.Sheet1);
    assert.equal(l.sheets.Sheet1.bindings.x.col, 0);
    assert.equal(l.sheets.Sheet1.bindings.y.col, 1);
  });

  it('column isColumn flag set correctly', () => {
    const l = lay('Sales {\n  rev = [100, 200, 300]\n}');
    assert.equal(l.sheets.Sales.bindings.rev.isColumn, true);
    assert.equal(l.sheets.Sales.bindings.rev.rows, 3);
  });

  it('FuncDef inside sheet excluded from bindings', () => {
    const l = lay('Sales {\n  helper(x) = x * 2\n  val = [1,2]\n}');
    const s = l.sheets.Sales.bindings;
    assert.ok(!('helper' in s));
    assert.ok('val' in s);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Codegen
// ═════════════════════════════════════════════════════════════════════

describe('codegen', () => {
  function compile(src) {
    const ast = parse(lex(src));
    const result = evaluate(ast);
    const l = layout(ast, result);
    return codegen(ast, l, result);
  }

  function sheet(workbook, name) {
    return workbook.sheets.find(s => s.name === name);
  }

  it('revenue * 0.15 → per-cell formulas', () => {
    const { workbook } = compile('Sales {\n  revenue = [100, 200, 300]\n  tax = revenue * 0.15\n}');
    const taxCol = sheet(workbook, 'Sales').columns.tax;
    assert.ok(taxCol.formulas);
    assert.equal(taxCol.formulas.length, 3);
    assert.equal(taxCol.formulas[0], '=A2*0.15');
    assert.equal(taxCol.formulas[1], '=A3*0.15');
    assert.equal(taxCol.formulas[2], '=A4*0.15');
  });

  it('revenue - tax → two column refs', () => {
    const { workbook } = compile('Sales {\n  revenue = [100, 200, 300]\n  tax = [10, 20, 30]\n  net = revenue - tax\n}');
    const netCol = sheet(workbook, 'Sales').columns.net;
    assert.ok(netCol.formulas);
    assert.equal(netCol.formulas[0], '=A2-B2');
  });

  it('sum(revenue) → SUM with range', () => {
    const { workbook } = compile('Sales {\n  revenue = [100, 200, 300]\n  total = sum(revenue)\n}');
    const totalCol = sheet(workbook, 'Sales').columns.total;
    assert.ok(totalCol.formulas);
    assert.equal(totalCol.formulas[0], '=SUM(A$2:A$4)');
  });

  it('sum(Sales.revenue) → cross-sheet SUM', () => {
    const { workbook } = compile('Sales {\n  revenue = [100, 200, 300]\n}\nSummary {\n  total = sum(Sales.revenue)\n}');
    const totalCol = sheet(workbook, 'Summary').columns.total;
    assert.ok(totalCol.formulas);
    assert.equal(totalCol.formulas[0], '=SUM(Sales!A$2:A$4)');
  });

  it('string & concatenation', () => {
    const { workbook } = compile('Sales {\n  a = ["x","y"]\n  b = ["1","2"]\n  c = a & b\n}');
    const cCol = sheet(workbook, 'Sales').columns.c;
    assert.ok(cCol.formulas);
    assert.equal(cCol.formulas[0], '=A2&B2');
  });

  it('if x > 0 then "big" else "small" → IF()', () => {
    const { workbook } = compile('Sales {\n  x = [10, -5]\n  y = if x > 0 then "big" else "small"\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=IF(A2>0,"big","small")');
  });

  it('== maps to = in formula', () => {
    const { workbook } = compile('Sales {\n  x = [1, 2]\n  y = [1, 3]\n  z = if x == y then 1 else 0\n}');
    const zCol = sheet(workbook, 'Sales').columns.z;
    assert.ok(zCol.formulas);
    assert.ok(zCol.formulas[0].includes('='));
    assert.equal(zCol.formulas[0], '=IF(A2=B2,1,0)');
  });

  it('/= maps to <> in formula', () => {
    const { workbook } = compile('Sales {\n  x = [1, 2]\n  y = [1, 3]\n  z = if x /= y then 1 else 0\n}');
    const zCol = sheet(workbook, 'Sales').columns.z;
    assert.ok(zCol.formulas);
    assert.equal(zCol.formulas[0], '=IF(A2<>B2,1,0)');
  });

  it('a and b → AND(), not a → NOT()', () => {
    const { workbook } = compile('Sales {\n  a = [true, false]\n  b = [true, true]\n  c = a and b\n  d = not a\n}');
    const cCol = sheet(workbook, 'Sales').columns.c;
    assert.ok(cCol.formulas);
    assert.equal(cCol.formulas[0], '=AND(A2,B2)');
    const dCol = sheet(workbook, 'Sales').columns.d;
    assert.ok(dCol.formulas);
    assert.equal(dCol.formulas[0], '=NOT(A2)');
  });

  it('FuncDef → definedNames LAMBDA', () => {
    const { workbook } = compile('tax(amount, rate) = amount * rate\nrev = [100, 200]');
    assert.ok(workbook.definedNames.length >= 1);
    const taxDef = workbook.definedNames.find(d => d.name === 'tax');
    assert.ok(taxDef);
    assert.equal(taxDef.formula, 'LAMBDA(amount,rate,amount*rate)');
  });

  it('array literal → baked (no formula)', () => {
    const { workbook, warnings } = compile('Sales {\n  data = [1, 2, 3]\n}');
    const dataCol = sheet(workbook, 'Sales').columns.data;
    assert.ok(!dataCol.formulas);
    assert.ok(warnings.some(w => w.includes('array literal')));
  });

  it('range → baked + warning', () => {
    const { workbook, warnings } = compile('Sales {\n  nums = 1..10\n}');
    const numsCol = sheet(workbook, 'Sales').columns.nums;
    assert.ok(!numsCol.formulas);
    assert.ok(warnings.some(w => w.includes('range')));
  });

  it('scalar ref → absolute $D$2', () => {
    const { workbook } = compile('Sales {\n  revenue = [100, 200, 300]\n  rate = 0.15\n  tax = revenue * rate\n}');
    const taxCol = sheet(workbook, 'Sales').columns.tax;
    assert.ok(taxCol.formulas);
    // rate is col B (index 1), scalar → $B$2
    assert.equal(taxCol.formulas[0], '=A2*$B$2');
    assert.equal(taxCol.formulas[1], '=A3*$B$2');
  });

  it('column ref → relative B2, B3', () => {
    const { workbook } = compile('Sales {\n  a = [1, 2, 3]\n  b = a + 1\n}');
    const bCol = sheet(workbook, 'Sales').columns.b;
    assert.ok(bCol.formulas);
    assert.equal(bCol.formulas[0], '=A2+1');
    assert.equal(bCol.formulas[1], '=A3+1');
    assert.equal(bCol.formulas[2], '=A4+1');
  });

  it('abs() is pointwise, not reduction', () => {
    const { workbook } = compile('Sales {\n  x = [-1, -2, 3]\n  y = abs(x)\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=ABS(A2)');
    assert.equal(yCol.formulas[1], '=ABS(A3)');
  });

  it('round(x, 2) → ROUND(A2,2)', () => {
    const { workbook } = compile('Sales {\n  x = [3.14159, 2.71828]\n  y = round(x, 2)\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=ROUND(A2,2)');
  });

  it('nested reduction sum(abs(col)) → SUM(ABS(range))', () => {
    const { workbook } = compile('Sales {\n  x = [1, -2, 3]\n  y = sum(abs(x))\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=SUM(ABS(A$2:A$4))');
  });

  it('baked values are correct arrays', () => {
    const { workbook } = compile('Sales {\n  data = [10, 20, 30]\n}');
    const dataCol = sheet(workbook, 'Sales').columns.data;
    assert.deepEqual(Array.from(dataCol), [10, 20, 30]);
  });

  it('UDF call in formula', () => {
    const { workbook } = compile('tax(a, r) = a * r\nSales {\n  rev = [100, 200]\n  t = tax(rev, 0.15)\n}');
    const tCol = sheet(workbook, 'Sales').columns.t;
    assert.ok(tCol.formulas);
    assert.equal(tCol.formulas[0], '=tax(A2,0.15)');
  });

  it('template string \u2192 concatenation formula', () => {
    const src = 'Sales {\n  name = ["Alice", "Bob"]\n  revenue = [100, 200]\n  msg = \x60\x24{name} earned \x24{revenue:$#,##0.00}\x60\n}';
    const { workbook } = compile(src);
    const msgCol = sheet(workbook, 'Sales').columns.msg;
    assert.ok(msgCol.formulas);
    assert.equal(msgCol.formulas[0], '=A2&" earned "&TEXT(B2,"$#,##0.00")');
    assert.equal(msgCol.formulas[1], '=A3&" earned "&TEXT(B3,"$#,##0.00")');
  });

  it('scan → SCAN(init, range, LAMBDA) spilled', () => {
    const { workbook } = compile('Sales {\n  x = [10, 20, 30]\n  y = scan(x, 0, (acc, v) -> acc + v)\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=SCAN(0,A$2:A$4,LAMBDA(acc,v,acc+v))');
    // spilled: only first cell has formula
    assert.equal(yCol.formulas[1], null);
    assert.equal(yCol.formulas[2], null);
  });

  it('sort → SORT(range) spilled', () => {
    const { workbook } = compile('Sales {\n  x = [30, 10, 20]\n  y = sort(x)\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=SORT(A$2:A$4)');
    assert.equal(yCol.formulas[1], null);
  });

  it('unique → UNIQUE(range) spilled', () => {
    const { workbook } = compile('Sales {\n  x = ["a", "b", "a"]\n  y = unique(x)\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=UNIQUE(A$2:A$4)');
  });

  it('filter col[col > 0] → FILTER(range, range>0) spilled', () => {
    const { workbook } = compile('Sales {\n  x = [1, -2, 3, -4, 5]\n  y = x[x > 0]\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=FILTER(A$2:A$6,A$2:A$6>0)');
    // spilled: only first cell has formula
    assert.equal(yCol.formulas[1], null);
  });

  it('lookup → XLOOKUP', () => {
    const { workbook } = compile('Sales {\n  keys = ["a", "b", "c"]\n  vals = [10, 20, 30]\n  result = lookup("b", keys, vals)\n}');
    const rCol = sheet(workbook, 'Sales').columns.result;
    assert.ok(rCol.formulas);
    assert.equal(rCol.formulas[0], '=XLOOKUP("b",A$2:A$4,B$2:B$4)');
  });

  it('lookup with nearest: "below" → XLOOKUP with match_mode', () => {
    const { workbook } = compile('Sales {\n  keys = [10, 20, 30]\n  vals = ["a", "b", "c"]\n  result = lookup(25, keys, vals, nearest: "below")\n}');
    const rCol = sheet(workbook, 'Sales').columns.result;
    assert.ok(rCol.formulas);
    assert.equal(rCol.formulas[0], '=XLOOKUP(25,A$2:A$4,B$2:B$4,,-1)');
  });

  it('rolling(col, 3, "mean") → per-row AVERAGE with sliding range', () => {
    const { workbook } = compile('Sales {\n  x = [1, 2, 3, 4, 5]\n  y = rolling(x, 3, "mean")\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    // row 0: window [x0] → AVERAGE(A2:A2)
    assert.equal(yCol.formulas[0], '=AVERAGE(A2:A2)');
    // row 1: window [x0, x1] → AVERAGE(A2:A3)
    assert.equal(yCol.formulas[1], '=AVERAGE(A2:A3)');
    // row 2: window [x0, x1, x2] → full window AVERAGE(A2:A4)
    assert.equal(yCol.formulas[2], '=AVERAGE(A2:A4)');
    // row 3: window [x1, x2, x3] → slides: AVERAGE(A3:A5)
    assert.equal(yCol.formulas[3], '=AVERAGE(A3:A5)');
    // row 4: window [x2, x3, x4] → AVERAGE(A4:A6)
    assert.equal(yCol.formulas[4], '=AVERAGE(A4:A6)');
  });

  it('rolling(col, 2, "sum") → per-row SUM', () => {
    const { workbook } = compile('Sales {\n  x = [10, 20, 30]\n  y = rolling(x, 2, "sum")\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(yCol.formulas);
    assert.equal(yCol.formulas[0], '=SUM(A2:A2)');
    assert.equal(yCol.formulas[1], '=SUM(A2:A3)');
    assert.equal(yCol.formulas[2], '=SUM(A3:A4)');
  });

  it('rolling with lambda → baked', () => {
    const { workbook, warnings } = compile('Sales {\n  x = [1, 2, 3]\n  y = rolling(x, 2, (w) -> sum(w))\n}');
    const yCol = sheet(workbook, 'Sales').columns.y;
    assert.ok(!yCol.formulas);
    assert.ok(warnings.some(w => w.includes('rolling')));
  });
});

// ═════════════════════════════════════════════════════════════════════
// Integration (calque.compile)
// ═════════════════════════════════════════════════════════════════════

describe('calque.compile', () => {
  function sheet(workbook, name) {
    return workbook.sheets.find(s => s.name === name);
  }

  it('returns workbook structure', () => {
    const { workbook, warnings, result } = calque.compile(`
      Sales {
        name = ["Alice", "Bob", "Carol"]
        revenue = [42000, 38000, 55000]
        tax = revenue * 0.15
        net = revenue - tax
      }
    `);
    assert.ok(sheet(workbook, 'Sales'));
    assert.ok(result.bindings.Sales);
    assert.ok(Array.isArray(warnings));
  });

  it('workbook has correct sheet names and columns', () => {
    const { workbook } = calque.compile(`
      Sales {
        name = ["Alice", "Bob"]
        revenue = [100, 200]
      }
    `);
    const sales = sheet(workbook, 'Sales');
    assert.ok(sales);
    assert.equal(Object.keys(sales.columns).length, 2);
    assert.ok('name' in sales.columns);
    assert.ok('revenue' in sales.columns);
  });

  it('formula columns have .formulas arrays', () => {
    const { workbook } = calque.compile(`
      Sales {
        revenue = [100, 200, 300]
        tax = revenue * 0.15
      }
    `);
    const taxCol = sheet(workbook, 'Sales').columns.tax;
    assert.ok(Array.isArray(taxCol.formulas));
    assert.equal(taxCol.formulas.length, 3);
  });

  it('baked columns are plain arrays without formulas', () => {
    const { workbook } = calque.compile(`
      Sales {
        data = [10, 20, 30]
      }
    `);
    const dataCol = sheet(workbook, 'Sales').columns.data;
    assert.ok(dataCol);
    assert.ok(!dataCol.formulas);
    assert.deepEqual(Array.from(dataCol), [10, 20, 30]);
  });

  it('definedNames populated for FuncDefs', () => {
    const { workbook } = calque.compile(`
      tax(amount, rate) = amount * rate
      Sales {
        rev = [100, 200]
        t = tax(rev, 0.1)
      }
    `);
    assert.ok(workbook.definedNames.length >= 1);
    assert.equal(workbook.definedNames[0].name, 'tax');
    assert.ok(workbook.definedNames[0].formula.includes('LAMBDA'));
  });
});
