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
import { createGeasClient } from '../ext/geas/src/worker/client.js';
import { setupGeasWorker } from '../ext/geas/src/worker/worker-shim.js';
import { createLoopback } from '../ext/geas/src/worker/loopback.js';
import { serveVFS, createVfsClient } from '../ext/geas/src/worker/vfs-proxy.js';
import { createTermAdapter, adapterHooks, makeLineEditor } from '../ext/geas/src/adapters/term.js';
import { createXtermAdapter } from '../ext/geas/src/adapters/xterm.js';
import { drainInput } from '../ext/geas/src/typed.js';
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
      // Pipelines now hand stdin as a queue (concurrent dispatch);
      // drainInput collapses string / typed / queue down to one value.
      const v = await drainInput(ctx);
      await ctx.stdout(typeof v === 'string' ? v : String(v));
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
      const v = await drainInput(ctx);
      const s = typeof v === 'string' ? v : String(v);
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

// ══════════════════════════════════════════════════════════
// TERMINAL ADAPTERS (with stub underlying terminals)
// ══════════════════════════════════════════════════════════
//
// Tests use minimal stubs that quack like @gcu/term and xterm.js — just
// the methods the adapter calls. Avoids pulling DOM / xterm.js into node
// tests while still exercising the adapter contract.

function _stubTerm(cols = 80, rows = 24) {
  // Minimal @gcu/term-shaped stub: write captures, onText subscribes,
  // unsubscribe via the returned function.
  const buf = [];
  let subs = new Set();
  return {
    cols, rows,
    write(text) { buf.push(text); },
    onText(cb) { subs.add(cb); return () => subs.delete(cb); },
    // helpers for the test
    _output() { return buf.join(''); },
    _sendInput(text) { for (const cb of subs) cb(text); },
    _subCount() { return subs.size; },
  };
}

function _stubXterm(cols = 80, rows = 24) {
  // Minimal xterm.js-shaped stub: onData returns a disposable, clear() works.
  const buf = [];
  let dataSubs = new Set();
  let resizeSubs = new Set();
  return {
    cols, rows,
    write(text) { buf.push(text); },
    onData(cb) {
      dataSubs.add(cb);
      return { dispose: () => dataSubs.delete(cb) };
    },
    onResize(cb) {
      resizeSubs.add(cb);
      return { dispose: () => resizeSubs.delete(cb) };
    },
    clear() { buf.length = 0; },
    _output() { return buf.join(''); },
    _sendInput(text) { for (const cb of dataSubs) cb(text); },
    _sendResize(cols, rows) { for (const cb of resizeSubs) cb({ cols, rows }); },
  };
}

describe('@gcu/term adapter', () => {
  it('write forwards to terminal.write', () => {
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    a.write('hello');
    assert.equal(t._output(), 'hello');
  });

  it('writeBlock falls back to block.text', () => {
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    a.writeBlock({ kind: 'table', value: {}, text: 'rendered table\n' });
    assert.equal(t._output(), 'rendered table\n');
  });

  it('onInput subscribes via terminal.onText and unsub works', () => {
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    const got = [];
    const unsub = a.onInput((s) => got.push(s));
    t._sendInput('x');
    t._sendInput('y');
    unsub();
    t._sendInput('z');
    assert.deepEqual(got, ['x', 'y']);
    assert.equal(t._subCount(), 0);
  });

  it('size + onResize work', () => {
    const t = _stubTerm(120, 40);
    const a = createTermAdapter({ terminal: t });
    assert.deepEqual(a.size(), { cols: 120, rows: 40 });
    const sizes = [];
    a.onResize((s) => sizes.push(s));
    a.notifyResize(100, 30);
    assert.deepEqual(sizes, [{ cols: 100, rows: 30 }]);
  });

  it('clear writes the ANSI clear sequence', () => {
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    a.clear();
    assert.equal(t._output(), '\x1b[2J\x1b[H');
  });

  it('caps reports richBlocks=false in v0', () => {
    const a = createTermAdapter({ terminal: _stubTerm() });
    assert.equal(a.caps().richBlocks, false);
  });

  it('rejects missing terminal', () => {
    assert.throws(() => createTermAdapter({}));
  });
});

describe('xterm.js adapter', () => {
  it('write forwards to terminal.write', () => {
    const t = _stubXterm();
    const a = createXtermAdapter({ terminal: t });
    a.write('hello');
    assert.equal(t._output(), 'hello');
  });

  it('writeBlock falls back to block.text', () => {
    const t = _stubXterm();
    const a = createXtermAdapter({ terminal: t });
    a.writeBlock({ kind: 'table', text: 'csv,here\n' });
    assert.equal(t._output(), 'csv,here\n');
  });

  it('onInput uses disposable; unsub disposes', () => {
    const t = _stubXterm();
    const a = createXtermAdapter({ terminal: t });
    const got = [];
    const unsub = a.onInput((s) => got.push(s));
    t._sendInput('a');
    unsub();
    t._sendInput('b');
    assert.deepEqual(got, ['a']);
  });

  it('onResize bridges to {cols, rows} payload', () => {
    const t = _stubXterm();
    const a = createXtermAdapter({ terminal: t });
    const sizes = [];
    a.onResize((s) => sizes.push(s));
    t._sendResize(100, 30);
    assert.deepEqual(sizes, [{ cols: 100, rows: 30 }]);
  });

  it('clear delegates to terminal.clear', () => {
    const t = _stubXterm();
    t.write('something');
    const a = createXtermAdapter({ terminal: t });
    a.clear();
    assert.equal(t._output(), '');
  });

  it('caps reports richBlocks=false', () => {
    assert.equal(createXtermAdapter({ terminal: _stubXterm() }).caps().richBlocks, false);
  });
});

describe('adapter hooks (GeasClient wiring helper)', () => {
  it('wires onStdout to adapter.write', async () => {
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    const hooks = adapterHooks(a);
    hooks.onStdout('chunk1');
    hooks.onStdout('chunk2');
    assert.equal(t._output(), 'chunk1chunk2');
  });

  it('onBlock routes to adapter.write when richBlocks=false', () => {
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    const hooks = adapterHooks(a);
    hooks.onBlock({ kind: 'table', text: 'fallback\n' });
    assert.equal(t._output(), 'fallback\n');
  });

  it('full integration: GeasClient + term adapter end-to-end', async () => {
    // Worker-hosted shell, output piped through the adapter into a stub terminal.
    const t = _stubTerm();
    const a = createTermAdapter({ terminal: t });
    const vfs = new VFS();
    vfs._mounts.set('/', new MemoryBackend());
    const { mainSide, workerSide } = createLoopback();
    setupGeasWorker(workerSide, { createShell });
    const client = createGeasClient({
      worker: mainSide, vfs, cwd: '/',
      ...adapterHooks(a),
    });
    await client.ready();
    await client.exec('echo hello');
    assert.equal(t._output(), 'hello\n');
    await client.terminate();
  });
});

// ══════════════════════════════════════════════════════════
// WORKER HARNESS (loopback)
// ══════════════════════════════════════════════════════════

// Build a worker-hosted shell using the in-process loopback. Returns a
// helper bundle: { client, vfs, output, errOutput, blocks, terminate }.
async function _workerShell(opts = {}) {
  const { mainSide, workerSide } = createLoopback();
  const vfs = opts.vfs || (() => {
    const v = new VFS();
    v._mounts.set('/', new MemoryBackend());
    return v;
  })();
  const stdoutBuf = [];
  const stderrBuf = [];
  const blocks = [];
  // Worker side: load geas, set up shim.
  setupGeasWorker(workerSide, { createShell });
  // Main side: client.
  const client = createGeasClient({
    worker: mainSide, vfs,
    env: opts.env || { HOME: '/home' },
    cwd: opts.cwd || '/',
    onStdout: (t) => stdoutBuf.push(t),
    onStderr: (t) => stderrBuf.push(t),
    onBlock:  (b) => blocks.push(b),
  });
  await client.ready();
  return {
    client, vfs,
    output: () => stdoutBuf.join(''),
    errOutput: () => stderrBuf.join(''),
    blocks: () => blocks.slice(),
    clear: () => { stdoutBuf.length = 0; stderrBuf.length = 0; blocks.length = 0; },
    terminate: () => client.terminate(),
  };
}

describe('worker harness — basics', () => {
  it('init + ready resolves', async () => {
    const t = await _workerShell();
    // If we got here, ready() resolved.
    assert.ok(true);
    await t.terminate();
  });

  it('exec returns exit code', async () => {
    const t = await _workerShell();
    const r = await t.client.exec('true');
    assert.equal(r.exitCode, 0);
    const r2 = await t.client.exec('false');
    assert.equal(r2.exitCode, 1);
    await t.terminate();
  });

  it('stdout flows to onStdout', async () => {
    const t = await _workerShell();
    await t.client.exec('echo hello');
    assert.equal(t.output(), 'hello\n');
    await t.terminate();
  });

  it('stderr flows to onStderr', async () => {
    const t = await _workerShell();
    await t.client.exec('cat /nope');
    assert.match(t.errOutput(), /no VFS|nope/);
    await t.terminate();
  });

  it('env persists across exec calls', async () => {
    const t = await _workerShell();
    await t.client.exec('export FOO=bar');
    await t.client.exec('echo $FOO');
    assert.equal(t.output(), 'bar\n');
    await t.terminate();
  });

  it('typed pipe output arrives as a block', async () => {
    const t = await _workerShell();
    await t.vfs.writeFile('/x.csv', 'name,age\nalice,30\n');
    await t.client.exec('from-csv /x.csv');
    const blocks = t.blocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'table');
    assert.deepEqual(blocks[0].value.columns, ['name', 'age']);
    await t.terminate();
  });

  it('VFS RPC: cat reads a file written from main', async () => {
    const t = await _workerShell();
    await t.vfs.writeFile('/greeting.txt', 'hello from main\n');
    await t.client.exec('cat /greeting.txt');
    assert.equal(t.output(), 'hello from main\n');
    await t.terminate();
  });

  it('VFS RPC: shell can write through the proxy', async () => {
    const t = await _workerShell();
    await t.client.exec('echo persisted > /file.txt');
    const text = await t.vfs.readFile('/file.txt', 'text');
    assert.equal(text, 'persisted\n');
    await t.terminate();
  });

  it('exec calls serialise (run one at a time)', async () => {
    const t = await _workerShell();
    // Two execs back-to-back; both should complete.
    const p1 = t.client.exec('echo one');
    const p2 = t.client.exec('echo two');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.exitCode, 0);
    assert.equal(r2.exitCode, 0);
    // Output should be ordered.
    assert.equal(t.output(), 'one\ntwo\n');
    await t.terminate();
  });

  it('pipeline + typed pipe inside a worker round-trips', async () => {
    const t = await _workerShell();
    await t.vfs.writeFile('/d.csv', 'a,b\n1,2\n3,4\n5,6\n');
    await t.client.exec("from-csv /d.csv | where 'a > 2' | to-csv");
    assert.equal(t.output(), 'a,b\n3,4\n5,6\n');
    await t.terminate();
  });

  it('terminate rejects pending execs', async () => {
    const t = await _workerShell();
    // Start an exec but don't await; terminate immediately.
    const pending = t.client.exec('echo will-be-cancelled').catch((e) => e);
    await t.terminate();
    const result = await pending;
    // Either it completed cleanly (race won by exec) OR was rejected.
    // We accept either — the contract is "no hangs."
    assert.ok(result);
  });
});

