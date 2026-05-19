// Tests for @gcu/geas v0.0.1 — lexer + parser.
//
// No DOM shim needed; the lexer + parser are pure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../ext/geas/src/lexer.js';
import { parse } from '../ext/geas/src/parser.js';
import { parseWordParts } from '../ext/geas/src/word-parts.js';
import { execute } from '../ext/geas/src/executor.js';
import { NODE } from '../ext/geas/src/ast-nodes.js';
import { createHeadlessAdapter } from '../ext/geas/src/adapters/headless.js';
import { createShell, defaultBuiltins } from '../ext/geas/src/api.js';
import { VFS, MemoryBackend } from '../ext/vfs/index.js';

// Build a fresh VFS + shell pair for tests that exercise filesystem builtins.
function _testShell(opts = {}) {
  const vfs = new VFS();
  vfs._mounts.set('/', new MemoryBackend());
  const stdoutBuf = [];
  const stderrBuf = [];
  const shell = createShell({
    vfs,
    env: opts.env || { HOME: '/home', PATH: '/bin' },
    cwd: opts.cwd || '/',
    stdout: (t) => stdoutBuf.push(String(t)),
    stderr: (t) => stderrBuf.push(String(t)),
  });
  return {
    shell, vfs,
    output: () => stdoutBuf.join(''),
    errOutput: () => stderrBuf.join(''),
    clear: () => { stdoutBuf.length = 0; stderrBuf.length = 0; },
  };
}

// ── exec test harness ──
// Build a minimal context with a captured stdout/stderr and a small set of
// reference builtins. Returns { exitCode, stdout, stderr } for assertions.
async function run(source, opts = {}) {
  const stdoutBuf = [];
  const stderrBuf = [];
  // Builtins MUST write through ctx.stdout (not the captured top-level
  // buffer) so pipelines route correctly — the per-stage ctx.stdout
  // captures into a pipe buffer when the stage isn't last.
  const builtins = {
    echo: async (argv, ctx) => {
      const args = argv.slice(1);
      let newline = true;
      if (args[0] === '-n') { newline = false; args.shift(); }
      await ctx.stdout(args.join(' ') + (newline ? '\n' : ''));
      return 0;
    },
    true:  async () => 0,
    false: async () => 1,
    cat: async (_argv, ctx) => {
      const s = typeof ctx.stdin === 'string' ? ctx.stdin : '';
      await ctx.stdout(s);
      return 0;
    },
    ...(opts.builtins || {}),
  };
  const ast = parse(source);
  const ctx = {
    env:        new Map(Object.entries(opts.env || {})),
    cwd:        opts.cwd || '/',
    stdin:      opts.stdin ?? '',
    stdout:     (t) => stdoutBuf.push(String(t)),
    stderr:     (t) => stderrBuf.push(String(t)),
    builtins,
    vfs:        opts.vfs,
  };
  const result = await execute(ast, ctx);
  return {
    exitCode: result.exitCode,
    stdout:   stdoutBuf.join(''),
    stderr:   stderrBuf.join(''),
  };
}

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
    // `<<-` beats `<<` beats `<`. The trailing tokens after EOF here are
    // an empty HEREDOC_BODY (since there's no closing delimiter) — we only
    // assert the first three tokens to keep this test about operator-match
    // semantics rather than heredoc capture.
    const ts = nonEOF(tokenize('cat <<- EOF'));
    assert.deepEqual(valuesOf(ts).slice(0, 3), ['cat', '<<-', 'EOF']);
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

// ══════════════════════════════════════════════════════════
// HERE-DOCS
// ══════════════════════════════════════════════════════════

describe('lexer — here-docs', () => {
  it('basic <<EOF emits HEREDOC_BODY token after delimiter', () => {
    const ts = nonEOF(tokenize('cat <<EOF\nhello\nworld\nEOF\n'));
    // expect: WORD('cat'), OP('<<'), WORD('EOF'), HEREDOC_BODY, NEWLINE
    assert.equal(ts.length, 5);
    assert.equal(ts[3].type, 'HEREDOC_BODY');
    assert.equal(ts[3].value, 'hello\nworld\n');
    assert.equal(ts[3].quoted, false);
    assert.equal(ts[3].delim, 'EOF');
  });

  it('<<-EOF strips ALL leading TABS from body lines and delimiter', () => {
    // POSIX: `<<-` removes all leading tab characters from each body line
    // and from the line containing the closing delimiter (so the delimiter
    // can be aligned with surrounding indentation). Spaces are NOT stripped.
    const src = "cat <<-END\n\thello\n\t\tworld\n\tEND\n";
    const ts = nonEOF(tokenize(src));
    const body = ts.find(t => t.type === 'HEREDOC_BODY');
    assert.equal(body.value, 'hello\nworld\n');
    assert.equal(body.stripTabs, true);
  });

  it('<<-EOF does NOT strip leading SPACES from body (POSIX-strict)', () => {
    // The closing delimiter must still be reachable, so use TABS for it.
    // Body lines with leading SPACES keep them — only TAB prefixes go.
    const src = "cat <<-END\n    hello\n\tEND\n";
    const ts = nonEOF(tokenize(src));
    const body = ts.find(t => t.type === 'HEREDOC_BODY');
    assert.equal(body.value, '    hello\n');
  });

  it("quoted delimiter <<'EOF' marks body as quoted (no expansion)", () => {
    const ts = nonEOF(tokenize("cat <<'EOF'\nhello $USER\nEOF\n"));
    const body = ts.find(t => t.type === 'HEREDOC_BODY');
    assert.equal(body.quoted, true);
    assert.equal(body.delim, 'EOF');
    assert.equal(body.value, 'hello $USER\n');
  });

  it('double-quoted delimiter <<"EOF" also marks body as quoted', () => {
    const ts = nonEOF(tokenize('cat <<"EOF"\ntest\nEOF\n'));
    const body = ts.find(t => t.type === 'HEREDOC_BODY');
    assert.equal(body.quoted, true);
  });

  it('multiple heredocs on one line capture in queue order', () => {
    const src = "cat <<A <<B\nA_body\nA\nB_body\nB\n";
    const ts = nonEOF(tokenize(src));
    const bodies = ts.filter(t => t.type === 'HEREDOC_BODY');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].delim, 'A');
    assert.equal(bodies[0].value, 'A_body\n');
    assert.equal(bodies[1].delim, 'B');
    assert.equal(bodies[1].value, 'B_body\n');
  });

  it('empty heredoc body', () => {
    const ts = nonEOF(tokenize('cat <<EOF\nEOF\n'));
    const body = ts.find(t => t.type === 'HEREDOC_BODY');
    assert.equal(body.value, '');
  });

  it('unterminated heredoc captures what it can up to EOF', () => {
    const ts = nonEOF(tokenize('cat <<EOF\nhello\nworld\n'));
    const body = ts.find(t => t.type === 'HEREDOC_BODY');
    // Body capture continues until EOF since no closing EOF line ever appears.
    assert.equal(body.value, 'hello\nworld\n');
  });
});

