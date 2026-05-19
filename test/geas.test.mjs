// Tests for @gcu/geas v0.0.1 — lexer + parser.
//
// No DOM shim needed; the lexer + parser are pure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../ext/geas/src/lexer.js';
import { parse } from '../ext/geas/src/parser.js';
import { NODE } from '../ext/geas/src/ast-nodes.js';

// ── token helpers (test-side) ──

function typesOf(tokens) {
  return tokens.map(t => t.type);
}
function valuesOf(tokens) {
  return tokens.map(t => t.value);
}
function nonEOF(tokens) {
  return tokens.filter(t => t.type !== 'EOF');
}

// ══════════════════════════════════════════════════════════
// LEXER
// ══════════════════════════════════════════════════════════

describe('lexer — basics', () => {
  it('empty input → just EOF', () => {
    const ts = tokenize('');
    assert.deepEqual(typesOf(ts), ['EOF']);
  });

  it('single word', () => {
    const ts = nonEOF(tokenize('ls'));
    assert.equal(ts.length, 1);
    assert.equal(ts[0].type, 'WORD');
    assert.equal(ts[0].value, 'ls');
  });

  it('words separated by whitespace', () => {
    const ts = nonEOF(tokenize('ls -l /home'));
    assert.deepEqual(typesOf(ts), ['WORD', 'WORD', 'WORD']);
    assert.deepEqual(valuesOf(ts), ['ls', '-l', '/home']);
  });

  it('tabs are whitespace too', () => {
    const ts = nonEOF(tokenize('a\tb\tc'));
    assert.deepEqual(valuesOf(ts), ['a', 'b', 'c']);
  });

  it('position info is contiguous and non-overlapping', () => {
    const ts = nonEOF(tokenize('foo bar baz'));
    assert.equal(ts[0].pos.start, 0);
    assert.equal(ts[0].pos.end, 3);
    assert.equal(ts[1].pos.start, 4);
    assert.equal(ts[1].pos.end, 7);
    assert.equal(ts[2].pos.start, 8);
    assert.equal(ts[2].pos.end, 11);
  });
});

describe('lexer — operators', () => {
  it('pipe', () => {
    const ts = nonEOF(tokenize('a | b'));
    assert.deepEqual(valuesOf(ts), ['a', '|', 'b']);
    assert.equal(ts[1].type, 'OPERATOR');
  });

  it('and-or', () => {
    const ts = nonEOF(tokenize('a && b || c'));
    assert.deepEqual(typesOf(ts), ['WORD', 'OPERATOR', 'WORD', 'OPERATOR', 'WORD']);
    assert.deepEqual(valuesOf(ts), ['a', '&&', 'b', '||', 'c']);
  });

  it('multi-char ops are longest-match', () => {
    // `<<-` beats `<<` beats `<`
    const ts = nonEOF(tokenize('cat <<- EOF'));
    assert.deepEqual(valuesOf(ts), ['cat', '<<-', 'EOF']);
  });

  it('redirect operators', () => {
    const ts = nonEOF(tokenize('a > b < c >> d'));
    assert.deepEqual(valuesOf(ts), ['a', '>', 'b', '<', 'c', '>>', 'd']);
  });

  it('parens and braces (as operator chars)', () => {
    const ts = nonEOF(tokenize('( cmd ) ; more'));
    assert.deepEqual(valuesOf(ts), ['(', 'cmd', ')', ';', 'more']);
    assert.equal(ts[0].type, 'OPERATOR');
    assert.equal(ts[2].type, 'OPERATOR');
  });

  it('semicolon and ampersand', () => {
    const ts = nonEOF(tokenize('a ; b & c'));
    assert.deepEqual(valuesOf(ts), ['a', ';', 'b', '&', 'c']);
  });
});

describe('lexer — IO_NUMBER', () => {
  it('digit immediately before > is IO_NUMBER', () => {
    const ts = nonEOF(tokenize('2>foo'));
    assert.equal(ts[0].type, 'IO_NUMBER');
    assert.equal(ts[0].value, '2');
    assert.equal(ts[1].value, '>');
    assert.equal(ts[2].value, 'foo');
  });

  it('digit followed by something else is just a word', () => {
    const ts = nonEOF(tokenize('echo 42'));
    assert.deepEqual(typesOf(ts), ['WORD', 'WORD']);
    assert.equal(ts[1].value, '42');
  });

  it('digit with whitespace before redirect is NOT IO_NUMBER', () => {
    const ts = nonEOF(tokenize('echo 2 > foo'));
    assert.equal(ts[1].type, 'WORD');
    assert.equal(ts[1].value, '2');
  });
});

