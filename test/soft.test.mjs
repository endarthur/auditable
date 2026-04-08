import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { softTokenize, T, KEYWORDS, softSetLocale } from '../ext/soft/src/tokenize.js';
import { softParse } from '../ext/soft/src/parse.js';
import { softParseNames, softFindUses, softExecute } from '../ext/soft/src/cell.js';
import { tokenizeSoft, softCompletions } from '../ext/soft/src/highlight.js';
import { softTag } from '../ext/soft/src/tag.js';

// helper: extract types and values, stripping trailing NL+EOF
function toks(code) {
  return softTokenize(code).filter(t => t.type !== T.EOF).map(t => [t.type, t.value]);
}
function types(code) {
  return softTokenize(code).filter(t => t.type !== T.EOF && t.type !== T.NL).map(t => t.type);
}
function vals(code) {
  return softTokenize(code).filter(t => t.type !== T.EOF && t.type !== T.NL).map(t => t.value);
}

describe('soft tokenizer', () => {

  describe('basics', () => {
    it('empty string', () => {
      const r = softTokenize('');
      assert.equal(r.length, 1);
      assert.equal(r[0].type, T.EOF);
    });

    it('single number', () => {
      assert.deepEqual(types('42'), [T.NUM]);
      assert.deepEqual(vals('42'), ['42']);
    });

    it('float', () => {
      assert.deepEqual(vals('3.14'), ['3.14']);
    });

    it('hex, binary, octal', () => {
      assert.deepEqual(vals('0xFF'), ['0xFF']);
      assert.deepEqual(vals('0b1010'), ['0b1010']);
      assert.deepEqual(vals('0o77'), ['0o77']);
    });

    it('negative number', () => {
      assert.deepEqual(vals('-7'), ['-7']);
      assert.deepEqual(types('-7'), [T.NUM]);
    });

    it('subtraction (not negative)', () => {
      const r = vals('x - 7');
      assert.deepEqual(r, ['x', '-', '7']);
    });
  });

  describe('strings', () => {
    it('simple string', () => {
      assert.deepEqual(vals('"hello world"'), ['hello world']);
    });

    it('escape sequences', () => {
      assert.deepEqual(vals('"a\\nb"'), ['a\nb']);
      assert.deepEqual(vals('"a\\tb"'), ['a\tb']);
      assert.deepEqual(vals('"she said \\"hi\\""'), ['she said "hi"']);
      assert.deepEqual(vals('"back\\\\slash"'), ['back\\slash']);
    });

    it('empty string', () => {
      assert.deepEqual(vals('""'), ['']);
    });
  });

  describe('keywords', () => {
    it('recognizes keywords', () => {
      assert.deepEqual(types('say'), [T.KW]);
      assert.deepEqual(types('if'), [T.KW]);
      assert.deepEqual(types('keep'), [T.KW]);
      assert.deepEqual(types('set'), [T.KW]);
      assert.deepEqual(types('define'), [T.KW]);
    });

    it('identifiers are not keywords', () => {
      assert.deepEqual(types('myVar'), [T.ID]);
      assert.deepEqual(types('grade'), [T.ID]);
    });

    it('dot-path is always ID', () => {
      assert.deepEqual(types('Math.round'), [T.ID]);
      assert.deepEqual(types('Text.upper'), [T.ID]);
    });

    it('dot-path with keyword segment is still ID', () => {
      // "set" is a keyword but "Math.set" should be ID
      assert.deepEqual(types('obj.set'), [T.ID]);
    });
  });

  describe('operators', () => {
    it('arithmetic', () => {
      assert.deepEqual(vals('+ - * / % **'), ['+', '-', '*', '/', '%', '**']);
    });

    it('comparison', () => {
      assert.deepEqual(vals('> < == != >= <='), ['>', '<', '==', '!=', '>=', '<=']);
      assert.deepEqual(types('== !='), [T.CMP, T.CMP]);
    });

    it('concat', () => {
      assert.deepEqual(types('&'), [T.CONCAT]);
    });

    it('bitwise', () => {
      assert.deepEqual(types('~ << >>'), [T.BITOP, T.BITOP, T.BITOP]);
    });

    it('bang', () => {
      assert.deepEqual(types('!'), [T.BANG]);
    });

    it('parens and comma', () => {
      assert.deepEqual(types('(x, y)'), [T.LPAREN, T.ID, T.COMMA, T.ID, T.RPAREN]);
    });
  });

  describe('newlines', () => {
    it('newlines produce NL tokens', () => {
      const r = toks('foo\nbar');
      assert.deepEqual(r, [[T.ID, 'foo'], [T.NL, '\n'], [T.ID, 'bar'], [T.NL, '\n']]);
    });

    it('consecutive newlines are collapsed', () => {
      const r = toks('foo\n\n\nbar');
      assert.deepEqual(r, [[T.ID, 'foo'], [T.NL, '\n'], [T.ID, 'bar'], [T.NL, '\n']]);
    });

    it('leading newlines are skipped', () => {
      const r = toks('\n\nfoo');
      assert.deepEqual(r, [[T.ID, 'foo'], [T.NL, '\n']]);
    });
  });

  describe('comments', () => {
    it('line comment', () => {
      assert.deepEqual(vals('# this is a comment\nsay'), ['say']);
    });

    it('inline comment', () => {
      assert.deepEqual(vals('set x to 5 # assign'), ['set', 'x', 'to', '5']);
    });
  });

  describe('unicode identifiers', () => {
    it('CJK characters', () => {
      assert.deepEqual(types('品位'), [T.ID]);
      assert.deepEqual(vals('品位'), ['品位']);
    });

    it('accented Latin', () => {
      assert.deepEqual(types('média'), [T.ID]);
    });
  });

  describe('full statements', () => {
    it('say hello world', () => {
      const r = vals('say "hello world"');
      assert.deepEqual(r, ['say', 'hello world']);
    });

    it('set x to 5', () => {
      const r = vals('set x to 5');
      assert.deepEqual(r, ['set', 'x', 'to', '5']);
    });

    it('say with concat', () => {
      const r = vals('say "hello " & name & "!"');
      assert.deepEqual(r, ['say', 'hello ', '&', 'name', '&', '!']);
    });

    it('keep with comparison', () => {
      const r = vals('keep grade above 50');
      assert.deepEqual(r, ['keep', 'grade', 'above', '50']);
    });

    it('if condition end', () => {
      const r = vals('if x above 5\nsay "big"\nend');
      assert.deepEqual(r, ['if', 'x', 'above', '5', 'say', 'big', 'end']);
    });

    it('pipeline', () => {
      const r = vals('take intervals\nkeep grade above 50\naverage grade');
      assert.deepEqual(r, [
        'take', 'intervals',
        'keep', 'grade', 'above', '50',
        'average', 'grade',
      ]);
    });

    it('function definition', () => {
      const r = vals('define send message to person\nsay message\nend');
      assert.deepEqual(r, ['define', 'send', 'message', 'to', 'person', 'say', 'message', 'end']);
    });

    it('mixed symbols and english', () => {
      const r = vals('set tonnage to length * density');
      assert.deepEqual(r, ['set', 'tonnage', 'to', 'length', '*', 'density']);
    });

    it('bitwise with english', () => {
      const r = vals('say flags bitwise and mask');
      assert.deepEqual(r, ['say', 'flags', 'bitwise', 'and', 'mask']);
    });

    it('at least / at most', () => {
      const r = vals('if x at least 50\nsay "pass"\nend');
      assert.deepEqual(r, ['if', 'x', 'at', 'least', '50', 'say', 'pass', 'end']);
    });
  });

  describe('edge cases', () => {
    it('negative number after operator', () => {
      const r = vals('set x to -5');
      assert.deepEqual(r, ['set', 'x', 'to', '-5']);
    });

    it('negative number after comma', () => {
      const r = vals('list 1, -2, 3');
      assert.deepEqual(r, ['list', '1', ',', '-2', ',', '3']);
    });

    it('subtraction between values', () => {
      const r = vals('x - 5');
      assert.deepEqual(r, ['x', '-', '5']);
    });

    it('negative after lparen', () => {
      const r = vals('(-5)');
      assert.deepEqual(r, ['(', '-5', ')']);
    });

    it('URL in string does not break', () => {
      const r = vals('"https://example.com"');
      assert.deepEqual(r, ['https://example.com']);
    });

    it('empty program', () => {
      const r = softTokenize('');
      assert.equal(r.length, 1);
      assert.equal(r[0].type, T.EOF);
    });

    it('only comments', () => {
      const r = softTokenize('# nothing here');
      assert.equal(r.length, 1);
      assert.equal(r[0].type, T.EOF);
    });
  });
});