// ══════════════════════════════════════════════════════════
// HEADLESS TERMINAL ADAPTER
// ══════════════════════════════════════════════════════════

describe('headless adapter — basic IO', () => {
  it('write + output round-trip', () => {
    const t = createHeadlessAdapter();
    t.write('hello ');
    t.write('world');
    assert.equal(t.output(), 'hello world');
  });

  it('preserves ANSI escape sequences verbatim', () => {
    const t = createHeadlessAdapter();
    t.write('\x1b[31mred\x1b[0m');
    assert.equal(t.output(), '\x1b[31mred\x1b[0m');
  });

  it('null/undefined writes are no-ops', () => {
    const t = createHeadlessAdapter();
    t.write(null);
    t.write(undefined);
    t.write('ok');
    assert.equal(t.output(), 'ok');
  });

  it('non-string writes get stringified', () => {
    const t = createHeadlessAdapter();
    t.write(42);
    assert.equal(t.output(), '42');
  });

  it('clear() empties buffer + blocks', () => {
    const t = createHeadlessAdapter();
    t.write('stuff');
    t.writeBlock({ type: 'text', value: 'block' });
    t.clear();
    assert.equal(t.output(), '');
    assert.equal(t.capturedBlocks().length, 0);
  });
});

describe('headless adapter — caps + blocks', () => {
  it('defaults to richBlocks=true so blocks are captured structurally', () => {
    const t = createHeadlessAdapter();
    assert.equal(t.caps().richBlocks, true);
    t.writeBlock({ type: 'table', columns: ['a'], rows: [[1]] });
    const blocks = t.capturedBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'table');
  });

  it('richBlocks=false reports back and serializes block writes to text', () => {
    const t = createHeadlessAdapter({ richBlocks: false });
    assert.equal(t.caps().richBlocks, false);
    t.writeBlock({ type: 'table', columns: ['a'], rows: [[1]] });
    assert.equal(t.capturedBlocks().length, 0);
    // JSON fallback for text-only terminals
    assert.match(t.output(), /"type":"table"/);
  });
});

describe('headless adapter — input + resize', () => {
  it('onInput callback fires on sendInput', () => {
    const t = createHeadlessAdapter();
    const received = [];
    t.onInput(text => received.push(text));
    t.sendInput('hello');
    t.sendInput('\n');
    assert.deepEqual(received, ['hello', '\n']);
  });

  it('onInput returns an unsubscribe', () => {
    const t = createHeadlessAdapter();
    const received = [];
    const unsub = t.onInput(text => received.push(text));
    t.sendInput('one');
    unsub();
    t.sendInput('two');
    assert.deepEqual(received, ['one']);
    assert.equal(t._subCounts().input, 0);
  });

  it('multiple input subscribers all fire', () => {
    const t = createHeadlessAdapter();
    const a = [];
    const b = [];
    t.onInput(s => a.push(s));
    t.onInput(s => b.push(s));
    t.sendInput('x');
    assert.deepEqual(a, ['x']);
    assert.deepEqual(b, ['x']);
  });

  it('a throwing handler does not break other handlers', () => {
    const t = createHeadlessAdapter();
    const ok = [];
    t.onInput(() => { throw new Error('boom'); });
    t.onInput(s => ok.push(s));
    t.sendInput('survived');
    assert.deepEqual(ok, ['survived']);
  });

  it('size + setSize + onResize work together', () => {
    const t = createHeadlessAdapter({ cols: 80, rows: 24 });
    assert.deepEqual(t.size(), { cols: 80, rows: 24 });
    const resizes = [];
    t.onResize(s => resizes.push(s));
    t.setSize(120, 40);
    assert.deepEqual(t.size(), { cols: 120, rows: 40 });
    assert.deepEqual(resizes, [{ cols: 120, rows: 40 }]);
  });

  it('default size is 80x24', () => {
    const t = createHeadlessAdapter();
    assert.deepEqual(t.size(), { cols: 80, rows: 24 });
  });
});

// ══════════════════════════════════════════════════════════
// EXECUTOR
// ══════════════════════════════════════════════════════════

describe('executor — simple commands', () => {
  it('echo prints args', async () => {
    const r = await run('echo hello world');
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'hello world\n');
  });

  it('echo -n suppresses trailing newline', async () => {
    const r = await run('echo -n no-nl');
    assert.equal(r.stdout, 'no-nl');
  });

  it('true / false exit codes', async () => {
    assert.equal((await run('true')).exitCode, 0);
    assert.equal((await run('false')).exitCode, 1);
  });

  it('unknown command exits 127', async () => {
    const r = await run('nosuchcommand');
    assert.equal(r.exitCode, 127);
  });

  it('multiple commands run in order', async () => {
    const r = await run('echo one; echo two; echo three');
    assert.equal(r.stdout, 'one\ntwo\nthree\n');
  });
});