describe('lexer — quoting and expansions', () => {
  it('single quotes are literal (preserved verbatim in WORD value)', () => {
    const ts = nonEOF(tokenize("echo 'a b c'"));
    assert.equal(ts.length, 2);
    assert.equal(ts[1].value, "'a b c'");
  });

  it('double quotes preserve spaces inside as one word', () => {
    const ts = nonEOF(tokenize('echo "a b c"'));
    assert.equal(ts.length, 2);
    assert.equal(ts[1].value, '"a b c"');
  });

  it('mixed quoted and unquoted within one word', () => {
    const ts = nonEOF(tokenize('echo foo"bar baz"qux'));
    assert.equal(ts.length, 2);
    assert.equal(ts[1].value, 'foo"bar baz"qux');
  });

  it('backslash escape preserves the next char as part of the word', () => {
    const ts = nonEOF(tokenize('echo a\\ b'));
    assert.equal(ts.length, 2);
    assert.equal(ts[1].value, 'a\\ b');
  });

  it('$name parameter expansion', () => {
    const ts = nonEOF(tokenize('echo $HOME'));
    assert.equal(ts[1].value, '$HOME');
  });

  it('${var} parameter expansion preserves braces', () => {
    const ts = nonEOF(tokenize('echo ${HOME}'));
    assert.equal(ts[1].value, '${HOME}');
  });

  it('${var:-default} balanced braces', () => {
    const ts = nonEOF(tokenize('echo ${name:-arthur}'));
    assert.equal(ts[1].value, '${name:-arthur}');
  });

  it('$(cmd) command substitution', () => {
    const ts = nonEOF(tokenize('echo $(date)'));
    assert.equal(ts[1].value, '$(date)');
  });

  it('nested $(...) keeps balance', () => {
    const ts = nonEOF(tokenize('echo $(echo $(date))'));
    assert.equal(ts[1].value, '$(echo $(date))');
  });

  it('$(...) containing a close-paren in a string', () => {
    const ts = nonEOF(tokenize('echo $(echo ")")'));
    assert.equal(ts[1].value, '$(echo ")")');
  });

  it('backtick substitution', () => {
    const ts = nonEOF(tokenize('echo `date`'));
    assert.equal(ts[1].value, '`date`');
  });

  it('special parameters: $?, $#, $@, $$', () => {
    const ts = nonEOF(tokenize('echo $? $# $@ $$'));
    assert.deepEqual(valuesOf(ts.slice(1)), ['$?', '$#', '$@', '$$']);
  });
});

describe('lexer — comments and line continuation', () => {
  it('# starts a comment to end of line', () => {
    const ts = nonEOF(tokenize('echo hi # this is a comment\necho bye'));
    // The newline survives as a token separator
    assert.deepEqual(valuesOf(ts), ['echo', 'hi', '\n', 'echo', 'bye']);
  });

  it('# inside a word is NOT a comment', () => {
    const ts = nonEOF(tokenize('echo foo#bar'));
    assert.equal(ts[1].value, 'foo#bar');
  });

  it('line continuation between tokens disappears', () => {
    const ts = nonEOF(tokenize('a \\\nb'));
    // backslash + newline silently consumed
    assert.deepEqual(valuesOf(ts), ['a', 'b']);
  });
});

describe('lexer — newlines as tokens', () => {
  it('blank lines produce NEWLINE tokens', () => {
    const ts = nonEOF(tokenize('a\nb\n'));
    assert.deepEqual(typesOf(ts), ['WORD', 'NEWLINE', 'WORD', 'NEWLINE']);
  });
});

// ══════════════════════════════════════════════════════════
// PARSER
// ══════════════════════════════════════════════════════════

describe('parser — simple commands', () => {
  it('single command, no args', () => {
    const ast = parse('ls');
    assert.equal(ast.type, NODE.PROGRAM);
    assert.equal(ast.commands.length, 1);
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.SIMPLE_COMMAND);
    assert.equal(cmd.words.length, 1);
    assert.equal(cmd.words[0].value, 'ls');
    assert.equal(cmd.assignments.length, 0);
    assert.equal(cmd.redirects.length, 0);
  });

  it('command with args', () => {
    const ast = parse('ls -l /home');
    const cmd = ast.commands[0];
    assert.deepEqual(cmd.words.map(w => w.value), ['ls', '-l', '/home']);
  });

  it('leading assignments + command', () => {
    const ast = parse('FOO=bar BAZ=qux mycmd arg1');
    const cmd = ast.commands[0];
    assert.equal(cmd.assignments.length, 2);
    assert.equal(cmd.assignments[0].name, 'FOO');
    assert.equal(cmd.assignments[0].value.value, 'bar');
    assert.equal(cmd.assignments[1].name, 'BAZ');
    assert.equal(cmd.assignments[1].value.value, 'qux');
    assert.deepEqual(cmd.words.map(w => w.value), ['mycmd', 'arg1']);
  });

  it('assignment-only command (no program name)', () => {
    const ast = parse('FOO=bar');
    const cmd = ast.commands[0];
    assert.equal(cmd.assignments.length, 1);
    assert.equal(cmd.words.length, 0);
  });

  it('WORD=value AFTER the command name is an arg, not an assignment', () => {
    // POSIX rule 7b: assignments only count before the command name.
    const ast = parse('mycmd FOO=bar');
    const cmd = ast.commands[0];
    assert.equal(cmd.assignments.length, 0);
    assert.deepEqual(cmd.words.map(w => w.value), ['mycmd', 'FOO=bar']);
  });
});