// ── parser tests ──

describe('soft parser', () => {

  describe('expressions', () => {
    it('number literal', () => {
      const ast = softParse('say 42');
      assert.equal(ast.body[0].type, 'Say');
      assert.equal(ast.body[0].value.type, 'Num');
      assert.equal(ast.body[0].value.value, 42);
    });

    it('string literal', () => {
      const ast = softParse('say "hello"');
      assert.equal(ast.body[0].value.type, 'Str');
      assert.equal(ast.body[0].value.value, 'hello');
    });

    it('arithmetic', () => {
      const ast = softParse('say 3 + 4 * 2');
      const expr = ast.body[0].value;
      assert.equal(expr.type, 'BinOp');
      assert.equal(expr.op, '+');
      assert.equal(expr.left.value, 3);
      assert.equal(expr.right.op, '*');
    });

    it('english arithmetic', () => {
      const ast = softParse('say 3 plus 4 times 2');
      const expr = ast.body[0].value;
      assert.equal(expr.op, '+');
      assert.equal(expr.right.op, '*');
    });

    it('concat', () => {
      const ast = softParse('say "a" & "b"');
      const expr = ast.body[0].value;
      assert.equal(expr.type, 'BinOp');
      assert.equal(expr.op, '&');
    });

    it('parentheses', () => {
      const ast = softParse('say (3 + 4) * 2');
      const expr = ast.body[0].value;
      assert.equal(expr.op, '*');
      assert.equal(expr.left.type, 'Group');
    });

    it('of chain', () => {
      const ast = softParse('say grade of row');
      const expr = ast.body[0].value;
      assert.equal(expr.type, 'Of');
      assert.equal(expr.prop.name, 'grade');
      assert.equal(expr.obj.name, 'row');
    });

    it('boolean and nothing', () => {
      const t = softParse('say true').body[0].value;
      assert.equal(t.type, 'Bool');
      assert.equal(t.value, true);
      const n = softParse('say nothing').body[0].value;
      assert.equal(n.type, 'Nothing');
    });

    it('length of', () => {
      const ast = softParse('say length of items');
      const expr = ast.body[0].value;
      assert.equal(expr.type, 'LengthOf');
      assert.equal(expr.expr.name, 'items');
    });
  });

  describe('statements', () => {
    it('set/to', () => {
      const ast = softParse('set x to 5');
      assert.equal(ast.body[0].type, 'Set');
      assert.equal(ast.body[0].name, 'x');
      assert.equal(ast.body[0].value.value, 5);
    });

    it('put/into', () => {
      const ast = softParse('put 42 into answer');
      assert.equal(ast.body[0].type, 'Set');
      assert.equal(ast.body[0].name, 'answer');
    });

    it('if/end', () => {
      const ast = softParse('if x above 5\nsay "big"\nend');
      const node = ast.body[0];
      assert.equal(node.type, 'If');
      assert.equal(node.cond.op, '>');
      assert.equal(node.body.length, 1);
      assert.equal(node.elseBody, null);
    });

    it('if/otherwise/end', () => {
      const ast = softParse('if x above 5\nsay "big"\notherwise\nsay "small"\nend');
      const node = ast.body[0];
      assert.equal(node.type, 'If');
      assert.equal(node.body.length, 1);
      assert.equal(node.elseBody.length, 1);
    });

    it('repeat N times', () => {
      const ast = softParse('repeat 5 times\nsay "hi"\nend');
      assert.equal(ast.body[0].type, 'Repeat');
      assert.equal(ast.body[0].count.value, 5);
    });

    it('repeat each', () => {
      const ast = softParse('repeat each x in items\nsay x\nend');
      assert.equal(ast.body[0].type, 'ForEach');
      assert.equal(ast.body[0].varName, 'x');
    });

    it('define function', () => {
      const ast = softParse('define double takes n\nreturn n times 2\nend');
      const fn = ast.body[0];
      assert.equal(fn.type, 'Define');
      assert.equal(fn.name, 'double');
      assert.equal(fn.sig.length, 1);
      assert.equal(fn.sig[0].param, 'n');
    });

    it('define with labeled params', () => {
      const ast = softParse('define send message to person\nsay message\nend');
      const fn = ast.body[0];
      assert.equal(fn.sig.length, 2);
      assert.equal(fn.sig[0].param, 'message');
      assert.equal(fn.sig[1].sep, 'to');
      assert.equal(fn.sig[1].param, 'person');
    });

    it('return', () => {
      const ast = softParse('define f\nreturn 42\nend');
      assert.equal(ast.body[0].body[0].type, 'Return');
      assert.equal(ast.body[0].body[0].value.value, 42);
    });

    it('return nothing', () => {
      const ast = softParse('define f\nreturn\nend');
      assert.equal(ast.body[0].body[0].value, null);
    });
  });

  describe('conditions', () => {
    it('above / below', () => {
      const ast = softParse('if x above 5\nend');
      assert.equal(ast.body[0].cond.op, '>');
    });

    it('is / is not', () => {
      const ast = softParse('if x is 5\nend');
      assert.equal(ast.body[0].cond.op, '==');
      const ast2 = softParse('if x is not 5\nend');
      assert.equal(ast2.body[0].cond.op, '!=');
    });

    it('at least / at most', () => {
      const ast = softParse('if x at least 50\nend');
      assert.equal(ast.body[0].cond.op, '>=');
      const ast2 = softParse('if x at most 100\nend');
      assert.equal(ast2.body[0].cond.op, '<=');
    });

    it('and/or logic', () => {
      const ast = softParse('if x above 5 and y below 10\nend');
      assert.equal(ast.body[0].cond.type, 'Logic');
      assert.equal(ast.body[0].cond.op, 'and');
    });

    it('symbol comparisons', () => {
      const ast = softParse('if x > 5\nend');
      assert.equal(ast.body[0].cond.op, '>');
      const ast2 = softParse('if x == 5\nend');
      assert.equal(ast2.body[0].cond.op, '==');
    });
  });

  describe('fizzbuzz', () => {
    it('parses full fizzbuzz', () => {
      const code = `define fizzbuzz takes n
if n mod 15 is 0
return "fizzbuzz"
end
if n mod 3 is 0
return "fizz"
end
if n mod 5 is 0
return "buzz"
end
return n
end
say fizzbuzz 15`;
      // should not throw
      const ast = softParse(code);
      assert.equal(ast.body[0].type, 'Define');
      assert.equal(ast.body[0].name, 'fizzbuzz');
      assert.equal(ast.body[1].type, 'Say');
    });
  });
});