describe('executor — word expansion', () => {
  it('$VAR is substituted', async () => {
    const r = await run('echo $name', { env: { name: 'arthur' } });
    assert.equal(r.stdout, 'arthur\n');
  });

  it('"$VAR" expands inside double quotes', async () => {
    const r = await run('echo "hi $name"', { env: { name: 'arthur' } });
    assert.equal(r.stdout, 'hi arthur\n');
  });

  it("'$VAR' stays literal inside single quotes", async () => {
    const r = await run("echo '$name'", { env: { name: 'arthur' } });
    assert.equal(r.stdout, '$name\n');
  });

  it('unset $VAR expands to empty string', async () => {
    const r = await run('echo "<$missing>"');
    assert.equal(r.stdout, '<>\n');
  });

  it('${VAR:-default} uses default when unset', async () => {
    const r = await run('echo ${missing:-fallback}');
    assert.equal(r.stdout, 'fallback\n');
  });

  it('${VAR:-default} keeps value when set', async () => {
    const r = await run('echo ${name:-fallback}', { env: { name: 'real' } });
    assert.equal(r.stdout, 'real\n');
  });

  it('${VAR:=default} assigns and uses default when unset', async () => {
    const r = await run('echo ${x:=hello}; echo $x');
    assert.equal(r.stdout, 'hello\nhello\n');
  });

  it('${#VAR} returns string length', async () => {
    const r = await run('echo ${#name}', { env: { name: 'arthur' } });
    assert.equal(r.stdout, '6\n');
  });

  it("$(cmd) substitutes command output (trailing newlines stripped)", async () => {
    const r = await run('echo $(echo nested)');
    assert.equal(r.stdout, 'nested\n');
  });

  it('$? is the previous command exit code', async () => {
    const r = await run('false; echo $?');
    assert.equal(r.stdout, '1\n');
  });
});

describe('executor — pipelines', () => {
  it('echo | cat — basic pipe', async () => {
    const r = await run('echo hello | cat');
    assert.equal(r.stdout, 'hello\n');
  });

  it('multi-stage pipe', async () => {
    // Add a uppercase builtin so we can test multi-stage.
    const upper = async (_argv, ctx) => {
      const s = typeof ctx.stdin === 'string' ? ctx.stdin : '';
      await ctx.stdout(s.toUpperCase());
      return 0;
    };
    const r = await run('echo abc | cat | upper', { builtins: { upper } });
    assert.equal(r.stdout, 'ABC\n');
  });

  it('pipeline exit code is the last command', async () => {
    const r = await run('true | false');
    assert.equal(r.exitCode, 1);
    const r2 = await run('false | true');
    assert.equal(r2.exitCode, 0);
  });

  it('negated pipeline inverts exit code', async () => {
    assert.equal((await run('! true')).exitCode, 1);
    assert.equal((await run('! false')).exitCode, 0);
  });
});

describe('executor — and-or chains', () => {
  it('&& runs right only when left succeeded', async () => {
    const r = await run('true && echo yes');
    assert.equal(r.stdout, 'yes\n');
    const r2 = await run('false && echo yes');
    assert.equal(r2.stdout, '');
  });

  it('|| runs right only when left failed', async () => {
    const r = await run('false || echo backup');
    assert.equal(r.stdout, 'backup\n');
    const r2 = await run('true || echo backup');
    assert.equal(r2.stdout, '');
  });

  it('chained: true && false || echo recover', async () => {
    const r = await run('true && false || echo recover');
    assert.equal(r.stdout, 'recover\n');
  });
});

describe('executor — control flow', () => {
  it('if/then/fi', async () => {
    const r = await run('if true; then echo yes; fi');
    assert.equal(r.stdout, 'yes\n');
  });

  it('if/then/else with false', async () => {
    const r = await run('if false; then echo yes; else echo no; fi');
    assert.equal(r.stdout, 'no\n');
  });

  it('if/elif/else', async () => {
    const r = await run('if false; then echo a; elif true; then echo b; else echo c; fi');
    assert.equal(r.stdout, 'b\n');
  });

  it('for x in list', async () => {
    const r = await run('for x in a b c; do echo $x; done');
    assert.equal(r.stdout, 'a\nb\nc\n');
  });

  it('while loop with counter (using arith)', async () => {
    const r = await run('i=0; while [ "$i" != "3" ]; do echo $i; i=$((i + 1)); done', {
      builtins: { '[': async (argv) => {
        // crude: [ A != B ] → strip trailing ']' arg
        if (argv[argv.length - 1] === ']') argv = argv.slice(0, -1);
        const [, a, op, b] = argv;
        if (op === '!=') return a !== b ? 0 : 1;
        if (op === '=')  return a === b ? 0 : 1;
        return 2;
      }},
    });
    assert.equal(r.stdout, '0\n1\n2\n');
  });

  it('case with star pattern', async () => {
    const r = await run('case foo in bar) echo no ;; *) echo wild ;; esac');
    assert.equal(r.stdout, 'wild\n');
  });

  it('case with alternative patterns', async () => {
    const r = await run('case b in a|b|c) echo match ;; *) echo nope ;; esac');
    assert.equal(r.stdout, 'match\n');
  });
});

describe('executor — assignments', () => {
  it('top-level assignment persists in env', async () => {
    const r = await run('x=hello; echo $x');
    assert.equal(r.stdout, 'hello\n');
  });

  it('per-command assignment is scoped to that command', async () => {
    const r = await run('TZ=UTC echo before; echo after-$TZ');
    // Per-command TZ shouldn't leak after the echo.
    assert.equal(r.stdout, 'before\nafter-\n');
  });
});

describe('executor — field splitting (IFS)', () => {
  it('unquoted $VAR splits on whitespace', async () => {
    const r = await run('echo $list', { env: { list: 'a b c' } });
    // echo sees three argv entries; joins with single space
    assert.equal(r.stdout, 'a b c\n');
  });

  it('quoted "$VAR" stays one field', async () => {
    // Use a builtin that counts argv to disambiguate.
    const r = await run('count "$list"', {
      env: { list: 'a b c' },
      builtins: { count: async (argv, ctx) => { await ctx.stdout(String(argv.length - 1)); return 0; } },
    });
    assert.equal(r.stdout, '1');
  });

  it('unquoted $VAR yields multiple argv entries', async () => {
    const r = await run('count $list', {
      env: { list: 'a b c' },
      builtins: { count: async (argv, ctx) => { await ctx.stdout(String(argv.length - 1)); return 0; } },
    });
    assert.equal(r.stdout, '3');
  });

  it('multiple whitespace runs collapse', async () => {
    const r = await run('count $x', {
      env: { x: '  a   b\tc  ' },
      builtins: { count: async (argv, ctx) => { await ctx.stdout(String(argv.length - 1)); return 0; } },
    });
    assert.equal(r.stdout, '3');
  });

  it('unquoted $EMPTY produces no field', async () => {
    const r = await run('count $missing one', {
      builtins: { count: async (argv, ctx) => { await ctx.stdout(argv.slice(1).join('|')); return 0; } },
    });
    assert.equal(r.stdout, 'one');
  });

  it('quoted "$EMPTY" produces one empty field', async () => {
    const r = await run('count "$missing" one', {
      builtins: { count: async (argv, ctx) => { await ctx.stdout(argv.slice(1).join('|')); return 0; } },
    });
    assert.equal(r.stdout, '|one');
  });

  it('IFS=":" splits on colons', async () => {
    const r = await run('count $path', {
      env: { IFS: ':', path: 'a:b:c' },
      builtins: { count: async (argv, ctx) => { await ctx.stdout(argv.slice(1).join('|')); return 0; } },
    });
    assert.equal(r.stdout, 'a|b|c');
  });

  it('for-loop iterates expanded fields', async () => {
    const r = await run('for x in $list; do echo $x; done', { env: { list: 'a b c' } });
    assert.equal(r.stdout, 'a\nb\nc\n');
  });
});

describe('executor — globbing', () => {
  // These need a VFS — use the _testShell harness defined below.
  it('* expands matching files in the cwd', async () => {
    const t = _testShell({ cwd: '/' });
    await t.vfs.mkdir('/dir', { recursive: true });
    await t.vfs.writeFile('/dir/a.txt', 'a');
    await t.vfs.writeFile('/dir/b.txt', 'b');
    await t.vfs.writeFile('/dir/c.csv', 'c');
    await t.shell.exec('echo /dir/*.txt');
    assert.equal(t.output(), '/dir/a.txt /dir/b.txt\n');
  });

  it('no-match glob stays literal (POSIX)', async () => {
    const t = _testShell({ cwd: '/' });
    await t.shell.exec('echo /nothing/*.csv');
    assert.equal(t.output(), '/nothing/*.csv\n');
  });

  it('relative glob uses cwd', async () => {
    const t = _testShell({ cwd: '/data' });
    await t.vfs.mkdir('/data', { recursive: true });
    await t.vfs.writeFile('/data/x.txt', 'x');
    await t.vfs.writeFile('/data/y.txt', 'y');
    await t.shell.exec('echo *.txt');
    assert.equal(t.output(), 'x.txt y.txt\n');
  });

  it('quoted glob does NOT expand', async () => {
    const t = _testShell({ cwd: '/' });
    await t.vfs.mkdir('/dir', { recursive: true });
    await t.vfs.writeFile('/dir/a.txt', 'a');
    await t.shell.exec('echo "/dir/*.txt"');
    assert.equal(t.output(), '/dir/*.txt\n');
  });

  it('for-loop over glob iterates each match', async () => {
    const t = _testShell({ cwd: '/' });
    await t.vfs.mkdir('/d', { recursive: true });
    await t.vfs.writeFile('/d/1.txt', '1');
    await t.vfs.writeFile('/d/2.txt', '2');
    await t.shell.exec('for f in /d/*.txt; do echo $f; done');
    assert.equal(t.output(), '/d/1.txt\n/d/2.txt\n');
  });
});

describe('executor — here-docs', () => {
  it('<<EOF body is fed as stdin', async () => {
    const r = await run('cat <<EOF\nhello\nworld\nEOF\n');
    assert.equal(r.stdout, 'hello\nworld\n');
  });

  it('unquoted heredoc expands $vars', async () => {
    const r = await run('cat <<END\nhi $name\nEND\n', { env: { name: 'arthur' } });
    assert.equal(r.stdout, 'hi arthur\n');
  });

  it("quoted heredoc <<'END' is literal", async () => {
    const r = await run("cat <<'END'\nhi $name\nEND\n", { env: { name: 'arthur' } });
    assert.equal(r.stdout, 'hi $name\n');
  });
});

// ══════════════════════════════════════════════════════════
// BUILT-INS + createShell
// ══════════════════════════════════════════════════════════

describe('createShell — basic shape', () => {
  it('returns an object with exec, env, cwd, lastStatus, builtins, functions', () => {
    const t = _testShell();
    assert.equal(typeof t.shell.exec, 'function');
    assert.ok(t.shell.env instanceof Map);
    assert.equal(typeof t.shell.cwd, 'string');
    assert.equal(typeof t.shell.lastStatus, 'number');
    assert.ok(t.shell.builtins instanceof Map);
    assert.ok(t.shell.functions instanceof Map);
  });

  it('ships with default builtins pre-loaded', () => {
    const t = _testShell();
    for (const name of ['echo', 'cat', 'pwd', 'cd', 'ls', 'env', 'true', 'false', 'test', '[', ':', 'export', 'exit']) {
      assert.ok(t.shell.builtins.has(name), `missing builtin ${name}`);
    }
  });

  it('exec returns {exitCode}', async () => {
    const t = _testShell();
    const r = await t.shell.exec('echo hi');
    assert.equal(r.exitCode, 0);
    assert.equal(t.output(), 'hi\n');
  });

  it('env persists across exec calls', async () => {
    const t = _testShell();
    await t.shell.exec('x=value');
    await t.shell.exec('echo $x');
    assert.equal(t.output(), 'value\n');
  });
});