describe('parser — redirects', () => {
  it('stdout redirect', () => {
    const ast = parse('cmd > out.txt');
    const cmd = ast.commands[0];
    assert.equal(cmd.redirects.length, 1);
    assert.equal(cmd.redirects[0].op, '>');
    assert.equal(cmd.redirects[0].fd, null);
    assert.equal(cmd.redirects[0].target.value, 'out.txt');
  });

  it('stderr redirect with explicit fd', () => {
    const ast = parse('cmd 2> err.log');
    const cmd = ast.commands[0];
    assert.equal(cmd.redirects[0].fd, 2);
    assert.equal(cmd.redirects[0].op, '>');
  });

  it('input redirect', () => {
    const ast = parse('cmd < input.txt');
    const cmd = ast.commands[0];
    assert.equal(cmd.redirects[0].op, '<');
    assert.equal(cmd.redirects[0].target.value, 'input.txt');
  });

  it('append redirect', () => {
    const ast = parse('cmd >> log.txt');
    const cmd = ast.commands[0];
    assert.equal(cmd.redirects[0].op, '>>');
  });

  it('multiple redirects (prefix + suffix)', () => {
    const ast = parse('< in.txt cmd > out.txt');
    const cmd = ast.commands[0];
    assert.equal(cmd.redirects.length, 2);
    assert.equal(cmd.redirects[0].op, '<');
    assert.equal(cmd.redirects[1].op, '>');
    assert.equal(cmd.words[0].value, 'cmd');
  });

  it('2>&1 (fd duplication)', () => {
    const ast = parse('cmd 2>&1');
    const cmd = ast.commands[0];
    assert.equal(cmd.redirects[0].fd, 2);
    assert.equal(cmd.redirects[0].op, '>&');
    assert.equal(cmd.redirects[0].target.value, '1');
  });
});

describe('parser — pipelines and and-or', () => {
  it('two-stage pipeline', () => {
    const ast = parse('a | b');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.PIPELINE);
    assert.equal(cmd.commands.length, 2);
    assert.equal(cmd.commands[0].words[0].value, 'a');
    assert.equal(cmd.commands[1].words[0].value, 'b');
    assert.equal(cmd.negated, false);
  });

  it('three-stage pipeline', () => {
    const ast = parse('a | b | c');
    const cmd = ast.commands[0];
    assert.equal(cmd.commands.length, 3);
  });

  it('negated pipeline', () => {
    const ast = parse('! grep foo file');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.PIPELINE);
    assert.equal(cmd.negated, true);
    assert.equal(cmd.commands.length, 1);
  });

  it('and-or chain (left-associative)', () => {
    const ast = parse('a && b || c');
    const cmd = ast.commands[0];
    // ((a && b) || c)
    assert.equal(cmd.type, NODE.AND_OR);
    assert.equal(cmd.op, '||');
    assert.equal(cmd.right.type, NODE.SIMPLE_COMMAND);
    assert.equal(cmd.right.words[0].value, 'c');
    assert.equal(cmd.left.type, NODE.AND_OR);
    assert.equal(cmd.left.op, '&&');
  });

  it('pipeline inside and-or', () => {
    const ast = parse('a | b && c');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.AND_OR);
    assert.equal(cmd.op, '&&');
    assert.equal(cmd.left.type, NODE.PIPELINE);
    assert.equal(cmd.right.type, NODE.SIMPLE_COMMAND);
  });
});

describe('parser — lists', () => {
  it('semicolon-separated', () => {
    const ast = parse('a ; b ; c');
    assert.equal(ast.commands.length, 1);
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.LIST);
    assert.equal(cmd.items.length, 3);
    assert.equal(cmd.items[0].op, ';');
    assert.equal(cmd.items[1].op, ';');
    assert.equal(cmd.items[2].op, null);  // no trailing ;
  });

  it('newline-separated', () => {
    const ast = parse('a\nb\nc');
    assert.equal(ast.commands.length, 3);
  });

  it('background command', () => {
    const ast = parse('long-task &');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.LIST);
    assert.equal(cmd.items[0].op, '&');
  });
});