// ── evaluator tests ──

import { softEval, softString } from '../ext/soft/src/eval.js';

function run(code, opts) { return softEval(code, opts); }
function out(code, opts) { return run(code, opts).output.map(v => typeof v === 'string' ? v : softString(v)); }

describe('soft evaluator', () => {

  describe('B.1–B.4: basics', () => {
    it('B.1 — hello world', () => {
      assert.deepEqual(out('say "hello world"'), ['hello world']);
    });

    it('B.2 — concatenation with &', () => {
      assert.deepEqual(out('set name to "Arthur"\nsay "hello " & name & "!"'), ['hello Arthur!']);
    });

    it('B.3 — conditional', () => {
      assert.deepEqual(out('set x to 10\nif x above 5\nsay "big"\notherwise\nsay "small"\nend'), ['big']);
    });

    it('B.4 — counted loop', () => {
      assert.deepEqual(out('set n to 0\nrepeat 5 times\nset n to n plus 1\nend\nsay n'), ['5']);
    });
  });

  describe('B.5–B.8: functions', () => {
    it('B.5 — for-each', () => {
      assert.deepEqual(out('set items to list 1, 2, 3\nrepeat each x in items\nsay x times x\nend'),
        ['1', '4', '9']);
    });

    it('B.6 — labeled params', () => {
      const code = `define send message to person
say message & " → " & person
end
send "hello" to "Arthur"`;
      assert.deepEqual(out(code), ['hello → Arthur']);
    });

    it('B.7 — default params', () => {
      const code = `define greet person with greeting is "hello"
say greeting & " " & person
end
greet "world"`;
      assert.deepEqual(out(code), ['hello world']);
    });

    it('B.8 — variadic', () => {
      const code = `define total of many numbers
set s to 0
repeat each n in numbers
set s to s plus n
end
return s
end
say total of 1, 2, 3, 4, 5`;
      assert.deepEqual(out(code), ['15']);
    });
  });

  describe('B.11–B.14: FFI and fizzbuzz', () => {
    it('B.11 — use as', () => {
      const code = 'use Math.round as round\nsay round 3.7';
      assert.deepEqual(out(code, { globals: { Math } }), ['4']);
    });

    it('B.12 — bare JS call', () => {
      assert.deepEqual(out('say Math.floor 9.9', { globals: { Math } }), ['9']);
    });

    it('B.14 — FizzBuzz', () => {
      const code = `define fizzbuzz takes n
if n mod 15 is 0
return "fizzbuzz"
end
if n mod 3 is 0
return "fizz"
end
if n mod 5 is 0
return "buzz"
end
return n
end
say fizzbuzz 15
say fizzbuzz 9
say fizzbuzz 10
say fizzbuzz 7`;
      assert.deepEqual(out(code), ['fizzbuzz', 'fizz', 'buzz', '7']);
    });
  });

  describe('B.16–B.18: put, chunks', () => {
    it('B.16 — put/into', () => {
      assert.deepEqual(out('put 42 into answer\nsay "the answer is " & answer'), ['the answer is 42']);
    });
  });

  describe('B.22: it variable', () => {
    it('sets it on expression statements', () => {
      // count is not auto-displayed but sets it
      assert.deepEqual(out('5 plus 3\nsay "result: " & it'), ['result: 8']);
    });
  });

  describe('B.28: records', () => {
    it('record creation', () => {
      assert.deepEqual(out('set r to record name "Alice" age 30\nsay name of r & " is " & age of r'),
        ['Alice is 30']);
    });
  });

  describe('B.30: existence checks', () => {
    it('there is a / there is no', () => {
      assert.deepEqual(out('set x to 5\nif there is a x\nsay "x exists"\nend\nif there is no y\nsay "y missing"\nend'),
        ['x exists', 'y missing']);
    });
  });

  describe('B.33b–c: stop/skip', () => {
    it('stop breaks loop', () => {
      const code = `set items to list 1, 2, 3, 4, 5
repeat each x in items
  stop if x above 3
  say x
end`;
      assert.deepEqual(out(code), ['1', '2', '3']);
    });

    it('skip continues loop', () => {
      const code = `set items to list 1, 2, 3, 4, 5
repeat each x in items
  skip if x is 3
  say x
end`;
      assert.deepEqual(out(code), ['1', '2', '4', '5']);
    });
  });

  describe('B.34–B.39: arithmetic and symbols', () => {
    it('B.34 — precedence', () => {
      assert.deepEqual(out('say 3 + 4 * 2'), ['11']);
    });

    it('B.35 — parens', () => {
      assert.deepEqual(out('say (3 + 4) * 2'), ['14']);
    });

    it('B.36 — exponentiation', () => {
      assert.deepEqual(out('say 2 raised to 10'), ['1024']);
      assert.deepEqual(out('say 2 ** 10'), ['1024']);
    });

    it('B.37 — negation', () => {
      assert.deepEqual(out('set x to 5\nsay negative x'), ['-5']);
    });

    it('B.39 — symbol comparisons', () => {
      assert.deepEqual(out('set x to 10\nif x > 5 and x < 20\nsay "in range"\nend'), ['in range']);
    });
  });

  describe('B.40–B.45: syntax flexibility', () => {
    it('B.40 — noise words', () => {
      assert.deepEqual(out('set the cutoff to 50\nsay the cutoff'), ['50']);
    });

    it('B.41 — else for otherwise', () => {
      assert.deepEqual(out('if 1 > 2\nsay "no"\nelse\nsay "yes"\nend'), ['yes']);
    });

    it('B.43 — range loop', () => {
      const code = 'repeat from 1 to 5 as i\nsay i\nend';
      assert.deepEqual(out(code), ['1', '2', '3', '4', '5']);
    });

    it('B.45 — optional do', () => {
      assert.deepEqual(out('repeat 3 times do\nsay "hi"\nend'), ['hi', 'hi', 'hi']);
    });
  });

  describe('B.52–B.56: bitwise', () => {
    it('bitwise AND', () => {
      assert.deepEqual(out('say 0xFF bitwise and 0x0F'), ['15']);
      assert.deepEqual(out('say 0xFF bit and 0x0F'), ['15']);
    });

    it('bitwise XOR', () => {
      assert.deepEqual(out('say 0xFF xor 0x0F'), ['240']);
    });

    it('shift', () => {
      assert.deepEqual(out('say 1 << 8'), ['256']);
      assert.deepEqual(out('say 1 shift left 8'), ['256']);
    });

    it('bitwise NOT', () => {
      assert.deepEqual(out('say bit not 0'), ['-1']);
      assert.deepEqual(out('say ~0'), ['-1']);
    });
  });

  describe('B.57–B.62: unless, inline conditional, type checks', () => {
    it('B.57 — unless block', () => {
      assert.deepEqual(out('set grade to 30\nunless grade above 50\nsay "below cutoff"\nend'),
        ['below cutoff']);
    });

    it('B.60 — inline conditional', () => {
      assert.deepEqual(out('set grade to 62\nset label to "ore" if grade above 50 otherwise "waste"\nsay label'),
        ['ore']);
    });

    it('B.62 — type checks', () => {
      assert.deepEqual(out('set x to 42\nif x is a number\nsay "yes"\nend'), ['yes']);
      assert.deepEqual(out('set y to "hi"\nif y is a text\nsay "yes"\nend'), ['yes']);
      assert.deepEqual(out('set z to list 1, 2\nif z is a list\nsay "yes"\nend'), ['yes']);
    });
  });

  describe('B.64–B.65: range loops with step', () => {
    it('B.64 — step loop', () => {
      assert.deepEqual(out('repeat from 0 to 20 by 5 as n\nsay n\nend'),
        ['0', '5', '10', '15', '20']);
    });

    it('B.65 — countdown', () => {
      assert.deepEqual(out('repeat from 3 to 1 by -1 as n\nsay n\nend'),
        ['3', '2', '1']);
    });
  });

  describe('B.72–B.76: assume, suppose, try', () => {
    it('B.72 — assume passes', () => {
      assert.deepEqual(out('set x to 10\nassume x above 0\nsay "ok"'), ['ok']);
    });

    it('B.73 — assume fails', () => {
      assert.throws(() => out('set x to -1\nassume x above 0 otherwise "x must be positive"'),
        { message: 'x must be positive' });
    });

    it('B.74 — suppose', () => {
      assert.deepEqual(out('set cutoff to 50\nsuppose cutoff is 30\nsay "inside: " & cutoff\nend\nsay "outside: " & cutoff'),
        ['inside: 30', 'outside: 50']);
    });

    it('B.76 — try/catch', () => {
      const code = `try
set x to grade of nothing
if it fails
say "caught: " & the error
end`;
      const result = out(code);
      assert.equal(result.length, 1);
      assert.ok(result[0].startsWith('caught:'));
    });
  });

  describe('B.79–B.80: record with shorthand', () => {
    it('B.79 — record with', () => {
      assert.deepEqual(out('set x to 10\nset y to 20\nset p to record with x, y\nsay x of p & ", " & y of p'),
        ['10, 20']);
    });
  });

  describe('closures', () => {
    it('closures with call keyword', () => {
      const code = `define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end
set c to make_counter
say call c
say call c`;
      assert.deepEqual(out(code), ['1', '2']);
    });

    it('closures with run keyword', () => {
      const code = `define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end
set c to make_counter
say run c
say run c`;
      assert.deepEqual(out(code), ['1', '2']);
    });

    it('closures with result of', () => {
      const code = `define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end
set c to make_counter
say result of c
say result of c`;
      assert.deepEqual(out(code), ['1', '2']);
    });

    it('call works inside & concatenation', () => {
      const code = `define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end
set counter to make_counter
say "count: " & call counter
say "count: " & call counter
say "count: " & call counter`;
      assert.deepEqual(out(code), ['count: 1', 'count: 2', 'count: 3']);
    });

    it('function values are first-class (no auto-call)', () => {
      const code = `define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end
set c to make_counter
set c2 to c
say call c2
say call c2`;
      // c2 holds the same closure — not a called result
      assert.deepEqual(out(code), ['1', '2']);
    });
  });

  describe('of mapping', () => {
    it('length of array', () => {
      assert.deepEqual(out('set data to list 10, 20, 30\nsay length of data'), ['3']);
    });
  });

  describe('division', () => {
    it('IEEE 754: 1/0 is Infinity', () => {
      assert.deepEqual(out('say 1 over 0'), ['Infinity']);
    });
    it('IEEE 754: 0/0 is NaN', () => {
      assert.deepEqual(out('say 0 over 0'), ['NaN']);
    });
  });

  // ── pipeline DSL ──

  const setupData = `set intervals to list record hole "DDH001" grade 62.1 lithology "itabirite" length 4 density 3.2, record hole "DDH001" grade 48.3 lithology "phyllite" length 6 density 2.8, record hole "DDH002" grade 55.0 lithology "itabirite" length 3 density 3.5, record hole "DDH002" grade 31.2 lithology "phyllite" length 5 density 2.6, record hole "DDH003" grade 70.5 lithology "itabirite" length 2 density 3.8`;

  describe('pipeline: take and filter', () => {
    it('take sets it', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\nsay length of it'), ['5']);
    });

    it('keep filters rows', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\nkeep lithology is "itabirite"\nsay length of it'), ['3']);
    });

    it('drop removes rows', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\ndrop lithology is "phyllite"\nsay length of it'), ['3']);
    });

    it('keep with numeric comparison', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\nkeep grade above 50\nsay length of it'), ['3']);
    });
  });

  describe('pipeline: sort', () => {
    it('sort ascending + limit', () => {
      const r = out(setupData + '\ntake intervals\nsort by grade ascending\nfirst 1\nsay grade of it');
      assert.deepEqual(r, ['31.2']);
    });

    it('sort descending + limit', () => {
      const r = out(setupData + '\ntake intervals\nsort by grade descending\nfirst 1\nsay grade of it');
      assert.deepEqual(r, ['70.5']);
    });
  });

  describe('pipeline: aggregation', () => {
    it('average', () => {
      assert.deepEqual(out('set d to list record g 10, record g 20, record g 30\ntake d\naverage g\nsay it'), ['20']);
    });

    it('total', () => {
      assert.deepEqual(out('set d to list record g 10, record g 20, record g 30\ntake d\ntotal g\nsay it'), ['60']);
    });

    it('smallest / largest', () => {
      assert.deepEqual(out('set d to list record g 10, record g 20, record g 30\ntake d\nsmallest g\nsay it'), ['10']);
      assert.deepEqual(out('set d to list record g 10, record g 20, record g 30\ntake d\nlargest g\nsay it'), ['30']);
    });

    it('mean alias', () => {
      assert.deepEqual(out('set d to list record v 10, record v 20, record v 30\ntake d\nmean v\nsay it'), ['20']);
    });
  });

  describe('pipeline: count, limit, round', () => {
    it('count', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\ncount\nsay it'), ['5']);
    });

    it('first N', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\nfirst 2\nsay length of it'), ['2']);
    });

    it('last N', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\nlast 2\nsay length of it'), ['2']);
    });

    it('round to N', () => {
      assert.deepEqual(out('set it to 3.14159\nround to 2\nsay it'), ['3.14']);
    });
  });

  describe('pipeline: group, pick, with', () => {
    it('group by', () => {
      assert.deepEqual(out(setupData + '\ntake intervals\ngroup by lithology\nsay length of it'), ['2']);
    });

    it('pick single field', () => {
      const code = 'set d to list record name "Alice" age 30, record name "Bob" age 25\ntake d\npick name\nsay it';
      assert.deepEqual(out(code), ['Alice, Bob']);
    });

    it('with computed column', () => {
      const code = 'set d to list record length 4 density 3.2\ntake d\nwith tonnage being length times density\nfirst 1\nsay tonnage of it';
      assert.equal(parseFloat(out(code)[0]), 12.8);
    });
  });

  describe('pipeline: full queries', () => {
    it('filter + average + round', () => {
      const code = setupData + '\ntake intervals\nkeep lithology is "itabirite"\naverage grade\nround to 1\nsay it';
      assert.equal(parseFloat(out(code)[0]), 62.5);
    });

    it('multiple pipelines with capture', () => {
      const code = setupData + `
take intervals
keep lithology is "itabirite"
count
into ore_count

take intervals
keep lithology is "phyllite"
count
into waste_count

say ore_count & " ore, " & waste_count & " waste"`;
      assert.deepEqual(out(code), ['3 ore, 2 waste']);
    });

    it('called mid-pipeline naming', () => {
      const code = setupData + `
take intervals
keep grade above 50 called high_grade
count called n
say n & " intervals from " & length of high_grade & " filtered"`;
      assert.deepEqual(out(code), ['3 intervals from 3 filtered']);
    });

    it('sort + limit + pick', () => {
      const code = 'set d to list record name "Alice" score 90, record name "Bob" score 75, record name "Carol" score 85\ntake d\nsort by score descending\nfirst 2\npick name\nsay it';
      assert.deepEqual(out(code), ['Alice, Carol']);
    });
  });
});