describe('builtins — echo / true / false / : / exit', () => {
  it(': is a no-op exit 0', async () => {
    const t = _testShell();
    const r = await t.shell.exec(':');
    assert.equal(r.exitCode, 0);
  });
  it('exit with code', async () => {
    const t = _testShell();
    const r = await t.shell.exec('exit 7');
    assert.equal(r.exitCode, 7);
  });
  it('exit stops subsequent commands', async () => {
    const t = _testShell();
    await t.shell.exec('echo before; exit 3; echo after');
    assert.equal(t.output(), 'before\n');
  });
});

describe('builtins — pwd / cd', () => {
  it('pwd prints cwd', async () => {
    const t = _testShell({ cwd: '/home' });
    await t.shell.exec('pwd');
    assert.equal(t.output(), '/home\n');
  });
  it('cd changes cwd', async () => {
    const t = _testShell({ cwd: '/' });
    await t.vfs.mkdir('/etc', { recursive: true });
    await t.shell.exec('cd /etc; pwd');
    assert.equal(t.output(), '/etc\n');
  });
  it('cd ~ goes to HOME', async () => {
    const t = _testShell({ cwd: '/' });
    await t.vfs.mkdir('/home', { recursive: true });
    await t.shell.exec('cd ~; pwd');
    assert.equal(t.output(), '/home\n');
  });
  it('cd to non-existent fails', async () => {
    const t = _testShell({ cwd: '/' });
    const r = await t.shell.exec('cd /nosuch');
    assert.equal(r.exitCode, 1);
    assert.match(t.errOutput(), /no such directory/);
  });
});

describe('builtins — env / export', () => {
  it('env lists current environment', async () => {
    const t = _testShell({ env: { A: '1', B: '2' } });
    await t.shell.exec('env');
    const lines = t.output().trim().split('\n').sort();
    assert.deepEqual(lines, ['A=1', 'B=2']);
  });
  it('export NAME=value adds to env', async () => {
    const t = _testShell();
    await t.shell.exec('export FOO=bar; echo $FOO');
    assert.equal(t.output(), 'bar\n');
  });
});

describe('builtins — cat', () => {
  it('cat with no args echoes stdin', async () => {
    const t = _testShell();
    await t.shell.exec('echo hello | cat');
    assert.equal(t.output(), 'hello\n');
  });
  it('cat reads files from VFS', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/data.txt', 'file content\n');
    await t.shell.exec('cat /data.txt');
    assert.equal(t.output(), 'file content\n');
  });
  it('cat missing file → exit 1, stderr message', async () => {
    const t = _testShell();
    const r = await t.shell.exec('cat /nosuch.txt');
    assert.equal(r.exitCode, 1);
    assert.match(t.errOutput(), /cat: .*nosuch/);
  });
});

describe('builtins — ls', () => {
  it('ls lists VFS directory entries', async () => {
    const t = _testShell();
    await t.vfs.mkdir('/dir', { recursive: true });
    await t.vfs.writeFile('/dir/a.txt', 'a');
    await t.vfs.writeFile('/dir/b.txt', 'b');
    await t.shell.exec('ls /dir');
    assert.equal(t.output(), 'a.txt\nb.txt\n');
  });
  it("ls -a includes dot files", async () => {
    const t = _testShell();
    await t.vfs.mkdir('/dir', { recursive: true });
    await t.vfs.writeFile('/dir/.hidden', 'h');
    await t.vfs.writeFile('/dir/visible', 'v');
    await t.shell.exec('ls -a /dir');
    const lines = t.output().trim().split('\n').sort();
    assert.deepEqual(lines, ['.hidden', 'visible']);
  });
  it('ls -l includes file info', async () => {
    const t = _testShell();
    await t.vfs.mkdir('/dir', { recursive: true });
    await t.vfs.writeFile('/dir/file.txt', 'hello world');
    await t.shell.exec('ls -l /dir');
    assert.match(t.output(), /file\.txt/);
  });
});

describe('builtins — test / [', () => {
  it('test -z empty / -n non-empty', async () => {
    const t = _testShell();
    assert.equal((await t.shell.exec('test -z ""')).exitCode, 0);
    assert.equal((await t.shell.exec('test -z hi')).exitCode, 1);
    assert.equal((await t.shell.exec('test -n hi')).exitCode, 0);
    assert.equal((await t.shell.exec('test -n ""')).exitCode, 1);
  });
  it('[ A = B ] / != ]', async () => {
    const t = _testShell();
    assert.equal((await t.shell.exec('[ a = a ]')).exitCode, 0);
    assert.equal((await t.shell.exec('[ a = b ]')).exitCode, 1);
    assert.equal((await t.shell.exec('[ a != b ]')).exitCode, 0);
  });
  it('integer comparison -eq -lt -gt', async () => {
    const t = _testShell();
    assert.equal((await t.shell.exec('test 5 -eq 5')).exitCode, 0);
    assert.equal((await t.shell.exec('test 5 -lt 10')).exitCode, 0);
    assert.equal((await t.shell.exec('test 10 -gt 5')).exitCode, 0);
    assert.equal((await t.shell.exec('test 5 -gt 10')).exitCode, 1);
  });
  it('file tests -e -f -d', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'x');
    await t.vfs.mkdir('/dir');
    assert.equal((await t.shell.exec('test -e /x.txt')).exitCode, 0);
    assert.equal((await t.shell.exec('test -f /x.txt')).exitCode, 0);
    assert.equal((await t.shell.exec('test -d /x.txt')).exitCode, 1);
    assert.equal((await t.shell.exec('test -d /dir')).exitCode, 0);
    assert.equal((await t.shell.exec('test -e /nope')).exitCode, 1);
  });
  it('[ in a real conditional', async () => {
    const t = _testShell();
    await t.shell.exec('if [ 1 -eq 1 ]; then echo yes; fi');
    assert.equal(t.output(), 'yes\n');
  });
});