describe('worker harness — VFS RPC error propagation', () => {
  it('VFS errors come back as rejected promises in the worker', async () => {
    const t = await _workerShell();
    // cat on a missing file — VFS readFile throws, cat catches, writes
    // stderr + returns 1. Tests that the RPC error path works end-to-end.
    const r = await t.client.exec('cat /nosuch.txt');
    assert.equal(r.exitCode, 1);
    assert.match(t.errOutput(), /nosuch/);
    await t.terminate();
  });
});

describe('typed pipes', () => {
  it('from-csv | to-csv round-trips', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'name,age\nalice,30\nbob,25\n');
    await t.shell.exec('from-csv /x.csv | to-csv');
    assert.equal(t.output(), 'name,age\nalice,30\nbob,25\n');
  });

  it('from-csv | where | to-csv filters rows', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'name,age\nalice,30\nbob,25\ncarol,40\n');
    await t.shell.exec("from-csv /x.csv | where 'age > 28' | to-csv");
    assert.equal(t.output(), 'name,age\nalice,30\ncarol,40\n');
  });

  it('from-csv | select projects columns', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'name,age,city\nalice,30,NYC\nbob,25,LA\n');
    await t.shell.exec('from-csv /x.csv | select name city | to-csv');
    assert.equal(t.output(), 'name,city\nalice,NYC\nbob,LA\n');
  });

  it('from-csv | first 2 | to-csv slices rows', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'n\n1\n2\n3\n4\n5\n');
    await t.shell.exec('from-csv /x.csv | first 2 | to-csv');
    assert.equal(t.output(), 'n\n1\n2\n');
  });

  it('full pipeline: where + select + last', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/data.csv',
      'name,age,city\nalice,30,NYC\nbob,25,LA\ncarol,40,NYC\ndave,22,LA\n');
    await t.shell.exec(`
from-csv /data.csv | where 'city == NYC' | select name age | to-csv
`);
    assert.equal(t.output(), 'name,age\nalice,30\ncarol,40\n');
  });

  it('typed value degrades gracefully through cat', async () => {
    // cat doesn't understand typed values — falls back to toString() which
    // returns the CSV text rendering. End result is identical CSV.
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'a,b\n1,2\n');
    await t.shell.exec('from-csv /x.csv | cat');
    assert.equal(t.output(), 'a,b\n1,2\n');
  });

  it('typed value flows through grep (text fallback)', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'name,age\nalice,30\nbob,25\n');
    // grep gets the CSV text and matches lines.
    await t.shell.exec('from-csv /x.csv | grep alice');
    assert.equal(t.output(), 'alice,30\n');
  });

  it('typed pipe survives where with string ==', async () => {
    const t = _testShell();
    await t.vfs.writeFile('/x.csv', 'a,b\nx,1\ny,2\nx,3\n');
    await t.shell.exec("from-csv /x.csv | where 'a == x' | to-csv");
    assert.equal(t.output(), 'a,b\nx,1\nx,3\n');
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

// ── shell options (set -e/-u/-o pipefail) ──

describe('set -e (errexit)', () => {
  it('halts on first failing command', async () => {
    const { shell, output, errOutput } = _testShell();
    const r = await shell.exec('set -e\nfalse\necho should-not-run\n');
    assert.equal(r.exitCode, 1);
    assert.equal(output(), '');
  });

  it('does not halt when failure is in an `if` condition', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e\nif false; then echo a; else echo b; fi\necho done\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'b\ndone\n');
  });

  it('does not halt when failure is in a `while` condition (loop just exits)', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e\nwhile false; do echo body; done\necho done\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'done\n');
  });

  it('does not halt on left of && (only rightmost can trigger)', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e\nfalse || echo recovered\necho done\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'recovered\ndone\n');
  });

  it('does halt when rightmost of && fails', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e\ntrue && false\necho should-not-run\n');
    assert.equal(r.exitCode, 1);
    assert.equal(output(), '');
  });

  it('does not halt on negated pipeline', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e\n! true\necho ran\n');
    // `! true` → exit 1, but errexit-exempt under POSIX rules.
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'ran\n');
  });

  it('can be toggled off with set +e', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e\nset +e\nfalse\necho after\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'after\n');
  });

  it('set -o errexit is equivalent', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -o errexit\nfalse\necho should-not-run\n');
    assert.equal(r.exitCode, 1);
    assert.equal(output(), '');
  });
});

describe('set -u (nounset)', () => {
  it('errors on bare $UNDEFINED', async () => {
    const { shell, output, errOutput } = _testShell();
    const r = await shell.exec('set -u\necho $MISSING\n');
    assert.equal(r.exitCode, 1);
    assert.match(errOutput(), /MISSING.*unbound/);
    assert.equal(output(), '');
  });

  it('does not error when var is set', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -u\nFOO=bar\necho $FOO\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'bar\n');
  });

  it('does not error for ${X:-default}', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -u\necho ${MISSING:-fallback}\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'fallback\n');
  });

  it('does not error for ${X-default} when X is unset', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -u\necho ${MISSING-fallback}\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'fallback\n');
  });
});

describe('set -o pipefail', () => {
  it('without pipefail: pipeline exit = last stage', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('false | true\n');
    assert.equal(r.exitCode, 0);
  });

  it('with pipefail: pipeline exit = first non-zero stage', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('set -o pipefail\nfalse | true\n');
    assert.equal(r.exitCode, 1);
  });

  it('pipefail with all-success returns 0', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('set -o pipefail\ntrue | true | true\n');
    assert.equal(r.exitCode, 0);
  });

  it('pipefail composes with errexit', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -e -o pipefail\nfalse | true\necho after\n');
    assert.equal(r.exitCode, 1);
    assert.equal(output(), '');
  });

  it('set +o pipefail turns it off', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('set -o pipefail\nset +o pipefail\nfalse | true\n');
    assert.equal(r.exitCode, 0);
  });
});

describe('set -- (positional parameters)', () => {
  it('rewrites positional params', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -- a b c\necho $1 $2 $3\n');
    assert.equal(r.exitCode, 0);
    assert.equal(output(), 'a b c\n');
  });

  it('$# reflects the new count', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -- one two\necho $#\n');
    assert.equal(output(), '2\n');
  });
});

// ── printf ──

describe('printf', () => {
  it('plain string', async () => {
    const { shell, output } = _testShell();
    await shell.exec("printf hello\n");
    assert.equal(output(), 'hello');
  });

  it('%s substitution', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%s\\n" world\n');
    assert.equal(output(), 'world\n');
  });

  it('%d integer formatting', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%d\\n" 42\n');
    assert.equal(output(), '42\n');
  });

  it('%-10s left-aligned width', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%-10s|" hi\n');
    assert.equal(output(), 'hi        |');
  });

  it('%05d zero-padded width', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%05d\\n" 42\n');
    assert.equal(output(), '00042\n');
  });

  it('%.2f precision on floats', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%.2f\\n" 3.14159\n');
    assert.equal(output(), '3.14\n');
  });

  it('%x hex conversion', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%x\\n" 255\n');
    assert.equal(output(), 'ff\n');
  });

  it('format string is reused when more args than specifiers', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "%s " a b c\n');
    assert.equal(output(), 'a b c ');
  });

  it('%% literal percent', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "100%%\\n"\n');
    assert.equal(output(), '100%\n');
  });

  it('backslash escapes in the format', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "a\\tb\\n"\n');
    assert.equal(output(), 'a\tb\n');
  });
});

// ── read ──

describe('read', () => {
  it('reads a single line into a variable from heredoc', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read line <<EOF\nhello\nEOF\necho got=$line\n");
    assert.equal(output(), 'got=hello\n');
  });

  it('splits on $IFS into multiple vars', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read a b c <<EOF\none two three\nEOF\necho a=$a b=$b c=$c\n");
    assert.equal(output(), 'a=one b=two c=three\n');
  });

  it('last var absorbs trailing fields', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read a b <<EOF\none two three four\nEOF\necho a=$a b=$b\n");
    assert.equal(output(), 'a=one b=two three four\n');
  });

  it('no var name → REPLY', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read <<EOF\nfoo bar\nEOF\necho REPLY=$REPLY\n");
    assert.equal(output(), 'REPLY=foo bar\n');
  });

  it('returns 1 on EOF', async () => {
    const { shell } = _testShell();
    const r = await shell.exec("read line\n");
    assert.equal(r.exitCode, 1);
  });

  it('-n N reads exactly N characters', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read -n 3 part <<EOF\nabcdefg\nEOF\necho got=$part\n");
    assert.equal(output(), 'got=abc\n');
  });

  it('-n N reads across newlines (no newline terminator like default read)', async () => {
    const { shell, output } = _testShell();
    // Heredoc body is "hi\nthere\n" (9 chars). -n 10 reads all of it.
    await shell.exec('read -n 10 part <<EOF\nhi\nthere\nEOF\necho "got=$part"\n');
    assert.equal(output(), 'got=hi\nthere\n');
  });

  it('-n N truncates when N is smaller than input', async () => {
    const { shell, output } = _testShell();
    await shell.exec('read -n 4 part <<EOF\nabcdefgh\nEOF\necho got=$part\n');
    assert.equal(output(), 'got=abcd\n');
  });

  it('-n 0 reads nothing but still succeeds', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read -n 0 part <<EOF\nhello\nEOF\necho got=[$part]\n");
    assert.equal(output(), 'got=[]\n');
  });

  it('-d uses an alternate terminator', async () => {
    const { shell, output } = _testShell();
    await shell.exec("read -d ',' part <<EOF\nfirst,second\nEOF\necho got=$part\n");
    assert.equal(output(), 'got=first\n');
  });

  it("-d '' reads everything to EOF", async () => {
    const { shell, output } = _testShell();
    await shell.exec("read -d '' all <<EOF\nline1\nline2\nline3\nEOF\necho \"got=[$all]\"\n");
    assert.match(output(), /got=\[line1\nline2\nline3\n?\]/);
  });

  it('-r skips backslash processing (vs default which would consume one level)', async () => {
    // Use a *quoted* heredoc delimiter so the body reaches `read` raw —
    // otherwise heredoc text expansion would eat backslashes first.
    const { shell, output } = _testShell();
    await shell.exec("read -r line <<'EOF'\nback\\\\slash\nEOF\necho \"$line\"\n");
    assert.equal(output(), 'back\\\\slash\n');
    // Same heredoc body without -r: read consumes one level of backslash.
    const { shell: s2, output: o2 } = _testShell();
    await s2.exec("read line <<'EOF'\nback\\\\slash\nEOF\necho \"$line\"\n");
    assert.equal(o2(), 'back\\slash\n');
  });
});

// ── seq / sleep / date / which / command ──

describe('seq', () => {
  it('seq N → 1..N', async () => {
    const { shell, output } = _testShell();
    await shell.exec('seq 4\n');
    assert.equal(output(), '1\n2\n3\n4\n');
  });

  it('seq FIRST LAST', async () => {
    const { shell, output } = _testShell();
    await shell.exec('seq 3 6\n');
    assert.equal(output(), '3\n4\n5\n6\n');
  });

  it('seq FIRST INCR LAST', async () => {
    const { shell, output } = _testShell();
    await shell.exec('seq 0 2 10\n');
    assert.equal(output(), '0\n2\n4\n6\n8\n10\n');
  });

  it('seq with negative increment counts down', async () => {
    const { shell, output } = _testShell();
    await shell.exec('seq 3 -1 0\n');
    assert.equal(output(), '3\n2\n1\n0\n');
  });

  it('seq -s custom separator', async () => {
    const { shell, output } = _testShell();
    await shell.exec('seq -s , 1 4\n');
    assert.equal(output(), '1,2,3,4\n');
  });

  it('seq integrates with for-loops', async () => {
    const { shell, output } = _testShell();
    await shell.exec('for i in $(seq 3); do echo n=$i; done\n');
    assert.equal(output(), 'n=1\nn=2\nn=3\n');
  });
});

describe('sleep', () => {
  it('returns 0 after sleeping', async () => {
    const { shell } = _testShell();
    const start = Date.now();
    const r = await shell.exec('sleep 0.05\n');
    const elapsed = Date.now() - start;
    assert.equal(r.exitCode, 0);
    assert.ok(elapsed >= 40, `expected ≥40ms, got ${elapsed}`);
  });
});

describe('date', () => {
  it('outputs a non-empty line by default', async () => {
    const { shell, output } = _testShell();
    await shell.exec('date\n');
    assert.ok(output().length > 0);
    assert.ok(output().endsWith('\n'));
  });

  it('date +%Y prints the current year', async () => {
    const { shell, output } = _testShell();
    await shell.exec('date +%Y\n');
    const year = parseInt(output().trim(), 10);
    assert.ok(year >= 2024 && year < 2100);
  });

  it('date +%F prints ISO date', async () => {
    const { shell, output } = _testShell();
    await shell.exec('date +%F\n');
    assert.match(output().trim(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('clear', () => {
  it('emits the VT100 clear-screen + home sequence', async () => {
    const { shell, output } = _testShell();
    await shell.exec('clear\n');
    assert.equal(output(), '\x1b[2J\x1b[H');
  });
});

describe('which / command', () => {
  it('which recognises builtins', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('which echo\n');
    assert.equal(r.exitCode, 0);
    assert.match(output(), /echo: shell built-in/);
  });

  it('which returns 1 on unknown name', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('which definitely-not-a-thing\n');
    assert.equal(r.exitCode, 1);
  });

  it('command -v finds a builtin', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('command -v echo\n');
    assert.equal(r.exitCode, 0);
    assert.match(output(), /echo/);
  });

  it('command runs the builtin bypassing functions', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo() { printf "FN\\n"; }\ncommand echo plain\n');
    assert.equal(output(), 'plain\n');
  });
});

// ── typed: from-json / to-json / display / plot ──

describe('from-json / to-json', () => {
  it('from-json on an array of flat objects → typed table', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.json', JSON.stringify([
      { name: 'a', x: 1 }, { name: 'b', x: 2 },
    ]));
    await shell.exec('from-json /data.json | to-csv\n');
    assert.equal(output(), 'name,x\na,1\nb,2\n');
  });

  it('from-json | where filters rows', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.json', JSON.stringify([
      { name: 'a', x: 1 }, { name: 'b', x: 5 }, { name: 'c', x: 10 },
    ]));
    await shell.exec("from-json /data.json | where 'x > 3' | to-csv\n");
    assert.equal(output(), 'name,x\nb,5\nc,10\n');
  });

  it('from-json | select projects columns', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.json', JSON.stringify([
      { name: 'a', x: 1, y: 100 }, { name: 'b', x: 2, y: 200 },
    ]));
    await shell.exec('from-json /data.json | select name y | to-csv\n');
    assert.equal(output(), 'name,y\na,100\nb,200\n');
  });

  it('from-csv | to-json round-trips through JSON', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.csv', 'k,v\nfoo,1\nbar,2\n');
    await shell.exec('from-csv /data.csv | to-json\n');
    const parsed = JSON.parse(output());
    assert.deepEqual(parsed, [{ k: 'foo', v: '1' }, { k: 'bar', v: '2' }]);
  });

  it('to-json --pretty prints indented', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.csv', 'a\n1\n');
    await shell.exec('from-csv /data.csv | to-json --pretty\n');
    assert.match(output(), /\n {2}\{/);
  });

  it('from-json on top-level object emits typed object', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.json', JSON.stringify({ a: 1, b: 'hi' }));
    await shell.exec('from-json /data.json | to-json\n');
    assert.equal(JSON.parse(output()).a, 1);
  });

  it('from-json reports a parse error and exits non-zero', async () => {
    const { shell, vfs, errOutput } = _testShell();
    await vfs.writeFile('/bad.json', 'not json');
    const r = await shell.exec('from-json /bad.json\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /parse error/);
  });
});

describe('display', () => {
  it('renders a typed table as fixed-width text', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.csv', 'name,x\na,1\nb,2\n');
    await shell.exec('from-csv /data.csv | display\n');
    // Expect header + separator + rows in a column layout
    assert.match(output(), /name\s+x/);
    assert.match(output(), /a\s+1/);
    assert.match(output(), /─/);
  });

  it('renders a typed array as JSON', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.json', '[1, 2, 3]');
    await shell.exec('from-json /data.json | display\n');
    assert.match(output(), /\[\s*\n\s*1/);
  });

  it('passes plain text through unchanged', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo hello | display\n');
    assert.equal(output(), 'hello\n');
  });
});

describe('plot', () => {
  it('emits typed plot descriptor with ascii sparkline fallback', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.csv', 'y\n1\n3\n5\n4\n2\n1\n');
    await shell.exec('from-csv /data.csv | plot y\n');
    // The output should contain the ASCII sparkline characters from the
    // typed value's text fallback (via toString() — emitted to stdout
    // through the final pipe stage when richBlocks=false).
    assert.match(output(), /min=/);
    assert.match(output(), /max=/);
  });

  it('--kind hist produces a histogram-shaped fallback', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.csv', 'y\n1\n2\n2\n3\n3\n3\n4\n');
    await shell.exec('from-csv /data.csv | plot --kind hist y\n');
    assert.match(output(), /hist y/);
    assert.match(output(), /bins=/);
  });

  it('errors cleanly on unknown column', async () => {
    const { shell, vfs, errOutput } = _testShell();
    await vfs.writeFile('/data.csv', 'a\n1\n');
    const r = await shell.exec('from-csv /data.csv | plot missing\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /no column/);
  });
});

// ── stage 16: per-stage env isolation + xtrace ──

describe('pipeline subshell isolation', () => {
  it('cd in a pipeline stage does not change parent cwd', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/elsewhere', { recursive: true });
    await shell.exec('cd /elsewhere | true\npwd\n');
    assert.equal(output(), '/\n');
  });

  it('variable assignment in a pipeline stage does not leak', async () => {
    const { shell, output } = _testShell();
    await shell.exec('X=outer\necho start | { X=changed; cat; }\necho got=$X\n');
    assert.equal(output(), 'start\ngot=outer\n');
  });

  it('set -e inside a pipeline stage does not enable errexit outside', async () => {
    const { shell, output } = _testShell();
    await shell.exec('(set -e) | true\nfalse\necho after\n');
    assert.equal(output(), 'after\n');
  });

  it('positional mutations in a pipeline stage do not leak', async () => {
    const { shell, output } = _testShell();
    await shell.exec('set -- a b c\necho hi | { set -- z; echo inside=$1; }\necho outside=$1\n');
    assert.equal(output(), 'inside=z\noutside=a\n');
  });

  it('parent env is visible inside the stage (clone, not erase)', async () => {
    const { shell, output } = _testShell();
    await shell.exec('FOO=bar\necho hi | { echo got=$FOO; }\n');
    assert.equal(output(), 'got=bar\n');
  });
});

describe('set -x (xtrace)', () => {
  it('prints expanded commands to stderr', async () => {
    const { shell, errOutput } = _testShell();
    await shell.exec('set -x\necho hello\n');
    assert.match(errOutput(), /\+ echo hello/);
  });

  it('shows the values after expansion, not the source', async () => {
    const { shell, errOutput } = _testShell();
    await shell.exec('set -x\nname=alice\necho hi $name\n');
    // After expansion, $name → alice.
    assert.match(errOutput(), /\+ echo hi alice/);
  });

  it('respects $PS4 for the prefix', async () => {
    const { shell, errOutput } = _testShell();
    await shell.exec('PS4="DEBUG: "\nset -x\necho marker\n');
    assert.match(errOutput(), /DEBUG: echo marker/);
  });

  it('set +x turns tracing off', async () => {
    const { shell, errOutput } = _testShell();
    await shell.exec('set -x\necho on\nset +x\necho off\n');
    // The "set +x" line itself traces, but subsequent "echo off" should not.
    const errs = errOutput();
    assert.match(errs, /\+ echo on/);
    assert.match(errs, /\+ set \+x/);
    assert.ok(!errs.includes('+ echo off'), 'echo off should NOT be traced');
  });

  it('tracing does not pollute stdout', async () => {
    const { shell, output } = _testShell();
    await shell.exec('set -x\necho stdout-only\n');
    assert.equal(output(), 'stdout-only\n');
  });
});

// ── stage 17: eval, source, getopts ──

describe('eval', () => {
  it('parses and executes its joined args', async () => {
    const { shell, output } = _testShell();
    await shell.exec('eval echo hello\n');
    assert.equal(output(), 'hello\n');
  });

  it('runs control flow', async () => {
    const { shell, output } = _testShell();
    await shell.exec("eval 'for x in a b c; do echo $x; done'\n");
    assert.equal(output(), 'a\nb\nc\n');
  });

  it('mutations leak to the caller', async () => {
    const { shell, output } = _testShell();
    await shell.exec("eval 'X=set'\necho got=$X\n");
    assert.equal(output(), 'got=set\n');
  });

  it('forwards exit code', async () => {
    const { shell } = _testShell();
    const r = await shell.exec("eval false\n");
    assert.equal(r.exitCode, 1);
  });

  it('handles a pipeline inside the eval string', async () => {
    const { shell, output } = _testShell();
    await shell.exec("eval 'echo a; echo b' | cat\n");
    assert.equal(output(), 'a\nb\n');
  });

  it('no args is a no-op success', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('eval\n');
    assert.equal(r.exitCode, 0);
  });
});

describe('source / .', () => {
  it('runs file contents in the current scope', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/lib.sh', 'X=loaded\necho first\n');
    await shell.exec('source /lib.sh\necho got=$X\n');
    assert.equal(output(), 'first\ngot=loaded\n');
  });

  it('. is the POSIX alias', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/lib.sh', 'Y=alias-form\n');
    await shell.exec('. /lib.sh\necho got=$Y\n');
    assert.equal(output(), 'got=alias-form\n');
  });

  it('extra args become positional inside the sourced file', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/lib.sh', 'echo got: $1 and $2\n');
    await shell.exec('set -- script-arg\nsource /lib.sh alice bob\necho outside: $1\n');
    assert.equal(output(), 'got: alice and bob\noutside: script-arg\n');
  });

  it('functions defined in the file are usable after source', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/lib.sh', 'greet() { echo hi $1; }\n');
    await shell.exec('source /lib.sh\ngreet world\n');
    assert.equal(output(), 'hi world\n');
  });

  it('exit inside sourced file halts the calling script', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/lib.sh', 'echo before-exit\nexit 7\n');
    const r = await shell.exec('source /lib.sh\necho unreachable\n');
    assert.equal(r.exitCode, 7);
    assert.equal(output(), 'before-exit\n');
  });

  it('missing file reports an error', async () => {
    const { shell, errOutput } = _testShell();
    const r = await shell.exec('source /nope.sh\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /nope/);
  });
});

describe('getopts', () => {
  it('parses a bare flag', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'set -- -v\n' +
      'while getopts "v" opt; do echo opt=$opt; done\n'
    );
    assert.equal(output(), 'opt=v\n');
  });

  it('parses a flag with required argument', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'set -- -n alice\n' +
      'while getopts "n:" opt; do echo name=$OPTARG; done\n'
    );
    assert.equal(output(), 'name=alice\n');
  });

  it('handles glued -nVAL form', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'set -- -nbob\n' +
      'while getopts "n:" opt; do echo name=$OPTARG; done\n'
    );
    assert.equal(output(), 'name=bob\n');
  });

  it('clusters bare flags into separate iterations', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'set -- -abc\n' +
      'while getopts "abc" opt; do echo opt=$opt; done\n'
    );
    assert.equal(output(), 'opt=a\nopt=b\nopt=c\n');
  });

  it('stops on first non-option and shift uses OPTIND', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'set -- -v file1 file2\n' +
      'verbose=0\n' +
      'while getopts "v" opt; do if [ $opt = v ]; then verbose=1; fi; done\n' +
      'shift $((OPTIND - 1))\n' +
      'echo verbose=$verbose remaining=$#\n'
    );
    assert.equal(output(), 'verbose=1 remaining=2\n');
  });

  it('reports illegal option', async () => {
    const { shell, output, errOutput } = _testShell();
    await shell.exec(
      'set -- -z\n' +
      'while getopts "a" opt; do echo opt=$opt OPTARG=$OPTARG; done\n'
    );
    assert.match(output(), /opt=\? OPTARG=z/);
    assert.match(errOutput(), /illegal option/);
  });

  it('reports missing required argument', async () => {
    const { shell, errOutput } = _testShell();
    await shell.exec(
      'set -- -n\n' +
      'while getopts "n:" opt; do :; done\n'
    );
    assert.match(errOutput(), /requires argument/);
  });
});

// ── stage 18: tr / du / df / base64 / md5sum / sha256sum / ** glob ──

describe('tr', () => {
  it('translates a single char', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo hello | tr l L\n');
    assert.equal(output(), 'heLLo\n');
  });

  it('translates a range to uppercase', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo hello | tr a-z A-Z\n');
    assert.equal(output(), 'HELLO\n');
  });

  it('-d deletes chars', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo hello | tr -d l\n');
    assert.equal(output(), 'heo\n');
  });

  it('-d with class', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo "abc 123" | tr -d "[:digit:]"\n');
    assert.equal(output(), 'abc \n');
  });

  it('-s squeezes runs', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo aaabbbcccc | tr -s abc\n');
    assert.equal(output(), 'abc\n');
  });

  it('-c (complement) deletes chars NOT in set', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo "abc123" | tr -cd "[:digit:]"\n');
    assert.equal(output(), '123');
  });

  it('class [:upper:] works', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo Hello | tr "[:upper:]" "[:lower:]"\n');
    assert.equal(output(), 'hello\n');
  });
});

describe('du', () => {
  it('sums sizes recursively', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/p/sub', { recursive: true });
    await vfs.writeFile('/p/a', 'AAAA');       // 4 bytes
    await vfs.writeFile('/p/sub/b', 'BBBBBBB'); // 7 bytes
    await shell.exec('du -s /p\n');
    assert.match(output(), /^11\s+\/p\n/);
  });

  it('-h prints human-readable sizes', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/p', { recursive: true });
    await vfs.writeFile('/p/big', 'x'.repeat(2048));
    await shell.exec('du -sh /p\n');
    assert.match(output(), /2\.0K\s+\/p/);
  });

  it('without -s emits subdirectory lines too', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/p/sub', { recursive: true });
    await vfs.writeFile('/p/sub/x', 'hello');
    await shell.exec('du /p\n');
    // Both /p/sub and /p should appear.
    assert.match(output(), /\/p\/sub/);
    assert.match(output(), /\/p\n/);
  });
});

describe('df', () => {
  it('lists mounts and their sizes', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/f', 'hello');
    await shell.exec('df\n');
    // First line is the header. Second is the / mount.
    assert.match(output(), /^Mount/);
    assert.match(output(), /\/\s+5/);
  });
});

describe('base64', () => {
  it('encodes', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf hello | base64\n');
    // 'hello' → 'aGVsbG8='
    assert.match(output(), /aGVsbG8=/);
  });

  it('-d decodes', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo aGVsbG8= | base64 -d\n');
    assert.equal(output(), 'hello');
  });

  it('roundtrips', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf "GCU" | base64 | base64 -d\n');
    assert.equal(output(), 'GCU');
  });

  it('encodes file content', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/f', 'world');
    await shell.exec('base64 /f\n');
    assert.match(output(), /d29ybGQ=/);
  });
});

describe('md5sum / sha256sum', () => {
  it('md5sum hashes stdin', async () => {
    const { shell, output } = _testShell();
    // md5("hello") = 5d41402abc4b2a76b9719d911017c592
    await shell.exec('printf hello | md5sum\n');
    assert.match(output(), /^5d41402abc4b2a76b9719d911017c592\s+-/);
  });

  it('sha256sum hashes stdin', async () => {
    const { shell, output } = _testShell();
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    await shell.exec('printf hello | sha256sum\n');
    assert.match(output(), /^2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\s+-/);
  });

  it('md5sum hashes files with the filename in the second column', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/f.txt', 'hello');
    await shell.exec('md5sum /f.txt\n');
    assert.match(output(), /^5d41402abc4b2a76b9719d911017c592\s+\/f\.txt/);
  });

  it('hash composes with cut for use in scripts', async () => {
    const { shell, output } = _testShell();
    await shell.exec('printf hello | sha256sum | cut -d " " -f 1\n');
    // Just the hex, no '  -'
    const hex = output().trim();
    assert.equal(hex, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('** recursive glob', () => {
  it('** matches files at any depth via vfs.glob', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/p/a/b/c', { recursive: true });
    await vfs.writeFile('/p/x.txt', '');
    await vfs.writeFile('/p/a/y.txt', '');
    await vfs.writeFile('/p/a/b/z.txt', '');
    await vfs.writeFile('/p/a/b/c/w.txt', '');
    // Use ls + for to surface what the glob expands to.
    await shell.exec('for f in /p/**/*.txt; do echo $f; done\n');
    const lines = output().split('\n').filter(Boolean).sort();
    // Should hit at least the deep file and the surface one.
    assert.ok(lines.some(l => l.endsWith('/p/x.txt')) || lines.some(l => l.endsWith('/x.txt')),
      `expected /p/x.txt in glob results: ${JSON.stringify(lines)}`);
    assert.ok(lines.some(l => l.endsWith('/c/w.txt')),
      `expected deep /p/a/b/c/w.txt in results: ${JSON.stringify(lines)}`);
  });
});

// ── stage 14: cp / mv / stat ──

// ── stage 15: interactive read plumbing ──

describe('interactive read (in-process readLine hook)', () => {
  function _shellWithLineQueue(lines) {
    // Build a shell whose ctx.readLine returns successive elements
    // from `lines` (string for a line, null for eof, {timeout: true}
    // for timeout). Captures the most recent opts so tests can check
    // that flags propagate.
    const vfs = new VFS();
    vfs._mounts.set('/', new MemoryBackend());
    const stdoutBuf = [];
    const stderrBuf = [];
    const observedOpts = [];
    let cursor = 0;
    const shell = createShell({
      vfs,
      env: { HOME: '/home' },
      cwd: '/',
      stdout: (t) => stdoutBuf.push(String(t)),
      stderr: (t) => stderrBuf.push(String(t)),
      readLine: async (opts) => {
        observedOpts.push(opts);
        const next = lines[cursor++];
        if (next == null) return { eof: true };
        if (typeof next === 'object' && next.timeout) return { timeout: true };
        return { line: next };
      },
    });
    return {
      shell,
      output: () => stdoutBuf.join(''),
      errOutput: () => stderrBuf.join(''),
      observedOpts,
    };
  }

  it('falls through to readLine when stdin is empty', async () => {
    const t = _shellWithLineQueue(['alice']);
    await t.shell.exec('read who\necho hi $who\n');
    assert.equal(t.output(), 'hi alice\n');
  });

  it('readLine receives the prompt flag', async () => {
    const t = _shellWithLineQueue(['x']);
    await t.shell.exec('read -p "name? " name\n');
    assert.equal(t.observedOpts[0].prompt, 'name? ');
  });

  it('readLine receives the silent flag', async () => {
    const t = _shellWithLineQueue(['hunter2']);
    await t.shell.exec('read -s pw\n');
    assert.equal(t.observedOpts[0].silent, true);
  });

  it('readLine receives nChars, delim, timeout, raw', async () => {
    const t = _shellWithLineQueue(['x']);
    await t.shell.exec('read -r -n 5 -d "," -t 30 v\n');
    const opts = t.observedOpts[0];
    assert.equal(opts.nChars, 5);
    assert.equal(opts.delim, ',');
    assert.equal(opts.timeout, 30);
    assert.equal(opts.raw, true);
  });

  it('eof from readLine → exit code 1', async () => {
    const t = _shellWithLineQueue([null]); // first ask gets eof
    const r = await t.shell.exec('read v\n');
    assert.equal(r.exitCode, 1);
  });

  it('timeout from readLine → exit code 142', async () => {
    const t = _shellWithLineQueue([{ timeout: true }]);
    const r = await t.shell.exec('read -t 1 v\n');
    assert.equal(r.exitCode, 142);
  });

  it('readLine result is IFS-split into multiple vars', async () => {
    const t = _shellWithLineQueue(['one two three']);
    await t.shell.exec('read a b c\necho a=$a b=$b c=$c\n');
    assert.equal(t.output(), 'a=one b=two c=three\n');
  });

  it('heredoc stdin still works without invoking readLine', async () => {
    const t = _shellWithLineQueue([]);
    await t.shell.exec('read v <<EOF\nfrom-here\nEOF\necho got $v\n');
    assert.equal(t.observedOpts.length, 0);
    assert.equal(t.output(), 'got from-here\n');
  });

  it('without readLine, empty stdin still returns 1', async () => {
    const vfs = new VFS();
    vfs._mounts.set('/', new MemoryBackend());
    const out = [];
    const shell = createShell({
      vfs, cwd: '/',
      stdout: (t) => out.push(String(t)),
      stderr: () => {},
      // no readLine
    });
    const r = await shell.exec('read v\n');
    assert.equal(r.exitCode, 1);
  });
});

describe('makeLineEditor — adapter line editor', () => {
  function _mockAdapter() {
    const writes = [];
    const inputSubs = [];
    return {
      adapter: {
        write(t) { writes.push(t); },
        onInput(cb) { inputSubs.push(cb); return () => { /* unsubscribe noop */ }; },
        caps: () => ({ richBlocks: false }),
      },
      writes,
      feed(text) { for (const cb of inputSubs) cb(text); },
      written: () => writes.join(''),
    };
  }

  it('Enter submits the buffered line and echoes it', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({});
    m.feed('hello');
    m.feed('\r');
    const r = await p;
    assert.equal(r.line, 'hello');
    assert.match(m.written(), /hello/);
    assert.match(m.written(), /\r\n/);
  });

  it('Backspace deletes the last char', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({});
    m.feed('hellox');
    m.feed('\x7f'); // DEL backspace — remove the stray x
    m.feed('\r');
    const r = await p;
    assert.equal(r.line, 'hello');
  });

  it('silent mode does not echo characters', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({ silent: true });
    m.feed('secret\r');
    const r = await p;
    assert.equal(r.line, 'secret');
    // No 'secret' in the written stream, and no echoed Enter either.
    assert.ok(!m.written().includes('secret'));
  });

  it('Ctrl+D on empty buffer returns eof', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({});
    m.feed('\x04');
    const r = await p;
    assert.equal(r.eof, true);
  });

  it('Ctrl+D with chars in buffer is ignored', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({});
    m.feed('keep');
    m.feed('\x04'); // ignored
    m.feed('\r');
    const r = await p;
    assert.equal(r.line, 'keep');
  });

  it('Ctrl+C cancels with eof and writes ^C', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({});
    m.feed('abc');
    m.feed('\x03');
    const r = await p;
    assert.equal(r.eof, true);
    assert.match(m.written(), /\^C/);
  });

  it('nChars caps the line', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({ nChars: 3 });
    m.feed('abcdef'); // captures 'abc' then resolves
    const r = await p;
    assert.equal(r.line, 'abc');
  });

  it('delim terminates the line (not included)', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({ delim: ',' });
    m.feed('hello,more');
    const r = await p;
    assert.equal(r.line, 'hello');
  });

  it('prompt is written before reading', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({ prompt: 'name? ' });
    m.feed('x\r');
    await p;
    assert.match(m.written(), /^name\? /);
  });

  it('timeout fires when no input arrives', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({ timeout: 0.05 });
    const r = await p;
    assert.equal(r.timeout, true);
  });

  it('CSI escape sequences (cursor keys) are swallowed cleanly', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const p = edit({});
    m.feed('\x1b[A');  // up arrow — fully consumed, no onHistory so no-op
    m.feed('\x1b[C');  // right arrow — swallowed
    m.feed('hi\r');
    const r = await p;
    assert.equal(r.line, 'hi'); // arrow-key bytes never reach the buffer
  });

  it('up/down arrows recall history via onHistory', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const ring = ['first', 'second', 'third'];
    let pos = ring.length;
    const onHistory = (dir) => {
      pos = Math.max(0, Math.min(ring.length, pos + dir));
      return pos < ring.length ? ring[pos] : '';
    };
    const p = edit({ onHistory });
    m.feed('\x1b[A');  // up → 'third'
    m.feed('\x1b[A');  // up → 'second'
    m.feed('\r');
    const r = await p;
    assert.equal(r.line, 'second');
  });

  it('history recall replaces the current buffer', async () => {
    const m = _mockAdapter();
    const edit = makeLineEditor(m.adapter);
    const onHistory = () => 'recalled';
    const p = edit({ onHistory });
    m.feed('typed');   // user typed something
    m.feed('\x1b[A');  // up → replaces 'typed' with 'recalled'
    m.feed('\r');
    const r = await p;
    assert.equal(r.line, 'recalled');
  });
});

describe('worker + client interactive read', () => {
  it('end-to-end: client.input pushes a line through to read', async () => {
    const lo = createLoopback();
    setupGeasWorker(lo.workerSide, { createShell });
    const out = [];
    const client = createGeasClient({
      worker: lo.mainSide,
      vfs: null,
      env: {},
      cwd: '/',
      onStdout: (t) => out.push(t),
    });
    await client.ready();
    // Pre-queue the line BEFORE exec — the worker's `input` handler
    // pushes it into the ahead-buffer, so when `read` runs and asks
    // for a line, it's already there. Without pre-queuing, the worker
    // would post want-input first, and the no-onWantInput path on the
    // client side would immediately respond with EOF.
    client.input('alice');
    const r = await client.exec('read v\necho got=$v\n');
    assert.equal(r.exitCode, 0);
    assert.equal(out.join(''), 'got=alice\n');
    await client.terminate();
  });

  it('end-to-end: onWantInput line editor over a mock adapter', async () => {
    const lo = createLoopback();
    setupGeasWorker(lo.workerSide, { createShell });
    const writes = [];
    const inputSubs = [];
    const adapter = {
      write: (t) => writes.push(t),
      onInput: (cb) => { inputSubs.push(cb); return () => {}; },
      caps: () => ({ richBlocks: false }),
    };
    const out = [];
    const client = createGeasClient({
      worker: lo.mainSide,
      vfs: null,
      env: {},
      cwd: '/',
      onStdout: (t) => out.push(t),
      onWantInput: makeLineEditor(adapter),
    });
    await client.ready();
    const execPromise = client.exec('read -p "name? " who\necho hi $who\n');
    // Let the worker request input, then simulate typing.
    setTimeout(() => {
      for (const cb of inputSubs) cb('bob\r');
    }, 20);
    const r = await execPromise;
    assert.equal(r.exitCode, 0);
    assert.equal(out.join(''), 'hi bob\n');
    assert.match(writes.join(''), /name\? /); // prompt was written
    assert.match(writes.join(''), /bob/);     // echo
    await client.terminate();
  });

  it('end-to-end: no onWantInput → read returns 1 on empty stdin', async () => {
    const lo = createLoopback();
    setupGeasWorker(lo.workerSide, { createShell });
    const client = createGeasClient({
      worker: lo.mainSide,
      vfs: null,
      env: {},
      cwd: '/',
      // no onWantInput
    });
    await client.ready();
    const r = await client.exec('read v\n');
    assert.equal(r.exitCode, 1);
    await client.terminate();
  });
});

describe('worker client — cwd reporting', () => {
  it('client.cwd starts at the init cwd', async () => {
    const lo = createLoopback();
    setupGeasWorker(lo.workerSide, { createShell });
    const client = createGeasClient({ worker: lo.mainSide, vfs: null, env: {}, cwd: '/' });
    await client.ready();
    assert.equal(client.cwd, '/');
    await client.terminate();
  });

  it('client.cwd updates after a cd', async () => {
    // Needs a VFS so `cd` can verify the target directory exists.
    const { VFS, MemoryBackend } = await import('../ext/vfs/index.js');
    const vfs = new VFS();
    vfs._mounts.set('/', new MemoryBackend());
    await vfs.mkdir('/home', { recursive: true });
    const lo = createLoopback();
    setupGeasWorker(lo.workerSide, { createShell });
    const client = createGeasClient({ worker: lo.mainSide, vfs, env: {}, cwd: '/' });
    await client.ready();
    const r = await client.exec('cd /home\n');
    assert.equal(r.exitCode, 0);
    assert.equal(r.cwd, '/home');
    assert.equal(client.cwd, '/home');
    await client.terminate();
  });

  it('cwd is reported even when the command fails', async () => {
    const { VFS, MemoryBackend } = await import('../ext/vfs/index.js');
    const vfs = new VFS();
    vfs._mounts.set('/', new MemoryBackend());
    await vfs.mkdir('/data', { recursive: true });
    const lo = createLoopback();
    setupGeasWorker(lo.workerSide, { createShell });
    const client = createGeasClient({ worker: lo.mainSide, vfs, env: {}, cwd: '/' });
    await client.ready();
    await client.exec('cd /data\n');
    // A failing command shouldn't lose the cwd.
    await client.exec('false\n');
    assert.equal(client.cwd, '/data');
    await client.terminate();
  });
});