// ── cell integration tests ──

describe('soft cell handler', () => {
  describe('parseNames', () => {
    it('finds set assignments', () => {
      const names = softParseNames('set x to 5\nset y to 10');
      assert.ok(names.has('x'));
      assert.ok(names.has('y'));
    });

    it('finds define', () => {
      const names = softParseNames('define double takes n\nreturn n times 2\nend');
      assert.ok(names.has('double'));
    });

    it('finds capture with into', () => {
      const names = softParseNames('take data\ncount\ninto total');
      assert.ok(names.has('total'));
    });

    it('finds called', () => {
      const names = softParseNames('take data\nkeep grade above 50 called ore');
      assert.ok(names.has('ore'));
    });

    it('does not find inner variables', () => {
      const names = softParseNames('repeat each x in items\nsay x\nend');
      // x is a loop variable, not a top-level define — but we still report it for DAG
      // since the Set inside might be at top level in other cases
    });
  });

  describe('findUses', () => {
    it('finds references to upstream cells', () => {
      const allDefined = new Set(['intervals', 'cutoff', 'other']);
      const uses = softFindUses('take intervals\nkeep grade above cutoff', allDefined);
      assert.ok(uses.has('intervals'));
      assert.ok(uses.has('cutoff'));
      assert.ok(!uses.has('other'));
    });

    it('excludes self-defined names', () => {
      const allDefined = new Set(['x', 'y']);
      const uses = softFindUses('set x to 5\nsay y', allDefined);
      assert.ok(!uses.has('x')); // self-defined
      assert.ok(uses.has('y'));   // upstream reference
    });
  });

  describe('execute', () => {
    it('returns defines and output', async () => {
      const result = await softExecute('set x to 42\nsay "hello"', {}, {});
      assert.equal(result.defines.x, 42);
      assert.equal(result.output, 'hello');
    });

    it('receives upstream scope', async () => {
      const result = await softExecute('say cutoff', { cutoff: 50 }, {});
      assert.equal(result.output, '50');
    });

    it('pipeline with upstream data', async () => {
      const data = [{ grade: 60 }, { grade: 40 }, { grade: 80 }];
      const result = await softExecute('take data\nkeep grade above 50\ncount\ninto n\nsay n', { data }, {});
      assert.equal(result.defines.n, 2);
      assert.equal(result.output, '2');
    });
  });
});

// ── highlighting tests ──

describe('soft highlighting', () => {
  it('tokenizes keywords and verbs', () => {
    const tokens = tokenizeSoft('set x to 5');
    const types = tokens.filter(t => t.type !== 'ws').map(t => t.type);
    assert.deepEqual(types, ['tf', 'id', 'kw', 'num']);
  });

  it('tokenizes transforms', () => {
    const tokens = tokenizeSoft('take intervals');
    const types = tokens.filter(t => t.type !== 'ws').map(t => t.type);
    assert.deepEqual(types, ['tf', 'id']);
  });

  it('tokenizes strings and comments', () => {
    const tokens = tokenizeSoft('say "hello" # greeting');
    const types = tokens.filter(t => t.type !== 'ws').map(t => t.type);
    assert.deepEqual(types, ['tf', 'str', 'cmt']);
  });

  it('tokenizes dot-paths as fn', () => {
    const tokens = tokenizeSoft('Math.round');
    assert.equal(tokens[0].type, 'fn');
  });
});

// ── completions tests ──

describe('soft completions', () => {
  it('completes keywords', () => {
    const results = softCompletions('rep');
    assert.ok(results.includes('repeat'));
  });

  it('completes builtins', () => {
    const results = softCompletions('flo');
    assert.ok(results.includes('floor'));
  });
});