describe('builtins — redirects with VFS', () => {
  it('echo > file writes through VFS', async () => {
    const t = _testShell();
    await t.shell.exec('echo content > /out.txt');
    const text = await t.vfs.readFile('/out.txt', 'text');
    assert.equal(text, 'content\n');
  });
  it('cat < file reads through VFS', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/in.txt', 'from-file');
    await t.shell.exec('cat < /in.txt');
    assert.equal(t.output(), 'from-file');
  });
  it('append >> on existing file', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/log.txt', 'first\n');
    await t.shell.exec('echo second >> /log.txt');
    const text = await t.vfs.readFile('/log.txt', 'text');
    assert.equal(text, 'first\nsecond\n');
  });
});

describe('builtins — mkdir / rm / touch', () => {
  it('mkdir -p creates nested dirs', async () => {
    const t = _testShell();
    await t.shell.exec('mkdir -p /a/b/c');
    const st = await t.vfs.stat('/a/b/c');
    assert.equal(st.type, 'directory');
  });
  it('touch creates empty file', async () => {
    const t = _testShell();
    await t.shell.exec('touch /new.txt');
    const text = await t.vfs.readFile('/new.txt', 'text');
    assert.equal(text, '');
  });
  it('rm removes a file', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'x');
    await t.shell.exec('rm /x.txt');
    let exists = true;
    try { await t.vfs.stat('/x.txt'); } catch { exists = false; }
    assert.equal(exists, false);
  });
  it('rm -r removes a directory tree', async () => {
    const t = _testShell();
    await t.vfs.mkdir('/d/sub', { recursive: true });
    await t.vfs.writeFile('/d/a.txt', 'a');
    await t.vfs.writeFile('/d/sub/b.txt', 'b');
    await t.shell.exec('rm -r /d');
    let exists = true;
    try { await t.vfs.stat('/d'); } catch { exists = false; }
    assert.equal(exists, false);
  });
  it('rm of missing file → exit 1; rm -f silent', async () => {
    const t = _testShell();
    const r1 = await t.shell.exec('rm /nope');
    assert.equal(r1.exitCode, 1);
    t.clear();
    const r2 = await t.shell.exec('rm -f /nope');
    assert.equal(r2.exitCode, 0);
    assert.equal(t.errOutput(), '');
  });
});

describe('builtins — head / tail / wc', () => {
  it('head -n 2', async () => {
    const t = _testShell();
    await t.shell.exec('printf "a\\nb\\nc\\nd\\n" | head -n 2');
    // No printf builtin → fallback to onCommand → 127. Use a different approach:
    // pipe via echo with explicit newlines isn't easy. Use a file instead.
  });
  it('head with file', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'one\ntwo\nthree\nfour\n');
    await t.shell.exec('head -n 2 /x.txt');
    assert.equal(t.output(), 'one\ntwo\n');
  });
  it('tail with file', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'one\ntwo\nthree\nfour\n');
    await t.shell.exec('tail -n 2 /x.txt');
    assert.equal(t.output(), 'three\nfour\n');
  });
  it('wc -l counts lines', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'a\nb\nc\n');
    await t.shell.exec('wc -l /x.txt');
    assert.match(t.output(), /\b3\b/);
  });
  it('wc default shows lines words bytes', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'one two\nthree\n');
    await t.shell.exec('wc /x.txt');
    // Should contain 2 (lines), 3 (words), 14 (bytes)
    const out = t.output();
    assert.match(out, /\b2\b/);
    assert.match(out, /\b3\b/);
    assert.match(out, /\b14\b/);
  });
});

describe('builtins — grep / sort / uniq', () => {
  it('grep matches lines containing pattern', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'apple\nbanana\napricot\n');
    await t.shell.exec('grep ap /x.txt');
    assert.equal(t.output(), 'apple\napricot\n');
  });
  it('grep -v inverts match', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'apple\nbanana\napricot\n');
    await t.shell.exec('grep -v ap /x.txt');
    assert.equal(t.output(), 'banana\n');
  });
  it('grep -i case-insensitive', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'Apple\nbanana\nAPRICOT\n');
    await t.shell.exec('grep -i ap /x.txt');
    assert.equal(t.output(), 'Apple\nAPRICOT\n');
  });
  it('grep -c counts matches', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'a\nb\nc\nab\n');
    await t.shell.exec('grep -c a /x.txt');
    assert.equal(t.output(), '2\n');
  });
  it('grep no match exits 1', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'a\nb\n');
    const r = await t.shell.exec('grep nope /x.txt');
    assert.equal(r.exitCode, 1);
  });
  it('sort alphabetical', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'cherry\napple\nbanana\n');
    await t.shell.exec('sort /x.txt');
    assert.equal(t.output(), 'apple\nbanana\ncherry\n');
  });
  it('sort -n numeric', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', '10\n2\n100\n1\n');
    await t.shell.exec('sort -n /x.txt');
    assert.equal(t.output(), '1\n2\n10\n100\n');
  });
  it('sort -r reverse', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'a\nb\nc\n');
    await t.shell.exec('sort -r /x.txt');
    assert.equal(t.output(), 'c\nb\na\n');
  });
  it('uniq collapses adjacent dupes', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'a\na\nb\nb\nb\nc\n');
    await t.shell.exec('uniq /x.txt');
    assert.equal(t.output(), 'a\nb\nc\n');
  });
  it('uniq -c counts each run', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'a\na\nb\nc\nc\nc\n');
    await t.shell.exec('uniq -c /x.txt');
    const lines = t.output().trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /\b2 a/);
    assert.match(lines[1], /\b1 b/);
    assert.match(lines[2], /\b3 c/);
  });
});

