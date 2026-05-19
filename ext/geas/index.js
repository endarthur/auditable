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

function mkWord(value, pos, parts) {
  // `value` is the raw lexer text (preserved verbatim — quotes, expansions,
  // escapes all intact for round-trip / error reporting).
  // `parts` is the structured decomposition for the executor — array of
  // shapes documented in word-parts.js. Parser callers should pass parts
  // from `parseWordParts(value)`; older callers can omit and get parts
  // computed lazily on first access.
  return { type: NODE.WORD, value, parts: parts ?? null, pos };
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
//   WORD          — anything that isn't an operator (preserves quoting verbatim)
//   OPERATOR      — single- or multi-char shell operator (see OPERATORS table)
//   IO_NUMBER     — digit run immediately followed by < or > (no space between)
//   NEWLINE       — \n line terminator (token-significant in shell grammar)
//   HEREDOC_BODY  — body text of a `<<DELIM` / `<<-DELIM` here-doc, emitted
//                   immediately after the operator's delimiter word. The
//                   `quoted` flag tells the executor whether the delimiter
//                   was quoted (POSIX: any quoting suppresses body expansion).
//   EOF           — end-of-input sentinel emitted once at the end
//
// Line continuation (backslash-newline) between tokens is silently consumed.
// Comments (# to end of line) are stripped before token emission.
//
// Here-doc handling: when `<<` or `<<-` is emitted, the immediately-following
// word is consumed as the delimiter (`heredoc:` field on the operator token);
// the body is captured on the next NEWLINE. Multiple heredocs on the same
// line stack in queue order: `cat <<A <<B` captures A's body then B's body
// after the trailing newline. The `<<-` variant strips leading TABS (not
// spaces — POSIX-strict) from each body line and from the closing delimiter.
//
// Not yet implemented (TODOs):
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
  // Queue of here-docs awaiting body capture. Each entry: { delim, quoted,
  // stripTabs }. Filled when `<<` / `<<-` is emitted; drained when the next
  // NEWLINE fires.
  const heredocQueue = [];

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
      const nlStart = pos;
      pos++; // consume the newline first — heredoc bodies start on the next char

      // Drain any pending here-docs. Each captures lines until its delimiter.
      while (heredocQueue.length > 0) {
        const hd = heredocQueue.shift();
        const cap = _captureHeredocBody(src, pos, hd.delim, hd.stripTabs);
        tokens.push({
          type: 'HEREDOC_BODY',
          value: cap.body,
          quoted: hd.quoted,
          delim: hd.delim,
          stripTabs: hd.stripTabs,
          pos: { start: pos, end: cap.end },
        });
        pos = cap.end;
      }

      // Emit the NEWLINE at its ORIGINAL position (not adjusted for the body scan).
      tokens.push({ type: 'NEWLINE', value: '\n', pos: { start: nlStart, end: nlStart + 1 } });
      continue;
    }

    // Operator (longest-match against OPERATORS table).
    const opLen = _matchOperator(src, pos);
    if (opLen > 0) {
      const opVal = src.slice(pos, pos + opLen);
      tokens.push({
        type: 'OPERATOR',
        value: opVal,
        pos: { start: pos, end: pos + opLen },
      });
      pos += opLen;

      // If this was `<<` or `<<-`, the next word is the delimiter — consume
      // it inline so we can queue the heredoc before any NEWLINE shows up.
      if (opVal === '<<' || opVal === '<<-') {
        pos = _skipWS(src, pos);
        if (pos < src.length && src[pos] !== '\n') {
          const delimStart = pos;
          const delimEnd = _readWord(src, pos);
          const delimRaw = src.slice(delimStart, delimEnd);
          // Emit the delimiter as a WORD so the parser sees it normally.
          tokens.push({
            type: 'WORD',
            value: delimRaw,
            pos: { start: delimStart, end: delimEnd },
          });
          pos = delimEnd;
          // Queue the heredoc. `delim` is the unquoted form (for matching).
          // `quoted` records whether the original WORD had any quoting at all
          // (POSIX: any quoting suppresses body expansion).
          const unquoted = _unquoteDelim(delimRaw);
          heredocQueue.push({
            delim: unquoted,
            quoted: unquoted !== delimRaw,
            stripTabs: opVal === '<<-',
          });
        }
        // If no delimiter followed (malformed input), let the parser raise.
      }
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

  // If input ends without a trailing newline but heredocs are queued, drain
  // them now — unterminated heredocs capture what they can up to EOF.
  while (heredocQueue.length > 0) {
    const hd = heredocQueue.shift();
    const cap = _captureHeredocBody(src, pos, hd.delim, hd.stripTabs);
    tokens.push({
      type: 'HEREDOC_BODY',
      value: cap.body,
      quoted: hd.quoted,
      delim: hd.delim,
      stripTabs: hd.stripTabs,
      pos: { start: pos, end: cap.end },
    });
    pos = cap.end;
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

// ── here-doc support ──

// Scan from `pos` line-by-line, capturing body lines until a line matching
// `delim` is found. POSIX: the closing delimiter must occupy its line by
// itself (with leading TABS stripped if `stripTabs`). Lines and the closing
// delimiter line itself are NOT included in the body.
//
// Returns { body, end } where `end` is the index just past the delimiter
// line's trailing \n (or end of input if unterminated). `body` is joined
// with '\n' and a trailing '\n' on each line (so the executor sees real
// shell-shape line-terminated text).
function _captureHeredocBody(src, pos, delim, stripTabs) {
  const lines = [];
  let i = pos;
  while (i < src.length) {
    const lineStart = i;
    while (i < src.length && src[i] !== '\n') i++;
    let line = src.slice(lineStart, i);
    if (stripTabs) {
      let k = 0;
      while (k < line.length && line[k] === '\t') k++;
      line = line.slice(k);
    }
    if (line === delim) {
      // Closing delimiter — consume its trailing \n and stop.
      const end = i < src.length ? i + 1 : i;
      return { body: lines.length ? lines.join('\n') + '\n' : '', end };
    }
    lines.push(line);
    if (i < src.length) i++; // step over the \n
  }
  // Unterminated. Return what we have; the executor / parser can choose to
  // warn or accept as-is.
  return { body: lines.length ? lines.join('\n') + '\n' : '', end: i };
}

// POSIX: a here-doc delimiter that contains any quoted or escaped character
// is matched against the literal (unquoted) text, and the body is treated
// as literal (no expansion). This helper strips quotes/escapes so the
// matching delimiter is correct; the *caller* records whether quoting was
// present (via the `quoted` flag on the HEREDOC_BODY token) so the executor
// later knows whether to expand body content.
function _unquoteDelim(word) {
  let out = '';
  let i = 0;
  while (i < word.length) {
    const ch = word[i];
    if (ch === '\\' && i + 1 < word.length) {
      out += word[i + 1];
      i += 2;
    } else if (ch === "'") {
      i++;
      while (i < word.length && word[i] !== "'") { out += word[i]; i++; }
      if (i < word.length) i++;
    } else if (ch === '"') {
      i++;
      while (i < word.length && word[i] !== '"') {
        if (word[i] === '\\' && i + 1 < word.length) {
          out += word[i + 1];
          i += 2;
        } else {
          out += word[i];
          i++;
        }
      }
      if (i < word.length) i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// -- word-parts.js --

// Word structure: parse an opaque WORD value into structured parts so the
// executor can do expansion without re-tokenising. Called by the parser's
// mkWord(); the lexer remains "opaque WORDs" — all structure lives here.
//
// Part shapes (the `kind` discriminator):
//
//   { kind: 'lit',    value }                    plain unquoted literal text
//   { kind: 'sq',     value }                    single-quoted segment (literal)
//   { kind: 'dq',     parts: [Part] }            double-quoted: nested parts,
//                                                  expansions allowed inside but
//                                                  no field-splitting on results
//   { kind: 'escape', value }                    backslash-escaped char
//   { kind: 'var',    name }                     $X — simple variable reference
//   { kind: 'param',  name, op, word: Word? }    ${X op default}: op ∈ {':-',':=',':?',':+','-','=','?','+','#','##','%','%%'}
//                                                  word = the default/replacement (parsed as a Word)
//   { kind: 'cmd',    body }                     $(...) or `...` — command substitution
//   { kind: 'arith',  body }                     $((...)) — arithmetic substitution
//
// For v0 the parser produces these but the EXECUTOR may only implement the
// common subset (lit, sq, dq, var, cmd). param/arith are emitted faithfully
// but the executor can choose how to handle them (substitute "" or warn).

function parseWordParts(src) {
  const parts = [];
  const state = { src, i: 0, buf: '' };
  while (state.i < src.length) _wpScanTop(state, parts);
  _wpFlushBuf(state, parts);
  return parts;
}

function _wpFlushBuf(state, parts) {
  if (state.buf) { parts.push({ kind: 'lit', value: state.buf }); state.buf = ''; }
}

function _wpScanTop(state, parts) {
  const { src } = state;
  const ch = src[state.i];

  // Backslash escape: preserved as 'escape' part so the executor knows it
  // was escaped (and which char). Mostly equivalent to a 'lit' for purposes
  // of substitution, but kept distinct for round-tripping / error messages.
  if (ch === '\\' && state.i + 1 < src.length) {
    _wpFlushBuf(state, parts);
    parts.push({ kind: 'escape', value: src[state.i + 1] });
    state.i += 2;
    return;
  }
  if (ch === "'") {
    _wpFlushBuf(state, parts);
    parts.push(_wpScanSQ(state));
    return;
  }
  if (ch === '"') {
    _wpFlushBuf(state, parts);
    parts.push(_wpScanDQ(state));
    return;
  }
  if (ch === '$') {
    const expanded = _wpScanDollar(state);
    if (expanded) {
      _wpFlushBuf(state, parts);
      parts.push(expanded);
      return;
    }
    // Bare $ with no recognisable expansion — treat as literal $.
    state.buf += '$';
    state.i++;
    return;
  }
  if (ch === '`') {
    _wpFlushBuf(state, parts);
    parts.push(_wpScanBacktick(state));
    return;
  }
  state.buf += ch;
  state.i++;
}

// Inside double quotes: the rules differ. Backslash escapes a smaller set,
// $ and ` still introduce expansions, single quotes lose their meaning,
// double quote closes the group. All inner expansions get `quoted: true`
// semantics, but we encode that via the wrapping 'dq' part rather than a
// per-part flag.
function _wpScanDQ(state) {
  const { src } = state;
  state.i++; // consume opening "
  const parts = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push({ kind: 'lit', value: buf }); buf = ''; } };

  while (state.i < src.length && src[state.i] !== '"') {
    const ch = src[state.i];
    if (ch === '\\' && state.i + 1 < src.length) {
      // POSIX: inside "...", \ escapes only $ ` " \ <newline>
      const next = src[state.i + 1];
      if ('$`"\\'.includes(next)) {
        buf += next;
        state.i += 2;
      } else if (next === '\n') {
        // line continuation in dquote: backslash + newline both disappear
        state.i += 2;
      } else {
        buf += ch;
        state.i++;
      }
      continue;
    }
    if (ch === '$') {
      const expanded = _wpScanDollar(state);
      if (expanded) {
        flush();
        parts.push(expanded);
        continue;
      }
      buf += '$';
      state.i++;
      continue;
    }
    if (ch === '`') {
      flush();
      parts.push(_wpScanBacktick(state));
      continue;
    }
    buf += ch;
    state.i++;
  }
  flush();
  if (state.i < src.length) state.i++; // consume closing "
  return { kind: 'dq', parts };
}

function _wpScanSQ(state) {
  const { src } = state;
  state.i++; // consume opening '
  let buf = '';
  while (state.i < src.length && src[state.i] !== "'") {
    buf += src[state.i];
    state.i++;
  }
  if (state.i < src.length) state.i++; // consume closing '
  return { kind: 'sq', value: buf };
}

function _wpScanBacktick(state) {
  const { src } = state;
  state.i++; // consume opening `
  let buf = '';
  while (state.i < src.length && src[state.i] !== '`') {
    // POSIX: inside backticks, only `, $, and \ need escape; the canonical
    // form is `\$`, `\\`, `\\`` for literal $, \, `. We preserve verbatim
    // so the executor can re-parse the body when it executes.
    if (src[state.i] === '\\' && state.i + 1 < src.length
        && '\\$`'.includes(src[state.i + 1])) {
      buf += src[state.i + 1];
      state.i += 2;
    } else {
      buf += src[state.i];
      state.i++;
    }
  }
  if (state.i < src.length) state.i++; // consume closing `
  return { kind: 'cmd', body: buf };
}

// Returns a Part or null. `null` means the $ wasn't a recognisable
// expansion (the caller should emit a literal '$').
function _wpScanDollar(state) {
  const { src } = state;
  const next = src[state.i + 1];

  if (next === '(') {
    // $((arith)) — two opens; $(cmd) — one
    if (src[state.i + 2] === '(') {
      const end = _wpFindArith(src, state.i + 2);
      const body = src.slice(state.i + 3, end - 1);
      state.i = end + 1;
      return { kind: 'arith', body };
    }
    const end = _wpFindBalanced(src, state.i + 1, '(', ')');
    const body = src.slice(state.i + 2, end);
    state.i = end + 1;
    return { kind: 'cmd', body };
  }

  if (next === '{') {
    const end = _wpFindBalanced(src, state.i + 1, '{', '}');
    const inner = src.slice(state.i + 2, end);
    state.i = end + 1;
    return _wpParseParam(inner);
  }

  if (next && /[a-zA-Z_]/.test(next)) {
    let j = state.i + 2;
    while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
    const name = src.slice(state.i + 1, j);
    state.i = j;
    return { kind: 'var', name };
  }

  if (next && '@*#?$!-0123456789'.includes(next)) {
    state.i += 2;
    return { kind: 'var', name: next };
  }

  return null;
}

// Parse the contents of `${...}`. Supports:
//   ${name}                      bare reference
//   ${name:-word}                use default if unset or null
//   ${name:=word}                assign default if unset or null
//   ${name:?word}                error if unset or null
//   ${name:+word}                alt value if set and non-null
//   ${name-word} / ${name=word}/ ${name?word} / ${name+word}   same but only "unset"
//   ${#name}                     string length
//   ${name#pattern} / ${name##pattern}   prefix removal
//   ${name%pattern} / ${name%%pattern}   suffix removal
// Returns either { kind: 'var', name } (simple) or { kind: 'param', name, op, word: Word }.
function _wpParseParam(inner) {
  // Length: ${#name}
  if (inner.startsWith('#') && inner.length > 1) {
    const name = inner.slice(1);
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || '@*#?$!-0123456789'.includes(name)) {
      return { kind: 'param', name, op: '#', word: null };
    }
  }
  // Match the leading name (identifier-shape or special-parameter).
  const nameMatch = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*|[@*#?$!-]|\d+)/);
  if (!nameMatch) {
    // Malformed ${...}; preserve as a literal var reference with the whole inner as the name.
    return { kind: 'var', name: inner };
  }
  const name = nameMatch[1];
  const rest = inner.slice(name.length);
  if (rest.length === 0) return { kind: 'var', name };
  // Multi-char operators first (longest-match).
  for (const op of [':-', ':=', ':?', ':+', '##', '%%', '-', '=', '?', '+', '#', '%']) {
    if (rest.startsWith(op)) {
      const word = rest.slice(op.length);
      // Recursively parse the default-word as its own Word.
      return { kind: 'param', name, op, word: { type: 'Word', value: word, parts: parseWordParts(word) } };
    }
  }
  // Unknown operator — fall back to a bare var with the whole rest captured
  // as the op's literal payload, so the executor at least knows something
  // was there.
  return { kind: 'param', name, op: rest, word: null };
}

function _wpFindBalanced(src, openIdx, openCh, closeCh) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "'") { i = _wpSkipQuote(src, i, "'"); continue; }
    if (ch === '"') { i = _wpSkipDQuote(src, i); continue; }
    if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
    if (ch === '`') { i = _wpSkipQuote(src, i, '`'); continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) return i; }
    i++;
  }
  return i;
}

// $((...)) — match an inner double-close `))`.
function _wpFindArith(src, openOuterIdx) {
  // openOuterIdx points at the SECOND `(` of `$((`. We want the matching `))`.
  let depth = 1;
  let i = openOuterIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) {
      // We just consumed the inner ). The outer ) should be next.
      if (src[i + 1] === ')') return i + 1;
      // Unbalanced; treat as end here.
      return i + 1;
    }
    i++;
  }
  return i;
}

function _wpSkipQuote(src, openIdx, quoteCh) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== quoteCh) {
    if (src[i] === '\\' && i + 1 < src.length && quoteCh !== "'") i += 2;
    else i++;
  }
  return i < src.length ? i + 1 : i;
}