describe('parser — compound: if', () => {
  it('if-then-fi', () => {
    const ast = parse('if test -f foo; then cat foo; fi');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.IF_CLAUSE);
    assert.equal(cmd.elifs.length, 0);
    assert.equal(cmd.else, null);
  });

  it('if-elif-else-fi', () => {
    const ast = parse('if a; then b; elif c; then d; else e; fi');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.IF_CLAUSE);
    assert.equal(cmd.elifs.length, 1);
    assert.notEqual(cmd.else, null);
  });

  it('if with newlines instead of semicolons', () => {
    const ast = parse(`if test -f foo
then
  cat foo
fi`);
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.IF_CLAUSE);
  });
});

describe('parser — compound: for, while, until', () => {
  it('for-in-do-done', () => {
    const ast = parse('for f in a b c; do echo $f; done');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.FOR_CLAUSE);
    assert.equal(cmd.name, 'f');
    assert.deepEqual(cmd.words.map(w => w.value), ['a', 'b', 'c']);
  });

  it('for with no "in" clause defaults to null words', () => {
    const ast = parse('for x; do echo $x; done');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.FOR_CLAUSE);
    assert.equal(cmd.words, null);
  });

  it('while loop', () => {
    const ast = parse('while test -f flag; do sleep 1; done');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.WHILE_CLAUSE);
  });

  it('until loop', () => {
    const ast = parse('until test -f done.flag; do sleep 1; done');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.UNTIL_CLAUSE);
  });
});

describe('parser — compound: case', () => {
  it('basic case statement', () => {
    const ast = parse(`case "$1" in
  start) do_start ;;
  stop) do_stop ;;
  *) echo "huh?" ;;
esac`);
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.CASE_CLAUSE);
    assert.equal(cmd.items.length, 3);
    assert.deepEqual(cmd.items[0].patterns.map(p => p.value), ['start']);
    assert.deepEqual(cmd.items[2].patterns.map(p => p.value), ['*']);
  });

  it('case with alternative patterns', () => {
    const ast = parse(`case x in
  a|b|c) handle_abc ;;
  *) other ;;
esac`);
    const cmd = ast.commands[0];
    assert.deepEqual(cmd.items[0].patterns.map(p => p.value), ['a', 'b', 'c']);
  });
});

describe('parser — compound: groups, subshells, functions', () => {
  it('brace group', () => {
    const ast = parse('{ a; b; c; }');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.BRACE_GROUP);
  });

  it('subshell', () => {
    const ast = parse('( a && b )');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.SUBSHELL);
  });

  it('function definition', () => {
    const ast = parse('greet() { echo "hi"; }');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.FUNCTION_DEF);
    assert.equal(cmd.name, 'greet');
    assert.equal(cmd.body.type, NODE.BRACE_GROUP);
  });

  it('compound command with trailing redirect', () => {
    const ast = parse('{ echo a; echo b; } > out.txt');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.BRACE_GROUP);
    assert.equal(cmd.redirects.length, 1);
    assert.equal(cmd.redirects[0].target.value, 'out.txt');
  });
});

describe('parser — composite scripts', () => {
  it('realistic-looking script', () => {
    const script = `#!/usr/bin/env geas
# fetch a few CSVs and count their rows
LOG=/tmp/run.log

for f in /data/*.csv; do
  echo "processing $f" >> $LOG
  wc -l < "$f" | grep -v 0 || echo "empty: $f"
done

if test -s $LOG; then
  echo "done"
fi`;
    const ast = parse(script);
    assert.equal(ast.type, NODE.PROGRAM);
    // First top-level command: LOG=… assignment
    const first = ast.commands[0];
    assert.equal(first.type, NODE.SIMPLE_COMMAND);
    assert.equal(first.assignments[0].name, 'LOG');
    // Should also contain a for-clause and an if-clause
    const types = ast.commands.map(c => c.type);
    assert.ok(types.includes(NODE.FOR_CLAUSE));
    assert.ok(types.includes(NODE.IF_CLAUSE));
  });

  it('pipeline with quoted args parses cleanly', () => {
    const ast = parse(`cat foo | grep "hello world" | sort -r`);
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.PIPELINE);
    assert.equal(cmd.commands.length, 3);
    assert.equal(cmd.commands[1].words[1].value, '"hello world"');
  });
});

describe('parser — position info', () => {
  it('AST nodes carry pos with start/end offsets', () => {
    const ast = parse('echo hello');
    const cmd = ast.commands[0];
    assert.equal(typeof cmd.pos.start, 'number');
    assert.equal(typeof cmd.pos.end, 'number');
    assert.equal(cmd.pos.start, 0);
    assert.equal(cmd.pos.end, 10);
  });
});