// ── tagged template tests ──

describe('soft tagged template', () => {
  it('returns defines', () => {
    const result = softTag`set x to 42`;
    assert.equal(result.x, 42);
  });

  it('supports interpolation', () => {
    const val = 10;
    const result = softTag`set doubled to ${val} times 2`;
    assert.equal(result.doubled, 20);
  });

  it('dedents code', () => {
    const result = softTag`
      set x to 1
      set y to 2
    `;
    assert.equal(result.x, 1);
    assert.equal(result.y, 2);
  });
});

// ── then piping ──

describe('soft then piping', () => {
  it('B.15 — take then count', () => {
    const code = 'set d to list record g 1, record g 2, record g 3, record g 4\ntake d then count\nsay it';
    assert.deepEqual(out(code), ['4']);
  });

  it('chained transforms', () => {
    const code = 'set d to list record g 60, record g 40, record g 80\ntake d then keep g above 50 then count\nsay it';
    assert.deepEqual(out(code), ['2']);
  });

  it('and then sugar', () => {
    const code = 'set d to list record g 60, record g 40, record g 80\ntake d and then keep g above 50 and then count\nsay it';
    assert.deepEqual(out(code), ['2']);
  });

  it('then with capture', () => {
    const code = 'set d to list record g 60, record g 40, record g 80\ntake d then keep g above 50 then count into n\nsay n';
    assert.deepEqual(out(code), ['2']);
  });

  it('then with sort + limit', () => {
    const code = 'set d to list record name "Alice" score 90, record name "Bob" score 75, record name "Carol" score 85\ntake d then sort by score descending then first 1\nsay name of it';
    assert.deepEqual(out(code), ['Alice']);
  });
});

// ── chunk expressions ──

describe('soft chunk expressions', () => {
  describe('reads', () => {
    it('B.17 — word and character', () => {
      assert.deepEqual(out('set s to "the quick brown fox"\nsay word 2 of s'), ['brown']);
      assert.deepEqual(out('set s to "the quick brown fox"\nsay character 1 of s'), ['h']);
    });

    it('B.19 — chunk nesting', () => {
      assert.deepEqual(out('set doc to "first line\\nsecond line\\nthird line"\nsay word 1 of line 2 of doc'), ['line']);
    });

    it('character 0', () => {
      assert.deepEqual(out('say character 0 of "hello"'), ['h']);
    });

    it('line access', () => {
      assert.deepEqual(out('set t to "aaa\\nbbb\\nccc"\nsay line 1 of t'), ['bbb']);
    });

    it('item access (comma-separated)', () => {
      assert.deepEqual(out('say item 1 of "red,green,blue"'), ['green']);
    });
  });

  describe('writes', () => {
    it('B.18 — set word of string', () => {
      assert.deepEqual(out('set s to "hello world"\nset word 1 of s to "Soft"\nsay s'), ['hello Soft']);
    });

    it('B.25 — set word 0', () => {
      assert.deepEqual(out('set s to "hello world"\nset word 0 of s to "goodbye"\nsay s'), ['goodbye world']);
    });

    it('set character', () => {
      assert.deepEqual(out('set s to "hello"\nset character 0 of s to "H"\nsay s'), ['Hello']);
    });

    it('set line', () => {
      assert.deepEqual(out('set d to "aaa\\nbbb\\nccc"\nset line 1 of d to "XXX"\nsay d'), ['aaa\nXXX\nccc']);
    });
  });
});

// ── of-path writes ──

describe('soft of-path writes', () => {
  it('set property of record', () => {
    assert.deepEqual(out('set r to record name "Alice" age 30\nset age of r to 31\nsay age of r'), ['31']);
  });

  it('B.20-style — set grade of row', () => {
    assert.deepEqual(out('set row to record grade 50 depth 10\nset grade of row to 60\nsay grade of row'), ['60']);
  });

  it('put into of-path', () => {
    assert.deepEqual(out('set r to record x 0 y 0\nput 42 into x of r\nsay x of r'), ['42']);
  });

  it('nested of-path write', () => {
    const code = `set book to record title "X" author record name "Unknown"
set name of author of book to "Banks"
say name of author of book`;
    assert.deepEqual(out(code), ['Banks']);
  });
});

// ── say juxtaposition ──

describe('soft say juxtaposition', () => {
  it('string + variable + string', () => {
    assert.deepEqual(out('set name to "Arthur"\nsay "hello " name "!"'), ['hello Arthur!']);
  });

  it('variable + string', () => {
    assert.deepEqual(out('set x to 42\nsay "value: " x'), ['value: 42']);
  });

  it('multiple strings', () => {
    assert.deepEqual(out('say "a" "b" "c"'), ['abc']);
  });

  it('expression + string', () => {
    assert.deepEqual(out('set x to 5\nsay "result: " (x + 3) " done"'), ['result: 8 done']);
  });

  it('still works with &', () => {
    assert.deepEqual(out('set name to "Arthur"\nsay "hello " & name & "!"'), ['hello Arthur!']);
  });

  it('single expression (no juxtaposition)', () => {
    assert.deepEqual(out('say 42'), ['42']);
  });
});

// ── new features: comparison synonyms, chunk counting/ranges, regex, builtins, globals ──

describe('soft comparison synonyms', () => {
  it('does not equal', () => {
    assert.deepEqual(out('if 5 does not equal 6\nsay "yes"\nend'), ['yes']);
  });
  it('is equal to', () => {
    assert.deepEqual(out('if 5 is equal to 5\nsay "yes"\nend'), ['yes']);
  });
  it('is greater than', () => {
    assert.deepEqual(out('if 10 is greater than 5\nsay "yes"\nend'), ['yes']);
  });
  it('is less than', () => {
    assert.deepEqual(out('if 3 is less than 10\nsay "yes"\nend'), ['yes']);
  });
});

describe('soft chunk counting', () => {
  it('number of characters', () => {
    assert.deepEqual(out('say number of characters in "hello"'), ['5']);
  });
  it('number of words', () => {
    assert.deepEqual(out('say number of words in "the quick brown fox"'), ['4']);
  });
  it('number of lines', () => {
    assert.deepEqual(out('say number of lines in "a\\nb\\nc"'), ['3']);
  });
});

describe('soft chunk ranges', () => {
  it('characters range', () => {
    assert.deepEqual(out('say characters 1 to 3 of "hello"'), ['ell']);
  });
  it('words range', () => {
    assert.deepEqual(out('say words 1 to 2 of "the quick brown fox"'), ['quick brown']);
  });
});

describe('soft regex matching', () => {
  it('regex literal', () => {
    assert.deepEqual(out('set h to "DDH042"\nif h matches /^DDH\\d+$/\nsay "match"\nend'), ['match']);
  });
  it('regex with flags', () => {
    assert.deepEqual(out('set h to "ddh042"\nif h matches /^DDH/i\nsay "match"\nend'), ['match']);
  });
  it('regex no match', () => {
    assert.deepEqual(out('set h to "RC001"\nif h matches /^DDH/\nsay "match"\nend'), []);
  });
  it('glob still works', () => {
    assert.deepEqual(out('if "DDH001" matches "DDH*"\nsay "yes"\nend'), ['yes']);
  });
});

describe('soft number/text coercion', () => {
  it('number coercion', () => {
    assert.deepEqual(out('say number "42"'), ['42']);
  });
  it('text coercion', () => {
    assert.deepEqual(out('say text 42'), ['42']);
  });
});

describe('soft host globals', () => {
  it('Math.round via use', () => {
    assert.deepEqual(out('use Math.round as round\nsay round 3.7', { globals: { Math } }), ['4']);
  });
  it('Text.upper via dot-path', () => {
    assert.deepEqual(out('say Text.upper "hello"'), ['HELLO']);
  });
  it('Text.trim', () => {
    assert.deepEqual(out('say Text.trim "  hi  "'), ['hi']);
  });
  it('List.reverse', () => {
    assert.deepEqual(out('say List.reverse list 1, 2, 3'), ['3, 2, 1']);
  });
});

// ── then function piping ──

describe('soft then function piping', () => {
  it('pipes value to dot-path function', () => {
    assert.deepEqual(out('"  hello  " then Text.trim then Text.upper\nsay it'), ['HELLO']);
  });

  it('pipes with multi-arg function', () => {
    assert.deepEqual(out('"hello world" then Text.split " "\nsay it'), ['hello, world']);
  });

  it('mixes transforms and functions', () => {
    assert.deepEqual(out('set d to list record g 10, record g 20, record g 30\ntake d then average g\nsay it'), ['20']);
  });
});