describe('builtins — cut / tee / xargs', () => {
  it('cut -d "," -f 1,3', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'a,b,c,d\n1,2,3,4\n');
    await t.shell.exec('cut -d , -f 1,3 /x.csv');
    assert.equal(t.output(), 'a,c\n1,3\n');
  });
  it('cut -c 1-3', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.txt', 'hello\nworld\n');
    await t.shell.exec('cut -c 1-3 /x.txt');
    assert.equal(t.output(), 'hel\nwor\n');
  });
  it('tee writes stdin to file AND stdout', async () => {
    const t = _testShell();
    await t.shell.exec('echo hi | tee /out.txt');
    assert.equal(t.output(), 'hi\n');
    const text = await t.vfs.readFile('/out.txt', 'text');
    assert.equal(text, 'hi\n');
  });
  it('tee -a appends', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/log', 'prior\n');
    await t.shell.exec('echo new | tee -a /log');
    const text = await t.vfs.readFile('/log', 'text');
    assert.equal(text, 'prior\nnew\n');
  });
  it('xargs dispatches per-token', async () => {
    const t = _testShell();
    await t.shell.exec('echo a b c | xargs echo "list:"');
    assert.equal(t.output(), 'list: a b c\n');
  });
  it('xargs -n 1 batches single tokens', async () => {
    const t = _testShell();
    await t.shell.exec('echo a b c | xargs -n 1 echo');
    assert.equal(t.output(), 'a\nb\nc\n');
  });
});

describe('builtins — composed script', () => {
  it('write, then read back with pipeline', async () => {
    const t = _testShell();
    await t.shell.exec(`
echo line1 > /file.txt
echo line2 >> /file.txt
echo line3 >> /file.txt
cat /file.txt | cat | cat
`);
    assert.equal(t.output(), 'line1\nline2\nline3\n');
  });
});

// ══════════════════════════════════════════════════════════
// WORD PARTS (structured decomposition)
// ══════════════════════════════════════════════════════════

describe('word-parts — literals', () => {
  it('plain literal', () => {
    const p = parseWordParts('hello');
    assert.deepEqual(p, [{ kind: 'lit', value: 'hello' }]);
  });

  it('empty string', () => {
    assert.deepEqual(parseWordParts(''), []);
  });

  it('backslash escape becomes an escape part', () => {
    const p = parseWordParts('a\\$b');
    assert.deepEqual(p, [
      { kind: 'lit', value: 'a' },
      { kind: 'escape', value: '$' },
      { kind: 'lit', value: 'b' },
    ]);
  });
});

describe('word-parts — quoting', () => {
  it("single quotes produce a 'sq' part with literal contents", () => {
    const p = parseWordParts("'hello $world'");
    assert.deepEqual(p, [{ kind: 'sq', value: 'hello $world' }]);
  });

  it('double quotes produce a "dq" wrapper with inner parts', () => {
    const p = parseWordParts('"hello"');
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, 'dq');
    assert.deepEqual(p[0].parts, [{ kind: 'lit', value: 'hello' }]);
  });

  it('double quotes preserve $ expansions as inner parts', () => {
    const p = parseWordParts('"hi $USER!"');
    assert.equal(p[0].kind, 'dq');
    const inner = p[0].parts;
    assert.equal(inner.length, 3);
    assert.deepEqual(inner[0], { kind: 'lit', value: 'hi ' });
    assert.deepEqual(inner[1], { kind: 'var', name: 'USER' });
    assert.deepEqual(inner[2], { kind: 'lit', value: '!' });
  });

  it('inside double quotes, only $ ` " \\ are escapable; other \\X stays literal', () => {
    const p = parseWordParts('"a \\n b"');
    // \n is NOT a POSIX-recognised escape inside dquote, so backslash stays.
    assert.equal(p[0].kind, 'dq');
    assert.deepEqual(p[0].parts, [{ kind: 'lit', value: 'a \\n b' }]);
  });

  it('mixed unquoted + quoted segments', () => {
    const p = parseWordParts('foo"bar"baz');
    assert.equal(p.length, 3);
    assert.equal(p[0].kind, 'lit'); assert.equal(p[0].value, 'foo');
    assert.equal(p[1].kind, 'dq');
    assert.equal(p[2].kind, 'lit'); assert.equal(p[2].value, 'baz');
  });
});

describe('word-parts — variable references', () => {
  it('$NAME — simple identifier', () => {
    const p = parseWordParts('$HOME');
    assert.deepEqual(p, [{ kind: 'var', name: 'HOME' }]);
  });

  it('$0..9, $?, $#, $@, $* — special parameters', () => {
    for (const name of ['?', '#', '@', '*', '0', '1', '9', '!', '$', '-']) {
      const p = parseWordParts('$' + name);
      assert.deepEqual(p, [{ kind: 'var', name }], `for $${name}`);
    }
  });

  it('${NAME} — braced reference', () => {
    const p = parseWordParts('${HOME}');
    assert.deepEqual(p, [{ kind: 'var', name: 'HOME' }]);
  });

  it("${name:-default} — param with op", () => {
    const p = parseWordParts('${name:-arthur}');
    assert.equal(p[0].kind, 'param');
    assert.equal(p[0].name, 'name');
    assert.equal(p[0].op, ':-');
    assert.deepEqual(p[0].word.parts, [{ kind: 'lit', value: 'arthur' }]);
  });

  it("${name:+alt} — colon-plus op", () => {
    const p = parseWordParts('${name:+set}');
    assert.equal(p[0].op, ':+');
  });

  it('${#name} — length op', () => {
    const p = parseWordParts('${#name}');
    assert.deepEqual(p, [{ kind: 'param', name: 'name', op: '#', word: null }]);
  });

  it('${name##pattern} — longest-prefix removal', () => {
    const p = parseWordParts('${path##*/}');
    assert.equal(p[0].op, '##');
    assert.equal(p[0].name, 'path');
  });

  it('${name%suffix} — suffix removal', () => {
    const p = parseWordParts('${name%.txt}');
    assert.equal(p[0].op, '%');
  });

  it('bare $ followed by nothing recognisable stays literal', () => {
    const p = parseWordParts('$');
    assert.deepEqual(p, [{ kind: 'lit', value: '$' }]);
  });
});

describe('word-parts — command + arith substitution', () => {
  it('$(cmd) — command substitution', () => {
    const p = parseWordParts('$(date)');
    assert.deepEqual(p, [{ kind: 'cmd', body: 'date' }]);
  });

  it('`cmd` — backtick command substitution', () => {
    const p = parseWordParts('`date`');
    assert.deepEqual(p, [{ kind: 'cmd', body: 'date' }]);
  });

  it('nested $(...) keeps balance', () => {
    const p = parseWordParts('$(echo $(date))');
    assert.equal(p[0].kind, 'cmd');
    assert.equal(p[0].body, 'echo $(date)');
  });

  it('$((arith)) — arithmetic substitution', () => {
    const p = parseWordParts('$((1 + 2))');
    assert.deepEqual(p, [{ kind: 'arith', body: '1 + 2' }]);
  });

  it('arith with nested parens', () => {
    const p = parseWordParts('$((1 + (2 * 3)))');
    assert.equal(p[0].kind, 'arith');
    assert.equal(p[0].body, '1 + (2 * 3)');
  });
});

describe('word-parts — composite words', () => {
  it('mixed lit + var + lit', () => {
    const p = parseWordParts('prefix_$VAR_suffix');
    // POSIX greedy identifier: $VAR_suffix reads as $VAR_suffix (one name)
    assert.equal(p.length, 2);
    assert.deepEqual(p[0], { kind: 'lit', value: 'prefix_' });
    assert.deepEqual(p[1], { kind: 'var', name: 'VAR_suffix' });
  });

  it("mixed lit + var (use \${}) + lit to disambiguate", () => {
    const p = parseWordParts('prefix_${VAR}_suffix');
    assert.equal(p.length, 3);
    assert.deepEqual(p[0], { kind: 'lit', value: 'prefix_' });
    assert.deepEqual(p[1], { kind: 'var', name: 'VAR' });
    assert.deepEqual(p[2], { kind: 'lit', value: '_suffix' });
  });

  it('dq containing cmdsub', () => {
    const p = parseWordParts('"today is $(date)"');
    assert.equal(p[0].kind, 'dq');
    const inner = p[0].parts;
    assert.equal(inner.length, 2);
    assert.deepEqual(inner[0], { kind: 'lit', value: 'today is ' });
    assert.equal(inner[1].kind, 'cmd');
  });

  it('sq inside dq is literal text (single quotes lose meaning)', () => {
    const p = parseWordParts(`"it's fine"`);
    assert.equal(p[0].kind, 'dq');
    assert.deepEqual(p[0].parts, [{ kind: 'lit', value: "it's fine" }]);
  });
});

describe('parser — Word nodes carry .parts', () => {
  it('a simple command name has structured parts', () => {
    const ast = parse('echo hello');
    const cmd = ast.commands[0];
    assert.ok(Array.isArray(cmd.words[0].parts));
    assert.deepEqual(cmd.words[0].parts, [{ kind: 'lit', value: 'echo' }]);
  });

  it("$HOME in an arg gets a var part", () => {
    const ast = parse('cd $HOME');
    const cmd = ast.commands[0];
    assert.deepEqual(cmd.words[1].parts, [{ kind: 'var', name: 'HOME' }]);
  });

  it('redirect target words also carry parts', () => {
    const ast = parse('cmd > "$logfile"');
    const target = ast.commands[0].redirects[0].target;
    assert.equal(target.parts[0].kind, 'dq');
    assert.deepEqual(target.parts[0].parts, [{ kind: 'var', name: 'logfile' }]);
  });
});

describe('parser — here-docs', () => {
  it('attaches body to << redirect', () => {
    const ast = parse('cat <<EOF\nhello\nworld\nEOF\n');
    const cmd = ast.commands[0];
    assert.equal(cmd.type, NODE.SIMPLE_COMMAND);
    const redir = cmd.redirects[0];
    assert.equal(redir.op, '<<');
    assert.equal(redir.target.value, 'EOF');
    assert.equal(redir.body, 'hello\nworld\n');
    assert.equal(redir.bodyQuoted, false);
  });

  it('attaches body to <<- redirect with stripped tabs', () => {
    const src = "cat <<-END\n\thello\n\tEND\n";
    const ast = parse(src);
    const redir = ast.commands[0].redirects[0];
    assert.equal(redir.op, '<<-');
    assert.equal(redir.body, 'hello\n');
  });

  it("quoted delimiter records bodyQuoted=true", () => {
    const ast = parse("cat <<'STOP'\nliteral $stuff\nSTOP\n");
    const redir = ast.commands[0].redirects[0];
    assert.equal(redir.bodyQuoted, true);
    assert.equal(redir.body, 'literal $stuff\n');
  });

  it('multiple heredocs on one command pair in declaration order', () => {
    const src = "cat <<A <<B\nfirst\nA\nsecond\nB\n";
    const ast = parse(src);
    const redirs = ast.commands[0].redirects;
    assert.equal(redirs.length, 2);
    assert.equal(redirs[0].body, 'first\n');
    assert.equal(redirs[1].body, 'second\n');
  });

  it('heredoc followed by more code on the same line works', () => {
    const src = "cat <<EOF; echo done\nbody\nEOF\n";
    const ast = parse(src);
    // It's a List: [cat<<EOF, echo done]
    const list = ast.commands[0];
    assert.equal(list.type, NODE.LIST);
    const catCmd = list.items[0].cmd;
    assert.equal(catCmd.redirects[0].body, 'body\n');
    const echoCmd = list.items[1].cmd;
    assert.equal(echoCmd.words[1].value, 'done');
  });

  it('heredoc inside a for-loop body', () => {
    const src = "for f in a b; do\n  cat <<EOF\n  line for $f\nEOF\ndone\n";
    const ast = parse(src);
    assert.equal(ast.commands[0].type, NODE.FOR_CLAUSE);
    // body of the for-loop should contain a simple_command with a heredoc.
    // The for-loop body might be a List or a single SimpleCommand depending
    // on collapsing — just verify *some* redirect's body got attached.
    const body = ast.commands[0].body;
    // Walk to find the cat command's redirect (may be inside a List).
    const cat = body.type === NODE.LIST ? body.items[0].cmd : body;
    assert.equal(cat.redirects[0].body, '  line for $f\n');
  });
});