function _wpSkipDQuote(src, openIdx) {
  let i = openIdx + 1;
  while (i < src.length && src[i] !== '"') {
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


// All parser-side Word constructions go through _word so the structured
// parts get computed once at parse time. mkWord (in ast-nodes.js) accepts
// an optional `parts` arg and uses it verbatim when provided.
function _word(value, pos) {
  return mkWord(value, pos, parseWordParts(value));
}

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
  // pendingHeredocs: FIFO of Redirect nodes awaiting body attachment. Each
  // `<<` / `<<-` parseRedirect pushes; HEREDOC_BODY tokens drain via
  // _drainHeredocBodies (called as part of _skipNL).
  const ctx = { tokens, i: 0, pendingHeredocs: [] };
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
// HEREDOC_BODY tokens immediately preceding a NEWLINE are drained here too
// — the lexer emits them right before the NEWLINE that triggered their
// capture, so this is where they naturally get attached to their owning
// redirects (in queue order).
function _skipNL(ctx) {
  while (true) {
    _drainHeredocBodies(ctx);
    if (!_at(ctx, 'NEWLINE')) break;
    ctx.i++;
  }
}

function _drainHeredocBodies(ctx) {
  while (_at(ctx, 'HEREDOC_BODY')) {
    const t = _consume(ctx);
    const redir = ctx.pendingHeredocs.shift();
    if (redir) {
      redir.body = t.value;
      redir.bodyQuoted = t.quoted;
    }
    // If there's no pending redirect (shouldn't happen for well-formed input
    // since the lexer only emits HEREDOC_BODY when it queued one at op-time),
    // silently drop the body — better than throwing on a parser-internal
    // accounting mismatch.
  }
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
    // Defensive: drain any HEREDOC_BODY tokens that ended up sitting at EOF
    // (input that lacks a trailing newline after the last heredoc).
    _drainHeredocBodies(ctx);
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
      assignments.push(mkAssignment(m[1], _word(m[2], t.pos), t.pos));
      _consume(ctx);
      continue;
    }
    break;
  }

  // Command name + suffix. POSIX rule 7b: after the command name, subsequent
  // tokens that look like `NAME=value` are arguments, not assignments.
  if (_at(ctx, 'WORD')) {
    words.push(_word(_consume(ctx).value, ctx.tokens[ctx.i - 1].pos));
    while (true) {
      const t = ctx.tokens[ctx.i];
      if (!t) break;
      if (t.type === 'IO_NUMBER' || (t.type === 'OPERATOR' && REDIR_OPS.has(t.value))) {
        redirects.push(parseRedirect(ctx));
        continue;
      }
      if (t.type === 'WORD') {
        // POSIX rule: reserved words are recognised ONLY at command-start
        // position. Once we've started accumulating a simple command's
        // suffix, subsequent WORDs are always arguments — including words
        // spelled like reserved words. So `echo done` reads `done` as an
        // arg, not a do-group terminator. The enclosing list's call to
        // _canStartCommand handles keyword-as-terminator at the right time
        // (when deciding whether to start the next command in the list).
        words.push(_word(t.value, t.pos));
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
  const redir = mkRedirect(fd, opTok.value, _word(targetTok.value, targetTok.pos),
                           { start: startPos, end: targetTok.pos.end });
  // Here-doc redirects expect a body to be attached when the next NEWLINE
  // fires (the lexer queues bodies in declaration order and emits them just
  // before the NEWLINE; _drainHeredocBodies pairs them with these). Bodies
  // remain null on this node if the input is malformed or unterminated.
  if (opTok.value === '<<' || opTok.value === '<<-') {
    redir.body = null;
    redir.bodyQuoted = false;
    ctx.pendingHeredocs.push(redir);
  }
  return redir;
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
      words.push(_word(w.value, w.pos));
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
  const word = _word(wTok.value, wTok.pos);
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
    patterns.push(_word(p0.value, p0.pos));
    while (_at(ctx, 'OPERATOR', '|')) {
      _consume(ctx);
      const pn = _expect(ctx, 'WORD');
      patterns.push(_word(pn.value, pn.pos));
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

// -- typed.js --

// Typed pipe protocol — the GCU-distinctive feature.
//
// Pipes carry one of two payload shapes:
//
//   string       — POSIX-shape text (default)
//   Typed object — { __geas_typed: true, kind, value, toString }
//
// When the previous stage's stdout is a Typed value, the next stage's ctx.stdin
// is that Typed object. Stages that recognise its `kind` can read `.value`
// directly without re-parsing. Stages that don't (cat, grep, head, etc.)
// fall back to `String(stdin)` — the Typed object's `toString()` returns
// its text rendering, so the pipe degrades gracefully to POSIX semantics.
//
// Capability negotiation is implicit: producers always emit Typed; consumers
// inspect `__geas_typed`. No explicit handshake. The terminal adapter does
// a separate negotiation via `caps()` for inline rich-block rendering of
// the final pipe stage's typed output.

// ── factory ──

// Construct a Typed value. `text` is the canonical text rendering used by
// downstream non-typed consumers and by terminal adapters without rich-block
// support. Can be a string OR a function () => string for lazy rendering.
function mkTyped(kind, value, text) {
  const tv = {
    __geas_typed: true,
    kind,
    value,
    toString() { return typeof text === 'function' ? text() : text; },
  };
  // Make sure `'' + tv` / template literals invoke toString correctly.
  // (Object stringification falls back to toString automatically.)
  return tv;
}

function isTyped(v) {
  return v != null && typeof v === 'object' && v.__geas_typed === true;
}

// Convert any pipe payload to text. Used by builtins that don't understand
// the Typed kind — they read input through here and get a string.
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (isTyped(v)) return v.toString();
  return String(v);
}

// ── CSV helpers (minimal) ──
//
// v0 ships a compact CSV parser/serialiser inline so the typed-pipe demo
// works without dragging in sadpan. The format is small but POSIX-friendly:
//
//   parseCSV(text, opts)   → { columns: string[], rows: any[][] }
//   serializeCSV(table)    → string (with trailing newline if rows > 0)
//
// Quoting: double-quote-wrapped fields with ""-doubled embedded quotes.
// Delimiter: comma by default; opts.delim overrides.

function parseCSV(text, opts = {}) {
  const delim = opts.delim || ',';
  if (!text || text.length === 0) return { columns: [], rows: [] };
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const records = _parseCSVRecords(trimmed, delim);
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0];
  const rows = records.slice(1);
  return { columns, rows };
}

function _parseCSVRecords(text, delim) {
  const out = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  // Last field / row.
  row.push(field);
  if (row.length > 1 || row[0] !== '') out.push(row);
  return out;
}

function serializeCSV(table, opts = {}) {
  const delim = opts.delim || ',';
  const escape = (v) => {
    const s = String(v ?? '');
    if (s.includes(delim) || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [];
  if (table.columns && table.columns.length > 0) {
    lines.push(table.columns.map(escape).join(delim));
  }
  for (const row of table.rows || []) {
    lines.push(row.map(escape).join(delim));
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

// Pretty-format a table as a fixed-width text block, for tty fallback.
// Used by Typed-table.toString() in the absence of structured rendering.
function formatTable(table, opts = {}) {
  const max = opts.maxRows ?? 50;
  const cols = table.columns || [];
  const rows = (table.rows || []).slice(0, max);
  const widths = cols.map((c, i) => {
    let w = String(c).length;
    for (const r of rows) w = Math.max(w, String(r[i] ?? '').length);
    return w;
  });
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const lines = [];
  if (cols.length > 0) {
    lines.push(cols.map((c, i) => pad(c, widths[i])).join('  '));
    lines.push(widths.map(w => '─'.repeat(w)).join('  '));
  }
  for (const r of rows) lines.push(r.map((v, i) => pad(v, widths[i])).join('  '));
  if ((table.rows?.length ?? 0) > max) {
    lines.push(`… (${table.rows.length - max} more rows)`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

// -- executor.js --

// Executor — walks a parsed geas AST against a context, producing output
// and exit codes. v0 skeleton: covers the common-path shell semantics
// (simple commands, pipelines, and-or, lists, if/for/while/until/case,
// redirects, word expansion with $vars and $(cmd) substitution).
//
// Context shape (all fields are optional unless noted; defaults below):
//
//   vfs       — @gcu/vfs-shaped instance (readFile/writeFile/readdir/...).
//               Required if any redirect or filesystem builtin runs.
//   env       — Map<string,string>. Defaults to empty.
//   cwd       — string. Defaults to '/'.
//   stdin     — string | AsyncIterable<string>. Defaults to ''.
//   stdout    — async (text) => void. Defaults to throw if not provided.
//   stderr    — async (text) => void. Defaults to ctx.stdout if absent.
//   builtins  — Map<name, async (argv, subctx) => exitCode>. Empty default.
//   onCommand — async (name, argv, subctx) => exitCode. Called when a
//               command isn't a builtin; defaults to "127 command not found".
//   functions — Map<name, FunctionDef AST>. Populated by FunctionDef nodes.
//   lastStatus — number. Tracks $? across commands. Initialised to 0.
//
// What v0 does NOT do:
//   - Backgrounding via `&` (parsed, runs synchronously)
//   - Function call frames (FunctionDef stores the body; calling skips for now)
//   - Subshell isolation (Subshell runs in the same scope as a brace group)
//   - Glob expansion (patterns stay literal except inside `case`)
//   - Field splitting on $IFS (unquoted expansions stay single fields)
//   - Real streaming pipes (each stage's stdout buffers before the next runs)
//   - Process substitution `<(...)` / `>(...)`
//   - Job control / signals beyond Ctrl+C-style abort via thrown promises
//
// These are sized-by-need additions; the architecture leaves room.


async function execute(ast, ctx) {
  const c = _normalize(ctx);
  return await _exec(ast, c);
}

function _normalize(ctx) {
  return {
    vfs:        ctx.vfs ?? null,
    env:        ctx.env instanceof Map ? ctx.env : new Map(Object.entries(ctx.env || {})),
    cwd:        ctx.cwd ?? '/',
    stdin:      ctx.stdin ?? '',
    stdout:     ctx.stdout ?? (() => { throw new Error('geas: no stdout sink configured'); }),
    stderr:     ctx.stderr ?? ctx.stdout ?? (() => { throw new Error('geas: no stderr sink configured'); }),
    builtins:   ctx.builtins instanceof Map ? ctx.builtins : new Map(Object.entries(ctx.builtins || {})),
    onCommand:  ctx.onCommand ?? (async (name) => 127),
    functions:  ctx.functions instanceof Map ? ctx.functions : new Map(Object.entries(ctx.functions || {})),
    lastStatus: ctx.lastStatus ?? 0,
    // Shell options (set via `set -e`, `set -u`, `set -o pipefail`, ...).
    // Live on ctx so builtins like `set` can flip them at runtime, and the
    // executor checks them at the right gates (errexit after every command
    // in a list / program; pipefail when deriving a pipeline's exit code;
    // nounset on var lookup).
    options:    ctx.options ?? { errexit: false, nounset: false, pipefail: false, xtrace: false },
    // True while evaluating an `if`/`while`/`until` condition, the left
    // side of `&&`/`||`, or a negated `! cmd`. errexit doesn't trigger
    // inside these contexts — only on the rightmost actually-evaluated
    // command of a list (POSIX 2.5.3 / Bash "Shell Builtin Commands" set).
    _inCondition: ctx._inCondition ?? false,
    positional: ctx.positional ?? [],
    // Internal signal markers — thrown by `break`/`continue`/`return`/`exit`.
    // Exposed on ctx so builtins can throw them too.
    _BREAK:     ctx._BREAK ?? Symbol.for('geas:break'),
    _CONTINUE:  ctx._CONTINUE ?? Symbol.for('geas:continue'),
    _RETURN:    ctx._RETURN ?? Symbol.for('geas:return'),
    _EXIT:      ctx._EXIT ?? Symbol.for('geas:exit'),
  };
}

// Run a child node with _inCondition forced true. Used by if/while/until
// conditions, the left side of &&/||, and the body of a negated pipeline.
// Restores _inCondition on return so siblings see the original value.
async function _withCondition(node, ctx) {
  const prev = ctx._inCondition;
  ctx._inCondition = true;
  try {
    return await _exec(node, ctx);
  } finally {
    ctx._inCondition = prev;
  }
}

// Does a command qualify for errexit-suppression by being a "tested" command?
// POSIX: negated pipelines (`! cmd`) never trigger errexit even on failure.
// Compound conditions handle their own context via _withCondition.
function _errexitExempt(cmd) {
  if (cmd && cmd.type === NODE.PIPELINE && cmd.negated) return true;
  return false;
}

// After executing a command in a list/program context, check whether
// errexit should trigger a script exit. Called by _execProgram, _execList,
// and the compound-body helpers (which themselves invoke _execList for
// their bodies, so the check happens transparently there too).
function _maybeErrexit(cmd, exitCode, ctx) {
  if (!ctx.options || !ctx.options.errexit) return;
  if (exitCode === 0) return;
  if (ctx._inCondition) return;
  if (_errexitExempt(cmd)) return;
  throw { exitCode, _exit: true };
}

async function _exec(node, ctx) {
  switch (node.type) {
    case NODE.PROGRAM:        return await _execProgram(node, ctx);
    case NODE.LIST:           return await _execList(node, ctx);
    case NODE.AND_OR:         return await _execAndOr(node, ctx);
    case NODE.PIPELINE:       return await _execPipeline(node, ctx);
    case NODE.SIMPLE_COMMAND: return await _execSimpleCommand(node, ctx);
    case NODE.IF_CLAUSE:      return await _execIf(node, ctx);
    case NODE.FOR_CLAUSE:     return await _execFor(node, ctx);
    case NODE.WHILE_CLAUSE:   return await _execWhile(node, ctx);
    case NODE.UNTIL_CLAUSE:   return await _execUntil(node, ctx);
    case NODE.CASE_CLAUSE:    return await _execCase(node, ctx);
    case NODE.BRACE_GROUP:    return await _execBraceGroup(node, ctx);
    case NODE.SUBSHELL:       return await _execSubshell(node, ctx);
    case NODE.FUNCTION_DEF:   return _execFunctionDef(node, ctx);
    default: throw new Error(`geas executor: unknown node type "${node.type}"`);
  }
}

// ── top-level ──

async function _execProgram(node, ctx) {
  let exitCode = 0;
  try {
    for (const cmd of node.commands) {
      const r = await _exec(cmd, ctx);
      exitCode = r.exitCode;
      ctx.lastStatus = exitCode;
      _maybeErrexit(cmd, exitCode, ctx);
    }
  } catch (e) {
    // `exit` builtin throws { exitCode, _exit: true }; catch here to stop
    // running subsequent top-level commands. The errexit path also throws
    // an _exit signal, which routes the same way. nounset (`set -u`)
    // tags its throw with `_unbound` so we can surface the variable name.
    if (e && e._exit) {
      if (e._unbound) {
        try { await ctx.stderr(`geas: ${e._unbound}: unbound variable\n`); } catch {}
      }
      return { exitCode: e.exitCode };
    }
    throw e;
  }
  return { exitCode };
}

async function _execList(node, ctx) {
  let exitCode = 0;
  for (const item of node.items) {
    const r = await _exec(item.cmd, ctx);
    exitCode = r.exitCode;
    ctx.lastStatus = exitCode;
    _maybeErrexit(item.cmd, exitCode, ctx);
    // v0: `&` runs synchronously, same as `;`.
  }
  return { exitCode };
}

async function _execAndOr(node, ctx) {
  // The left side of && / || is a "tested" command (its exit code drives
  // the chain decision), so errexit doesn't trigger on it. The right side
  // inherits the caller's _inCondition — at the top level that's false,
  // so the rightmost actually-evaluated command CAN trigger errexit; for
  // nested chains like `A && B && C` the outer wraps the inner left in a
  // condition, which transitively suppresses A and B but leaves C exposed.
  const left = await _withCondition(node.left, ctx);
  ctx.lastStatus = left.exitCode;
  if (node.op === '&&' && left.exitCode !== 0) return left;
  if (node.op === '||' && left.exitCode === 0) return left;
  const right = await _exec(node.right, ctx);
  ctx.lastStatus = right.exitCode;
  return right;
}

// ── pipelines ──

async function _execPipeline(node, ctx) {
  // A `! pipeline` is a "tested" command for errexit purposes — POSIX says
  // commands whose status is being inverted with `!` do NOT trigger
  // errexit. Force _inCondition for the body's evaluation so anything
  // inside (including non-final pipefail-derived non-zero exits) is
  // suppressed, then invert the final exit. The outer _maybeErrexit()
  // also short-circuits on negated pipelines via _errexitExempt.
  if (node.negated) {
    const inner = await _withCondition({ ...node, negated: false }, ctx);
    return { exitCode: inner.exitCode === 0 ? 1 : 0 };
  }

  if (node.commands.length === 1) {
    const r = await _exec(node.commands[0], ctx);
    return { exitCode: r.exitCode };
  }

  // v0: buffered pipes. Each stage runs to completion, its stdout collected
  // and passed to the next stage as stdin. The buffer can be either string
  // chunks (POSIX-shape) OR a single Typed value (GCU-shape typed pipe):
  //
  //   - If a stage emits a Typed value via ctx.stdout({__geas_typed, ...}),
  //     the next stage's stdin is that Typed object directly.
  //   - If a stage emits text, the next stage's stdin is the concatenated
  //     string.
  //   - If both happen in the same stage (mixed), text wins (Typed values
  //     are dropped). Stages should emit either-or, not both.
  //
  // Consumers that don't understand the Typed kind get text via the value's
  // toString() — see typed.js for the protocol contract.
  let pipeIn = ctx.stdin;
  const exits = [];
  for (let i = 0; i < node.commands.length; i++) {
    const isLast = i === node.commands.length - 1;
    let bufOut = [];
    let bufTyped = null;
    const subCtx = {
      ...ctx,
      stdin: pipeIn,
      stdout: isLast ? ctx.stdout : (value) => {
        if (value && typeof value === 'object' && value.__geas_typed === true) {
          bufTyped = value;
        } else {
          bufOut.push(typeof value === 'string' ? value : String(value));
        }
      },
    };
    const r = await _exec(node.commands[i], subCtx);
    exits.push(r.exitCode);
    if (!isLast) {
      // Prefer Typed if the stage emitted one — otherwise concat text.
      pipeIn = bufTyped !== null ? bufTyped : bufOut.join('');
    }
  }
  // POSIX pipefail: pipeline exit code is the rightmost non-zero stage,
  // or 0 if all succeeded. Without pipefail, only the last stage's exit
  // counts. (We use first non-zero here — bash returns "last non-zero",
  // which is the same when only one stage fails; for multi-failure
  // cases, "first non-zero" tends to be more useful for diagnosis.)
  const lastExit = exits[exits.length - 1];
  const finalExit = ctx.options.pipefail
    ? (exits.find(c => c !== 0) ?? 0)
    : lastExit;
  return { exitCode: finalExit };
}

// ── simple commands ──

async function _execSimpleCommand(node, ctx) {
  // 1. Expand assignments. If there are no words (no command name), apply
  //    them to ctx.env permanently. Otherwise, scope them to this command
  //    only (POSIX semantics).
  const assignmentBindings = [];
  for (const a of node.assignments) {
    const value = await _expandWord(a.value, ctx);
    assignmentBindings.push([a.name, value]);
  }
  if (node.words.length === 0) {
    for (const [n, v] of assignmentBindings) ctx.env.set(n, v);
    return { exitCode: 0 };
  }

  // 2. Set up sub-context for per-command assignments + redirects.
  //    Only create a fresh subCtx when we actually need isolation —
  //    otherwise pass the parent ctx through directly so builtins that
  //    mutate state (cd → ctx.cwd, exit → throws) see the right object.
  //    POSIX: per-command assignments scope only to that command; redirects
  //    only affect that command's stdio. Plain builtins with no
  //    assignments/redirects can (and should) mutate the parent ctx.
  let subCtx = ctx;
  const needsScope =
    assignmentBindings.length > 0 ||
    (node.redirects && node.redirects.length > 0);
  if (needsScope) {
    subCtx = { ...ctx };
    if (assignmentBindings.length > 0) {
      subCtx.env = new Map(ctx.env);
      for (const [n, v] of assignmentBindings) subCtx.env.set(n, v);
    }
    await _applyRedirects(node.redirects, subCtx);
  }

  // 3. Expand command name + args. Argv expansion (unlike redirect targets)
  //    is subject to field splitting on $IFS and pathname (glob) expansion,
  //    so a single Word can produce zero, one, or many argv entries.
  const argv = [];
  for (const w of node.words) {
    const fields = await _expandWordToFields(w, subCtx);
    for (const f of fields) argv.push(f);
  }
  // POSIX: if all words expand to nothing (e.g. `$EMPTY $UNDEFINED`),
  // there's no command to run — exit 0 (assignments + redirects above
  // are the side effect).
  if (argv.length === 0) return { exitCode: 0 };
  const cmdName = argv[0];

  // 4. Dispatch.
  let exitCode = 127;
  try {
    if (ctx.builtins.has(cmdName)) {
      const r = await ctx.builtins.get(cmdName)(argv, subCtx);
      exitCode = typeof r === 'number' ? r : 0;
    } else if (ctx.functions.has(cmdName)) {
      // Functions: execute the body in a context with $1..$N bound. v0
      // doesn't do full call-frame isolation — just runs the body with
      // positional params overlaid.
      const fnBody = ctx.functions.get(cmdName).body;
      const r = await _exec(fnBody, subCtx);
      exitCode = r.exitCode;
    } else {
      exitCode = await ctx.onCommand(cmdName, argv, subCtx);
    }
  } catch (e) {
    // The `exit` builtin throws { exitCode, _exit: true } to signal full
    // script termination — re-throw so _execProgram catches it instead of
    // smoothing it over into a normal exit code. Plain { exitCode } throws
    // (no _exit marker) are treated as the command's exit code.
    if (e && e._exit) throw e;
    if (e && typeof e.exitCode === 'number') exitCode = e.exitCode;
    else throw e;
  }
  ctx.lastStatus = exitCode;
  return { exitCode };
}

// ── compound commands ──

async function _execIf(node, ctx) {
  const cond = await _withCondition(node.cond, ctx);
  if (cond.exitCode === 0) return await _exec(node.then, ctx);
  for (const elif of node.elifs) {
    const c = await _withCondition(elif.cond, ctx);
    if (c.exitCode === 0) return await _exec(elif.then, ctx);
  }
  if (node.else) return await _exec(node.else, ctx);
  return { exitCode: 0 };
}

async function _execFor(node, ctx) {
  // POSIX: `for x` (no `in`) iterates over "$@" — the positional params.
  // v0 doesn't have positional params plumbed through; treat as no-op
  // iteration in that case.
  //
  // Field expansion: each word can yield multiple values via $list-splitting
  // or glob expansion (`for f in *.csv`), so flatten with the splitting
  // surface rather than the single-string one.
  const values = [];
  if (node.words) {
    for (const w of node.words) {
      const fields = await _expandWordToFields(w, ctx);
      for (const f of fields) values.push(f);
    }
  }
  let exitCode = 0;
  for (const v of values) {
    ctx.env.set(node.name, v);
    try {
      const r = await _exec(node.body, ctx);
      exitCode = r.exitCode;
    } catch (e) {
      if (e === ctx._BREAK) return { exitCode };
      if (e === ctx._CONTINUE) continue;
      throw e;
    }
  }
  return { exitCode };
}

async function _execWhile(node, ctx) {
  let exitCode = 0;
  // POSIX safety net: cap iterations to a large but bounded number so a
  // pure infinite loop in a notebook cell doesn't hang the worker. Real
  // shells don't do this; we choose to because we're running in someone's
  // browser. Override by setting ctx.maxWhileIters.
  const maxIters = ctx.maxWhileIters ?? 1_000_000;
  let n = 0;
  while (true) {
    if (++n > maxIters) {
      throw new Error(`geas: while-loop exceeded ${maxIters} iterations (set ctx.maxWhileIters to raise)`);
    }
    const cond = await _withCondition(node.cond, ctx);
    if (cond.exitCode !== 0) break;
    try {
      const r = await _exec(node.body, ctx);
      exitCode = r.exitCode;
    } catch (e) {
      if (e === ctx._BREAK) break;
      if (e === ctx._CONTINUE) continue;
      throw e;
    }
  }
  return { exitCode };
}

async function _execUntil(node, ctx) {
  let exitCode = 0;
  const maxIters = ctx.maxWhileIters ?? 1_000_000;
  let n = 0;
  while (true) {
    if (++n > maxIters) {
      throw new Error(`geas: until-loop exceeded ${maxIters} iterations`);
    }
    const cond = await _withCondition(node.cond, ctx);
    if (cond.exitCode === 0) break;
    try {
      const r = await _exec(node.body, ctx);
      exitCode = r.exitCode;
    } catch (e) {
      if (e === ctx._BREAK) break;
      if (e === ctx._CONTINUE) continue;
      throw e;
    }
  }
  return { exitCode };
}

async function _execCase(node, ctx) {
  const word = await _expandWord(node.word, ctx);
  for (const item of node.items) {
    for (const pat of item.patterns) {
      const patStr = await _expandWord(pat, ctx);
      if (_globMatch(patStr, word)) {
        if (item.body) {
          const r = await _exec(item.body, ctx);
          return r;
        }
        return { exitCode: 0 };
      }
    }
  }
  return { exitCode: 0 };
}

async function _execBraceGroup(node, ctx) {
  const subCtx = { ...ctx };
  await _applyRedirects(node.redirects, subCtx);
  return await _exec(node.body, subCtx);
}

async function _execSubshell(node, ctx) {
  // POSIX: subshells run in a copy of the parent's environment so
  // mutations don't leak out. v0 approximates by giving a shallow copy
  // of env + cwd. Function definitions and lastStatus reset semantics
  // are deferred until there's a need.
  const subCtx = { ...ctx, env: new Map(ctx.env) };
  await _applyRedirects(node.redirects, subCtx);
  return await _exec(node.body, subCtx);
}

function _execFunctionDef(node, ctx) {
  ctx.functions.set(node.name, node);
  return { exitCode: 0 };
}

// ── redirects ──

async function _applyRedirects(redirects, ctx) {
  if (!redirects || redirects.length === 0) return;
  for (const r of redirects) {
    const target = await _expandWord(r.target, ctx);
    switch (r.op) {
      case '>':
      case '>|': {
        _requireVfs(ctx, 'redirect >');
        const path = _resolvePath(target, ctx);
        const chunks = [];
        ctx.stdout = (text) => { chunks.push(String(text)); };
        // Flush on next tick? No — POSIX: a write redirect truncates first
        // then writes as the command produces. We can't easily intercept
        // post-execution finalisation here, so buffer everything and write
        // on the next applied redirect's overwrite. The caller is expected
        // to await the command's completion before observing the file.
        // v0 compromise: write everything at the end of the command via a
        // commit hook. For now, we use a setter that writes immediately on
        // each call, opening in truncate mode on first call:
        let firstWrite = true;
        ctx.stdout = async (text) => {
          if (firstWrite) {
            await ctx.vfs.writeFile(path, String(text));
            firstWrite = false;
          } else {
            // Append. Real POSIX would keep the fd open; we read+rewrite.
            // Inefficient but simple for v0.
            let prior;
            try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
            await ctx.vfs.writeFile(path, prior + String(text));
          }
        };
        break;
      }
      case '>>': {
        _requireVfs(ctx, 'redirect >>');
        const path = _resolvePath(target, ctx);
        ctx.stdout = async (text) => {
          let prior;
          try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
          await ctx.vfs.writeFile(path, prior + String(text));
        };
        break;
      }
      case '<': {
        _requireVfs(ctx, 'redirect <');
        const path = _resolvePath(target, ctx);
        ctx.stdin = await ctx.vfs.readFile(path, 'text');
        break;
      }
      case '<<':
      case '<<-': {
        // Here-doc body was attached at parse time.
        let body = r.body ?? '';
        if (!r.bodyQuoted) {
          // Expand $vars and $(cmd) in body text.
          body = await _expandTextString(body, ctx);
        }
        ctx.stdin = body;
        break;
      }
      // For 2>, 2>&1, etc., fd-targeted redirects:
      default: {
        if (r.op === '>' && r.fd === 2) {
          // (Handled above when r.fd is null; here for fd=2)
        }
        if (r.op === '>' || r.op === '>|') {
          if (r.fd === 2) {
            _requireVfs(ctx, 'redirect 2>');
            const path = _resolvePath(target, ctx);
            ctx.stderr = async (text) => { await ctx.vfs.writeFile(path, String(text)); };
          }
        }
        if (r.op === '>&' || r.op === '<&') {
          // Duplicate fd. `2>&1` is the common case (stderr → stdout).
          if (r.fd === 2 && target === '1') ctx.stderr = ctx.stdout;
          if (r.fd === 1 && target === '2') ctx.stdout = ctx.stderr;
          // Other dup combinations are rare; skip for v0.
        }
      }
    }
  }
}

function _requireVfs(ctx, what) {
  if (!ctx.vfs) throw new Error(`geas: ${what} requires a VFS in context`);
}

function _resolvePath(p, ctx) {
  if (p.startsWith('/')) return p;
  // Simple POSIX join: cwd + '/' + path. Doesn't normalise '../' etc.
  // The VFS itself can handle that on its end.
  return ctx.cwd.endsWith('/') ? ctx.cwd + p : ctx.cwd + '/' + p;
}

// ── word expansion ──
//
// Two surfaces:
//   _expandWord(word, ctx) → string
//     Concatenates parts, NO field splitting or globbing. Used for
//     redirect targets, case patterns, heredoc delimiters — anywhere
//     POSIX says expansion produces a single field.
//
//   _expandWordToFields(word, ctx) → string[]
//     Full POSIX expansion: substitution → field splitting on $IFS →
//     pathname expansion (glob). Used for argv positions (command name
//     + args) and `for ... in` lists, where one word can yield 0-N fields.

async function _expandWord(word, ctx) {
  if (!word || !word.parts) return word?.value ?? '';
  let out = '';
  for (const part of word.parts) {
    out += await _expandPart(part, ctx);
  }
  return out;
}

// Field-aware expansion. Walks parts producing "fragments" — pairs of
// (text, splittable?) — then runs IFS-based field splitting only at
// splittable boundaries. Literal/quoted text never splits, even if it
// contains spaces. Finally glob-expands each resulting field against
// ctx.vfs when the field contains pattern metacharacters.
async function _expandWordToFields(word, ctx) {
  if (!word || !word.parts) {
    return word?.value !== undefined ? [word.value] : [];
  }
  const frags = [];
  for (const part of word.parts) await _expandPartToFrags(part, ctx, frags, /*inQuote*/ false);
  // Pair each field with a "had any quoted contribution" flag so we know
  // whether to attempt glob expansion. POSIX: glob chars introduced via
  // quoted text are LITERAL (`"/a/*.txt"` doesn't expand). v0 simplifies
  // to per-field rather than per-character — if any contributing fragment
  // was quoted, skip globbing for that whole field. The common cases
  // (`*.txt` unquoted, `"/dir/*.txt"` quoted) work; the mixed case
  // (`"/dir"/*.txt`) errs on the safe side of not-globbing.
  const fieldsWithMeta = _splitFieldsWithMeta(frags, _getIFS(ctx));
  if (!ctx.vfs) return fieldsWithMeta.map(f => f.text);
  const out = [];
  for (const f of fieldsWithMeta) {
    if (f.anyQuoted || !_hasGlobChars(f.text)) { out.push(f.text); continue; }
    const matches = await _globExpand(f.text, ctx);
    if (matches.length === 0) out.push(f.text);
    else for (const m of matches) out.push(m);
  }
  return out;
}

// Fragment shape: { t: text, s: splittable, q: quoted-source }
// - s (splittable): true iff IFS-splitting should happen across this frag's chars
// - q (quoted-source): true iff this frag contributed by a quoted (dq/sq/escape)
//                     source; used downstream to suppress globbing on the
//                     resulting field.
async function _expandPartToFrags(part, ctx, frags, inQuote) {
  switch (part.kind) {
    case 'lit':    frags.push({ t: part.value, s: false, q: inQuote });            return;
    case 'sq':     frags.push({ t: part.value, s: false, q: true });               return;
    case 'escape': frags.push({ t: part.value, s: false, q: true });               return;
    case 'dq': {
      // Everything inside dq is quoted + non-splittable. Empty `""` still
      // contributes a sentinel frag so `cat ""` keeps its empty argv slot.
      const before = frags.length;
      for (const p of part.parts) await _expandPartToFrags(p, ctx, frags, /*inQuote*/ true);
      if (frags.length === before) frags.push({ t: '', s: false, q: true });
      return;
    }
    case 'var':    frags.push({ t: _lookupVar(part.name, ctx),        s: !inQuote, q: inQuote }); return;
    case 'param':  frags.push({ t: await _expandParam(part, ctx),     s: !inQuote, q: inQuote }); return;
    case 'cmd':    frags.push({ t: await _runCmdSub(part.body, ctx),  s: !inQuote, q: inQuote }); return;
    case 'arith':  frags.push({ t: _evalArith(part.body, ctx),        s: !inQuote, q: inQuote }); return;
  }
}

// Field-split fragments on IFS. Whitespace IFS chars (' ', '\t', '\n')
// are POSIX "whitespace IFS" — runs of them treat as one separator and
// leading/trailing runs are stripped. Non-whitespace IFS chars each
// separate one field (allowing empty fields). For v0 we honour both.
// Variant that returns [{text, anyQuoted}] so the caller knows whether to
// glob-expand each field. Per-field, anyQuoted is the OR of contributing
// fragments' q flag — once a quoted source has touched the field, glob
// chars in that field are treated as literal.
function _splitFieldsWithMeta(frags, ifs) {
  if (frags.length === 0) return [];
  // Build a marker-tagged string: '' marks where a splittable run
  // began, '' where it ended. Then walk, splitting only between
  // markers' contents on IFS chars.
  //
  // Simpler approach: produce fields by streaming. Maintain `cur` string
  // accumulator + emit when a splittable fragment yields an IFS char that
  // closes the current field.
  const wsIFS = new Set();
  const otherIFS = new Set();
  for (const c of ifs) {
    if (c === ' ' || c === '\t' || c === '\n') wsIFS.add(c);
    else otherIFS.add(c);
  }
  const out = [];
  let cur = '';
  let curAnyQuoted = false;
  let curHasContent = false;
  let seenSplittable = false;
  let pendingWsBoundary = false;
  const emit = () => {
    out.push({ text: cur, anyQuoted: curAnyQuoted });
    cur = ''; curAnyQuoted = false; curHasContent = false;
  };
  for (const frag of frags) {
    if (!frag.s) {
      if (pendingWsBoundary && curHasContent) emit();
      pendingWsBoundary = false;
      cur += frag.t;
      if (frag.t.length > 0) curHasContent = true;
      if (frag.q) curAnyQuoted = true;
      continue;
    }
    seenSplittable = true;
    for (const ch of frag.t) {
      if (wsIFS.has(ch)) {
        if (curHasContent) pendingWsBoundary = true;
        continue;
      }
      if (otherIFS.has(ch)) {
        if (curHasContent || !pendingWsBoundary) emit();
        else { cur = ''; curAnyQuoted = false; curHasContent = false; }
        pendingWsBoundary = false;
        continue;
      }
      if (pendingWsBoundary && curHasContent) emit();
      pendingWsBoundary = false;
      cur += ch;
      curHasContent = true;
      // splittable frag → unquoted-sourced; do NOT set curAnyQuoted
    }
  }
  if (curHasContent) emit();
  // Edge case (same as before): a Word with only non-splittable empty
  // frags (e.g. `""`) must still produce one empty field.
  if (out.length === 0 && !seenSplittable) {
    return [{ text: cur, anyQuoted: curAnyQuoted }];
  }
  return out;
}

function _getIFS(ctx) {
  return ctx.env.get('IFS') ?? ' \t\n';
}

// ── pathname expansion (glob) ──

function _hasGlobChars(s) {
  return /[*?\[]/.test(s);
}

async function _globExpand(pattern, ctx) {
  // VFS.glob handles absolute patterns natively. For relative, resolve
  // against ctx.cwd first, then strip the cwd prefix back off the results
  // so the returned fields stay relative — matching shell convention.
  const isRel = !pattern.startsWith('/');
  const fullPattern = isRel
    ? (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + pattern
    : pattern;
  let matches = [];
  try {
    matches = await ctx.vfs.glob(fullPattern);
  } catch {
    return [];
  }
  if (isRel) {
    const prefix = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    matches = matches.map(p => p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return matches.sort();
}

async function _expandPart(part, ctx) {
  switch (part.kind) {
    case 'lit':    return part.value;
    case 'sq':     return part.value;
    case 'escape': return part.value;
    case 'dq': {
      let out = '';
      for (const p of part.parts) out += await _expandPart(p, ctx);
      return out;
    }
    case 'var':   return _lookupVar(part.name, ctx);
    case 'param': return await _expandParam(part, ctx);
    case 'cmd':   return await _runCmdSub(part.body, ctx);
    case 'arith': return _evalArith(part.body, ctx);
    default: return '';
  }
}

function _lookupVar(name, ctx) {
  // Special parameters.
  if (name === '?') return String(ctx.lastStatus);
  if (name === '#') return String((ctx.positional || []).length);
  if (name === '@') return (ctx.positional || []).join(' ');
  if (name === '*') return (ctx.positional || []).join(' ');
  if (name === '$') return String(typeof process !== 'undefined' ? process.pid : 0);
  if (/^\d+$/.test(name)) {
    const idx = Number(name);
    if (idx === 0) return ctx.env.get('0') ?? 'geas';
    return (ctx.positional || [])[idx - 1] ?? '';
  }
  if (ctx.env.has(name)) return ctx.env.get(name);
  // POSIX nounset (`set -u`): unbound named variable is a fatal error.
  // Throws an _exit signal so _execProgram halts the script. Special
  // params, positional, and the parameter-expansion forms `${X:-d}` /
  // `${X-d}` / `${X:+v}` / `${X+v}` route around _lookupVar (they go
  // through _expandParam directly), which preserves POSIX semantics.
  if (ctx.options && ctx.options.nounset) {
    throw { exitCode: 1, _exit: true, _unbound: name };
  }
  return '';
}

async function _expandParam(part, ctx) {
  const set = ctx.env.has(part.name);
  const val = set ? ctx.env.get(part.name) : '';
  const isNull = !val;
  switch (part.op) {
    case '#':  return String(val.length);
    case ':-': return (!set || isNull) ? await _expandWord(part.word, ctx) : val;
    case '-':  return (!set)           ? await _expandWord(part.word, ctx) : val;
    case ':=': {
      if (!set || isNull) {
        const def = await _expandWord(part.word, ctx);
        ctx.env.set(part.name, def);
        return def;
      }
      return val;
    }
    case '=': {
      if (!set) {
        const def = await _expandWord(part.word, ctx);
        ctx.env.set(part.name, def);
        return def;
      }
      return val;
    }
    case ':?': {
      if (!set || isNull) {
        const msg = part.word ? await _expandWord(part.word, ctx) : `${part.name}: parameter null or not set`;
        await ctx.stderr(msg + '\n');
        throw { exitCode: 1 };
      }
      return val;
    }
    case '?': {
      if (!set) {
        const msg = part.word ? await _expandWord(part.word, ctx) : `${part.name}: parameter not set`;
        await ctx.stderr(msg + '\n');
        throw { exitCode: 1 };
      }
      return val;
    }
    case ':+': return (set && !isNull) ? await _expandWord(part.word, ctx) : '';
    case '+':  return (set)             ? await _expandWord(part.word, ctx) : '';
    // Prefix/suffix removal — v0 implements basic literal-only matching.
    case '#':
    case '##':
    case '%':
    case '%%': {
      const pat = part.word ? await _expandWord(part.word, ctx) : '';
      return _patternRemove(val, pat, part.op);
    }
    default: return val;
  }
}

function _patternRemove(s, pat, op) {
  // Convert POSIX glob to regex anchored at start (# / ##) or end (% / %%).
  const re = _globToRegExp(pat);
  if (op === '#') {
    const m = s.match(new RegExp('^' + re.source));
    if (!m) return s;
    // Shortest match: try progressively longer until one fits, take the first.
    // Simpler approach: lazy regex.
    const lazy = new RegExp('^(' + re.source + '?)');
    const mm = s.match(lazy);
    return mm ? s.slice(mm[0].length) : s;
  }
  if (op === '##') {
    const greedy = new RegExp('^(' + re.source + ')');
    const m = s.match(greedy);
    return m ? s.slice(m[0].length) : s;
  }
  if (op === '%') {
    // Suffix shortest: scan from end forward, find shortest match.
    for (let i = s.length; i >= 0; i--) {
      const suffix = s.slice(i);
      if (new RegExp('^' + re.source + '$').test(suffix)) return s.slice(0, i);
    }
    return s;
  }
  if (op === '%%') {
    // Suffix longest: scan from start, find longest match.
    for (let i = 0; i <= s.length; i++) {
      const suffix = s.slice(i);
      if (new RegExp('^' + re.source + '$').test(suffix)) return s.slice(0, i);
    }
    return s;
  }
  return s;
}

async function _runCmdSub(body, ctx) {
  // Parse + execute the body in a sub-context with a buffered stdout.
  // Lazy import to avoid a circular dep (parser already imports nothing
  // from executor, but we keep the surface minimal).
  const { parse } = await import('./parser.js');
  const ast = parse(body);
  const chunks = [];
  const subCtx = { ...ctx, stdout: (t) => { chunks.push(String(t)); } };
  await _exec(ast, subCtx);
  // POSIX: trailing newlines are stripped from $(...) result.
  return chunks.join('').replace(/\n+$/, '');
}

function _evalArith(body, ctx) {
  // v0: very basic. Substitute $vars and bare names → values, then eval as
  // JS expression. POSIX arith is a separate sub-language; full impl later.
  let src = body;
  src = src.replace(/\$([a-zA-Z_]\w*)/g, (_, n) => ctx.env.get(n) ?? '0');
  src = src.replace(/\b([a-zA-Z_]\w*)\b/g, (m, n) => {
    // Bare names also get var-substituted in arith context.
    return ctx.env.get(n) ?? '0';
  });
  // Restrict to digits / operators / parens / whitespace before eval'ing.
  if (!/^[\d\s+\-*/%()<>=!&|^~]+$/.test(src)) return '0';
  try { return String(Number(eval(src)) | 0); } catch { return '0'; }
}

// Expand $vars and $(cmd) inside a raw string (for here-doc bodies that
// weren't quoted). Reuses parseWordParts to get structure.
async function _expandTextString(text, ctx) {
  const { parseWordParts } = await import('./word-parts.js');
  const parts = parseWordParts(text);
  let out = '';
  for (const p of parts) out += await _expandPart(p, ctx);
  return out;
}

// ── glob matching (for case patterns) ──

function _globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; }
      else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close;
      }
    }
    else if ('.+^$()|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re);
}

function _globMatch(pattern, value) {
  const re = new RegExp('^(' + _globToRegExp(pattern).source + ')$');
  return re.test(value);
}

// -- builtins-typed.js --

// Typed-pipe-aware built-ins. These produce or consume Typed table values
// instead of (or in addition to) text. The shell auto-registers them via
// defaultBuiltins(); third-party builtins from the GCU stack (e.g. a
// future sadpan-backed `read-csv`) can override.
//
// Demo surface for v0:
//
//   from-csv FILE | where 'COL > N' | select COL1 COL2 | to-csv
//
// `from-csv` produces a Typed table; `where` and `select` consume and
// produce Typed tables (passing through unchanged when their input is text
// — they parse the text as CSV on the fly); `to-csv` serialises back to
// text. Mix-and-match with text builtins works because Typed.toString()
// returns the canonical CSV text, so e.g. `from-csv f.csv | head -n 5`
// degrades gracefully (head reads the CSV text and slices the first 5
// lines, ignoring that columns are involved).


function defaultTypedBuiltins() {
  return {
    'from-csv': _fromCsv,
    'to-csv':   _toCsv,
    where:      _where,
    select:     _select,
    'first':    _first,
    'last':     _last,
  };
}

// Read a CSV from file (or stdin) and emit a Typed table downstream.
async function _fromCsv(argv, ctx) {
  const path = argv[1];
  let text;
  try {
    if (path) {
      if (!ctx.vfs) {
        await ctx.stderr('from-csv: no VFS configured\n');
        return 1;
      }
      const abs = path.startsWith('/') ? path
        : (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + path;
      text = await ctx.vfs.readFile(abs, 'text');
    } else {
      // No path → read from stdin.
      text = ctx.stdin == null ? ''
        : typeof ctx.stdin === 'string' ? ctx.stdin
        : String(ctx.stdin);
    }
  } catch (e) {
    await ctx.stderr(`from-csv: ${e.message}\n`);
    return 1;
  }
  const table = parseCSV(text);
  await ctx.stdout(mkTyped('table', table, () => serializeCSV(table)));
  return 0;
}

// Convert Typed table → CSV text. Idempotent on text input.
async function _toCsv(_argv, ctx) {
  const v = ctx.stdin;
  if (isTyped(v) && v.kind === 'table') {
    await ctx.stdout(serializeCSV(v.value));
    return 0;
  }
  // Already text — pass through.
  await ctx.stdout(typeof v === 'string' ? v : String(v ?? ''));
  return 0;
}

// where 'COL OP VALUE' — filter table rows. Operators: == != > < >= <=
// VALUE may be a number (compared numerically) or a quoted-or-bare string.
// On text input, parses as CSV first; on Typed input, operates directly.
async function _where(argv, ctx) {
  const expr = argv[1];
  if (!expr) {
    await ctx.stderr('where: missing expression\n');
    return 2;
  }
  const pred = _compilePredicate(expr);
  if (!pred) {
    await ctx.stderr(`where: cannot parse expression "${expr}"\n`);
    return 2;
  }
  const table = await _consumeTable(ctx);
  const colIdx = table.columns.indexOf(pred.col);
  if (colIdx < 0) {
    await ctx.stderr(`where: no column "${pred.col}"\n`);
    return 2;
  }
  const filtered = {
    columns: table.columns,
    rows: table.rows.filter(r => pred.test(r[colIdx])),
  };
  await ctx.stdout(mkTyped('table', filtered, () => serializeCSV(filtered)));
  return 0;
}

// select COL1 COL2 ... — project columns by name. Unknown columns warned
// on stderr; the result drops them but doesn't fail.
async function _select(argv, ctx) {
  const names = argv.slice(1);
  if (names.length === 0) {
    await ctx.stderr('select: missing column names\n');
    return 2;
  }
  const table = await _consumeTable(ctx);
  const indices = names.map(n => {
    const i = table.columns.indexOf(n);
    if (i < 0) ctx.stderr(`select: warning: no column "${n}"\n`);
    return i;
  }).filter(i => i >= 0);
  const projected = {
    columns: indices.map(i => table.columns[i]),
    rows: table.rows.map(r => indices.map(i => r[i])),
  };
  await ctx.stdout(mkTyped('table', projected, () => serializeCSV(projected)));
  return 0;
}

// first [N] / last [N] — slice first/last N rows. Defaults to 5.
async function _first(argv, ctx) {
  const n = argv[1] ? Math.max(0, parseInt(argv[1], 10)) : 5;
  const table = await _consumeTable(ctx);
  const sliced = { columns: table.columns, rows: table.rows.slice(0, n) };
  await ctx.stdout(mkTyped('table', sliced, () => serializeCSV(sliced)));
  return 0;
}
async function _last(argv, ctx) {
  const n = argv[1] ? Math.max(0, parseInt(argv[1], 10)) : 5;
  const table = await _consumeTable(ctx);
  const sliced = { columns: table.columns, rows: table.rows.slice(-n) };
  await ctx.stdout(mkTyped('table', sliced, () => serializeCSV(sliced)));
  return 0;
}

// Common: pull a table out of ctx.stdin, parsing text if needed.
async function _consumeTable(ctx) {
  if (isTyped(ctx.stdin) && ctx.stdin.kind === 'table') {
    return ctx.stdin.value;
  }
  const text = ctx.stdin == null ? '' : String(ctx.stdin);
  return parseCSV(text);
}

// ── predicate parser for `where` ──
//
// Grammar (v0):
//   COL OP RHS
//   COL  := identifier or quoted string
//   OP   := == | != | >= | <= | > | <
//   RHS  := number | "quoted string" | 'quoted string' | bare identifier
//
// Returns { col, op, test: (cellValue) => bool } or null on parse failure.
function _compilePredicate(expr) {
  const m = expr.match(/^\s*([A-Za-z_][A-Za-z0-9_]*|"[^"]*"|'[^']*')\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!m) return null;
  let col = m[1];
  const op = m[2];
  let rhs = m[3];
  if ((col.startsWith('"') && col.endsWith('"')) ||
      (col.startsWith("'") && col.endsWith("'"))) col = col.slice(1, -1);
  // Unquote RHS if it's a quoted string; otherwise try numeric.
  let rhsVal;
  if ((rhs.startsWith('"') && rhs.endsWith('"')) ||
      (rhs.startsWith("'") && rhs.endsWith("'"))) {
    rhsVal = rhs.slice(1, -1);
  } else if (/^-?\d+(?:\.\d+)?$/.test(rhs)) {
    rhsVal = Number(rhs);
  } else {
    rhsVal = rhs;
  }
  const numericCompare = typeof rhsVal === 'number';
  const test = (cell) => {
    let a = cell;
    let b = rhsVal;
    if (numericCompare) {
      a = Number(cell);
      if (Number.isNaN(a)) return false;
    } else {
      a = String(cell ?? '');
      b = String(b);
    }
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a >  b;
      case '<':  return a <  b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
    return false;
  };
  return { col, op, test };
}

// -- builtins.js --

// Default built-ins for geas. Each is `async (argv, ctx) => exitCode`.
//
// The shell ships with a small POSIX-shape set covering the everyday
// operations a notebook user reaches for: I/O glue (echo, cat), navigation
// (pwd, cd, ls), env management (env, export, exit, :), and conditionals
// (test / [). More complete coverage lives in `@gcu/coreutils` (separate
// package, dispatched via ctx.onCommand when geas doesn't recognise a name).
//
// Built-ins MUST read input from ctx.stdin (a string in v0) and write
// output through `await ctx.stdout(...)` / `ctx.stderr(...)` rather than
// any other channel — that's how pipeline routing reaches them.


// Construct a fresh map of the default builtins. Returns a new Map per call
// so consumers can mutate (add/override) without affecting other shells.
function defaultBuiltins() {
  return new Map(Object.entries({
    ...defaultTypedBuiltins(),
    ':':      _colon,
    echo:     _echo,
    printf:   _printf,
    true:     _true,
    false:    _false,
    pwd:      _pwd,
    cd:       _cd,
    env:      _env,
    export:   _export,
    exit:     _exit,
    set:      _set,
    read:     _read,
    which:    _which,
    command:  _command,
    cat:      _cat,
    ls:       _ls,
    test:     _test,
    '[':      _testBracket,
    // Generators
    seq:      _seq,
    sleep:    _sleep,
    date:     _date,
    // Filesystem
    mkdir:    _mkdir,
    rm:       _rm,
    touch:    _touch,
    // Text wranglers
    head:     _head,
    tail:     _tail,
    wc:       _wc,
    grep:     _grep,
    sort:     _sort,
    uniq:     _uniq,
    cut:      _cut,
    tee:      _tee,
    xargs:    _xargs,
  }));
}

// ── individual builtins ──

async function _colon() { return 0; }

async function _echo(argv, ctx) {
  const args = argv.slice(1);
  let newline = true;
  // Support `-n` (no trailing newline) and `-e` (interpret backslash
  // escapes — for v0 just accept and ignore, treat literally).
  while (args.length && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    args.shift();
  }
  await ctx.stdout(args.join(' ') + (newline ? '\n' : ''));
  return 0;
}

async function _true() { return 0; }
async function _false() { return 1; }

async function _pwd(_argv, ctx) {
  await ctx.stdout((ctx.cwd || '/') + '\n');
  return 0;
}

async function _cd(argv, ctx) {
  let target = argv[1];
  if (!target || target === '~') {
    target = ctx.env.get('HOME') || '/';
  } else if (target === '-') {
    target = ctx.env.get('OLDPWD');
    if (!target) {
      await ctx.stderr('cd: OLDPWD not set\n');
      return 1;
    }
    await ctx.stdout(target + '\n');
  } else if (target.startsWith('~/')) {
    target = (ctx.env.get('HOME') || '') + target.slice(1);
  }
  // Make absolute via the existing cwd if needed.
  if (!target.startsWith('/')) {
    const base = ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/';
    target = base + target;
  }
  // Normalise simple `..` / `.` segments.
  target = _bNormalizePath(target);
  // Verify target exists if we have a VFS (otherwise trust the caller).
  if (ctx.vfs) {
    try {
      const st = await ctx.vfs.stat(target);
      if (st && st.type !== 'directory') {
        await ctx.stderr(`cd: not a directory: ${target}\n`);
        return 1;
      }
    } catch {
      await ctx.stderr(`cd: no such directory: ${target}\n`);
      return 1;
    }
  }
  ctx.env.set('OLDPWD', ctx.cwd);
  ctx.cwd = target;
  ctx.env.set('PWD', target);
  return 0;
}

async function _env(argv, ctx) {
  // `env` with no args lists the environment.
  // `env NAME=value... cmd args...` runs cmd with overlaid env (v0: just
  // sets in current env; no "run" semantics).
  const overlays = [];
  let i = 1;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
    overlays.push(argv[i]);
    i++;
  }
  if (overlays.length === 0 && i >= argv.length) {
    // List.
    for (const [k, v] of ctx.env) {
      await ctx.stdout(`${k}=${v}\n`);
    }
    return 0;
  }
  // Apply overlays.
  for (const a of overlays) {
    const eq = a.indexOf('=');
    ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
  }
  if (i < argv.length) {
    // env NAME=value cmd args… — run the remaining via the builtin lookup.
    const rest = argv.slice(i);
    const name = rest[0];
    if (ctx.builtins.has(name)) {
      return await ctx.builtins.get(name)(rest, ctx);
    }
    if (ctx.onCommand) {
      return await ctx.onCommand(name, rest, ctx);
    }
    await ctx.stderr(`env: ${name}: command not found\n`);
    return 127;
  }
  return 0;
}

async function _export(argv, ctx) {
  // `export NAME=value` — for v0 just sets in ctx.env (POSIX would mark
  // as "exportable to subprocesses"; we don't distinguish).
  // `export NAME` — marks an existing variable for export.
  // `export` (no args) — lists exported vars.
  if (argv.length === 1) {
    for (const [k, v] of ctx.env) await ctx.stdout(`export ${k}=${v}\n`);
    return 0;
  }
  for (const a of argv.slice(1)) {
    const eq = a.indexOf('=');
    if (eq >= 0) {
      ctx.env.set(a.slice(0, eq), a.slice(eq + 1));
    } else {
      // export of existing var — already in env, no-op
    }
  }
  return 0;
}

async function _exit(argv, _ctx) {
  const code = argv[1] !== undefined ? Number(argv[1]) : 0;
  // Thrown signal; _execProgram catches and stops the script.
  throw { exitCode: Number.isFinite(code) ? (code & 0xff) : 0, _exit: true };
}

async function _cat(argv, ctx) {
  const files = argv.slice(1);
  if (files.length === 0) {
    // No args: pipe stdin through. _bReadInput handles both string stdin
    // AND Typed stdin (via Typed.toString()), so a typed-pipe upstream
    // degrades gracefully.
    await ctx.stdout(await _bReadInput([], ctx));
    return 0;
  }
  if (!ctx.vfs) {
    await ctx.stderr('cat: no VFS configured\n');
    return 1;
  }
  let anyError = 0;
  for (const f of files) {
    const path = _bResolvePath(f, ctx);
    try {
      const text = await ctx.vfs.readFile(path, 'text');
      await ctx.stdout(text);
    } catch (e) {
      await ctx.stderr(`cat: ${f}: ${e.message || 'cannot read'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _ls(argv, ctx) {
  if (!ctx.vfs) {
    await ctx.stderr('ls: no VFS configured\n');
    return 1;
  }
  // Parse args. v0 supports `-l` (long format) and `-a` (show dotfiles).
  let longFmt = false, showHidden = false;
  const paths = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      if (a.includes('l')) longFmt = true;
      if (a.includes('a')) showHidden = true;
      continue;
    }
    paths.push(a);
  }
  if (paths.length === 0) paths.push(ctx.cwd || '/');

  let anyError = 0;
  for (let p of paths) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      if (st.type === 'file') {
        await ctx.stdout(p + '\n');
        continue;
      }
      const entries = await ctx.vfs.readdir(path);
      const names = entries
        .map(e => typeof e === 'string' ? e : e.name)
        .filter(n => showHidden || !n.startsWith('.'))
        .sort();
      if (longFmt) {
        for (const n of names) {
          let line = n;
          try {
            const childPath = path.endsWith('/') ? path + n : path + '/' + n;
            const cst = await ctx.vfs.stat(childPath);
            const flag = cst.type === 'directory' ? 'd' : '-';
            const size = cst.size ?? 0;
            line = `${flag} ${String(size).padStart(8)}  ${n}`;
          } catch { /* fall through with bare name */ }
          await ctx.stdout(line + '\n');
        }
      } else {
        for (const n of names) await ctx.stdout(n + '\n');
      }
    } catch (e) {
      await ctx.stderr(`ls: ${p}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// `test` / `[` — POSIX conditional. v0 covers the common operators; full
// POSIX-spec eval (including `-a` / `-o` / parens) is on the roadmap.
async function _testBracket(argv, ctx) {
  // The `[` builtin requires the last arg to be `]`. Strip it then defer.
  if (argv[argv.length - 1] !== ']') {
    await ctx.stderr('[: missing `]\'\n');
    return 2;
  }
  return await _test(argv.slice(0, -1), ctx);
}

async function _test(argv, ctx) {
  const args = argv.slice(1);
  // Zero-arg test → false
  if (args.length === 0) return 1;
  // One-arg test: true iff non-empty
  if (args.length === 1) return args[0].length > 0 ? 0 : 1;

  // Two-arg test: unary operator
  if (args.length === 2) {
    return await _testUnary(args[0], args[1], ctx);
  }

  // Three-arg test: binary
  if (args.length === 3) {
    return await _testBinary(args[0], args[1], args[2], ctx);
  }

  // Four-arg: `! <three-arg>` or grouping not handled in v0.
  if (args.length === 4 && args[0] === '!') {
    const r = await _testBinary(args[1], args[2], args[3], ctx);
    return r === 0 ? 1 : 0;
  }

  await ctx.stderr(`test: too many arguments (v0 limit)\n`);
  return 2;
}

async function _testUnary(op, val, ctx) {
  switch (op) {
    case '-z': return val.length === 0 ? 0 : 1;
    case '-n': return val.length > 0 ? 0 : 1;
    case '-e': case '-f': case '-d': case '-s': case '-r': case '-w': case '-x': {
      if (!ctx.vfs) return 1;
      try {
        const st = await ctx.vfs.stat(_bResolvePath(val, ctx));
        if (op === '-e' || op === '-r' || op === '-w' || op === '-x') return 0;
        if (op === '-f') return st.type === 'file' ? 0 : 1;
        if (op === '-d') return st.type === 'directory' ? 0 : 1;
        if (op === '-s') return (st.size ?? 0) > 0 ? 0 : 1;
      } catch { return 1; }
    }
    case '!': {
      // ! VAL — true iff VAL is empty
      return val.length === 0 ? 0 : 1;
    }
  }
  return 2;
}

async function _testBinary(a, op, b, _ctx) {
  switch (op) {
    case '=':   return a === b ? 0 : 1;
    case '!=':  return a !== b ? 0 : 1;
    case '-eq': return _num(a) === _num(b) ? 0 : 1;
    case '-ne': return _num(a) !== _num(b) ? 0 : 1;
    case '-lt': return _num(a) <   _num(b) ? 0 : 1;
    case '-le': return _num(a) <=  _num(b) ? 0 : 1;
    case '-gt': return _num(a) >   _num(b) ? 0 : 1;
    case '-ge': return _num(a) >=  _num(b) ? 0 : 1;
  }
  return 2;
}

function _num(x) { return Number(x); }

// ── helpers ──

function _bResolvePath(p, ctx) {
  if (p.startsWith('/')) return _bNormalizePath(p);
  const base = ctx.cwd && ctx.cwd.endsWith('/') ? ctx.cwd : (ctx.cwd || '/') + '/';
  return _bNormalizePath(base + p);
}

function _bNormalizePath(p) {
  const parts = p.split('/');
  const stack = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  return '/' + stack.join('/');
}

// Argv option parsing helper. Handles `-abc` (combined short flags),
// `-n VALUE` (option arg), `--` (end of options), `-` (stdin placeholder
// kept as a positional). Returns { opts, positionals }.
function _bParseArgs(argv, spec) {
  const opts = {};
  const positionals = [];
  for (const key of Object.keys(spec)) {
    opts[key] = spec[key].default ?? (spec[key].arg ? null : false);
  }
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-') || a.length === 1) {
      positionals.push(a);
      i++;
      continue;
    }
    // Multi-char short cluster: split each.
    const cluster = a.slice(1);
    let consumedNext = false;
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k];
      const matched = Object.keys(spec).find(name => spec[name].short === ch);
      if (!matched) {
        // Unknown flag — let the caller decide. Mark as positional and stop.
        positionals.push('-' + cluster.slice(k));
        break;
      }
      if (spec[matched].arg) {
        // Take the rest of the cluster as the value, or the next argv.
        const rest = cluster.slice(k + 1);
        if (rest.length > 0) { opts[matched] = rest; }
        else { opts[matched] = argv[i + 1]; consumedNext = true; }
        break;
      }
      opts[matched] = true;
    }
    i += consumedNext ? 2 : 1;
  }
  return { opts, positionals };
}

// Read all of stdin or, when paths are given, the concatenated contents
// of those VFS files. Common to head / tail / wc / grep / sort / uniq /
// cut / tee / xargs.
//
// Typed-pipe contract: if ctx.stdin is a Typed object, fall back to its
// text rendering via toString(). Builtins that don't know about types
// transparently get the canonical text representation.
async function _bReadInput(paths, ctx) {
  if (!paths || paths.length === 0) {
    if (ctx.stdin == null) return '';
    if (typeof ctx.stdin === 'string') return ctx.stdin;
    return String(ctx.stdin);
  }
  if (!ctx.vfs) throw new Error('VFS not configured');
  const chunks = [];
  for (const p of paths) {
    chunks.push(await ctx.vfs.readFile(_bResolvePath(p, ctx), 'text'));
  }
  return chunks.join('');
}

// ── filesystem builtins ──

async function _mkdir(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('mkdir: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, { p: { short: 'p' } });
  if (positionals.length === 0) {
    await ctx.stderr('mkdir: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      await ctx.vfs.mkdir(path, opts.p ? { recursive: true } : undefined);
    } catch (e) {
      await ctx.stderr(`mkdir: ${p}: ${e.message || 'cannot create'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _rm(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('rm: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, f: { short: 'f' },
  });
  // POSIX combines -R into -r; bash accepts both. We honour either bit.
  const recursive = opts.r;
  const force = opts.f;
  if (positionals.length === 0 && !force) {
    await ctx.stderr('rm: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      if (st.type === 'directory') {
        if (!recursive) {
          await ctx.stderr(`rm: ${p}: is a directory\n`);
          anyError = 1;
          continue;
        }
        // Recursive delete: walk entries, unlink files, rmdir folders.
        await _rmRecursive(ctx.vfs, path);
      } else {
        await ctx.vfs.unlink(path);
      }
    } catch (e) {
      if (!force) {
        await ctx.stderr(`rm: ${p}: ${e.message || 'cannot remove'}\n`);
        anyError = 1;
      }
    }
  }
  return anyError;
}

async function _rmRecursive(vfs, dir) {
  const entries = await vfs.readdir(dir);
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e.name;
    const child = dir.endsWith('/') ? dir + name : dir + '/' + name;
    const st = await vfs.stat(child);
    if (st.type === 'directory') await _rmRecursive(vfs, child);
    else await vfs.unlink(child);
  }
  await vfs.rmdir(dir);
}

async function _touch(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('touch: no VFS configured\n'); return 1; }
  const { positionals } = _bParseArgs(argv, { c: { short: 'c' } });
  if (positionals.length === 0) {
    await ctx.stderr('touch: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      try { await ctx.vfs.stat(path); /* exists — POSIX would update mtime; v0 no-op */ }
      catch { await ctx.vfs.writeFile(path, ''); }
    } catch (e) {
      await ctx.stderr(`touch: ${p}: ${e.message || 'cannot touch'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// ── text wranglers ──

async function _head(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    // Preserve trailing newline state: if text ends with '\n', the last
    // element is '' and we drop it for the "lines" count.
    const trailingNL = text.endsWith('\n');
    const effective = trailingNL ? lines.slice(0, -1) : lines;
    const take = effective.slice(0, n);
    await ctx.stdout(take.join('\n') + (take.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`head: ${e.message}\n`);
    return 1;
  }
}

async function _tail(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
    const trailingNL = text.endsWith('\n');
    const effective = trailingNL ? lines.slice(0, -1) : lines;
    const take = effective.slice(Math.max(0, effective.length - n));
    await ctx.stdout(take.join('\n') + (take.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`tail: ${e.message}\n`);
    return 1;
  }
}

async function _wc(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    l: { short: 'l' }, w: { short: 'w' }, c: { short: 'c' },
  });
  // Default (no flags) prints lines, words, bytes.
  const showAll = !opts.l && !opts.w && !opts.c;
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.endsWith('\n')
      ? text.split('\n').length - 1
      : (text.length === 0 ? 0 : text.split('\n').length);
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const bytes = text.length;
    const parts = [];
    if (opts.l || showAll) parts.push(String(lines).padStart(8));
    if (opts.w || showAll) parts.push(String(words).padStart(8));
    if (opts.c || showAll) parts.push(String(bytes).padStart(8));
    await ctx.stdout(parts.join('') + '\n');
    return 0;
  } catch (e) {
    await ctx.stderr(`wc: ${e.message}\n`);
    return 1;
  }
}

async function _grep(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    i: { short: 'i' }, v: { short: 'v' }, n: { short: 'n' },
    F: { short: 'F' }, c: { short: 'c' },
  });
  if (positionals.length === 0) {
    await ctx.stderr('grep: missing pattern\n');
    return 2;
  }
  const pattern = positionals[0];
  const files = positionals.slice(1);
  let regex;
  try {
    regex = opts.F
      ? new RegExp(_escapeRe(pattern), opts.i ? 'i' : '')
      : new RegExp(pattern, opts.i ? 'i' : '');
  } catch (e) {
    await ctx.stderr(`grep: bad pattern: ${e.message}\n`);
    return 2;
  }
  try {
    const text = await _bReadInput(files, ctx);
    const lines = text.split('\n');
    const trailing = text.endsWith('\n');
    const effective = trailing ? lines.slice(0, -1) : lines;
    let count = 0;
    const out = [];
    for (let i = 0; i < effective.length; i++) {
      const line = effective[i];
      const matched = regex.test(line);
      if (opts.v ? !matched : matched) {
        count++;
        if (!opts.c) {
          out.push(opts.n ? `${i + 1}:${line}` : line);
        }
      }
    }
    if (opts.c) await ctx.stdout(`${count}\n`);
    else if (out.length > 0) await ctx.stdout(out.join('\n') + '\n');
    return count > 0 ? 0 : 1;
  } catch (e) {
    await ctx.stderr(`grep: ${e.message}\n`);
    return 2;
  }
}

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function _sort(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, n: { short: 'n' }, u: { short: 'u' },
  });
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    let lines = (trailing ? text.slice(0, -1) : text).split('\n');
    if (opts.n) {
      lines.sort((a, b) => {
        const na = parseFloat(a), nb = parseFloat(b);
        if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
        if (Number.isNaN(na)) return -1;
        if (Number.isNaN(nb)) return 1;
        return na - nb;
      });
    } else {
      lines.sort();
    }
    if (opts.r) lines.reverse();
    if (opts.u) lines = [...new Set(lines)];
    await ctx.stdout(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`sort: ${e.message}\n`);
    return 1;
  }
}

async function _uniq(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    c: { short: 'c' }, d: { short: 'd' }, u: { short: 'u' },
  });
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    const lines = (trailing ? text.slice(0, -1) : text).split('\n');
    const out = [];
    let prev = null, runCount = 0;
    const emit = () => {
      if (prev === null) return;
      if (opts.d && runCount < 2) return;
      if (opts.u && runCount >= 2) return;
      if (opts.c) out.push(`${String(runCount).padStart(4)} ${prev}`);
      else out.push(prev);
    };
    for (const l of lines) {
      if (l === prev) { runCount++; continue; }
      emit();
      prev = l;
      runCount = 1;
    }
    emit();
    await ctx.stdout(out.join('\n') + (out.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`uniq: ${e.message}\n`);
    return 1;
  }
}

async function _cut(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    d: { short: 'd', arg: true, default: '\t' },
    f: { short: 'f', arg: true },
    c: { short: 'c', arg: true },
  });
  if (!opts.f && !opts.c) {
    await ctx.stderr('cut: must specify -f or -c\n');
    return 1;
  }
  const ranges = _parseRanges(opts.f || opts.c);
  try {
    const text = await _bReadInput(positionals, ctx);
    const trailing = text.endsWith('\n');
    const lines = (trailing ? text.slice(0, -1) : text).split('\n');
    const out = [];
    for (const line of lines) {
      if (opts.f) {
        const fields = line.split(opts.d);
        const picked = ranges.flatMap(([a, b]) => {
          const lo = Math.max(1, a) - 1;
          const hi = (b === Infinity ? fields.length : b);
          return fields.slice(lo, hi);
        });
        out.push(picked.join(opts.d));
      } else {
        const picked = ranges.flatMap(([a, b]) => {
          const lo = Math.max(1, a) - 1;
          const hi = (b === Infinity ? line.length : b);
          return [line.slice(lo, hi)];
        });
        out.push(picked.join(''));
      }
    }
    await ctx.stdout(out.join('\n') + (out.length > 0 ? '\n' : ''));
    return 0;
  } catch (e) {
    await ctx.stderr(`cut: ${e.message}\n`);
    return 1;
  }
}

// "1,3-5,7-" → [[1,1], [3,5], [7,Infinity]]
function _parseRanges(spec) {
  return spec.split(',').map(part => {
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      return [
        a === '' ? 1 : parseInt(a, 10),
        b === '' ? Infinity : parseInt(b, 10),
      ];
    }
    const n = parseInt(part, 10);
    return [n, n];
  });
}

async function _tee(argv, ctx) {
  if (!ctx.vfs && argv.length > 1) {
    await ctx.stderr('tee: no VFS configured for file targets\n');
    return 1;
  }
  const { opts, positionals } = _bParseArgs(argv, { a: { short: 'a' } });
  // _bReadInput handles Typed stdin via toString fallback.
  const input = await _bReadInput([], ctx);
  await ctx.stdout(input);
  let anyError = 0;
  for (const p of positionals) {
    try {
      const path = _bResolvePath(p, ctx);
      if (opts.a) {
        let prior;
        try { prior = await ctx.vfs.readFile(path, 'text'); } catch { prior = ''; }
        await ctx.vfs.writeFile(path, prior + input);
      } else {
        await ctx.vfs.writeFile(path, input);
      }
    } catch (e) {
      await ctx.stderr(`tee: ${p}: ${e.message || 'cannot write'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

// ── set — shell options ──
//
// POSIX set covers two responsibilities: flipping shell options (`-e` /
// `-u` / `-o pipefail` / …) and rewriting the positional parameters
// (`set -- a b c` makes `$1=a $2=b $3=c`). With no arguments, lists
// environment variables (the POSIX behaviour; bash also includes shell
// variables — close enough for v0).
async function _set(argv, ctx) {
  if (!ctx.options) ctx.options = { errexit: false, nounset: false, pipefail: false, xtrace: false };
  const knownLong = { errexit: 'errexit', nounset: 'nounset', pipefail: 'pipefail', xtrace: 'xtrace' };
  const knownShort = { e: 'errexit', u: 'nounset', x: 'xtrace' };
  let i = 1;
  let resetPositional = false;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i++; resetPositional = true; break; }
    if (a === '-' || a === '+') { i++; continue; }
    if (a.startsWith('-o') || a.startsWith('+o')) {
      const off = a[0] === '+';
      let opt = a.length > 2 ? a.slice(2) : (argv[++i] || '');
      if (!opt) {
        // List: `set -o` prints each shell option's state.
        for (const k of Object.keys(knownLong)) {
          await ctx.stdout(`${k.padEnd(12)} ${ctx.options[k] ? 'on' : 'off'}\n`);
        }
        i++;
        continue;
      }
      if (!knownLong[opt]) {
        await ctx.stderr(`set: ${opt}: invalid option name\n`);
        return 2;
      }
      ctx.options[knownLong[opt]] = !off;
      i++;
      continue;
    }
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1) {
      const off = a[0] === '+';
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (!knownShort[ch]) {
          await ctx.stderr(`set: -${ch}: unknown option\n`);
          return 2;
        }
        ctx.options[knownShort[ch]] = !off;
      }
      i++;
      continue;
    }
    // First non-option argument: stop parsing flags and treat the rest
    // as positional parameters (POSIX-shape, even without an explicit `--`).
    resetPositional = true;
    break;
  }
  if (resetPositional) {
    ctx.positional = argv.slice(i);
    return 0;
  }
  if (argv.length === 1) {
    const keys = [...ctx.env.keys()].sort();
    for (const k of keys) await ctx.stdout(`${k}=${ctx.env.get(k)}\n`);
  }
  return 0;
}

// ── printf — POSIX format strings ──
//
// printf FORMAT [ARGS...]
//
// Supports %s %d %i %u %o %x %X %e %E %f %F %g %G %c %b %% — plus flags
// (- + space # 0), width (number), precision (.N). The format string is
// reused if there are extra args; if there are no specifiers in the
// format, it's printed once. Backslash escapes in the format are
// interpreted (\n \t \r \\ \a \b \f \v \xHH \0OOO).
async function _printf(argv, ctx) {
  if (argv.length < 2) {
    await ctx.stderr('printf: usage: printf format [arguments]\n');
    return 1;
  }
  const fmt = argv[1];
  const args = argv.slice(2);
  let out = '';
  let argIdx = 0;
  // Apply the format at least once. If specifiers consumed arguments and
  // more remain, reapply (POSIX "reuse" semantics). Guard against
  // formats with zero specifiers so we don't loop.
  let pass = 0;
  while (pass === 0 || argIdx < args.length) {
    const result = _printfApply(fmt, args, argIdx);
    out += result.text;
    pass++;
    if (result.consumed === 0) break;
    argIdx += result.consumed;
    if (pass > 10000) break; // belt-and-braces guard
  }
  await ctx.stdout(out);
  return 0;
}

function _printfApply(fmt, args, startIdx) {
  let out = '';
  let consumed = 0;
  let hadSpecifier = false;
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === '\\' && i + 1 < fmt.length) {
      const r = _printfReadEscape(fmt, i);
      out += r.text;
      i = r.next;
      continue;
    }
    if (c === '%') {
      const spec = _printfParseSpec(fmt, i);
      if (spec.literal) { out += '%'; i = spec.end; continue; }
      hadSpecifier = true;
      const arg = args[startIdx + consumed];
      consumed++;
      out += _printfFormat(spec, arg);
      i = spec.end;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, consumed: hadSpecifier ? consumed : 0 };
}

function _printfReadEscape(fmt, i) {
  const next = fmt[i + 1];
  switch (next) {
    case 'n': return { text: '\n', next: i + 2 };
    case 't': return { text: '\t', next: i + 2 };
    case 'r': return { text: '\r', next: i + 2 };
    case '\\': return { text: '\\', next: i + 2 };
    case '"': return { text: '"', next: i + 2 };
    case "'": return { text: "'", next: i + 2 };
    case 'a': return { text: '\x07', next: i + 2 };
    case 'b': return { text: '\b', next: i + 2 };
    case 'f': return { text: '\f', next: i + 2 };
    case 'v': return { text: '\v', next: i + 2 };
    case '0': {
      let oct = '';
      let j = i + 2;
      while (oct.length < 3 && /[0-7]/.test(fmt[j] || '')) { oct += fmt[j]; j++; }
      return { text: String.fromCharCode(parseInt(oct || '0', 8)), next: j };
    }
    case 'x': {
      let hex = '';
      let j = i + 2;
      while (hex.length < 2 && /[0-9a-fA-F]/.test(fmt[j] || '')) { hex += fmt[j]; j++; }
      if (hex.length === 0) return { text: '\\x', next: j };
      return { text: String.fromCharCode(parseInt(hex, 16)), next: j };
    }
    default: return { text: '\\' + (next ?? ''), next: i + 2 };
  }
}

function _printfParseSpec(fmt, start) {
  let i = start + 1;
  if (fmt[i] === '%') return { literal: true, end: i + 1 };
  const flags = { left: false, plus: false, space: false, hash: false, zero: false };
  while (i < fmt.length && '-+ #0'.includes(fmt[i])) {
    if (fmt[i] === '-') flags.left = true;
    else if (fmt[i] === '+') flags.plus = true;
    else if (fmt[i] === ' ') flags.space = true;
    else if (fmt[i] === '#') flags.hash = true;
    else if (fmt[i] === '0') flags.zero = true;
    i++;
  }
  let width = -1;
  while (/[0-9]/.test(fmt[i] || '')) {
    width = width < 0 ? 0 : width;
    width = width * 10 + Number(fmt[i]);
    i++;
  }
  let precision = -1;
  if (fmt[i] === '.') {
    i++;
    precision = 0;
    while (/[0-9]/.test(fmt[i] || '')) {
      precision = precision * 10 + Number(fmt[i]);
      i++;
    }
  }
  const conv = fmt[i] || '';
  i++;
  return { literal: false, flags, width, precision, conv, end: i };
}

function _printfFormat(spec, rawArg) {
  const { flags, width, precision, conv } = spec;
  const arg = rawArg ?? '';
  let s;
  let isNumeric = true;
  switch (conv) {
    case 's': {
      s = String(arg);
      if (precision >= 0) s = s.slice(0, precision);
      isNumeric = false;
      break;
    }
    case 'b': {
      s = _printfBackslashArg(String(arg));
      if (precision >= 0) s = s.slice(0, precision);
      isNumeric = false;
      break;
    }
    case 'c': {
      s = String(arg).charAt(0);
      isNumeric = false;
      break;
    }
    case 'd': case 'i': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      const neg = n < 0;
      let v = String(Math.abs(n));
      if (precision >= 0) v = v.padStart(precision, '0');
      if (neg) s = '-' + v;
      else if (flags.plus) s = '+' + v;
      else if (flags.space) s = ' ' + v;
      else s = v;
      break;
    }
    case 'u': {
      let n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) n = 0;
      s = String(n);
      if (precision >= 0) s = s.padStart(precision, '0');
      break;
    }
    case 'o': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      s = n.toString(8);
      if (flags.hash && s[0] !== '0') s = '0' + s;
      if (precision >= 0) s = s.padStart(precision, '0');
      break;
    }
    case 'x': case 'X': {
      let n = parseInt(arg, 10);
      if (Number.isNaN(n)) n = 0;
      s = n.toString(16);
      if (conv === 'X') s = s.toUpperCase();
      if (precision >= 0) s = s.padStart(precision, '0');
      if (flags.hash && n !== 0) s = (conv === 'X' ? '0X' : '0x') + s;
      break;
    }
    case 'e': case 'E': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? precision : 6;
      s = n.toExponential(p);
      if (conv === 'E') s = s.toUpperCase();
      if (flags.plus && n >= 0) s = '+' + s;
      else if (flags.space && n >= 0) s = ' ' + s;
      break;
    }
    case 'f': case 'F': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? precision : 6;
      s = n.toFixed(p);
      if (flags.plus && n >= 0) s = '+' + s;
      else if (flags.space && n >= 0) s = ' ' + s;
      break;
    }
    case 'g': case 'G': {
      let n = parseFloat(arg);
      if (Number.isNaN(n)) n = 0;
      const p = precision >= 0 ? (precision === 0 ? 1 : precision) : 6;
      s = n.toPrecision(p);
      if (conv === 'G') s = s.toUpperCase();
      break;
    }
    default: s = '%' + conv;
  }
  if (width > 0 && s.length < width) {
    const padCh = (flags.zero && !flags.left && isNumeric) ? '0' : ' ';
    if (flags.left) s = s.padEnd(width, ' ');
    else if (padCh === '0' && (s[0] === '-' || s[0] === '+' || s[0] === ' ')) {
      s = s[0] + s.slice(1).padStart(width - 1, '0');
    } else {
      s = s.padStart(width, padCh);
    }
  }
  return s;
}

function _printfBackslashArg(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const r = _printfReadEscape(s, i);
      out += r.text;
      i = r.next - 1;
    } else {
      out += s[i];
    }
  }
  return out;
}

// ── read — line input ──
//
// read [-r] [-p prompt] [-d delim] [-n nchars] [-s] [-t timeout] [VAR...]
//
// v0 reads a single line from ctx.stdin, splits on $IFS, and binds the
// resulting fields to the named variables (last var absorbs any trailing
// content). Without VARs, reads into $REPLY. `-r` skips backslash
// processing. `-p PROMPT` writes the prompt to stderr before reading.
// `-s`/`-n`/`-t`/`-d` are accepted for compatibility but not all honoured
// (they need an async input channel from the adapter — coming with the
// worker-side interactive read protocol).
async function _read(argv, ctx) {
  let raw = false, prompt = '';
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    const flag = argv[i];
    if (flag === '-r') { raw = true; i++; continue; }
    if (flag === '-p') { prompt = argv[i + 1] ?? ''; i += 2; continue; }
    if (flag.startsWith('-p') && flag.length > 2) { prompt = flag.slice(2); i++; continue; }
    if (flag === '-s') { i++; continue; }
    if (flag === '-n' || flag === '-d' || flag === '-t') { i += 2; continue; }
    if (flag === '--') { i++; break; }
    await ctx.stderr(`read: ${flag}: unknown option\n`);
    return 2;
  }
  const vars = argv.slice(i);
  const varNames = vars.length > 0 ? vars : ['REPLY'];
  if (prompt) {
    try { await ctx.stderr(prompt); } catch { /* ignore */ }
  }
  if (typeof ctx.stdin !== 'string' || ctx.stdin.length === 0) return 1;
  // Consume one line from stdin. Mutate ctx.stdin so subsequent reads in
  // the same command context (e.g. `while read; do ...; done < file`)
  // continue from where we left off.
  const nlIdx = ctx.stdin.indexOf('\n');
  let line;
  if (nlIdx < 0) {
    line = ctx.stdin;
    ctx.stdin = '';
  } else {
    line = ctx.stdin.slice(0, nlIdx);
    ctx.stdin = ctx.stdin.slice(nlIdx + 1);
  }
  if (!raw) {
    let processed = '';
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '\\' && k + 1 < line.length) {
        processed += line[k + 1];
        k++;
      } else {
        processed += line[k];
      }
    }
    line = processed;
  }
  const ifs = ctx.env.get('IFS') ?? ' \t\n';
  if (varNames.length === 1) {
    // Single var: get the whole line minus IFS-whitespace trimming.
    const trimmed = _readTrimIfsWs(line, ifs);
    ctx.env.set(varNames[0], trimmed);
  } else {
    const fields = _readSplitFields(line, ifs, varNames.length);
    for (let k = 0; k < varNames.length; k++) {
      ctx.env.set(varNames[k], fields[k] ?? '');
    }
  }
  return 0;
}

function _readTrimIfsWs(line, ifs) {
  const wsSet = new Set();
  for (const c of ifs) if (c === ' ' || c === '\t' || c === '\n') wsSet.add(c);
  if (wsSet.size === 0) return line;
  let start = 0, end = line.length;
  while (start < end && wsSet.has(line[start])) start++;
  while (end > start && wsSet.has(line[end - 1])) end--;
  return line.slice(start, end);
}

function _readSplitFields(line, ifs, maxFields) {
  const wsSet = new Set(), otherSet = new Set();
  for (const c of ifs) {
    if (c === ' ' || c === '\t' || c === '\n') wsSet.add(c);
    else otherSet.add(c);
  }
  const out = [];
  let i = 0;
  while (i < line.length && wsSet.has(line[i])) i++;
  let cur = '';
  while (i < line.length) {
    if (out.length === maxFields - 1) {
      cur = line.slice(i);
      // Trim trailing whitespace-IFS from the last absorbed field (POSIX read).
      if (wsSet.size > 0) {
        let end = cur.length;
        while (end > 0 && wsSet.has(cur[end - 1])) end--;
        cur = cur.slice(0, end);
      }
      out.push(cur);
      return out;
    }
    const c = line[i];
    if (wsSet.has(c)) {
      out.push(cur);
      cur = '';
      i++;
      while (i < line.length && wsSet.has(line[i])) i++;
      continue;
    }
    if (otherSet.has(c)) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur || out.length < maxFields) out.push(cur);
  while (out.length < maxFields) out.push('');
  return out;
}

// ── which / command — name lookup ──

async function _which(argv, ctx) {
  let anyError = 0;
  for (const name of argv.slice(1)) {
    if (ctx.builtins.has(name)) {
      await ctx.stdout(`${name}: shell built-in\n`);
    } else if (ctx.functions.has(name)) {
      await ctx.stdout(`${name}: shell function\n`);
    } else {
      anyError = 1;
    }
  }
  return anyError;
}

async function _command(argv, ctx) {
  // command [-v|-V] NAME [args...] — runs NAME bypassing function lookup,
  // or with -v/-V prints how the name would be resolved.
  let mode = null;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    if (argv[i] === '-v') { mode = 'v'; i++; continue; }
    if (argv[i] === '-V') { mode = 'V'; i++; continue; }
    if (argv[i] === '--') { i++; break; }
    i++;
  }
  if (i >= argv.length) return 0;
  const name = argv[i];
  if (mode) {
    if (ctx.builtins.has(name)) {
      await ctx.stdout(mode === 'V' ? `${name} is a shell builtin\n` : `${name}\n`);
      return 0;
    }
    if (ctx.functions.has(name)) {
      await ctx.stdout(mode === 'V' ? `${name} is a shell function\n` : `${name}\n`);
      return 0;
    }
    return 1;
  }
  const rest = argv.slice(i);
  if (ctx.builtins.has(name)) {
    return await ctx.builtins.get(name)(rest, ctx);
  }
  return await ctx.onCommand(name, rest, ctx);
}

// ── seq / sleep / date ──

async function _seq(argv, ctx) {
  const positional = [];
  let sep = '\n';
  let i = 1;
  while (i < argv.length) {
    if (argv[i] === '-s' && i + 1 < argv.length) { sep = argv[++i]; i++; continue; }
    if (argv[i].startsWith('-s') && argv[i].length > 2) { sep = argv[i].slice(2); i++; continue; }
    positional.push(argv[i]);
    i++;
  }
  if (positional.length === 0) {
    await ctx.stderr('seq: missing operand\n');
    return 1;
  }
  let first = 1, increment = 1, last = 0;
  if (positional.length === 1) { last = Number(positional[0]); }
  else if (positional.length === 2) { first = Number(positional[0]); last = Number(positional[1]); }
  else { first = Number(positional[0]); increment = Number(positional[1]); last = Number(positional[2]); }
  if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(increment)) {
    await ctx.stderr('seq: invalid number\n');
    return 1;
  }
  if (increment === 0) {
    await ctx.stderr('seq: increment must be non-zero\n');
    return 1;
  }
  const out = [];
  if (increment > 0) {
    for (let n = first; n <= last + 1e-12; n += increment) out.push(_seqFormatNum(n));
  } else {
    for (let n = first; n >= last - 1e-12; n += increment) out.push(_seqFormatNum(n));
  }
  if (out.length === 0) return 0;
  await ctx.stdout(out.join(sep) + '\n');
  return 0;
}

function _seqFormatNum(n) {
  if (Number.isInteger(n)) return String(n);
  // Round to ~6 sig-figs for fractional sequences; trims runaway FP noise.
  const r = Math.round(n * 1e6) / 1e6;
  return String(r);
}

async function _sleep(argv, ctx) {
  const arg = argv[1];
  if (arg == null) {
    await ctx.stderr('sleep: missing operand\n');
    return 1;
  }
  const m = String(arg).match(/^(\d+(?:\.\d+)?)([smhd])?$/);
  if (!m) {
    await ctx.stderr(`sleep: invalid duration "${arg}"\n`);
    return 1;
  }
  const n = parseFloat(m[1]);
  const unit = m[2] || 's';
  const mult = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1;
  await new Promise(r => setTimeout(r, n * mult * 1000));
  return 0;
}

async function _date(argv, ctx) {
  let fmt = '%a %b %e %T %Y'; // POSIX default
  for (const a of argv.slice(1)) {
    if (a.startsWith('+')) fmt = a.slice(1);
  }
  const d = new Date();
  await ctx.stdout(_formatDate(d, fmt) + '\n');
  return 0;
}

function _formatDate(d, fmt) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return fmt.replace(/%./g, (m) => {
    switch (m) {
      case '%Y': return String(d.getFullYear());
      case '%y': return pad(d.getFullYear() % 100);
      case '%m': return pad(d.getMonth() + 1);
      case '%d': return pad(d.getDate());
      case '%H': return pad(d.getHours());
      case '%I': return pad(((d.getHours() + 11) % 12) + 1);
      case '%M': return pad(d.getMinutes());
      case '%S': return pad(d.getSeconds());
      case '%p': return d.getHours() < 12 ? 'AM' : 'PM';
      case '%a': return dayShort[d.getDay()];
      case '%A': return dayFull[d.getDay()];
      case '%b': case '%h': return monShort[d.getMonth()];
      case '%B': return monFull[d.getMonth()];
      case '%e': return String(d.getDate()).padStart(2, ' ');
      case '%j': return pad(_dayOfYear(d), 3);
      case '%T': return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      case '%R': return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      case '%D': return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
      case '%F': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      case '%s': return String(Math.floor(d.getTime() / 1000));
      case '%n': return '\n';
      case '%t': return '\t';
      case '%%': return '%';
      case '%z': {
        const off = -d.getTimezoneOffset();
        const sign = off >= 0 ? '+' : '-';
        const h = pad(Math.floor(Math.abs(off) / 60));
        const mm = pad(Math.abs(off) % 60);
        return `${sign}${h}${mm}`;
      }
      default: return m;
    }
  });
}

function _dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

// xargs: build commands from stdin tokens. v0 supports -n (batch size)
// and uses the dispatch in ctx to invoke the named command.
async function _xargs(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    n: { short: 'n', arg: true },
    I: { short: 'I', arg: true },
  });
  const cmdArgv = positionals.length === 0 ? ['echo'] : positionals;
  const stdin = typeof ctx.stdin === 'string' ? ctx.stdin : '';
  const tokens = stdin.split(/\s+/).filter(Boolean);
  const batchSize = opts.n ? Math.max(1, parseInt(opts.n, 10)) : tokens.length;
  let lastExit = 0;
  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize);
    let argvCall;
    if (opts.I) {
      // Substitute the placeholder in cmdArgv.
      argvCall = cmdArgv.map(a => a === opts.I ? batch.join(' ') : a);
    } else {
      argvCall = [...cmdArgv, ...batch];
    }
    const name = argvCall[0];
    if (ctx.builtins.has(name)) {
      const r = await ctx.builtins.get(name)(argvCall, ctx);
      lastExit = typeof r === 'number' ? r : 0;
    } else if (ctx.onCommand) {
      lastExit = await ctx.onCommand(name, argvCall, ctx);
    } else {
      await ctx.stderr(`xargs: ${name}: command not found\n`);
      lastExit = 127;
    }
    if (tokens.length === 0) break;
  }
  return lastExit;
}

// -- headless.js --

// Headless terminal adapter — implements the GeasTerminal interface as a
// pure in-memory buffer with simulated input. Used for:
//   - Tests: drive the executor without spinning up a real DOM terminal,
//     inspect captured output/blocks/input-callback registrations directly.
//   - MCP bridge / scripting: when the consumer wants the shell's output as
//     a string rather than rendering it.
//   - Reference implementation: nails down the GeasTerminal contract for
//     adapter authors writing @gcu/term and xterm.js bridges.
//
// Interface (all adapters MUST implement):
//
//   write(text)               — write a chunk of ANSI-bearing text
//   writeBlock(block)         — (optional, caps.richBlocks=true) write a
//                               structured Block (table, canvas, html, …)
//   onInput(cb) → unsubscribe — register a keystroke/input handler
//   size() → { cols, rows }   — current terminal dimensions
//   onResize(cb) → unsubscribe — register a resize handler
//   clear()                   — clear scrollback + any block region
//   caps() → { richBlocks }   — capability negotiation; geas inspects this
//                               at startup to decide whether to send Blocks
//                               or auto-serialize to text
//
// The headless adapter additionally exposes inspection / simulation methods
// for test use:
//
//   output()         → concatenated text written so far (string)
//   capturedBlocks() → array of Block objects writeBlock has received
//   sendInput(text)  → simulate the user typing `text`; fires onInput cbs
//   setSize(c, r)    → simulate a resize; fires onResize cbs

function createHeadlessAdapter(opts = {}) {
  const buffer = [];
  const blocks = [];
  let inputSubs = new Set();
  let resizeSubs = new Set();
  let cols = opts.cols ?? 80;
  let rows = opts.rows ?? 24;
  // Whether structured blocks are accepted. Headless defaults to true so
  // tests can assert the geas executor's typed-pipe output without needing
  // a separate adapter; pass `richBlocks: false` to simulate a text-only
  // terminal (e.g. xterm.js with no inline-block extension).
  const richBlocks = opts.richBlocks ?? true;

  return {
    // ── GeasTerminal interface ──
    write(text) {
      if (text == null) return;
      buffer.push(String(text));
    },
    writeBlock(block) {
      if (!richBlocks) {
        // Caller should check caps() first and serialize on their side, but
        // be defensive: stringify the block as a JSON fallback if we get one.
        try { buffer.push(JSON.stringify(block)); }
        catch { buffer.push(String(block)); }
        return;
      }
      blocks.push(block);
    },
    onInput(cb) {
      inputSubs.add(cb);
      return () => inputSubs.delete(cb);
    },
    size() {
      return { cols, rows };
    },
    onResize(cb) {
      resizeSubs.add(cb);
      return () => resizeSubs.delete(cb);
    },
    clear() {
      buffer.length = 0;
      blocks.length = 0;
    },
    caps() {
      return { richBlocks };
    },

    // ── headless-specific inspection / simulation ──
    output() {
      return buffer.join('');
    },
    capturedBlocks() {
      return blocks.slice();
    },
    sendInput(text) {
      const s = String(text ?? '');
      for (const cb of inputSubs) {
        try { cb(s); }
        catch (e) { /* swallow handler errors so one bad sub doesn't break the rest */ }
      }
    },
    setSize(newCols, newRows) {
      cols = newCols;
      rows = newRows;
      const size = { cols, rows };
      for (const cb of resizeSubs) {
        try { cb(size); }
        catch (e) { /* swallow */ }
      }
    },

    // Number of currently-registered subscribers — useful for tests that
    // verify unsubscribe semantics.
    _subCounts() {
      return { input: inputSubs.size, resize: resizeSubs.size };
    },
  };
}

// -- term.js --

// @gcu/term adapter — implements the GeasTerminal interface on top of a
// `@gcu/term` Terminal instance. The Terminal does the VT/ANSI parsing and
// DOM rendering; this adapter just bridges the two surfaces.
//
// Usage:
//
//   import { Terminal, DomRenderer, Input } from '@gcu/term';
//   import { createTermAdapter } from '@gcu/geas/adapters/term';
//
//   const term = new Terminal(80, 24);
//   const dom = new DomRenderer(term, screenEl);
//   const input = new Input(term, screenEl, hiddenEl, dom);
//   const adapter = createTermAdapter({ terminal: term });
//
//   const client = createGeasClient({ worker, vfs, ...adapterHooks(adapter) });
//
// where `adapterHooks(adapter)` wires onStdout / onStderr / onBlock to the
// adapter's write / writeBlock methods (see the helper at the bottom of
// this file).
//
// v0 capability: richBlocks=false. The Terminal renders to a fixed grid,
// so inline structured blocks (tables, canvases) aren't supported yet.
// Typed pipe output degrades to the canonical text rendering via the
// block's `.text` field. When @gcu/term grows "inline block regions"
// (interleavable DOM nodes between grid rows), flip caps to richBlocks=true
// and writeBlock can insert real widgets.

function createTermAdapter(opts) {
  const { terminal } = opts || {};
  if (!terminal) throw new Error('createTermAdapter: opts.terminal is required');
  const resizeSubs = new Set();
  return {
    write(text) {
      terminal.write(typeof text === 'string' ? text : String(text ?? ''));
    },
    writeBlock(block) {
      // No native inline-block rendering; write the canonical text view.
      // The producer-side typed-pipe output sets .text to the CSV / aligned
      // table rendering, so this degrades gracefully.
      if (block && typeof block.text === 'string') {
        terminal.write(block.text);
      } else {
        try { terminal.write(JSON.stringify(block)); }
        catch { terminal.write(String(block)); }
      }
    },
    onInput(cb) {
      // term.onText fires once per stretch of keyboard-generated bytes,
      // already decoded as a string. Returns an unsubscribe function — pass
      // straight through.
      return terminal.onText(cb);
    },
    size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    onResize(cb) {
      // @gcu/term v0 doesn't emit a resize event — the host triggers
      // resizes externally via term.resize(cols, rows). Callers that drive
      // resizes should also call adapter.notifyResize() so our subs fire.
      resizeSubs.add(cb);
      return () => resizeSubs.delete(cb);
    },
    clear() {
      // VT100: ESC[2J clears screen, ESC[H homes cursor.
      terminal.write('\x1b[2J\x1b[H');
    },
    caps() {
      return { richBlocks: false };
    },

    // Adapter-specific: call when you've externally resized the underlying
    // terminal so any GeasTerminal consumers learn about the new size.
    notifyResize(cols, rows) {
      const size = { cols, rows };
      for (const cb of resizeSubs) {
        try { cb(size); } catch { /* swallow per-listener */ }
      }
    },
  };
}

// Wire an adapter to a GeasClient's stdout/stderr/block sinks. Convenience
// so consumers don't have to spell out the same three callbacks at every
// createGeasClient call.
function adapterHooks(adapter) {
  return {
    onStdout: (text) => adapter.write(text),
    onStderr: (text) => adapter.write(text),
    onBlock:  (block) => {
      if (adapter.caps().richBlocks && typeof adapter.writeBlock === 'function') {
        adapter.writeBlock(block);
      } else {
        adapter.write(block.text || '');
      }
    },
  };
}

// -- xterm.js --

// xterm.js adapter — implements the GeasTerminal interface on top of an
// `xterm.js` Terminal instance. xterm.js is the industry-standard browser
// terminal (used by VS Code, koma, Hyper, …); the adapter exists so geas
// runs in any host that already vendors it.
//
// Usage:
//
//   import { Terminal as XtermTerminal } from 'xterm';
//   import { createXtermAdapter } from '@gcu/geas/adapters/xterm';
//
//   const term = new XtermTerminal({ cols: 80, rows: 24 });
//   term.open(screenEl);
//   const adapter = createXtermAdapter({ terminal: term });
//
//   const client = createGeasClient({ worker, vfs, ...adapterHooks(adapter) });
//
// v0 capability: richBlocks=false. xterm.js renders to a Canvas/WebGL grid
// with no built-in inline-DOM-block surface, so typed pipe output degrades
// via block.text — matching @gcu/term's behaviour. (xterm.js extensions
// exist for "addons" that could host inline widgets; defer that integration
// until someone reaches for it.)

function createXtermAdapter(opts) {
  const { terminal } = opts || {};
  if (!terminal) throw new Error('createXtermAdapter: opts.terminal is required');
  return {
    write(text) {
      terminal.write(typeof text === 'string' ? text : String(text ?? ''));
    },
    writeBlock(block) {
      if (block && typeof block.text === 'string') {
        terminal.write(block.text);
      } else {
        try { terminal.write(JSON.stringify(block)); }
        catch { terminal.write(String(block)); }
      }
    },
    onInput(cb) {
      // xterm.js: onData returns a disposable with .dispose().
      const sub = terminal.onData(cb);
      return () => { try { sub.dispose(); } catch { /* ignore */ } };
    },
    size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    onResize(cb) {
      // xterm.js fires onResize when fit / resize is called; wrap to match
      // our {cols, rows} payload shape.
      const sub = terminal.onResize((e) => cb({ cols: e.cols, rows: e.rows }));
      return () => { try { sub.dispose(); } catch { /* ignore */ } };
    },
    clear() {
      // xterm.js has a clear() method that wipes scrollback.
      if (typeof terminal.clear === 'function') terminal.clear();
      else terminal.write('\x1b[2J\x1b[H');
    },
    caps() {
      return { richBlocks: false };
    },
  };
}

// adapterHooks is defined once in adapters/term.js — import from there.
// (Both adapters expose the same shape, so a single helper suffices.)

// -- vfs-proxy.js --

// VFS-RPC proxy: lets a worker run geas while the actual @gcu/vfs lives
// on the main thread. Every vfs.X(...) call inside the worker round-trips
// through postMessage. Symmetric API — `serveVFS(target, vfs)` on the
// owning side, `createVfsClient(target)` on the consuming side. `target`
// is any object with `postMessage(msg)` and either `addEventListener('message', cb)`
// or settable `onmessage`.
//
// Why proxy (rather than move VFS into the worker): backends that need DOM
// access (auditable's Comment backend reads/writes a comment node) only
// work on the main thread. Proxying keeps a single VFS instance authoritative
// and lets every worker talk to it.
//
// Message shapes:
//
//   client → server:  { type: 'vfs-call', id, method, args }
//   server → client:  { type: 'vfs-reply', id, ok: true, value }
//                  |  { type: 'vfs-reply', id, ok: false, error: string }
//
// IDs are private to each direction so VFS replies can't conflict with
// other in-band messages (exec/done/stdout/etc.).

// Methods we proxy. Limited to the surface geas builtins actually call;
// add as needed.
const VFS_METHODS = [
  'readFile', 'writeFile', 'readdir', 'stat',
  'mkdir', 'unlink', 'rmdir', 'rename',
  'glob', 'exists', 'cp',
];

// Run on the side that OWNS the real VFS. Listens for vfs-call messages
// and dispatches to the real vfs, sending back vfs-reply.
//
// Returns a `stop()` function that removes the listener.
function serveVFS(target, vfs) {
  const handler = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'vfs-call') return;
    try {
      if (typeof vfs[msg.method] !== 'function') {
        throw new Error(`vfs: unknown method "${msg.method}"`);
      }
      const value = await vfs[msg.method](...(msg.args || []));
      target.postMessage({ type: 'vfs-reply', id: msg.id, ok: true, value });
    } catch (err) {
      target.postMessage({
        type: 'vfs-reply',
        id: msg.id,
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  };
  _vpAttach(target, handler);
  return () => _vpDetach(target, handler);
}

// Run on the side that CONSUMES vfs through message-passing (typically
// inside a worker). Returns a vfs-shaped proxy whose every call posts a
// message and awaits its reply.
function createVfsClient(target) {
  let nextId = 0;
  const pending = new Map();
  _vpAttach(target, (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || msg.type !== 'vfs-reply') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(new Error(msg.error));
  });

  const proxy = {};
  for (const method of VFS_METHODS) {
    proxy[method] = (...args) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage({ type: 'vfs-call', id, method, args });
      });
    };
  }
  return proxy;
}

// ── transport helpers ──
// Web Workers use addEventListener('message', cb); Node worker_threads use
// .on('message', cb). Our loopback target uses .addEventListener. Handle
// both shapes transparently.
function _vpAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    // Node worker_threads shape: payload arrives as the bare data, not an event.
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    // Chain so we don't blow away an existing onmessage.
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('vfs-proxy: target has no message-listener surface');
  }
}

function _vpDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
  // For onmessage-style we can't easily detach; the leak is small per worker.
}

// -- worker-shim.js --

// Worker shim — run this inside the worker scope after geas is loaded.
//
// Sets up the message protocol that pairs with GeasClient on the main side.
// Owns the long-lived shell instance for this worker; survives across exec
// calls so env mutations / cwd / function definitions persist.
//
// Usage (real worker):
//
//   import { setupGeasWorker } from '@gcu/geas/worker/shim';
//   setupGeasWorker(self);
//
// Usage (in-process / tests):
//
//   setupGeasWorker(loopback.workerSide);
//
// The shim doesn't import the geas API symbols directly here — they're
// passed via the `opts.createShell` factory so the same shim works whether
// geas was bundled or imported piecewise. (Inside the runnable worker
// entry, you'd pass `createShell` from the bundle.)


function setupGeasWorker(target, opts) {
  const { createShell, isTyped } = opts;
  if (typeof createShell !== 'function') {
    throw new Error('setupGeasWorker: opts.createShell is required');
  }
  const vfs = createVfsClient(target);
  let shell = null;

  // Forward writes from the shell out to the main side. Typed values get
  // their own message kind so the client can route them to writeBlock.
  const stdoutFn = (v) => {
    if (v && typeof v === 'object' && v.__geas_typed === true) {
      target.postMessage({
        type: 'block',
        kind: v.kind,
        value: v.value,
        text: String(v),
      });
    } else {
      target.postMessage({ type: 'stdout', text: typeof v === 'string' ? v : String(v ?? '') });
    }
  };
  const stderrFn = (text) => {
    target.postMessage({ type: 'stderr', text: typeof text === 'string' ? text : String(text ?? '') });
  };

  const handler = async (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init': {
        shell = createShell({
          vfs,
          env: msg.env || {},
          cwd: msg.cwd || '/',
          stdout: stdoutFn,
          stderr: stderrFn,
        });
        target.postMessage({ type: 'init-done' });
        return;
      }
      case 'exec': {
        if (!shell) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: 'shell not initialised',
          });
          return;
        }
        try {
          const r = await shell.exec(msg.source);
          target.postMessage({ type: 'done', id: msg.id, exitCode: r.exitCode ?? 0 });
        } catch (err) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: err && err.message ? err.message : String(err),
          });
        }
        return;
      }
      // input / resize are reserved for when a real interactive shell needs
      // to feed line-edited input back into a running command. v0 doesn't
      // have an interactive read builtin, so these are no-ops.
      case 'input':
      case 'resize':
        return;
    }
  };
  _wsAttach(target, handler);
}

function _wsAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('setupGeasWorker: target has no message-listener surface');
  }
}

// -- client.js --

// GeasClient — the main-thread facade around a worker-hosted shell.
//
//   const client = createGeasClient({
//     worker,                          // Worker-like: postMessage + onmessage / addEventListener
//     vfs,                             // @gcu/vfs instance (lives on main)
//     env, cwd,                        // initial shell env / cwd
//     onStdout, onStderr, onBlock,     // optional output sinks (defaults log to console)
//   });
//
//   await client.ready();              // resolves once the worker has init-done'd
//   const { exitCode } = await client.exec('ls /home | grep arthur');
//   await client.terminate();          // tears the worker down
//
// The client owns the VFS service-side of the RPC. It manages exec IDs so
// concurrent exec calls can be tracked (the worker serialises them one at
// a time — concurrency is a future concern; for v0 a second exec() while
// one's in flight queues client-side).


function createGeasClient(opts) {
  const {
    worker,
    vfs,
    env = {},
    cwd = '/',
    onStdout = (t) => { /* default: drop */ },
    onStderr = (t) => { /* default: drop */ },
    onBlock  = (b) => { /* default: render text fallback */ onStdout(b.text); },
  } = opts;
  if (!worker) throw new Error('createGeasClient: opts.worker is required');

  // Start serving VFS over the worker channel.
  const stopServe = vfs ? serveVFS(worker, vfs) : (() => {});

  // Track pending exec promises by id.
  let nextExecId = 0;
  const pendingExecs = new Map();
  let initReady = null;
  let initResolve = null;
  let initPromise = new Promise((r) => { initResolve = r; });

  const handler = (e) => {
    const msg = e && e.data !== undefined ? e.data : e;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'init-done':
        initReady = true;
        initResolve();
        return;
      case 'stdout':
        onStdout(msg.text || '');
        return;
      case 'stderr':
        onStderr(msg.text || '');
        return;
      case 'block':
        onBlock({ kind: msg.kind, value: msg.value, text: msg.text });
        return;
      case 'done': {
        const slot = pendingExecs.get(msg.id);
        if (!slot) return;
        pendingExecs.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error));
        else slot.resolve({ exitCode: msg.exitCode });
        return;
      }
      // vfs-call is handled by serveVFS's own listener attached above.
    }
  };
  _wcAttach(worker, handler);

  // Kick off init.
  worker.postMessage({ type: 'init', env, cwd });

  // Serialise execs: queue them client-side so the worker only sees one at
  // a time. Simpler than expecting the worker to maintain a queue.
  let execChain = Promise.resolve({ exitCode: 0 });
  let terminated = false;

  return {
    ready: () => initPromise,

    exec(source) {
      if (terminated) return Promise.reject(new Error('geas: client terminated'));
      const next = execChain.then(async () => {
        // Re-check after awaiting the prior exec — terminate may have fired
        // while we were queued, in which case we should reject rather than
        // post a message that nothing is listening for.
        if (terminated) throw new Error('geas: client terminated');
        await initPromise;
        if (terminated) throw new Error('geas: client terminated');
        const id = nextExecId++;
        const p = new Promise((resolve, reject) => {
          pendingExecs.set(id, { resolve, reject });
        });
        worker.postMessage({ type: 'exec', id, source });
        return p;
      });
      // Chain so the next exec waits for this one to finish — but don't
      // propagate errors through the chain (an individual failure shouldn't
      // poison subsequent execs).
      execChain = next.catch(() => ({ exitCode: 1 }));
      return next;
    },

    input(text) { if (!terminated) worker.postMessage({ type: 'input', text }); },
    resize(cols, rows) { if (!terminated) worker.postMessage({ type: 'resize', cols, rows }); },

    async terminate() {
      terminated = true;
      stopServe();
      _wcDetach(worker, handler);
      if (typeof worker.terminate === 'function') {
        try { await worker.terminate(); } catch { /* ignore */ }
      }
      // Reject any execs that have already registered themselves so callers
      // don't hang waiting for a reply that will never arrive.
      for (const [, slot] of pendingExecs) {
        slot.reject(new Error('geas: client terminated'));
      }
      pendingExecs.clear();
    },
  };
}

// ── transport helpers (same shape as vfs-proxy.js) ──
function _wcAttach(target, handler) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handler);
  } else if (typeof target.on === 'function') {
    target.on('message', (data) => handler({ data }));
  } else if ('onmessage' in target) {
    const prior = target.onmessage;
    target.onmessage = (e) => { handler(e); if (prior) prior(e); };
  } else {
    throw new Error('createGeasClient: worker has no message-listener surface');
  }
}
function _wcDetach(target, handler) {
  if (typeof target.removeEventListener === 'function') {
    target.removeEventListener('message', handler);
  } else if (typeof target.off === 'function') {
    target.off('message', handler);
  }
}

// -- loopback.js --

// Loopback "worker" — two paired endpoints that route postMessage calls to
// each other's listeners via queueMicrotask. Used for in-process tests so
// node --test can drive the worker harness without spawning real threads.
//
//   const { mainSide, workerSide } = createLoopback();
//   setupGeasWorker(workerSide, { createShell });
//   const client = createGeasClient({ worker: mainSide, vfs, ... });
//
// Both ends expose `addEventListener('message', cb)` / `removeEventListener`
// and `postMessage(msg)`. Messages are structured-cloned via JSON to mirror
// real Worker semantics (no shared refs across the boundary).

function createLoopback() {
  const mainListeners = new Set();
  const workerListeners = new Set();

  const main = {
    postMessage(msg) {
      const cloned = _clone(msg);
      queueMicrotask(() => {
        for (const cb of workerListeners) {
          try { cb({ data: cloned }); } catch (e) { /* swallow per-listener */ }
        }
      });
    },
    addEventListener(type, cb) {
      if (type === 'message') mainListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'message') mainListeners.delete(cb);
    },
    terminate() { mainListeners.clear(); workerListeners.clear(); },
  };
  const worker = {
    postMessage(msg) {
      const cloned = _clone(msg);
      queueMicrotask(() => {
        for (const cb of mainListeners) {
          try { cb({ data: cloned }); } catch (e) { /* swallow */ }
        }
      });
    },
    addEventListener(type, cb) {
      if (type === 'message') workerListeners.add(cb);
    },
    removeEventListener(type, cb) {
      if (type === 'message') workerListeners.delete(cb);
    },
    terminate() { mainListeners.clear(); workerListeners.clear(); },
  };
  return { mainSide: main, workerSide: worker };
}

// Mimic structured clone: anything JSON-safe round-trips identically;
// anything not (functions, DOM nodes, …) errors at the boundary, matching
// real postMessage semantics. ArrayBuffer / Map / Set get downgraded for v0
// (real structured clone preserves them; loopback's v0 doesn't matter for
// our message shapes which are plain JSON).
function _clone(v) {
  return JSON.parse(JSON.stringify(v));
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















// createShell({vfs, env, cwd, stdout, stderr, builtins, onCommand})
//
// Convenience factory that builds a long-lived shell context with the
// default geas built-ins pre-loaded (echo / pwd / cd / env / cat / ls /
// test / [ / true / false / : / export / exit). The returned object has:
//
//   .exec(source)      — parse + execute a script, return {exitCode,...}
//   .env               — Map (mutable; survives across exec calls)
//   .cwd               — string (mutable via cd builtin)
//   .lastStatus        — number, $? after the most recent command
//   .builtins          — Map (add/override entries before/between execs)
//   .functions         — Map of user-defined functions (populated by `name()`)
//
// Caller-supplied stdout/stderr/onCommand/extra builtins overlay the
// defaults. Pass a VFS instance to enable filesystem builtins + redirects.
function createShell(opts = {}) {
  const ctx = {
    vfs:        opts.vfs ?? null,
    env:        opts.env instanceof Map ? opts.env : new Map(Object.entries(opts.env || {})),
    cwd:        opts.cwd ?? '/',
    stdin:      '',
    stdout:     opts.stdout ?? (() => { throw new Error('createShell: stdout required'); }),
    stderr:     opts.stderr ?? opts.stdout ?? (() => { throw new Error('createShell: stderr required'); }),
    builtins:   _mergeBuiltins(opts.builtins),
    onCommand:  opts.onCommand ?? (async () => 127),
    functions:  new Map(),
    lastStatus: 0,
  };
  return {
    get env()        { return ctx.env; },
    get cwd()        { return ctx.cwd; },
    get lastStatus() { return ctx.lastStatus; },
    get builtins()   { return ctx.builtins; },
    get functions()  { return ctx.functions; },
    async exec(source) {
      const ast = parse(source);
      return await execute(ast, ctx);
    },
  };
}

function _mergeBuiltins(extra) {
  const base = defaultBuiltins();
  if (!extra) return base;
  const it = extra instanceof Map ? extra.entries() : Object.entries(extra);
  for (const [k, v] of it) base.set(k, v);
  return base;
}

export { tokenize, parse, parseWordParts, execute, defaultBuiltins, createShell, mkTyped, isTyped, NODE, createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback };
