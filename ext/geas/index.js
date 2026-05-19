// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/geas/src/  Build: node ext/geas/build.js
// @gcu/geas — the GCU shell. POSIX-syntax with typed-pipe extensions.

// -- ast-nodes.js --

// AST node type tags + factory helpers.
//
// Nodes are plain object literals with a `type` discriminator string from
// the NODE table below. Factories exist purely to centralise the shapes
// (so a typo in a producer like `{ type: 'Pipline' }` is harder to make);
// they're optional — consumers should pattern-match on the type field.

const NODE = Object.freeze({
  PROGRAM:        'Program',
  LIST:           'List',
  AND_OR:         'AndOr',
  PIPELINE:       'Pipeline',
  SIMPLE_COMMAND: 'SimpleCommand',
  BRACE_GROUP:    'BraceGroup',
  SUBSHELL:       'Subshell',
  IF_CLAUSE:      'IfClause',
  FOR_CLAUSE:     'ForClause',
  WHILE_CLAUSE:   'WhileClause',
  UNTIL_CLAUSE:   'UntilClause',
  CASE_CLAUSE:    'CaseClause',
  CASE_ITEM:      'CaseItem',
  FUNCTION_DEF:   'FunctionDef',
  ASSIGNMENT:     'Assignment',
  REDIRECT:       'Redirect',
  WORD:           'Word',
});

// `body` is a List node; List wraps multiple commands separated by ';' / '&' / NEWLINE.
// `commands` on Pipeline is the segments left-to-right (data flows L→R).
// `negated` on Pipeline reflects a leading `!` (POSIX: invert the pipeline's exit status).
// Redirect.fd is null when no explicit file descriptor was given (defaults inferred at exec time).

function mkProgram(commands, pos) {
  return { type: NODE.PROGRAM, commands, pos };
}

function mkList(items, pos) {
  // items: Array<{ op: ';' | '&' | null, cmd: AndOr | Pipeline | Command }>
  // The last item's `op` is null when the input didn't end with a terminator.
  return { type: NODE.LIST, items, pos };
}

function mkAndOr(left, op, right, pos) {
  // op: '&&' | '||'
  return { type: NODE.AND_OR, left, op, right, pos };
}

function mkPipeline(commands, negated, pos) {
  return { type: NODE.PIPELINE, commands, negated, pos };
}

function mkSimpleCommand(assignments, words, redirects, pos) {
  return { type: NODE.SIMPLE_COMMAND, assignments, words, redirects, pos };
}

function mkBraceGroup(body, redirects, pos) {
  return { type: NODE.BRACE_GROUP, body, redirects, pos };
}

function mkSubshell(body, redirects, pos) {
  return { type: NODE.SUBSHELL, body, redirects, pos };
}

function mkIfClause(cond, then_, elifs, else_, redirects, pos) {
  // elifs: [{ cond: List, then: List }]
  return { type: NODE.IF_CLAUSE, cond, then: then_, elifs, else: else_, redirects, pos };
}

function mkForClause(name, words, body, redirects, pos) {
  // words: Array<Word> | null  — null means `for x do …` (iterates "$@")
  return { type: NODE.FOR_CLAUSE, name, words, body, redirects, pos };
}

function mkWhileClause(cond, body, redirects, pos) {
  return { type: NODE.WHILE_CLAUSE, cond, body, redirects, pos };
}

function mkUntilClause(cond, body, redirects, pos) {
  return { type: NODE.UNTIL_CLAUSE, cond, body, redirects, pos };
}

function mkCaseClause(word, items, redirects, pos) {
  return { type: NODE.CASE_CLAUSE, word, items, redirects, pos };
}

function mkCaseItem(patterns, body, pos) {
  // body may be null (an empty case branch: `pat) ;;`)
  return { type: NODE.CASE_ITEM, patterns, body, pos };
}

function mkFunctionDef(name, body, pos) {
  return { type: NODE.FUNCTION_DEF, name, body, pos };
}

function mkAssignment(name, value, pos) {
  // value is a Word; for bare `name=` the word is an empty literal.
  return { type: NODE.ASSIGNMENT, name, value, pos };
}

function mkRedirect(fd, op, target, pos) {
  // op: one of '<' '>' '>>' '<&' '>&' '<>' '>|' '<<' '<<-'
  return { type: NODE.REDIRECT, fd, op, target, pos };
}

function mkWord(value, pos) {
  // Opaque string value for v0. The lexer preserves quoting so the executor
  // can later decide expansion semantics; the parser doesn't introspect.
  return { type: NODE.WORD, value, pos };
}

// -- lexer.js --

// POSIX-shape shell lexer for geas.
//
// Produces a flat token stream of {type, value, pos} records. Words preserve
// their quoting and expansion syntax verbatim — the executor decides how to
// unquote / expand them at run time. The parser treats words as opaque
// strings; word-internal $-expansions, ${...}, $(...), `...`, '...', "..."
// are NOT split out here, which keeps the lexer small (~300 LOC) and lets
// the executor own the expansion semantics.
//
// Token types:
//   WORD       — anything that isn't an operator (preserves quoting verbatim)
//   OPERATOR   — single- or multi-char shell operator (see OPERATORS table)
//   IO_NUMBER  — digit run immediately followed by < or > (no space between)
//   NEWLINE    — \n line terminator (token-significant in shell grammar)
//   EOF        — end-of-input sentinel emitted once at the end
//
// Line continuation (backslash-newline) between tokens is silently consumed.
// Comments (# to end of line) are stripped before token emission.
//
// Not yet implemented (TODOs):
//   - Here-doc body capture. The `<<WORD` / `<<-WORD` operator is tokenized,
//     but the body lines aren't extracted from the input stream — that requires
//     lookahead past the next newline and coupling with the parser. Will land
//     when the executor needs here-docs.
//   - Aliases. POSIX has alias expansion as a lexer-time transform; geas can
//     defer until aliases are a real feature.

// Multi-char operators MUST come before any single-char prefix to ensure
// longest-match wins (e.g. `<<-` before `<<` before `<`).
const OPERATORS = [
  '<<-', '&&', '||', ';;', ';&', '|&',
  '<<', '>>', '<&', '>&', '<>', '>|',
  '<', '>', '|', '&', ';', '(', ')',
];

// Characters that end an unquoted word.
const WORD_BOUNDARY = new Set([' ', '\t', '\n', '|', '&', ';', '<', '>', '(', ')']);

function tokenize(input) {
  const tokens = [];
  const src = String(input ?? '');
  let pos = 0;

  while (pos < src.length) {
    // Skip horizontal whitespace and line continuations.
    pos = _skipWS(src, pos);
    if (pos >= src.length) break;

    const ch = src[pos];

    // Comments: # to end of line. Newline itself stays in the stream.
    if (ch === '#') {
      while (pos < src.length && src[pos] !== '\n') pos++;
      continue;
    }

    if (ch === '\n') {
      tokens.push({ type: 'NEWLINE', value: '\n', pos: { start: pos, end: pos + 1 } });
      pos++;
      continue;
    }

    // Operator (longest-match against OPERATORS table).
    const opLen = _matchOperator(src, pos);
    if (opLen > 0) {
      tokens.push({
        type: 'OPERATOR',
        value: src.slice(pos, pos + opLen),
        pos: { start: pos, end: pos + opLen },
      });
      pos += opLen;
      continue;
    }

    // IO_NUMBER: a digit run that is *immediately* followed by < or >.
    // POSIX: this is what distinguishes `2>foo` (redirect stderr) from
    // `2 >foo` (word "2" then redirect stdout).
    if (ch >= '0' && ch <= '9') {
      const digits = _matchIONumber(src, pos);
      if (digits !== null) {
        tokens.push({
          type: 'IO_NUMBER',
          value: digits,
          pos: { start: pos, end: pos + digits.length },
        });
        pos += digits.length;
        continue;
      }
    }

    // Otherwise: a word. Read until the next unquoted boundary.
    const start = pos;
    const end = _readWord(src, pos);
    tokens.push({
      type: 'WORD',
      value: src.slice(start, end),
      pos: { start, end },
    });
    pos = end;
  }

  tokens.push({ type: 'EOF', value: '', pos: { start: pos, end: pos } });
  return tokens;
}

// ── helpers ──

function _skipWS(src, pos) {
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === ' ' || ch === '\t') {
      pos++;
    } else if (ch === '\\' && src[pos + 1] === '\n') {
      // Line continuation: backslash + newline → silently consumed between tokens.
      pos += 2;
    } else {
      break;
    }
  }
  return pos;
}

function _matchOperator(src, pos) {
  for (const op of OPERATORS) {
    if (src.startsWith(op, pos)) return op.length;
  }
  return 0;
}

function _matchIONumber(src, pos) {
  let i = pos;
  while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
  if (i === pos) return null;
  if (src[i] === '<' || src[i] === '>') return src.slice(pos, i);
  return null;
}

function _readWord(src, start) {
  let i = start;
  while (i < src.length) {
    const ch = src[i];

    // Single-quoted: literal, no interpretation, up to the next single quote.
    if (ch === "'") {
      i = _scanSingleQuote(src, i);
      continue;
    }
    // Double-quoted: allow $-expansions, `-substitution, and \-escape (of
    // limited chars per POSIX, but we don't enforce here — preserved verbatim).
    if (ch === '"') {
      i = _scanDoubleQuote(src, i);
      continue;
    }
    // Backslash-escape: preserve the backslash + the next char as part of the word.
    if (ch === '\\') {
      if (src[i + 1] === '\n') {
        // Line continuation INSIDE a word: per POSIX, the backslash+newline
        // pair is discarded. We collapse by advancing past both without
        // including them in the slice — but since _readWord returns an end
        // index for `src.slice(start, end)`, we can't easily skip mid-string.
        // For now: preserve verbatim; the executor handles unescaping. This
        // is a rare construct and the executor sees the right thing anyway
        // (literal backslash-newline disappears during expansion).
        i += 2;
      } else if (i + 1 < src.length) {
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // $(...) command substitution: balance parens.
    if (ch === '$' && src[i + 1] === '(') {
      // Could also be $((arith)) — same paren balancing handles it.
      i = _scanBalanced(src, i + 1, '(', ')') + 1;
      continue;
    }
    // ${...} parameter expansion: balance braces.
    if (ch === '$' && src[i + 1] === '{') {
      i = _scanBalanced(src, i + 1, '{', '}') + 1;
      continue;
    }
    // $name parameter expansion (identifier name).
    if (ch === '$' && src[i + 1] && /[a-zA-Z_]/.test(src[i + 1])) {
      i += 2;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
      continue;
    }
    // $@, $*, $#, $?, $$, $!, $0..$9, $- — single-char special parameters.
    if (ch === '$' && src[i + 1] && '@*#?$!-0123456789'.includes(src[i + 1])) {
      i += 2;
      continue;
    }
    // Backtick command substitution.
    if (ch === '`') {
      i = _scanBacktick(src, i);
      continue;
    }
    // Unquoted boundary char terminates the word.
    if (WORD_BOUNDARY.has(ch)) break;
    i++;
  }
  return i;
}

// Returns the index just past the closing single quote (or end of input if
// unterminated — we don't throw; the executor will see an unterminated word).
function _scanSingleQuote(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== "'") i++;
  return i < src.length ? i + 1 : i;
}

function _scanDoubleQuote(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== '"') {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      i += 2;
    } else if (ch === '$' && src[i + 1] === '(') {
      i = _scanBalanced(src, i + 1, '(', ')') + 1;
    } else if (ch === '$' && src[i + 1] === '{') {
      i = _scanBalanced(src, i + 1, '{', '}') + 1;
    } else if (ch === '`') {
      i = _scanBacktick(src, i);
    } else {
      i++;
    }
  }
  return i < src.length ? i + 1 : i;
}

// `openIdx` points at the opening bracket. Returns the index OF the matching
// closer (caller advances past it). Handles nested quoting and escapes so
// `$(echo ")")` doesn't terminate at the inner `)`.
function _scanBalanced(src, openIdx, openCh, closeCh) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "'") {
      i = _scanSingleQuote(src, i);
      continue;
    }
    if (ch === '"') {
      i = _scanDoubleQuote(src, i);
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      i = _scanBacktick(src, i);
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return i; // unterminated → caller treats as end of input
}

function _scanBacktick(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\' && i + 1 < src.length) i += 2;
    else i++;
  }
  return i < src.length ? i + 1 : i;
}

// -- parser.js --

// Recursive-descent parser for the POSIX-shape geas grammar.
//
// Consumes the token stream from `lexer.tokenize()` and produces a tree of
// AST nodes from `ast-nodes.js`. The grammar is a simplified subset of POSIX
// shell (https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html):
//
//   program          = linebreak (complete_command (separator complete_command)*)? linebreak EOF
//   complete_command = and_or
//   and_or           = pipeline (('&&'|'||') linebreak pipeline)*
//   pipeline         = ['!'] command ('|' linebreak command)*
//   command          = compound_command redirect*
//                    | function_def
//                    | simple_command
//   compound_command = brace_group | subshell | if_clause | for_clause
//                    | while_clause | until_clause | case_clause
//   simple_command   = (assignment | redirect)* (WORD (WORD | assignment | redirect)*)?
//   assignment       = a WORD matching /^[A-Za-z_][A-Za-z0-9_]*=/
//   redirect         = [IO_NUMBER] redir_op WORD
//
// Reserved words (`if`, `then`, `elif`, `else`, `fi`, `for`, `while`, `until`,
// `do`, `done`, `case`, `esac`, `in`, `!`, `{`, `}`) are recognised
// positionally — the lexer emits them as plain WORDs and the parser
// dispatches based on grammar context.
//
// Here-doc bodies are NOT captured in this pass: `<<WORD` / `<<-WORD` are
// parsed as redirects with op `<<`/`<<-` and target being the delimiter
// word, but the body lines stay in the source stream. Wire body capture
// when the executor needs it.


// Reserved words and word-operators recognised at command position.
const COMPOUND_START_WORDS = new Set(['if', 'for', 'while', 'until', 'case', '{']);
const REDIR_OPS = new Set(['<', '>', '>>', '<&', '>&', '<>', '>|', '<<', '<<-']);

class ParseError extends Error {
  constructor(message, token) {
    super(token
      ? `geas parse error at offset ${token.pos.start}: ${message} (got ${_describeToken(token)})`
      : `geas parse error: ${message}`);
    this.token = token;
    this.name = 'ParseError';
  }
}

function _describeToken(t) {
  if (t.type === 'EOF') return 'end of input';
  if (t.type === 'NEWLINE') return 'newline';
  return `${t.type} "${t.value}"`;
}

function parse(input) {
  const tokens = Array.isArray(input) ? input : tokenize(input);
  const ctx = { tokens, i: 0 };
  return parseProgram(ctx);
}

// ── token helpers ──

function _peek(ctx, offset = 0) {
  return ctx.tokens[ctx.i + offset];
}

function _at(ctx, type, value) {
  const t = ctx.tokens[ctx.i];
  if (!t || t.type !== type) return false;
  if (value !== undefined && t.value !== value) return false;
  return true;
}

// "Reserved word" peek — true iff the current token is a WORD whose value
// matches `name`. Used for keyword dispatch (`if`, `then`, `do`, `done`, …).
function _atKeyword(ctx, name) {
  const t = ctx.tokens[ctx.i];
  return !!t && t.type === 'WORD' && t.value === name;
}

function _consume(ctx) {
  return ctx.tokens[ctx.i++];
}

function _expect(ctx, type, value) {
  const t = ctx.tokens[ctx.i];
  if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
    throw new ParseError(`expected ${type}${value !== undefined ? ` "${value}"` : ''}`, t);
  }
  return _consume(ctx);
}

function _expectKeyword(ctx, name) {
  if (!_atKeyword(ctx, name)) {
    throw new ParseError(`expected "${name}"`, ctx.tokens[ctx.i]);
  }
  return _consume(ctx);
}

// Skip zero-or-more NEWLINE tokens. Used wherever POSIX `linebreak` appears.
function _skipNL(ctx) {
  while (_at(ctx, 'NEWLINE')) ctx.i++;
}

// ── top-level ──

function parseProgram(ctx) {
  const start = (ctx.tokens[0] || { pos: { start: 0 } }).pos.start;
  _skipNL(ctx);
  const commands = [];
  while (!_at(ctx, 'EOF')) {
    const before = ctx.i;
    // Parse one complete_command (which may itself be a List separated by
    // ';' or '&' or NEWLINEs).
    const cmd = parseList(ctx);
    if (cmd) commands.push(cmd);
    _skipNL(ctx);
    // Failsafe: if we made no progress AND aren't at EOF, the current token
    // is something the parser doesn't know how to handle. Throw rather than
    // loop forever — much better feedback than a silent hang.
    if (ctx.i === before) {
      throw new ParseError('unexpected token', ctx.tokens[ctx.i]);
    }
  }
  return mkProgram(commands, { start, end: ctx.tokens[ctx.tokens.length - 1].pos.end });
}

// list = and_or (separator and_or)*    where separator is ';' '&' (and NEWLINE in compound contexts).
//
// `crossNewlines` toggles whether NEWLINE counts as an item-separator. POSIX
// distinguishes:
//   - top-level `list` (per `complete_command`): separators are ';' / '&'
//     only; NEWLINE ends the list and starts a new complete_command at the
//     program level.
//   - `compound_list` (inside do/then/else/etc.): NEWLINE is also a
//     separator within the list, so the body of a `do ... done` block can
//     contain multiple newline-separated commands.
function parseList(ctx, crossNewlines = false) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  const items = [];
  let cur = parseAndOr(ctx);
  if (cur === null) return null;

  // Each "item" carries the separator that follows it (or null if it was the
  // last thing on its line with no trailing ';'/'&'/NEWLINE).
  while (true) {
    let sep = null;
    if (_at(ctx, 'OPERATOR', ';')) { sep = ';'; _consume(ctx); }
    else if (_at(ctx, 'OPERATOR', '&')) { sep = '&'; _consume(ctx); }
    else if (_at(ctx, 'NEWLINE')) {
      // Only treat as a list separator when caller permits crossing newlines
      // (compound contexts). At program level, NEWLINE peek-only — caller
      // (parseProgram) consumes and starts a fresh list.
      if (crossNewlines) {
        sep = '\n';
        _consume(ctx);
      }
    }

    items.push({ op: sep, cmd: cur });

    if (sep === null) break;

    // After any separator, skip extra blank lines.
    _skipNL(ctx);

    // Terminators that stop list parsing.
    if (_at(ctx, 'EOF')) break;
    if (_isListTerminatorKeyword(ctx)) break;
    if (_at(ctx, 'OPERATOR', ')') || _at(ctx, 'OPERATOR', ';;')) break;

    cur = parseAndOr(ctx);
    if (cur === null) break;
  }

  // Collapse a trivial 1-item list-with-no-trailing-separator into just its
  // command. Keeps the AST cleaner for the common one-command-per-line case.
  if (items.length === 1 && items[0].op === null) return items[0].cmd;
  return mkList(items, { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// Compound-list keywords that end a list (don't try to parse past them).
function _isListTerminatorKeyword(ctx) {
  const t = ctx.tokens[ctx.i];
  if (!t || t.type !== 'WORD') return false;
  return ['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'].includes(t.value)
      || t.value === '}';
}

// and_or = pipeline (('&&'|'||') linebreak pipeline)*    left-associative
function parseAndOr(ctx) {
  if (!_canStartCommand(ctx)) return null;
  let left = parsePipeline(ctx);
  const startPos = left.pos.start;
  while (_at(ctx, 'OPERATOR', '&&') || _at(ctx, 'OPERATOR', '||')) {
    const op = _consume(ctx).value;
    _skipNL(ctx);
    const right = parsePipeline(ctx);
    left = mkAndOr(left, op, right, { start: startPos, end: right.pos.end });
  }
  return left;
}

// pipeline = ['!'] command ('|' linebreak command)*
function parsePipeline(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  let negated = false;
  if (_atKeyword(ctx, '!')) { _consume(ctx); negated = true; }

  const commands = [parseCommand(ctx)];
  while (_at(ctx, 'OPERATOR', '|')) {
    _consume(ctx);
    _skipNL(ctx);
    commands.push(parseCommand(ctx));
  }
  if (commands.length === 1 && !negated) return commands[0];
  return mkPipeline(commands, negated, { start: startPos, end: commands[commands.length - 1].pos.end });
}

function _canStartCommand(ctx) {
  const t = ctx.tokens[ctx.i];
  if (!t) return false;
  if (t.type === 'EOF' || t.type === 'NEWLINE') return false;
  if (t.type === 'OPERATOR') {
    // `(` opens a subshell, `{` would be a WORD ('{' is brace-group reserved word
    // only when standalone, lexer-wise). Redirect ops can start a simple command
    // (POSIX: `< in.txt cmd` is valid — the cmd word can follow leading redirects).
    return t.value === '(' || REDIR_OPS.has(t.value);
  }
  if (t.type === 'IO_NUMBER') return true;
  if (t.type === 'WORD') {
    // Reserved word that terminates an enclosing context shouldn't start a new command.
    return !['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'].includes(t.value);
  }
  return false;
}

// command = compound_command redirect*
//         | function_def
//         | simple_command
function parseCommand(ctx) {
  const t = ctx.tokens[ctx.i];

  // Compound openers: `(`, `{`, or a keyword.
  if (t.type === 'OPERATOR' && t.value === '(') {
    return parseSubshell(ctx);
  }
  if (t.type === 'WORD' && t.value === '{') {
    return parseBraceGroup(ctx);
  }
  if (t.type === 'WORD' && COMPOUND_START_WORDS.has(t.value)) {
    switch (t.value) {
      case 'if':    return parseIf(ctx);
      case 'for':   return parseFor(ctx);
      case 'while': return parseWhile(ctx);
      case 'until': return parseUntil(ctx);
      case 'case':  return parseCase(ctx);
      case '{':     return parseBraceGroup(ctx);
    }
  }

  // Function def lookahead: `name ( )` with no leading assignment/redirect.
  // POSIX disallows prefix on function defs, so if the very first thing is a
  // bare WORD that's a valid identifier AND the next two tokens are '(' ')',
  // it's a function definition.
  if (t.type === 'WORD' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value)) {
    const t1 = ctx.tokens[ctx.i + 1];
    const t2 = ctx.tokens[ctx.i + 2];
    if (t1 && t1.type === 'OPERATOR' && t1.value === '('
        && t2 && t2.type === 'OPERATOR' && t2.value === ')') {
      return parseFunctionDef(ctx);
    }
  }

  return parseSimpleCommand(ctx);
}

// ── simple command ──

const _ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function _wordIsAssignment(token) {
  return token.type === 'WORD' && _ASSIGN_RE.test(token.value);
}

function parseSimpleCommand(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  const assignments = [];
  const words = [];
  const redirects = [];

  // Prefix: assignments and redirects, in any order, until we see something
  // that isn't either — at which point we're in the suffix.
  while (true) {
    const t = ctx.tokens[ctx.i];
    if (!t) break;
    if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
      redirects.push(parseRedirect(ctx));
      continue;
    }
    if (_wordIsAssignment(t)) {
      const m = t.value.match(_ASSIGN_RE);
      assignments.push(mkAssignment(m[1], mkWord(m[2], t.pos), t.pos));
      _consume(ctx);
      continue;
    }
    break;
  }

  // Command name + suffix. POSIX rule 7b: after the command name, subsequent
  // tokens that look like `NAME=value` are arguments, not assignments.
  if (_at(ctx, 'WORD')) {
    words.push(mkWord(_consume(ctx).value, ctx.tokens[ctx.i - 1].pos));
    while (true) {
      const t = ctx.tokens[ctx.i];
      if (!t) break;
      if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
        redirects.push(parseRedirect(ctx));
        continue;
      }
      if (t.type === 'WORD') {
        // A "compound terminator" keyword as a bare word ends the simple
        // command — but only if it's at a position that could start something
        // else. For a simple-command suffix, treat all WORDs as args
        // EXCEPT the keywords that terminate enclosing constructs.
        if (['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'].includes(t.value)) break;
        words.push(mkWord(t.value, t.pos));
        _consume(ctx);
        continue;
      }
      break;
    }
  } else if (assignments.length === 0 && redirects.length === 0) {
    // Nothing parsed — caller's _canStartCommand should have prevented this.
    throw new ParseError('expected a command', ctx.tokens[ctx.i]);
  }

  const endPos = ctx.tokens[ctx.i - 1] ? ctx.tokens[ctx.i - 1].pos.end : startPos;
  return mkSimpleCommand(assignments, words, redirects, { start: startPos, end: endPos });
}

// redirect = [IO_NUMBER] redir_op WORD
function parseRedirect(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  let fd = null;
  if (_at(ctx, 'IO_NUMBER')) {
    fd = Number(_consume(ctx).value);
  }
  const opTok = _consume(ctx);
  if (opTok.type !== 'OPERATOR' || !REDIR_OPS.has(opTok.value)) {
    throw new ParseError(`expected redirection operator`, opTok);
  }
  const targetTok = _consume(ctx);
  if (targetTok.type !== 'WORD') {
    throw new ParseError(`expected redirection target word`, targetTok);
  }
  return mkRedirect(fd, opTok.value, mkWord(targetTok.value, targetTok.pos),
                    { start: startPos, end: targetTok.pos.end });
}

// ── compound commands ──

// brace_group = '{' compound_list '}'
function parseBraceGroup(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, '{');
  _skipNL(ctx);
  const body = parseList(ctx, true);
  _skipNL(ctx);
  _expectKeyword(ctx, '}');
  const redirects = _parseTrailingRedirects(ctx);
  return mkBraceGroup(body, redirects, { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// subshell = '(' compound_list ')'
function parseSubshell(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expect(ctx, 'OPERATOR', '(');
  _skipNL(ctx);
  const body = parseList(ctx, true);
  _skipNL(ctx);
  _expect(ctx, 'OPERATOR', ')');
  const redirects = _parseTrailingRedirects(ctx);
  return mkSubshell(body, redirects, { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// if_clause = 'if' list 'then' list ('elif' list 'then' list)* ('else' list)? 'fi'
function parseIf(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'if');
  _skipNL(ctx);
  const cond = parseList(ctx, true);
  _skipNL(ctx);
  _expectKeyword(ctx, 'then');
  _skipNL(ctx);
  const then_ = parseList(ctx, true);
  _skipNL(ctx);

  const elifs = [];
  while (_atKeyword(ctx, 'elif')) {
    _consume(ctx);
    _skipNL(ctx);
    const ec = parseList(ctx, true);
    _skipNL(ctx);
    _expectKeyword(ctx, 'then');
    _skipNL(ctx);
    const et = parseList(ctx, true);
    _skipNL(ctx);
    elifs.push({ cond: ec, then: et });
  }

  let else_ = null;
  if (_atKeyword(ctx, 'else')) {
    _consume(ctx);
    _skipNL(ctx);
    else_ = parseList(ctx, true);
    _skipNL(ctx);
  }
  _expectKeyword(ctx, 'fi');
  const redirects = _parseTrailingRedirects(ctx);
  return mkIfClause(cond, then_, elifs, else_, redirects,
                    { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// for_clause = 'for' name (linebreak 'in' word* separator)? do_group
function parseFor(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'for');
  const nameTok = _expect(ctx, 'WORD');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nameTok.value)) {
    throw new ParseError(`invalid for-loop variable name "${nameTok.value}"`, nameTok);
  }
  const name = nameTok.value;
  _skipNL(ctx);

  let words = null;
  if (_atKeyword(ctx, 'in')) {
    _consume(ctx);
    words = [];
    while (_at(ctx, 'WORD') && !_isListTerminatorKeyword(ctx) && !_atKeyword(ctx, 'do')) {
      const w = _consume(ctx);
      words.push(mkWord(w.value, w.pos));
    }
    // Optional ; or newline before do
    if (_at(ctx, 'OPERATOR', ';')) _consume(ctx);
    _skipNL(ctx);
  } else {
    // No `in` clause; allow ; or newline directly before do.
    if (_at(ctx, 'OPERATOR', ';')) _consume(ctx);
    _skipNL(ctx);
  }
  const body = _parseDoGroup(ctx);
  const redirects = _parseTrailingRedirects(ctx);
  return mkForClause(name, words, body, redirects,
                     { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// while_clause = 'while' list do_group
function parseWhile(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'while');
  _skipNL(ctx);
  const cond = parseList(ctx, true);
  _skipNL(ctx);
  const body = _parseDoGroup(ctx);
  const redirects = _parseTrailingRedirects(ctx);
  return mkWhileClause(cond, body, redirects,
                       { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

function parseUntil(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'until');
  _skipNL(ctx);
  const cond = parseList(ctx, true);
  _skipNL(ctx);
  const body = _parseDoGroup(ctx);
  const redirects = _parseTrailingRedirects(ctx);
  return mkUntilClause(cond, body, redirects,
                       { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

function _parseDoGroup(ctx) {
  _expectKeyword(ctx, 'do');
  _skipNL(ctx);
  const body = parseList(ctx, true);
  _skipNL(ctx);
  _expectKeyword(ctx, 'done');
  return body;
}

// case_clause = 'case' word linebreak 'in' linebreak (case_item ;;)* [case_item ;;?] 'esac'
// case_item   = ['('] pattern ('|' pattern)* ')' compound_list?
function parseCase(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  _expectKeyword(ctx, 'case');
  const wTok = _expect(ctx, 'WORD');
  const word = mkWord(wTok.value, wTok.pos);
  _skipNL(ctx);
  _expectKeyword(ctx, 'in');
  _skipNL(ctx);

  const items = [];
  while (!_atKeyword(ctx, 'esac') && !_at(ctx, 'EOF')) {
    const itemStart = ctx.tokens[ctx.i].pos.start;
    // Optional leading `(`
    if (_at(ctx, 'OPERATOR', '(')) _consume(ctx);
    const patterns = [];
    // First pattern
    if (!_at(ctx, 'WORD')) {
      throw new ParseError('expected case pattern', ctx.tokens[ctx.i]);
    }
    const p0 = _consume(ctx);
    patterns.push(mkWord(p0.value, p0.pos));
    while (_at(ctx, 'OPERATOR', '|')) {
      _consume(ctx);
      const pn = _expect(ctx, 'WORD');
      patterns.push(mkWord(pn.value, pn.pos));
    }
    _expect(ctx, 'OPERATOR', ')');
    _skipNL(ctx);
    // Body: anything up to ';;' or 'esac'.
    let body = null;
    if (!_at(ctx, 'OPERATOR', ';;') && !_atKeyword(ctx, 'esac')) {
      body = parseList(ctx, true);
    }
    _skipNL(ctx);
    if (_at(ctx, 'OPERATOR', ';;')) _consume(ctx);
    _skipNL(ctx);
    items.push(mkCaseItem(patterns, body,
                          { start: itemStart, end: ctx.tokens[ctx.i - 1].pos.end }));
  }
  _expectKeyword(ctx, 'esac');
  const redirects = _parseTrailingRedirects(ctx);
  return mkCaseClause(word, items, redirects,
                      { start: startPos, end: ctx.tokens[ctx.i - 1].pos.end });
}

// function_def = name '(' ')' linebreak compound_command
function parseFunctionDef(ctx) {
  const startPos = ctx.tokens[ctx.i].pos.start;
  const nameTok = _expect(ctx, 'WORD');
  const name = nameTok.value;
  _expect(ctx, 'OPERATOR', '(');
  _expect(ctx, 'OPERATOR', ')');
  _skipNL(ctx);
  // POSIX says the body must be a compound_command — for simplicity we parse
  // any command (lets `foo() simple cmd` work too, a bash-style extension).
  const body = parseCommand(ctx);
  return mkFunctionDef(name, body, { start: startPos, end: body.pos.end });
}

function _parseTrailingRedirects(ctx) {
  const out = [];
  while (true) {
    const t = ctx.tokens[ctx.i];
    if (!t) break;
    if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
      out.push(parseRedirect(ctx));
    } else {
      break;
    }
  }
  return out;
}

// -- api.js --

// Public API surface for @gcu/geas.
//
// v0.0.1 (Medium scope): lexer + parser only. Executor, builtins, terminal
// adapters, and the worker harness come in later iterations.
//
// Note on shape: uses `import { x } from './foo.js'; export { x };` rather
// than `export { x } from './foo.js'` so the concat-style build can strip
// both lines and leave api.js's contribution empty in the bundle — the
// footer in build.js then provides a single canonical export.

export { tokenize, parse, NODE };