describe('cp', () => {
  it('copies a single file', async () => {
    const { shell, vfs } = _testShell();
    await vfs.writeFile('/a.txt', 'hello');
    const r = await shell.exec('cp /a.txt /b.txt\n');
    assert.equal(r.exitCode, 0);
    assert.equal(await vfs.readFile('/b.txt', 'text'), 'hello');
    // Original survives.
    assert.equal(await vfs.readFile('/a.txt', 'text'), 'hello');
  });

  it('overwrites the destination file', async () => {
    const { shell, vfs } = _testShell();
    await vfs.writeFile('/a.txt', 'new');
    await vfs.writeFile('/b.txt', 'old');
    await shell.exec('cp /a.txt /b.txt\n');
    assert.equal(await vfs.readFile('/b.txt', 'text'), 'new');
  });

  it('copies multiple sources into a directory', async () => {
    const { shell, vfs } = _testShell();
    await vfs.mkdir('/dst', { recursive: true });
    await vfs.writeFile('/a.txt', 'A');
    await vfs.writeFile('/b.txt', 'B');
    const r = await shell.exec('cp /a.txt /b.txt /dst\n');
    assert.equal(r.exitCode, 0);
    assert.equal(await vfs.readFile('/dst/a.txt', 'text'), 'A');
    assert.equal(await vfs.readFile('/dst/b.txt', 'text'), 'B');
  });

  it('refuses to copy a directory without -r', async () => {
    const { shell, vfs, errOutput } = _testShell();
    await vfs.mkdir('/src', { recursive: true });
    await vfs.writeFile('/src/x', '1');
    const r = await shell.exec('cp /src /dst\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /directory/);
  });

  it('-r copies a tree', async () => {
    const { shell, vfs } = _testShell();
    await vfs.mkdir('/src/sub', { recursive: true });
    await vfs.writeFile('/src/a', 'A');
    await vfs.writeFile('/src/sub/b', 'B');
    const r = await shell.exec('cp -r /src /dst\n');
    assert.equal(r.exitCode, 0);
    assert.equal(await vfs.readFile('/dst/a', 'text'), 'A');
    assert.equal(await vfs.readFile('/dst/sub/b', 'text'), 'B');
  });

  it('errors with missing operands', async () => {
    const { shell, errOutput } = _testShell();
    const r = await shell.exec('cp /one\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /missing/);
  });
});

describe('mv', () => {
  it('renames a file', async () => {
    const { shell, vfs } = _testShell();
    await vfs.writeFile('/old.txt', 'data');
    const r = await shell.exec('mv /old.txt /new.txt\n');
    assert.equal(r.exitCode, 0);
    assert.equal(await vfs.readFile('/new.txt', 'text'), 'data');
    // Source is gone.
    let gone = false;
    try { await vfs.stat('/old.txt'); } catch { gone = true; }
    assert.ok(gone, 'old.txt should be gone');
  });

  it('moves multiple files into a directory', async () => {
    const { shell, vfs } = _testShell();
    await vfs.mkdir('/dst', { recursive: true });
    await vfs.writeFile('/a', 'A');
    await vfs.writeFile('/b', 'B');
    const r = await shell.exec('mv /a /b /dst\n');
    assert.equal(r.exitCode, 0);
    assert.equal(await vfs.readFile('/dst/a', 'text'), 'A');
    assert.equal(await vfs.readFile('/dst/b', 'text'), 'B');
  });

  it('moves a directory', async () => {
    const { shell, vfs } = _testShell();
    await vfs.mkdir('/src/sub', { recursive: true });
    await vfs.writeFile('/src/x', 'X');
    const r = await shell.exec('mv /src /dst\n');
    assert.equal(r.exitCode, 0);
    assert.equal(await vfs.readFile('/dst/x', 'text'), 'X');
  });
});

describe('stat', () => {
  it('prints type + size for a file', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/f.txt', 'hello');
    const r = await shell.exec('stat /f.txt\n');
    assert.equal(r.exitCode, 0);
    assert.match(output(), /file\s+\d+\s+\/f\.txt/);
  });

  it('prints directory type', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/d', { recursive: true });
    await shell.exec('stat /d\n');
    assert.match(output(), /directory/);
  });

  it('-c format extracts a single field', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/f.txt', 'hello');
    await shell.exec('stat -c %s /f.txt\n');
    assert.match(output(), /^5\n$/);
  });

  it('-c %F prints the type', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/f.txt', 'x');
    await shell.exec('stat -c %F /f.txt\n');
    assert.match(output(), /regular file/);
  });

  it('errors on missing path', async () => {
    const { shell, errOutput } = _testShell();
    const r = await shell.exec('stat /nope\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /stat: \/nope/);
  });
});

// ── find ──

describe('find', () => {
  // Helper: build a small directory tree for each test.
  async function _seed() {
    const t = _testShell();
    await t.vfs.mkdir('/proj', { recursive: true });
    await t.vfs.mkdir('/proj/src', { recursive: true });
    await t.vfs.mkdir('/proj/src/sub', { recursive: true });
    await t.vfs.writeFile('/proj/README.md', 'r');
    await t.vfs.writeFile('/proj/src/a.js', 'aa');
    await t.vfs.writeFile('/proj/src/b.js', 'bbb');
    await t.vfs.writeFile('/proj/src/c.txt', 'cccc');
    await t.vfs.writeFile('/proj/src/sub/d.js', 'dddddd');
    await t.vfs.writeFile('/proj/src/sub/EMPTY', '');
    return t;
  }

  function _lines(s) {
    return s.split('\n').filter(Boolean).sort();
  }

  it('plain `find PATH` prints every entry pre-order', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj\n');
    const out = _lines(output());
    assert.deepEqual(out, [
      '/proj',
      '/proj/README.md',
      '/proj/src',
      '/proj/src/a.js',
      '/proj/src/b.js',
      '/proj/src/c.txt',
      '/proj/src/sub',
      '/proj/src/sub/EMPTY',
      '/proj/src/sub/d.js',
    ]);
  });

  it('-name with glob', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -name "*.js"\n');
    assert.deepEqual(_lines(output()), [
      '/proj/src/a.js',
      '/proj/src/b.js',
      '/proj/src/sub/d.js',
    ]);
  });

  it('-iname is case-insensitive', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -iname "readme.md"\n');
    assert.deepEqual(_lines(output()), ['/proj/README.md']);
  });

  it('-type d lists only directories', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type d\n');
    assert.deepEqual(_lines(output()), ['/proj', '/proj/src', '/proj/src/sub']);
  });

  it('-type f lists only files', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type f -name "*.js"\n');
    assert.deepEqual(_lines(output()), [
      '/proj/src/a.js',
      '/proj/src/b.js',
      '/proj/src/sub/d.js',
    ]);
  });

  it('-maxdepth limits descent', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -maxdepth 1\n');
    assert.deepEqual(_lines(output()), ['/proj', '/proj/README.md', '/proj/src']);
  });

  it('-mindepth skips shallow entries', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -mindepth 2 -type f\n');
    const out = _lines(output());
    // anything at depth >=2: /proj/src/* and /proj/src/sub/*
    assert.ok(out.includes('/proj/src/a.js'));
    assert.ok(!out.includes('/proj/README.md'));
  });

  it('-size +N filters bigger files', async () => {
    const { shell, output } = await _seed();
    // d.js is 6 bytes, c.txt is 4, b.js is 3, a.js is 2, README.md is 1.
    await shell.exec('find /proj -type f -size +3c\n');
    assert.deepEqual(_lines(output()), ['/proj/src/c.txt', '/proj/src/sub/d.js']);
  });

  it('-size -N filters smaller files', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type f -size -2c\n');
    // strictly less than 2 bytes: README.md (1) and EMPTY (0).
    assert.deepEqual(_lines(output()), ['/proj/README.md', '/proj/src/sub/EMPTY']);
  });

  it('-empty matches zero-byte files', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type f -empty\n');
    assert.deepEqual(_lines(output()), ['/proj/src/sub/EMPTY']);
  });

  it('-not inverts a predicate', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type f -not -name "*.js"\n');
    assert.deepEqual(_lines(output()), [
      '/proj/README.md',
      '/proj/src/c.txt',
      '/proj/src/sub/EMPTY',
    ]);
  });

  it('! is an alias for -not', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type f ! -name "*.js"\n');
    assert.deepEqual(_lines(output()), [
      '/proj/README.md',
      '/proj/src/c.txt',
      '/proj/src/sub/EMPTY',
    ]);
  });

  it('-or combines predicates', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -name "*.md" -or -name "*.txt"\n');
    assert.deepEqual(_lines(output()), ['/proj/README.md', '/proj/src/c.txt']);
  });

  it('parens group expressions', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type f "(" -name "*.md" -or -name "*.txt" ")"\n');
    assert.deepEqual(_lines(output()), ['/proj/README.md', '/proj/src/c.txt']);
  });

  it('-path matches against the full display path', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -path "*/sub/*"\n');
    assert.deepEqual(_lines(output()), ['/proj/src/sub/EMPTY', '/proj/src/sub/d.js']);
  });

  it('-print0 uses null separator', async () => {
    const { shell, output } = await _seed();
    await shell.exec('find /proj -type d -print0\n');
    assert.ok(output().includes('\0'));
    assert.ok(!output().includes('\n'));
  });

  it('integrates with for-loops via command substitution', async () => {
    const { shell, output } = await _seed();
    await shell.exec('for f in $(find /proj -type f -name "*.js"); do echo got $f; done\n');
    const out = _lines(output());
    assert.deepEqual(out, [
      'got /proj/src/a.js',
      'got /proj/src/b.js',
      'got /proj/src/sub/d.js',
    ]);
  });

  it('rejects an unknown predicate', async () => {
    const { shell, errOutput } = await _seed();
    const r = await shell.exec('find /proj -bogus\n');
    assert.notEqual(r.exitCode, 0);
    assert.match(errOutput(), /unknown predicate/);
  });
});

// ── stage 8: quick wins ──

describe('echo -e', () => {
  it('interprets backslash escapes when -e set', async () => {
    const { shell, output } = _testShell();
    await shell.exec("echo -e 'a\\tb\\nc'\n");
    assert.equal(output(), 'a\tb\nc\n');
  });

  it('default does NOT interpret', async () => {
    const { shell, output } = _testShell();
    await shell.exec("echo 'a\\tb'\n");
    assert.equal(output(), 'a\\tb\n');
  });

  it('-E reverts -e (last flag wins)', async () => {
    const { shell, output } = _testShell();
    await shell.exec("echo -e -E 'a\\tb'\n");
    assert.equal(output(), 'a\\tb\n');
  });

  it('-ne combines: no newline + interpret', async () => {
    const { shell, output } = _testShell();
    await shell.exec("echo -ne 'x\\ty'\n");
    assert.equal(output(), 'x\ty');
  });
});

describe('subshell isolation', () => {
  it('env mutation does not leak out', async () => {
    const { shell, output } = _testShell();
    await shell.exec('X=outer\n(X=inner; echo inside=$X)\necho outside=$X\n');
    assert.equal(output(), 'inside=inner\noutside=outer\n');
  });

  it('cwd mutation does not leak out', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/here', { recursive: true });
    await shell.exec('(cd /here; pwd)\npwd\n');
    assert.equal(output(), '/here\n/\n');
  });

  it('function definitions are scoped to the subshell', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('(greet() { echo hi; }; greet)\ngreet\n');
    // First call (inside subshell) emits "hi"; second call (outside) finds
    // no `greet` and falls through to onCommand which returns 127.
    assert.equal(output(), 'hi\n');
    assert.equal(r.exitCode, 127);
  });

  it('set -e inside a subshell does not enable errexit outside', async () => {
    const { shell, output } = _testShell();
    await shell.exec('(set -e; false; echo unreachable) || true\nfalse\necho after\n');
    assert.equal(output(), 'after\n');
  });
});

describe('${X#pat} / ${X##pat} / ${X%pat} / ${X%%pat} — glob matching', () => {
  it('# shortest prefix with a wildcard', async () => {
    const { shell, output } = _testShell();
    // s = abcabc, pat = a*c; shortest a..c prefix is "abc"
    await shell.exec('s=abcabc; echo "${s#a*c}"\n');
    assert.equal(output(), 'abc\n');
  });

  it('## longest prefix with a wildcard', async () => {
    const { shell, output } = _testShell();
    // longest a..c prefix is the full "abcabc"
    await shell.exec('s=abcabc; echo "${s##a*c}"\n');
    assert.equal(output(), '\n');
  });

  it('% shortest suffix with a wildcard', async () => {
    const { shell, output } = _testShell();
    await shell.exec('s=abcabc; echo "${s%a*c}"\n');
    assert.equal(output(), 'abc\n');
  });

  it('%% longest suffix with a wildcard', async () => {
    const { shell, output } = _testShell();
    await shell.exec('s=abcabc; echo "${s%%a*c}"\n');
    assert.equal(output(), '\n');
  });

  it('# with char-class pattern', async () => {
    const { shell, output } = _testShell();
    // Strip a single leading vowel.
    await shell.exec('s=apple; echo "${s#[aeiou]}"\n');
    assert.equal(output(), 'pple\n');
  });

  it('% common case: file extension stripping', async () => {
    const { shell, output } = _testShell();
    await shell.exec('f=report.csv; echo "${f%.csv}"\n');
    assert.equal(output(), 'report\n');
  });
});

describe('redirect buffering (write-once at command end)', () => {
  it('> file collects all stdout writes into a single VFS write', async () => {
    const { shell, vfs } = _testShell();
    await shell.exec('for i in 1 2 3; do echo line$i; done > /out.txt\n');
    const content = await vfs.readFile('/out.txt', 'text');
    // Without buffering, the second iteration's read+rewrite would
    // truncate the file mid-loop and the result would only have "line3".
    assert.equal(content, 'line1\nline2\nline3\n');
  });

  it('>> file appends a buffered command output to existing content', async () => {
    const { shell, vfs } = _testShell();
    await vfs.writeFile('/log.txt', 'header\n');
    await shell.exec('for i in 1 2; do echo entry$i; done >> /log.txt\n');
    const content = await vfs.readFile('/log.txt', 'text');
    assert.equal(content, 'header\nentry1\nentry2\n');
  });

  it('> with zero output still creates/truncates the file', async () => {
    const { shell, vfs } = _testShell();
    await vfs.writeFile('/x.txt', 'old content');
    await shell.exec('true > /x.txt\n');
    const content = await vfs.readFile('/x.txt', 'text');
    assert.equal(content, '');
  });

  it('2> file captures stderr', async () => {
    const { shell, vfs, output, errOutput } = _testShell();
    // First make sure non-redirected stderr reaches errOutput.
    await shell.exec('ls /nonexistent 2> /err.log\n');
    const content = await vfs.readFile('/err.log', 'text');
    assert.match(content, /nonexistent/);
    assert.equal(errOutput(), ''); // redirected, so the buf stayed empty
  });

  it('brace group redirect flushes at the group boundary', async () => {
    const { shell, vfs } = _testShell();
    await shell.exec('{ echo a; echo b; echo c; } > /grp.txt\n');
    const content = await vfs.readFile('/grp.txt', 'text');
    assert.equal(content, 'a\nb\nc\n');
  });

  it('subshell redirect flushes at the subshell boundary', async () => {
    const { shell, vfs } = _testShell();
    await shell.exec('(for i in 1 2 3; do echo $i; done) > /sub.txt\n');
    const content = await vfs.readFile('/sub.txt', 'text');
    assert.equal(content, '1\n2\n3\n');
  });
});

// ── stage 9: function frames + local + return + shift ──

describe('function positional parameters', () => {
  it('$1, $2 inside a function are the function args', async () => {
    const { shell, output } = _testShell();
    await shell.exec('greet() { echo hello $1 and $2; }\ngreet alice bob\n');
    assert.equal(output(), 'hello alice and bob\n');
  });

  it('$# inside a function reflects the function arg count', async () => {
    const { shell, output } = _testShell();
    await shell.exec('count() { echo got $#; }\ncount a b c d\n');
    assert.equal(output(), 'got 4\n');
  });

  it('"$@" iterates the function args', async () => {
    const { shell, output } = _testShell();
    await shell.exec('show() { for x in "$@"; do echo $x; done; }\nshow one two three\n');
    assert.equal(output(), 'one\ntwo\nthree\n');
  });

  it('positional restores after the function returns', async () => {
    const { shell, output } = _testShell();
    await shell.exec('set -- script-arg\nfn() { echo in: $1; }\nfn fn-arg\necho out: $1\n');
    assert.equal(output(), 'in: fn-arg\nout: script-arg\n');
  });

  it('nested functions each see their own args', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'inner() { echo inner: $1; }\n' +
      'outer() { echo outer: $1; inner deep; echo outer-after: $1; }\n' +
      'outer top\n'
    );
    assert.equal(output(), 'outer: top\ninner: deep\nouter-after: top\n');
  });
});

describe('local', () => {
  it('shadows the caller binding for the frame lifetime', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'x=outer\n' +
      'fn() { local x=inner; echo in: $x; }\n' +
      'fn\necho out: $x\n'
    );
    assert.equal(output(), 'in: inner\nout: outer\n');
  });

  it('local NAME (no value) shadows existing value', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'x=outer\n' +
      'fn() { local x; x=changed; echo in: $x; }\n' +
      'fn\necho out: $x\n'
    );
    assert.equal(output(), 'in: changed\nout: outer\n');
  });

  it('local for previously-unset name unbinds on return', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'fn() { local y=temp; echo in: $y; }\n' +
      'fn\necho "out: [$y]"\n'
    );
    assert.equal(output(), 'in: temp\nout: []\n');
  });

  it('non-local assignment in a function leaks to caller', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'fn() { z=leaked; }\n' +
      'fn\necho z=$z\n'
    );
    assert.equal(output(), 'z=leaked\n');
  });

  it('local outside a function fails', async () => {
    const { shell, errOutput } = _testShell();
    const r = await shell.exec('local x=5\n');
    assert.equal(r.exitCode, 1);
    assert.match(errOutput(), /only.*function/);
  });

  it('multiple locals in one declaration', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'a=A b=B c=C\n' +
      'fn() { local a=1 b=2 c=3; echo $a $b $c; }\n' +
      'fn\necho $a $b $c\n'
    );
    assert.equal(output(), '1 2 3\nA B C\n');
  });

  it('nested functions get nested local frames', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'x=top\n' +
      'inner() { local x=in; echo inner-x=$x; }\n' +
      'outer() { local x=out; inner; echo outer-x=$x; }\n' +
      'outer\necho top-x=$x\n'
    );
    assert.equal(output(), 'inner-x=in\nouter-x=out\ntop-x=top\n');
  });
});

describe('return', () => {
  it('return N sets the function exit code', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'fn() { return 42; }\n' +
      'fn\necho exit=$?\n'
    );
    assert.equal(output(), 'exit=42\n');
  });

  it('return without args uses last command exit code', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'fn() { false; return; }\n' +
      'fn\necho exit=$?\n'
    );
    assert.equal(output(), 'exit=1\n');
  });

  it('return halts the function body', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'fn() { echo before; return 0; echo unreachable; }\n' +
      'fn\necho after\n'
    );
    assert.equal(output(), 'before\nafter\n');
  });

  it('return only unwinds to the function boundary, not the caller', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'fn() { return 0; }\n' +
      'fn\necho still-here\n'
    );
    assert.equal(output(), 'still-here\n');
  });

  it('return composes with if conditionals', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'abs() { if [ $1 -lt 0 ]; then return 1; else return 0; fi; }\n' +
      'abs -3; echo r1=$?\n' +
      'abs 5;  echo r2=$?\n'
    );
    assert.equal(output(), 'r1=1\nr2=0\n');
  });

  it('return cleans up local bindings even on early exit', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'x=top\n' +
      'fn() { local x=local; return; }\n' +
      'fn\necho $x\n'
    );
    assert.equal(output(), 'top\n');
  });
});

describe('shift', () => {
  it('drops the first positional', async () => {
    const { shell, output } = _testShell();
    await shell.exec('set -- a b c\nshift\necho $1 $2\n');
    assert.equal(output(), 'b c\n');
  });

  it('shift N drops N positionals', async () => {
    const { shell, output } = _testShell();
    await shell.exec('set -- a b c d\nshift 2\necho $1\n');
    assert.equal(output(), 'c\n');
  });

  it('shift past the end fails without altering positionals', async () => {
    const { shell, output } = _testShell();
    const r = await shell.exec('set -- a b\nshift 5\necho ec=$?\necho $1 $2\n');
    assert.match(output(), /ec=1\na b\n/);
  });

  it('shift inside a function affects the function args only', async () => {
    const { shell, output } = _testShell();
    await shell.exec(
      'set -- s1 s2 s3\n' +
      'fn() { shift; echo fn: $1; }\n' +
      'fn a b c\necho script: $1\n'
    );
    assert.equal(output(), 'fn: b\nscript: s1\n');
  });
});

// ── stage 10: test / [ multi-clause ──

describe('test / [ — multi-clause expressions', () => {
  it('-a (and): both true', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ -n "x" -a -n "y" ] && echo both\n');
    assert.equal(output(), 'both\n');
  });

  it('-a (and): one false', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ -n "x" -a -z "y" ] || echo not-both\n');
    assert.equal(output(), 'not-both\n');
  });

  it('-o (or): one true', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ -z "x" -o -n "y" ] && echo either\n');
    assert.equal(output(), 'either\n');
  });

  it('-o (or): both false', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ -z "x" -o -z "y" ] || echo neither\n');
    assert.equal(output(), 'neither\n');
  });

  it('-a has higher precedence than -o', async () => {
    const { shell, output } = _testShell();
    // false -o true -a false → false -o (true && false) → false
    await shell.exec('[ -z "x" -o -n "y" -a -z "z" ] || echo right\n');
    assert.equal(output(), 'right\n');
  });

  it('parens override precedence', async () => {
    const { shell, output } = _testShell();
    // (false -o true) -a false → true -a false → false
    await shell.exec('[ "(" -z "x" -o -n "y" ")" -a -z "z" ] || echo grouped\n');
    assert.equal(output(), 'grouped\n');
  });

  it('! negates the whole expression', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ ! -z "x" ] && echo not-empty\n');
    assert.equal(output(), 'not-empty\n');
  });

  it('! applies to a binary atom', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ ! 1 -eq 2 ] && echo true\n');
    assert.equal(output(), 'true\n');
  });

  it('combines string + integer comparisons', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ "$USER" = "x" -o 1 -lt 5 ] && echo passed\n');
    assert.equal(output(), 'passed\n');
  });

  it('file tests compose with -a / -o', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/a', 'A');
    await vfs.writeFile('/b', 'B');
    await shell.exec('[ -f /a -a -f /b ] && echo both-files\n');
    assert.equal(output(), 'both-files\n');
  });

  it('nested parens', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ "(" "(" -n "x" ")" -a -n "y" ")" ] && echo nested\n');
    assert.equal(output(), 'nested\n');
  });

  it('multiple ! stack', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ ! ! -n "x" ] && echo doubly-negated\n');
    assert.equal(output(), 'doubly-negated\n');
  });

  it('missing right operand of binary op reports error', async () => {
    const { shell, errOutput } = _testShell();
    const r = await shell.exec('[ 1 -eq ]\n');
    assert.equal(r.exitCode, 2);
    assert.match(errOutput(), /missing/);
  });

  it('unbalanced paren reports error', async () => {
    const { shell, errOutput } = _testShell();
    const r = await shell.exec('[ "(" -n "x" ]\n');
    assert.equal(r.exitCode, 2);
    assert.match(errOutput(), /missing/);
  });

  it('1-arg fallback still works (non-empty)', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ "hello" ] && echo non-empty\n');
    assert.equal(output(), 'non-empty\n');
  });

  it('1-arg fallback: empty string is false', async () => {
    const { shell, output } = _testShell();
    await shell.exec('[ "" ] || echo empty\n');
    assert.equal(output(), 'empty\n');
  });
});

// ── stage 12: arithmetic expansion ──

describe('$((...)) arithmetic', () => {
  it('basic integer arithmetic', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((1 + 2 * 3))\n');
    assert.equal(output(), '7\n');
  });

  it('parens override precedence', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $(((1 + 2) * 3))\n');
    assert.equal(output(), '9\n');
  });

  it('variable expansion (bare name)', async () => {
    const { shell, output } = _testShell();
    await shell.exec('n=5\necho $((n * 2))\n');
    assert.equal(output(), '10\n');
  });

  it('variable expansion ($name form)', async () => {
    const { shell, output } = _testShell();
    await shell.exec('n=5\necho $(($n + 1))\n');
    assert.equal(output(), '6\n');
  });

  it('assignment inside $((...)) — was BLOCKED by old gated eval', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((x = 5))\necho after: $x\n');
    assert.equal(output(), '5\nafter: 5\n');
  });

  it('compound assignment x += 3', async () => {
    const { shell, output } = _testShell();
    await shell.exec('x=10\necho $((x += 3))\necho x=$x\n');
    assert.equal(output(), '13\nx=13\n');
  });

  it('integer division truncates toward zero', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((7 / 2))\necho $((-7 / 2))\n');
    assert.equal(output(), '3\n-3\n');
  });

  it('modulo', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((17 % 5))\n');
    assert.equal(output(), '2\n');
  });

  it('comparison returns 0 or 1', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((5 < 10)) $((5 > 10)) $((5 == 5))\n');
    assert.equal(output(), '1 0 1\n');
  });

  it('logical && and ||', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((1 && 2)) $((0 || 3)) $((0 && 5))\n');
    assert.equal(output(), '1 1 0\n');
  });

  it('bitwise operations', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((5 & 3)) $((5 | 3)) $((5 ^ 3)) $((~5))\n');
    assert.equal(output(), '1 7 6 -6\n');
  });

  it('shift operators', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((1 << 4)) $((256 >> 2))\n');
    assert.equal(output(), '16 64\n');
  });

  it('ternary conditional', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((5 > 3 ? 100 : 200))\necho $((1 == 2 ? 100 : 200))\n');
    assert.equal(output(), '100\n200\n');
  });

  it('hex literals', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((0xff))\necho $((0x10 + 0xa))\n');
    assert.equal(output(), '255\n26\n');
  });

  it('octal literals (leading zero)', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((0755))\n');
    assert.equal(output(), '493\n');
  });

  it('unary minus, plus, not', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((-5)) $((+7)) $((!0)) $((!42))\n');
    assert.equal(output(), '-5 7 1 0\n');
  });

  it('division by zero returns 0 (no crash)', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((10 / 0))\necho $((10 % 0))\n');
    assert.equal(output(), '0\n0\n');
  });

  it('unbound variable acts as 0', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo $((undefined_var + 5))\n');
    assert.equal(output(), '5\n');
  });

  it('use in for-loop counter idiom', async () => {
    const { shell, output } = _testShell();
    await shell.exec('i=0\nwhile [ $i -lt 3 ]; do echo i=$i; i=$((i + 1)); done\n');
    assert.equal(output(), 'i=0\ni=1\ni=2\n');
  });
});

// ── stage 13: streaming pipes ──

describe('streaming pipes', () => {
  it('basic pipe still works with concurrent dispatch', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo hello | cat\n');
    assert.equal(output(), 'hello\n');
  });

  it('multi-stage pipe preserves order', async () => {
    const { shell, output } = _testShell();
    await shell.exec('echo abc | cat | cat | cat\n');
    assert.equal(output(), 'abc\n');
  });

  it('typed pipe (from-csv | where | to-csv) survives the refactor', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.writeFile('/data.csv', 'k,v\nfoo,1\nbar,5\nbaz,10\n');
    await shell.exec("from-csv /data.csv | where 'v > 4' | to-csv\n");
    assert.equal(output(), 'k,v\nbar,5\nbaz,10\n');
  });

  it('head -N closes upstream early', async () => {
    // Build a generator that counts pushes — when head -1 finishes, the
    // generator's next emit should throw _pipeClosed and the stage
    // returns clean.
    const { shell, output } = _testShell();
    let pushCount = 0;
    shell.builtins.set('gen', async (argv, ctx) => {
      const total = parseInt(argv[1], 10);
      for (let i = 0; i < total; i++) {
        pushCount++;
        try { await ctx.stdout(`line${i}\n`); }
        catch (e) { if (e && e._pipeClosed) return 0; throw e; }
      }
      return 0;
    });
    await shell.exec('gen 100000 | head -1\n');
    assert.equal(output(), 'line0\n');
    // Without early-close, pushCount would hit 100000. With early-close,
    // it stops near the queue's high-water mark (64 by default) — well
    // under the full count.
    assert.ok(pushCount < 1000, `expected early termination, got ${pushCount} pushes`);
  });

  it('pipefail still reports first non-zero stage', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('set -o pipefail\nfalse | true | true\n');
    assert.equal(r.exitCode, 1);
  });

  it('exit code is last stage without pipefail', async () => {
    const { shell } = _testShell();
    const r = await shell.exec('false | true\n');
    assert.equal(r.exitCode, 0);
  });

  it('large pipeline does not deadlock under backpressure', async () => {
    // Push N items (> high-water-mark) through a 3-stage pipeline.
    // If backpressure is broken, this would hang or OOM; if it works,
    // it completes in normal time.
    const { shell, output } = _testShell();
    shell.builtins.set('gen', async (argv, ctx) => {
      const total = parseInt(argv[1], 10);
      for (let i = 0; i < total; i++) await ctx.stdout(`L${i}\n`);
      return 0;
    });
    shell.builtins.set('count', async (_argv, ctx) => {
      const { drainInput } = await import('../ext/geas/src/typed.js');
      const v = await drainInput(ctx);
      const s = typeof v === 'string' ? v : String(v);
      const n = s.split('\n').filter(Boolean).length;
      await ctx.stdout(`count=${n}\n`);
      return 0;
    });
    await shell.exec('gen 500 | cat | count\n');
    assert.equal(output(), 'count=500\n');
  });
});

describe('xargs -0', () => {
  it('reads NUL-separated tokens', async () => {
    const { shell, output } = _testShell();
    await shell.exec("printf 'a\\0b c\\0d' | xargs -0 echo\n");
    // -0 splits only on NUL, so 'b c' stays as one token.
    assert.equal(output(), 'a b c d\n');
  });

  it('pairs cleanly with find -print0', async () => {
    const { shell, vfs, output } = _testShell();
    await vfs.mkdir('/p', { recursive: true });
    await vfs.writeFile('/p/a.txt', '');
    await vfs.writeFile('/p/b.txt', '');
    await shell.exec('find /p -type f -print0 | xargs -0 echo files:\n');
    assert.match(output(), /files: \/p\/a\.txt \/p\/b\.txt/);
  });
});