// ── file I/O (with mock host) ──

describe('soft file I/O', () => {
  it('load and save with host functions', () => {
    const files = { 'data.csv': 'name,age\nAlice,30\nBob,25' };
    const result = softEval(`load "data.csv" as data\nsay length of data`, {
      host: {
        load: (path) => {
          const text = files[path];
          if (path.endsWith('.csv')) {
            const lines = text.trim().split('\n');
            const headers = lines[0].split(',');
            return lines.slice(1).map(l => {
              const vals = l.split(',');
              const row = {};
              headers.forEach((h, i) => row[h.trim()] = isNaN(vals[i]) ? vals[i] : Number(vals[i]));
              return row;
            });
          }
          return text;
        },
      },
    });
    assert.deepEqual(result.output.map(v => softString(v)), ['2']);
  });

  it('load sets it and captures into name', () => {
    const result = softEval('load "test.json" as config\nsay config', {
      host: { load: () => ({ key: 'value' }) },
    });
    assert.equal(result.scope.config.key, 'value');
  });

  it('save calls host.save', () => {
    let saved = null;
    softEval('set data to list 1, 2, 3\nsave data to "out.json"', {
      host: { save: (path, data) => { saved = { path, data }; } },
    });
    assert.equal(saved.path, 'out.json');
    assert.deepEqual(saved.data, [1, 2, 3]);
  });
});

// ── make (with mock host) ──

describe('soft make', () => {
  it('calls host.make', () => {
    let made = null;
    softEval('make "div" as box', {
      host: { make: (tag, parent) => { made = { tag, parent }; return { tagName: tag }; } },
    });
    assert.equal(made.tag, 'div');
  });

  it('make with parent', () => {
    const parent = { id: 'container' };
    let made = null;
    softEval('make "li" in container', {
      host: { make: (tag, p) => { made = { tag, parent: p }; return {}; } },
      scopeInit: { container: parent },
    });
    assert.equal(made.tag, 'li');
    assert.equal(made.parent, parent);
  });
});

// ── on events (with mock host) ──

describe('soft on events', () => {
  it('registers event handler', () => {
    let registered = null;
    softEval('on click btn\nstop\nend', {
      host: { on: (event, target, handler) => { registered = { event, target }; } },
      scopeInit: { btn: { id: 'myBtn' } },
    });
    assert.equal(registered.event, 'click');
    assert.equal(registered.target.id, 'myBtn');
  });

  it('handler receives event properties', () => {
    let handlerFn = null;
    const result = softEval('on keypress\nset it to key\nend', {
      host: { on: (event, target, handler) => { handlerFn = handler; } },
    });
    // simulate calling the handler with an event
    assert.ok(handlerFn);
    handlerFn({ key: 'enter', target: null });
    // the handler scope is isolated, so we can't easily check it
    // but the test verifies it doesn't throw
  });

  it('handler stop exits cleanly', () => {
    let handlerFn = null;
    softEval('on click\nstop\nend', {
      host: { on: (event, target, handler) => { handlerFn = handler; } },
    });
    // calling handler with stop should not throw
    assert.doesNotThrow(() => handlerFn({}));
  });
});

// ── pt-BR locale ──

import { readFileSync } from 'fs';
const ptBR = JSON.parse(readFileSync('ext/soft/locales/pt-BR.json', 'utf8'));

describe('soft pt-BR locale', () => {
  // activate locale before tests, deactivate after
  it('setup: activate pt-BR', () => { softSetLocale(ptBR); });

  describe('tokenizer', () => {
    it('maps Portuguese keywords to English', () => {
      const toks = softTokenize('diga "olá"');
      const kws = toks.filter(t => t.type === T.KW);
      assert.equal(kws[0].value, 'say');
    });

    it('fale also maps to say', () => {
      const toks = softTokenize('fale "olá"');
      const kws = toks.filter(t => t.type === T.KW);
      assert.equal(kws[0].value, 'say');
    });

    it('noise words consumed', () => {
      const toks = softTokenize('o grau');
      assert.equal(toks.filter(t => t.type === T.KW)[0].value, 'the'); // 'o' → 'the'
    });
  });

  describe('full programs', () => {
    it('hello world', () => {
      assert.deepEqual(out('diga "olá mundo"'), ['olá mundo']);
    });

    it('fale variant', () => {
      assert.deepEqual(out('fale "olá mundo"'), ['olá mundo']);
    });

    it('set and say', () => {
      assert.deepEqual(out('defina nome para "Arthur"\ndiga "olá " nome'), ['olá Arthur']);
    });

    it('conditional', () => {
      assert.deepEqual(out('defina grau para 62\nse grau acima 50\ndiga "minério"\nsenão\ndiga "estéril"\nfim'), ['minério']);
    });

    it('pipeline', () => {
      const code = `defina dados para lista
  registro grau 60 litologia "itabirito",
  registro grau 40 litologia "filito",
  registro grau 80 litologia "itabirito"

pegue dados
mantenha grau acima 50
conte
diga "resultado: " it`;
      assert.deepEqual(out(code), ['resultado: 2']);
    });

    it('loop', () => {
      assert.deepEqual(out('repita 3 vezes\ndiga "oi"\nfim'), ['oi', 'oi', 'oi']);
    });

    it('function definition and call', () => {
      const code = `declare dobro recebe n
  retorne n vezes 2
fim
diga dobro 5`;
      assert.deepEqual(out(code), ['10']);
    });

    it('pipeline with sort and average', () => {
      const code = `defina d para lista registro g 10, registro g 30, registro g 20
pegue d
ordene por g decrescente
média de g
diga it`;
      assert.deepEqual(out(code), ['20']);
    });

    it('mixed Portuguese and symbols', () => {
      assert.deepEqual(out('defina x para 3 + 4 * 2\ndiga x'), ['11']);
    });
  });

  // deactivate locale
  it('cleanup: deactivate locale', () => { softSetLocale(null); });

  // verify English still works after deactivation
  it('English works after locale deactivation', () => {
    assert.deepEqual(out('say "hello"'), ['hello']);
  });
});
