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

// Drain a pipe-stdin into a single value. Handles the four shapes
// ctx.stdin can take after the streaming-pipes refactor:
//   string             — passed through (initial stdin / heredoc body)
//   Typed object       — passed through (single upstream push)
//   async iterable     — drained: concatenate string items, keep the
//                        last Typed pushed; if any Typed was seen,
//                        return it (matching the prior "last typed
//                        wins" rule); else return the joined text
//   anything else      — String(...) fallback
//
// Builtins that want a string call this then `String(v)`; builtins
// that understand typed values inspect the return.
async function drainInput(ctx) {
  const s = ctx.stdin;
  if (s == null) return '';
  if (typeof s === 'string') return s;
  if (isTyped(s)) return s;
  if (s && typeof s[Symbol.asyncIterator] === 'function') {
    let typed = null;
    let text = '';
    for await (const v of s) {
      if (isTyped(v)) typed = v;
      else text += typeof v === 'string' ? v : String(v);
    }
    return typed != null ? typed : text;
  }
  return String(s);
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

// Normalize a raw context into the full executor-ready shape (env/
// functions as Maps, options/positional/signal-symbols filled in,
// _geasNormalized flag set). Exported so a long-lived shell can
// normalize ONCE and reuse the same ctx across exec calls — that's
// what makes `cd` and other cwd mutations persist between commands.
function normalizeContext(ctx) {
  return _normalize(ctx);
}

function _normalize(ctx) {
  // Idempotent: an already-normalized ctx is returned as-is. This lets
  // a long-lived shell (createShell) hold ONE normalized ctx and reuse
  // it across exec calls — without this, every exec copied `cwd` (a
  // string) into a fresh object, so `cd` never persisted between
  // commands. Env / functions survived only because they're Maps
  // (shared by reference); cwd, being a primitive, was silently lost.
  if (ctx && ctx._geasNormalized) return ctx;
  return {
    _geasNormalized: true,
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
    // Optional interactive-input hook used by `read` when stdin is empty.
    readLine:   typeof ctx.readLine === 'function' ? ctx.readLine : null,
    // When true, _execProgram's catch re-throws an `exit` signal
    // instead of converting it to a return value — needed by source
    // and eval so an `exit` in their bodies halts the calling script.
    _propagateExit: !!ctx._propagateExit,
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
    //
    // `ctx._propagateExit` lets the source / eval builtins re-throw
    // the exit signal past their inner `execute()` so it reaches the
    // caller's _execProgram instead of being smoothed into a normal
    // exit code (POSIX: exit inside a sourced file halts the script).
    if (e && e._exit) {
      if (ctx._propagateExit) throw e;
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

  // Multi-stage pipeline: stages run as CONCURRENT tasks, connected by
  // bounded async queues (one queue per inter-stage gap). Backpressure
  // is built in — upstream's push awaits when the downstream queue is
  // full. When a downstream stage finishes early (`head -1`), it closes
  // its input queue, which makes upstream's next push throw _pipeClosed;
  // upstream catches that as a clean early-return signal so the long
  // walk (e.g. `find /huge`) doesn't run to completion uselessly.
  //
  // Typed-pipe protocol stays: a stage can push a Typed value (`from-csv`)
  // or string chunks; the downstream's drain (_drainInput in builtins.js)
  // collects items and returns either text or a Typed value, matching
  // the previous semantics. The order rule (last typed wins, strings
  // concat) is preserved by the drain helper, not by the queue itself.
  const stages = node.commands;
  const queues = [];
  for (let i = 0; i < stages.length - 1; i++) queues.push(_makePipeQueue());
  const exits = new Array(stages.length).fill(0);

  await Promise.all(stages.map(async (cmd, i) => {
    const isFirst = i === 0;
    const isLast  = i === stages.length - 1;
    const inQueue  = isFirst ? null : queues[i - 1];
    const outQueue = isLast  ? null : queues[i];
    // POSIX: each pipeline stage runs in a subshell-like environment.
    // Clone the mutable containers (env, functions, options, positional)
    // so a stage's `cd` / `FOO=bar` / `set -e` / `set --` mutations stay
    // inside that stage instead of leaking sideways into siblings or up
    // into the parent. Local frames reset too — `local NAME` inside a
    // pipeline stage shadowed-binding mechanics don't make sense
    // outside an enclosing function, and we're starting a fresh nesting.
    const subCtx = {
      ...ctx,
      env:        new Map(ctx.env),
      functions:  new Map(ctx.functions),
      options:    { ...ctx.options },
      positional: [...(ctx.positional || [])],
      _localFrames:  [],
      _inCondition:  false,
      _redirectFlush: null,
      stdin: inQueue ?? ctx.stdin,
      stdout: isLast ? ctx.stdout : async (value) => {
        await outQueue.push(value);
      },
    };
    try {
      const r = await _exec(cmd, subCtx);
      exits[i] = r.exitCode;
    } catch (e) {
      if (e && e._pipeClosed) {
        // Downstream went away — clean early termination.
        exits[i] = 0;
      } else {
        // Propagate after closing our outgoing queue so other stages
        // don't deadlock waiting for our writes.
        if (outQueue) outQueue.close();
        throw e;
      }
    } finally {
      if (outQueue) outQueue.close();
    }
  }));

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

// Bounded async queue connecting two pipeline stages. push() waits when
// the buffer hits the high-water mark (backpressure); iterating drains
// in FIFO order. close() signals "no more writes coming" — readers exit
// when buffer empties; pending writers wake and see the close so they
// can throw _pipeClosed to their caller (which surfaces as the
// "downstream went away" signal in the executor).
function _makePipeQueue(highWaterMark = 64) {
  let buffer = [];
  let closed = false;
  const readers = [];
  const writers = [];
  const wakeAll = (arr) => { while (arr.length) arr.shift()(); };
  return {
    async push(value) {
      if (closed) throw { _pipeClosed: true };
      buffer.push(value);
      wakeAll(readers);
      if (buffer.length >= highWaterMark) {
        await new Promise(r => writers.push(r));
        if (closed) throw { _pipeClosed: true };
      }
    },
    close() {
      closed = true;
      wakeAll(readers);
      wakeAll(writers);
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buffer.length > 0) {
          const v = buffer.shift();
          wakeAll(writers);
          yield v;
          continue;
        }
        if (closed) return;
        await new Promise(r => readers.push(r));
      }
    },
    get _isPipeQueue() { return true; },
  };
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
    subCtx = { ...ctx, _redirectFlush: null };
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

  // 3b. xtrace (`set -x`). Print the fully-expanded command line to
  // stderr before dispatch, prefixed by $PS4 (default '+ '). POSIX
  // doesn't trace compound constructs in v0 — only simple commands.
  if (subCtx.options && subCtx.options.xtrace) {
    const ps4 = subCtx.env.get('PS4') || '+ ';
    try { await subCtx.stderr(ps4 + argv.join(' ') + '\n'); } catch { /* ignore */ }
  }

  // 4. Dispatch.
  let exitCode = 127;
  try {
    try {
      if (ctx.builtins.has(cmdName)) {
        const r = await ctx.builtins.get(cmdName)(argv, subCtx);
        exitCode = typeof r === 'number' ? r : 0;
      } else if (ctx.functions.has(cmdName)) {
        const fnDef = ctx.functions.get(cmdName);
        exitCode = await _callFunction(fnDef, argv.slice(1), subCtx);
      } else {
        exitCode = await ctx.onCommand(cmdName, argv, subCtx);
      }
    } catch (e) {
      // The `exit` builtin throws { exitCode, _exit: true } to signal full
      // script termination — re-throw so _execProgram catches it instead of
      // smoothing it over into a normal exit code. `return` throws
      // { exitCode, _return: true } to unwind to the function boundary —
      // also re-throw so _callFunction sees it. Plain { exitCode } throws
      // (no _exit/_return marker) are treated as the command's exit code.
      if (e && (e._exit || e._return)) throw e;
      if (e && typeof e.exitCode === 'number') exitCode = e.exitCode;
      else throw e;
    }
  } finally {
    // Redirects buffered their writes; flush them now that the command
    // has produced all its output. Runs even if the command exited via
    // `_exit` or threw — `> file` should land its bytes either way.
    if (subCtx !== ctx) await _flushRedirects(subCtx);
  }
  ctx.lastStatus = exitCode;
  return { exitCode };
}

// ── compound commands ──

// Wrap a compound clause's execution in its trailing-redirect scope.
// POSIX allows `if/for/while/until/case ... done > file` to redirect
// the whole compound's stdout. We isolate via a sub-ctx (same shape as
// brace groups: shared env, separate redirect-flush queue), run the
// caller-supplied body, and flush at the boundary.
async function _withCompoundRedirects(node, ctx, body) {
  if (!node.redirects || node.redirects.length === 0) return await body(ctx);
  const subCtx = { ...ctx, _redirectFlush: null };
  await _applyRedirects(node.redirects, subCtx);
  try {
    return await body(subCtx);
  } finally {
    await _flushRedirects(subCtx);
  }
}

async function _execIf(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
    const cond = await _withCondition(node.cond, ctx);
    if (cond.exitCode === 0) return await _exec(node.then, ctx);
    for (const elif of node.elifs) {
      const c = await _withCondition(elif.cond, ctx);
      if (c.exitCode === 0) return await _exec(elif.then, ctx);
    }
    if (node.else) return await _exec(node.else, ctx);
    return { exitCode: 0 };
  });
}

async function _execFor(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
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
  });
}

async function _execWhile(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
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
  });
}

async function _execUntil(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
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
  });
}

async function _execCase(node, ctx) {
  return await _withCompoundRedirects(node, ctx, async (ctx) => {
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
  });
}

async function _execBraceGroup(node, ctx) {
  // Brace groups share the caller's scope (unlike subshells) — only
  // redirects are scoped. We still need a fresh _redirectFlush queue
  // so the group's redirects flush at the group boundary, not earlier.
  const subCtx = { ...ctx, _redirectFlush: null };
  await _applyRedirects(node.redirects, subCtx);
  let result;
  try {
    result = await _exec(node.body, subCtx);
  } finally {
    await _flushRedirects(subCtx);
  }
  return result;
}

async function _execSubshell(node, ctx) {
  // POSIX: subshells run in a copy of the parent's environment, so any
  // mutation — env vars, cwd, function definitions, set-options, last
  // status — stays inside. We clone every mutable container; `options`
  // gets a shallow spread (it's a flat bool record). Positional params
  // are immutable arrays so a reference-share is fine.
  const subCtx = {
    ...ctx,
    env:       new Map(ctx.env),
    functions: new Map(ctx.functions),
    options:   { ...ctx.options },
    lastStatus: ctx.lastStatus,
    _redirectFlush: null,
    // The subshell starts a fresh execution context — its body is at
    // "top level" inside the subshell. Outer flags like `_inCondition`
    // (set when the subshell is the left side of `||`, the test of
    // an `if`, etc.) shouldn't suppress errexit inside.
    _inCondition: false,
  };
  await _applyRedirects(node.redirects, subCtx);
  let result;
  try {
    try {
      result = await _exec(node.body, subCtx);
    } catch (e) {
      // POSIX: an `exit` inside a subshell terminates only the subshell.
      // errexit (`set -e`) inside the subshell similarly halts only the
      // subshell. Both signal via `_exit` — convert to a regular exit
      // code for the subshell as a whole so it doesn't propagate out.
      if (e && e._exit) result = { exitCode: e.exitCode };
      else throw e;
    }
  } finally {
    await _flushRedirects(subCtx);
  }
  return result;
}

function _execFunctionDef(node, ctx) {
  ctx.functions.set(node.name, node);
  return { exitCode: 0 };
}

// ── function call frames ──
//
// Each call pushes a frame onto ctx._localFrames. The frame remembers
// the prior values of any variable later declared `local` inside the
// function, so we can restore them on return. Positional parameters
// ($1..$N, $#, $@, $*) are similarly save-and-restored.
//
// Non-local variable assignments inside a function leak to the parent
// (POSIX dynamic scoping). `local NAME[=val]` shadows the parent
// binding for the frame's lifetime. `return [N]` exits the function
// with status N; signalled via { _return: true } and caught here so
// it never propagates past the call boundary.
async function _callFunction(fnDef, args, ctx) {
  const frame = { savedBindings: new Map() };
  if (!ctx._localFrames) ctx._localFrames = [];
  ctx._localFrames.push(frame);
  const savedPositional = ctx.positional || [];
  ctx.positional = args;
  let exitCode = 0;
  try {
    const r = await _exec(fnDef.body, ctx);
    exitCode = r.exitCode;
  } catch (e) {
    if (e && e._return) {
      exitCode = e.exitCode;
    } else {
      // Re-throw _exit (which terminates the whole script) and any other
      // non-return signal, but make sure the finally still runs to
      // unwind locals and positional.
      throw e;
    }
  } finally {
    for (const [name, prior] of frame.savedBindings) {
      if (prior === undefined) ctx.env.delete(name);
      else ctx.env.set(name, prior);
    }
    ctx._localFrames.pop();
    ctx.positional = savedPositional;
  }
  return exitCode;
}

// ── redirects ──

async function _applyRedirects(redirects, ctx) {
  if (!redirects || redirects.length === 0) return;
  // Each write redirect buffers its chunks into a local array; the
  // single VFS write happens in `_flushRedirects` at the command (or
  // brace/subshell) boundary. The previous per-call read+rewrite cost
  // O(n²) for hot loops like `for i in ...; do echo $i >> file; done`.
  const ensureFlushQueue = () => {
    if (!ctx._redirectFlush) ctx._redirectFlush = [];
    return ctx._redirectFlush;
  };
  for (const r of redirects) {
    const target = await _expandWord(r.target, ctx);
    const isWrite = r.op === '>' || r.op === '>|' || r.op === '>>';
    const fd = r.fd;
    if (isWrite) {
      _requireVfs(ctx, `redirect ${r.op}`);
      const path = _resolvePath(target, ctx);
      const buf = [];
      const sink = (text) => {
        buf.push(typeof text === 'string' ? text : String(text));
      };
      // POSIX defaults: `>` / `>|` route fd 1 (stdout) to the file;
      // `2>` routes fd 2; other fd numbers are not modeled in v0.
      if (fd === 2) ctx.stderr = sink;
      else          ctx.stdout = sink;
      const appendMode = r.op === '>>';
      ensureFlushQueue().push(async () => {
        const out = buf.join('');
        if (appendMode) {
          let prior = '';
          try { prior = await ctx.vfs.readFile(path, 'text'); } catch { /* missing file → start fresh */ }
          await ctx.vfs.writeFile(path, prior + out);
        } else {
          // `>` truncates: even with zero output, the file is created/emptied.
          await ctx.vfs.writeFile(path, out);
        }
      });
      continue;
    }
    if (r.op === '<') {
      _requireVfs(ctx, 'redirect <');
      const path = _resolvePath(target, ctx);
      ctx.stdin = await ctx.vfs.readFile(path, 'text');
      continue;
    }
    if (r.op === '<<' || r.op === '<<-') {
      // Here-doc body was attached at parse time.
      let body = r.body ?? '';
      if (!r.bodyQuoted) body = await _expandTextString(body, ctx);
      ctx.stdin = body;
      continue;
    }
    if (r.op === '>&' || r.op === '<&') {
      // Duplicate fd. `2>&1` (stderr → stdout) and `1>&2` are the common cases.
      if (fd === 2 && target === '1') ctx.stderr = ctx.stdout;
      else if (fd === 1 && target === '2') ctx.stdout = ctx.stderr;
      // Other dup combinations are rare; skip for v0.
    }
  }
}

// Drain a context's pending redirect-flush callbacks. Called at the
// boundary of any scope that applied redirects (simple command, brace
// group, subshell). Failures during flush emit a stderr diagnostic but
// don't unwind further — the command's exit code is already decided.
async function _flushRedirects(ctx) {
  if (!ctx._redirectFlush || ctx._redirectFlush.length === 0) return;
  const queue = ctx._redirectFlush;
  ctx._redirectFlush = null;
  for (const flush of queue) {
    try { await flush(); }
    catch (e) {
      try { await ctx.stderr(`geas: redirect: ${e.message || e}\n`); } catch { /* ignore */ }
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
      // Exception: a dq containing only `"$@"` with no positional args
      // legitimately produces ZERO fields (POSIX), so we don't emit the
      // sentinel when the inside had content but resolved to no frags.
      const before = frags.length;
      for (const p of part.parts) await _expandPartToFrags(p, ctx, frags, /*inQuote*/ true);
      if (part.parts.length === 0 && frags.length === before) {
        frags.push({ t: '', s: false, q: true });
      }
      return;
    }
    case 'var': {
      // `$@` and `$*` are special: each positional becomes its own field.
      // POSIX:
      //   $@ unquoted   → each positional, then IFS-split each (rare)
      //   "$@"          → each positional, NO splitting (the common case)
      //   $* unquoted   → IFS-joined into one field, then IFS-split
      //   "$*"          → IFS-joined into one field, NO splitting
      // We use a splittable space frag between each positional to force
      // field boundaries through the splitter regardless of quoting.
      if (part.name === '@') {
        const pos = ctx.positional || [];
        for (let k = 0; k < pos.length; k++) {
          if (k > 0) frags.push({ t: ' ', s: true, q: false }); // boundary
          frags.push({ t: pos[k], s: false, q: inQuote });
        }
        return;
      }
      frags.push({ t: _lookupVar(part.name, ctx), s: !inQuote, q: inQuote });
      return;
    }
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
    // `#` is overloaded: `${#name}` (parser emits word=null) is length;
    // `${name#pat}` and friends are prefix/suffix removal using
    // _patternRemove's scan-based glob matcher.
    case '#':
    case '##':
    case '%':
    case '%%': {
      if (part.op === '#' && part.word == null) return String(val.length);
      const pat = part.word ? await _expandWord(part.word, ctx) : '';
      return _patternRemove(val, pat, part.op);
    }
    default: return val;
  }
}

function _patternRemove(s, pat, op) {
  // POSIX glob → regex via _globToRegExp. Match is scan-based rather
  // than relying on regex backtracking: appending `?` to make a regex
  // "lazy" only works for trailing quantifiers, and a bare `[abc]?`
  // means "optional class" not "shortest match." Direct scanning gives
  // unambiguous shortest/longest semantics for arbitrary glob shapes.
  const re = _globToRegExp(pat);
  const anchored = new RegExp('^' + re.source + '$');
  if (op === '#') {
    // Prefix shortest: empty prefix outward.
    for (let i = 0; i <= s.length; i++) {
      if (anchored.test(s.slice(0, i))) return s.slice(i);
    }
    return s;
  }
  if (op === '##') {
    // Prefix longest: full-string inward.
    for (let i = s.length; i >= 0; i--) {
      if (anchored.test(s.slice(0, i))) return s.slice(i);
    }
    return s;
  }
  if (op === '%') {
    // Suffix shortest: empty suffix outward.
    for (let i = s.length; i >= 0; i--) {
      if (anchored.test(s.slice(i))) return s.slice(0, i);
    }
    return s;
  }
  if (op === '%%') {
    // Suffix longest: full-string inward.
    for (let i = 0; i <= s.length; i++) {
      if (anchored.test(s.slice(i))) return s.slice(0, i);
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

// ── arithmetic expansion ──
//
// Real recursive-descent parser over POSIX arith. Replaces the previous
// `eval()`-after-substitution hack — the eval was gated by a strict
// charset regex, but that regex blocked legitimate POSIX syntax like
// `$((x = 5))` or `$((x ? a : b))`, and the eval itself was a code
// smell even when gated.
//
// Precedence ladder (low → high): assignment, ternary, logical-or,
// logical-and, bitwise-or, bitwise-xor, bitwise-and, equality,
// comparison, shift, additive, multiplicative, unary, primary.
//
// All arithmetic is 32-bit integer (POSIX). Division truncates toward
// zero. Division/modulo by zero → 0 (silent; POSIX-undefined). Variables
// can be referenced bare (`x`) or with `$` (`$x`); both look up in
// ctx.env. Unbound names treat as 0.
function _evalArith(body, ctx) {
  let tokens;
  try {
    tokens = _arithTokenize(body);
  } catch {
    return '0';
  }
  const state = { tokens, i: 0 };
  let val;
  try {
    val = _arithAssign(state, ctx);
    if (state.i !== tokens.length) return '0';
  } catch {
    return '0';
  }
  return String(val | 0);
}

const _ARITH_OPS = [
  // Longest-first so '<<=' beats '<<' beats '<'.
  '<<=', '>>=',
  '&&', '||', '<<', '>>', '<=', '>=', '==', '!=',
  '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=',
  '+', '-', '*', '/', '%', '!', '~', '&', '|', '^',
  '<', '>', '=', '(', ')', '?', ':', ',',
];

function _arithTokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i, val;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 16);
      } else if (ch === '0' && /[0-7]/.test(src[i + 1] || '')) {
        j = i;
        while (j < src.length && /[0-7]/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 8);
      } else {
        while (j < src.length && /\d/.test(src[j])) j++;
        val = parseInt(src.slice(i, j), 10);
      }
      tokens.push({ type: 'num', val: Number.isFinite(val) ? val : 0 });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'var', val: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '$') {
      // POSIX: `$var` inside arith is just `var` — the $ is optional.
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      if (j === i + 1) throw new Error('arith: lone $');
      tokens.push({ type: 'var', val: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    let matched = null;
    for (const op of _ARITH_OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      tokens.push({ type: 'op', val: matched });
      i += matched.length;
      continue;
    }
    throw new Error(`arith: unexpected char "${ch}"`);
  }
  return tokens;
}

function _arithLookup(name, ctx) {
  if (!ctx.env.has(name)) return 0;
  const v = ctx.env.get(name);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? (n | 0) : 0;
}

const _ARITH_ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=',
]);

// Assignment is right-associative. We peek for `var <assign-op>` and
// take the assignment branch only when both fit; otherwise fall through
// to the ternary level.
function _arithAssign(state, ctx) {
  const t = state.tokens[state.i];
  const next = state.tokens[state.i + 1];
  if (t && t.type === 'var' && next && next.type === 'op' && _ARITH_ASSIGN_OPS.has(next.val)) {
    const name = t.val;
    const op = next.val;
    state.i += 2;
    const rhs = _arithAssign(state, ctx);
    let val;
    if (op === '=') {
      val = rhs;
    } else {
      const cur = _arithLookup(name, ctx);
      switch (op) {
        case '+=':  val = (cur + rhs) | 0; break;
        case '-=':  val = (cur - rhs) | 0; break;
        case '*=':  val = (cur * rhs) | 0; break;
        case '/=':  val = rhs === 0 ? 0 : (Math.trunc(cur / rhs) | 0); break;
        case '%=':  val = rhs === 0 ? 0 : (cur % rhs) | 0; break;
        case '|=':  val = (cur | rhs) | 0; break;
        case '&=':  val = (cur & rhs) | 0; break;
        case '^=':  val = (cur ^ rhs) | 0; break;
        case '<<=': val = (cur << rhs) | 0; break;
        case '>>=': val = (cur >> rhs) | 0; break;
      }
    }
    val = val | 0;
    ctx.env.set(name, String(val));
    return val;
  }
  return _arithTernary(state, ctx);
}

function _arithTernary(state, ctx) {
  const cond = _arithLogicalOr(state, ctx);
  const t = state.tokens[state.i];
  if (t && t.val === '?') {
    state.i++;
    const ifTrue = _arithAssign(state, ctx);
    const colon = state.tokens[state.i];
    if (!colon || colon.val !== ':') throw new Error("arith: expected ':'");
    state.i++;
    const ifFalse = _arithAssign(state, ctx);
    return cond !== 0 ? ifTrue : ifFalse;
  }
  return cond;
}

function _arithLogicalOr(state, ctx) {
  let left = _arithLogicalAnd(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '||') {
    state.i++;
    const right = _arithLogicalAnd(state, ctx);
    left = (left !== 0 || right !== 0) ? 1 : 0;
  }
  return left;
}

function _arithLogicalAnd(state, ctx) {
  let left = _arithBitOr(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '&&') {
    state.i++;
    const right = _arithBitOr(state, ctx);
    left = (left !== 0 && right !== 0) ? 1 : 0;
  }
  return left;
}

function _arithBitOr(state, ctx) {
  let left = _arithBitXor(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '|') {
    state.i++;
    left = (left | _arithBitXor(state, ctx)) | 0;
  }
  return left;
}

function _arithBitXor(state, ctx) {
  let left = _arithBitAnd(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '^') {
    state.i++;
    left = (left ^ _arithBitAnd(state, ctx)) | 0;
  }
  return left;
}

function _arithBitAnd(state, ctx) {
  let left = _arithEq(state, ctx);
  while (state.tokens[state.i] && state.tokens[state.i].val === '&') {
    state.i++;
    left = (left & _arithEq(state, ctx)) | 0;
  }
  return left;
}

function _arithEq(state, ctx) {
  let left = _arithCmp(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '==' || state.tokens[state.i].val === '!=')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithCmp(state, ctx);
    left = (op === '==' ? left === right : left !== right) ? 1 : 0;
  }
  return left;
}

function _arithCmp(state, ctx) {
  let left = _arithShift(state, ctx);
  while (state.tokens[state.i] && ['<', '<=', '>', '>='].includes(state.tokens[state.i].val)) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithShift(state, ctx);
    let r;
    switch (op) {
      case '<':  r = left <  right; break;
      case '<=': r = left <= right; break;
      case '>':  r = left >  right; break;
      case '>=': r = left >= right; break;
    }
    left = r ? 1 : 0;
  }
  return left;
}

function _arithShift(state, ctx) {
  let left = _arithAdd(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '<<' || state.tokens[state.i].val === '>>')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithAdd(state, ctx);
    left = (op === '<<' ? left << right : left >> right) | 0;
  }
  return left;
}

function _arithAdd(state, ctx) {
  let left = _arithMul(state, ctx);
  while (state.tokens[state.i] && (state.tokens[state.i].val === '+' || state.tokens[state.i].val === '-')) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithMul(state, ctx);
    left = (op === '+' ? left + right : left - right) | 0;
  }
  return left;
}

function _arithMul(state, ctx) {
  let left = _arithUnary(state, ctx);
  while (state.tokens[state.i] && ['*', '/', '%'].includes(state.tokens[state.i].val)) {
    const op = state.tokens[state.i].val;
    state.i++;
    const right = _arithUnary(state, ctx);
    if ((op === '/' || op === '%') && right === 0) return 0;
    let r;
    switch (op) {
      case '*': r = left * right; break;
      case '/': r = Math.trunc(left / right); break;
      case '%': r = left % right; break;
    }
    left = r | 0;
  }
  return left;
}

function _arithUnary(state, ctx) {
  const t = state.tokens[state.i];
  if (t && t.type === 'op') {
    if (t.val === '-') { state.i++; return (-_arithUnary(state, ctx)) | 0; }
    if (t.val === '+') { state.i++; return _arithUnary(state, ctx); }
    if (t.val === '!') { state.i++; return _arithUnary(state, ctx) === 0 ? 1 : 0; }
    if (t.val === '~') { state.i++; return (~_arithUnary(state, ctx)) | 0; }
  }
  return _arithPrimary(state, ctx);
}

function _arithPrimary(state, ctx) {
  const t = state.tokens[state.i];
  if (!t) throw new Error('arith: unexpected end');
  if (t.type === 'num') { state.i++; return t.val | 0; }
  if (t.type === 'var') { state.i++; return _arithLookup(t.val, ctx); }
  if (t.type === 'op' && t.val === '(') {
    state.i++;
    const r = _arithAssign(state, ctx);
    const close = state.tokens[state.i];
    if (!close || close.val !== ')') throw new Error("arith: expected ')'");
    state.i++;
    return r;
  }
  throw new Error(`arith: unexpected token "${t.val}"`);
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
    'from-csv':  _fromCsv,
    'to-csv':    _toCsv,
    'from-json': _fromJson,
    'to-json':   _toJson,
    where:       _where,
    select:      _select,
    'first':     _first,
    'last':      _last,
    display:     _display,
    plot:        _plot,
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
      // No path → drain stdin (handles string, typed, async-iterable queue).
      const v = await drainInput(ctx);
      text = typeof v === 'string' ? v : String(v);
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
  const v = await drainInput(ctx);
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

// Common: pull a table out of ctx.stdin, parsing text if needed. Drains
// a streaming-pipe queue down to a single value first (typed if any was
// seen, else concatenated text).
async function _consumeTable(ctx) {
  const v = await drainInput(ctx);
  if (isTyped(v) && v.kind === 'table') return v.value;
  if (isTyped(v) && v.kind === 'array'
      && Array.isArray(v.value)
      && v.value.length > 0
      && typeof v.value[0] === 'object'
      && !Array.isArray(v.value[0])) {
    return _objectArrayToTable(v.value);
  }
  const text = isTyped(v) ? String(v) : (typeof v === 'string' ? v : String(v));
  return parseCSV(text);
}

// ── from-json / to-json ──
//
// from-json [FILE]: read JSON from FILE or stdin, emit a Typed value
// shaped to the JSON's structure:
//   - array of flat objects → kind='table' (where/select usable)
//   - array of primitives or mixed → kind='array'
//   - object → kind='object'
//   - scalar → text (no typing needed)
//
// to-json: consume any Typed value (or JSON text) and serialize to JSON
// text. `--pretty` (or `-p`) for indented output. Tables serialize as
// arrays of objects keyed by column name (the canonical JSON shape).
async function _fromJson(argv, ctx) {
  const path = argv[1];
  let text;
  try {
    if (path) {
      if (!ctx.vfs) {
        await ctx.stderr('from-json: no VFS configured\n');
        return 1;
      }
      const abs = path.startsWith('/') ? path
        : (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + path;
      text = await ctx.vfs.readFile(abs, 'text');
    } else {
      const v = await drainInput(ctx);
      text = typeof v === 'string' ? v : String(v);
    }
  } catch (e) {
    await ctx.stderr(`from-json: ${e.message}\n`);
    return 1;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    await ctx.stderr(`from-json: parse error: ${e.message}\n`);
    return 1;
  }
  // Shape-routing: array of homogeneous flat objects becomes a table.
  if (Array.isArray(parsed) && parsed.length > 0
      && parsed.every(r => r != null && typeof r === 'object' && !Array.isArray(r))) {
    const table = _objectArrayToTable(parsed);
    await ctx.stdout(mkTyped('table', table, () => JSON.stringify(parsed)));
    return 0;
  }
  if (Array.isArray(parsed)) {
    await ctx.stdout(mkTyped('array', parsed, () => JSON.stringify(parsed)));
    return 0;
  }
  if (parsed !== null && typeof parsed === 'object') {
    await ctx.stdout(mkTyped('object', parsed, () => JSON.stringify(parsed)));
    return 0;
  }
  // Scalars: just emit as text.
  await ctx.stdout(JSON.stringify(parsed) + '\n');
  return 0;
}

async function _toJson(argv, ctx) {
  const pretty = argv.slice(1).some(a => a === '--pretty' || a === '-p');
  const indent = pretty ? 2 : 0;
  const v = await drainInput(ctx);
  let obj;
  if (isTyped(v)) {
    if (v.kind === 'table') obj = _tableToObjectArray(v.value);
    else obj = v.value;
  } else if (typeof v === 'string') {
    try { obj = JSON.parse(v); }
    catch { obj = v; }
  } else if (v == null) {
    obj = null;
  } else {
    obj = v;
  }
  await ctx.stdout(JSON.stringify(obj, null, indent) + '\n');
  return 0;
}

// Convert an array of flat objects into a {columns, rows} table.
// Column order = first-seen order across all rows.
function _objectArrayToTable(arr) {
  const colSet = new Set();
  for (const r of arr) for (const k of Object.keys(r)) colSet.add(k);
  const columns = [...colSet];
  const rows = arr.map(r => columns.map(c => r[c] ?? ''));
  return { columns, rows };
}

function _tableToObjectArray(table) {
  const cols = table.columns || [];
  return (table.rows || []).map(row => {
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    return obj;
  });
}

// ── display / plot ──
//
// display: render whatever's in the pipe as text. Tables get
// fixed-width column layout; arrays/objects get JSON; everything
// else passes through as text. Useful for forcing a human-readable
// rendering mid-pipeline or before saving.
//
// plot [--kind line|scatter|bar|hist] [--x COL] [--y COL]: emit a
// Typed 'plot' descriptor that an adapter capable of rich-block
// rendering can show as a chart. Fallback text rendering is an ASCII
// sparkline + summary (min/max/n), so degradation to terminal is
// graceful.
async function _display(_argv, ctx) {
  const v = await drainInput(ctx);
  if (v == null || v === '') return 0;
  if (isTyped(v)) {
    if (v.kind === 'table') {
      await ctx.stdout(formatTable(v.value));
      return 0;
    }
    if (v.kind === 'array' || v.kind === 'object') {
      await ctx.stdout(JSON.stringify(v.value, null, 2) + '\n');
      return 0;
    }
    // Unknown typed kind: fall back to its text rendering.
    await ctx.stdout(String(v));
    return 0;
  }
  await ctx.stdout(typeof v === 'string' ? v : String(v));
  return 0;
}

async function _plot(argv, ctx) {
  const opts = { kind: 'line', x: null, y: null };
  const cols = [];
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--x' && i + 1 < argv.length) { opts.x = argv[++i]; i++; continue; }
    if (a === '--y' && i + 1 < argv.length) { opts.y = argv[++i]; i++; continue; }
    if (a === '--kind' && i + 1 < argv.length) { opts.kind = argv[++i]; i++; continue; }
    if (a.startsWith('--')) { i++; continue; }
    cols.push(a);
    i++;
  }
  const table = await _consumeTable(ctx);
  // Resolve x/y. Default behaviour:
  //   1-positional COL → y=COL, x=row index
  //   2-positional X Y → x=X, y=Y
  //   --y / --x override
  let xCol = opts.x;
  let yCol = opts.y ?? cols[cols.length - 1] ?? table.columns[0];
  if (!opts.x && cols.length >= 2) xCol = cols[0];
  const yIdx = table.columns.indexOf(yCol);
  if (yIdx < 0) {
    await ctx.stderr(`plot: no column "${yCol}"\n`);
    return 2;
  }
  const xIdx = xCol ? table.columns.indexOf(xCol) : -1;
  if (xCol && xIdx < 0) {
    await ctx.stderr(`plot: no column "${xCol}"\n`);
    return 2;
  }
  const ys = table.rows.map(r => Number(r[yIdx])).filter(n => Number.isFinite(n));
  const xs = xIdx >= 0
    ? table.rows.map(r => Number(r[xIdx]))
    : ys.map((_, k) => k);
  const spec = { kind: opts.kind, xCol: xCol ?? '_index', yCol, xs, ys };
  await ctx.stdout(mkTyped('plot', spec, () => _plotAscii(spec)));
  return 0;
}

function _plotAscii(spec) {
  if (spec.ys.length === 0) return '(no data)\n';
  if (spec.kind === 'hist') return _histAscii(spec);
  const min = Math.min(...spec.ys);
  const max = Math.max(...spec.ys);
  const range = max - min || 1;
  const blocks = '▁▂▃▄▅▆▇█';
  let bar = '';
  for (const v of spec.ys) {
    const t = (v - min) / range;
    const k = Math.min(blocks.length - 1, Math.max(0, Math.floor(t * blocks.length)));
    bar += blocks[k];
  }
  const head = `${spec.kind} ${spec.yCol}`;
  const footer = `min=${_fmtNum(min)} max=${_fmtNum(max)} n=${spec.ys.length}`;
  return `${head}\n${bar}\n${footer}\n`;
}

function _histAscii(spec) {
  const n = spec.ys.length;
  if (n === 0) return '(no data)\n';
  const min = Math.min(...spec.ys);
  const max = Math.max(...spec.ys);
  const bins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(n))));
  const w = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of spec.ys) {
    let k = Math.floor((v - min) / w);
    if (k >= bins) k = bins - 1;
    if (k < 0) k = 0;
    counts[k]++;
  }
  const peak = Math.max(...counts);
  const blocks = '▁▂▃▄▅▆▇█';
  let bar = '';
  for (const c of counts) {
    const t = peak ? c / peak : 0;
    const i = Math.min(blocks.length - 1, Math.max(0, Math.floor(t * blocks.length)));
    bar += blocks[i];
  }
  return `hist ${spec.yCol}\n${bar}\nmin=${_fmtNum(min)} max=${_fmtNum(max)} bins=${bins} n=${n}\n`;
}

function _fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
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

// -- pkg-cmd.js --

// pkg — the geas-side of the pkg-spec CLI. Lives alongside the other
// builtins so users can `pkg install npm:leaflet` from a geas terminal
// in Auditable Works or a `!pkg install ...` cell in a notebook.
//
// Spec: spec_inbox/auditable-pkg-spec.md.
//
// Subcommands (v1):
//   pkg install <alias>      — fetch, verify, write to /lib + lockfile
//   pkg install              — restore every entry from /lib/.gcu-lock.json
//   pkg list                 — list installed modules
//   pkg freeze               — print the workspace lockfile
//   pkg remove <alias>       — drop the entry + its /lib directory
//   pkg help                 — usage
//
// v1 always installs to workspace /lib. The --project flag (per-notebook
// installs to /projects/self/lib/) is deferred — needs the cell-side
// install() builtin to coordinate, which is its own design step.

const LIB_ROOT = '/lib';
const LOCKFILE = LIB_ROOT + '/.gcu-lock.json';

// pkg-spec §3.3 alias prefixes → URLs. Duplicated from
// src/js/cell-builtins/modules.js (different package; coreutils
// extraction will deduplicate later).
function _aliasToUrl(key) {
  if (key.startsWith('npm:'))   return { url: 'https://esm.sh/' + key.slice(4) };
  if (key.startsWith('jsr:'))   return { url: 'https://esm.sh/jsr/' + key.slice(4) };
  if (key.startsWith('gh:'))    return { url: 'https://esm.sh/gh/' + key.slice(3) };
  if (key.startsWith('@gcu/'))  return { url: 'https://esm.sh/' + key + '/bundled',
                                         fallback: 'https://esm.sh/' + key };
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return { url: 'https://esm.sh/' + key };
  return null;
}

// pkg-spec §3.1 key → /lib path. Duplicated from src/js/persist.js.
async function _sha256Short(s) {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf, 0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _keyToLibPath(key) {
  if (key.startsWith('npm:'))    return LIB_ROOT + '/npm/'    + key.slice('npm:'.length);
  if (key.startsWith('jsr:'))    return LIB_ROOT + '/jsr/'    + key.slice('jsr:'.length);
  if (key.startsWith('gh:'))     return LIB_ROOT + '/gh/'     + key.slice('gh:'.length);
  if (key.startsWith('local:'))  return LIB_ROOT + '/local/'  + await _sha256Short(key);
  if (key.startsWith('http://') || key.startsWith('https://'))
                                 return LIB_ROOT + '/url/'    + await _sha256Short(key);
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) return LIB_ROOT + '/' + key;
  return LIB_ROOT + '/url/' + await _sha256Short(key);
}

// SRI hash over the un-compressed bytes. pkg-spec §4.1.
function _toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function _sha256SRI(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256-' + _toBase64(new Uint8Array(buf));
}

// esm.sh wrapper unwrap (bounded). Matches modules.js install path.
async function _fetchAndUnwrap(startUrl) {
  const wrapperRe = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?export\s+\*\s+from\s*["']([^"']+)["'];?\s*$/;
  let currentUrl = startUrl;
  for (let hop = 0; hop < 3; hop++) {
    const resp = await fetch(currentUrl);
    if (!resp.ok) {
      if (hop === 0) return { ok: false, status: resp.status };
      throw new Error(`Failed to fetch ${currentUrl}: ${resp.status}`);
    }
    const text = await resp.text();
    const m = text.trim().match(wrapperRe);
    if (m) { currentUrl = new URL(m[1], resp.url).href; continue; }
    return { ok: true, source: text, finalUrl: resp.url };
  }
  throw new Error('Too many esm.sh wrapper redirects');
}

async function _readLockfile(vfs) {
  try {
    const raw = await vfs.readFile(LOCKFILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj.modules || typeof obj.modules !== 'object') obj.modules = {};
    if (!obj.version) obj.version = 1;
    return obj;
  } catch { return { version: 1, modules: {} }; }
}

async function _writeLockfile(vfs, lockfile) {
  await vfs.writeFile(LOCKFILE, JSON.stringify(lockfile, null, 2));
}

// pkg install <alias>  — one entry, end-to-end.
async function _installOne(ctx, alias) {
  const vfs = ctx.vfs;
  if (!vfs) { await ctx.stderr('pkg: no VFS in this context\n'); return 1; }

  let url, fallback;
  if (alias.startsWith('local:')) {
    // local: — read the surface VFS, no fetch.
    const fsPath = alias.slice('local:'.length);
    let source;
    try { source = await vfs.readFile(fsPath, 'utf8'); }
    catch (e) { await ctx.stderr(`pkg: cannot read ${fsPath}: ${e.message}\n`); return 1; }
    const dir = await _keyToLibPath(alias);
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.writeFile(dir + '/source', source);
    const meta = { alias, url: alias, kind: 'local',
      installedAt: new Date().toISOString(), size: source.length };
    await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));
    const lockfile = await _readLockfile(vfs);
    lockfile.modules[alias] = meta;
    await _writeLockfile(vfs, lockfile);
    await ctx.stdout(`installed ${alias} (${source.length} bytes, local)\n`);
    return 0;
  }

  if (alias.startsWith('http://') || alias.startsWith('https://')) {
    url = alias;
  } else {
    const r = _aliasToUrl(alias);
    if (!r) { await ctx.stderr(`pkg: don't know how to resolve "${alias}"\n`); return 1; }
    url = r.url; fallback = r.fallback;
  }

  let result;
  try { result = await _fetchAndUnwrap(url); }
  catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
  if (!result.ok && fallback) {
    try { result = await _fetchAndUnwrap(fallback); }
    catch (e) { await ctx.stderr(`pkg: ${e.message}\n`); return 1; }
  }
  if (!result.ok) {
    await ctx.stderr(`pkg: fetch ${url} failed (${result.status})\n`);
    return 1;
  }

  const source = result.source;
  const finalUrl = result.finalUrl;
  const sourceBytes = new TextEncoder().encode(source);
  const integrity = await _sha256SRI(sourceBytes);

  const dir = await _keyToLibPath(alias);
  await vfs.mkdir(dir, { recursive: true }).catch(() => {});
  await vfs.writeFile(dir + '/source', source);
  const meta = { alias, url: finalUrl, integrity, kind: 'js',
    installedAt: new Date().toISOString(), size: sourceBytes.length };
  await vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));

  const lockfile = await _readLockfile(vfs);
  lockfile.modules[alias] = meta;
  await _writeLockfile(vfs, lockfile);

  await ctx.stdout(`installed ${alias} (${sourceBytes.length} bytes) → ${finalUrl}\n`);
  return 0;
}

// pkg install (no args) — restore every entry from the lockfile.
async function _installFromLockfile(ctx) {
  const vfs = ctx.vfs;
  const lockfile = await _readLockfile(vfs);
  const aliases = Object.keys(lockfile.modules);
  if (aliases.length === 0) {
    await ctx.stdout('pkg: lockfile is empty\n');
    return 0;
  }
  let failed = 0;
  for (const alias of aliases) {
    const rc = await _installOne(ctx, alias);
    if (rc !== 0) failed++;
  }
  if (failed > 0) {
    await ctx.stderr(`pkg: ${failed}/${aliases.length} installs failed\n`);
    return 1;
  }
  return 0;
}

async function _list(ctx) {
  const lockfile = await _readLockfile(ctx.vfs);
  const aliases = Object.keys(lockfile.modules).sort();
  if (aliases.length === 0) {
    await ctx.stdout('(no modules installed)\n');
    return 0;
  }
  for (const alias of aliases) {
    const m = lockfile.modules[alias];
    const size = m.size ? `${m.size}b` : '?';
    const kind = m.kind || '?';
    await ctx.stdout(`${alias.padEnd(30)}  ${kind.padEnd(6)}  ${size}\n`);
  }
  return 0;
}

async function _freeze(ctx) {
  const lockfile = await _readLockfile(ctx.vfs);
  await ctx.stdout(JSON.stringify(lockfile, null, 2) + '\n');
  return 0;
}

async function _remove(ctx, alias) {
  const vfs = ctx.vfs;
  const lockfile = await _readLockfile(vfs);
  if (!(alias in lockfile.modules)) {
    await ctx.stderr(`pkg: ${alias} not installed\n`);
    return 1;
  }
  const dir = await _keyToLibPath(alias);
  try { await vfs.rm(dir, { recursive: true }); }
  catch (e) { /* directory may not exist if lockfile drifted */ }
  delete lockfile.modules[alias];
  await _writeLockfile(vfs, lockfile);
  await ctx.stdout(`removed ${alias}\n`);
  return 0;
}

async function _help(ctx) {
  await ctx.stdout([
    'usage: pkg <subcommand> [args...]',
    '',
    'subcommands:',
    '  install <alias>     fetch + verify, write to /lib + lockfile',
    '  install             re-install every entry from /lib/.gcu-lock.json',
    '  list                list installed modules',
    '  freeze              print the workspace lockfile',
    '  remove <alias>      delete the entry + its /lib directory',
    '  help                show this message',
    '',
    'alias prefixes (pkg-spec §3.3):',
    '  @gcu/<name>         GCU package via esm.sh',
    '  npm:<name>          npm package via esm.sh',
    '  jsr:<name>          jsr.io package via esm.sh',
    '  gh:<user>/<repo>    GitHub repo via esm.sh',
    '  local:/<vfs-path>   surface VFS, no integrity, no caching',
    '',
  ].join('\n'));
  return 0;
}

async function _pkg(argv, ctx) {
  const sub = argv[1];
  switch (sub) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':  return _help(ctx);
    case 'install': return argv[2] ? _installOne(ctx, argv[2]) : _installFromLockfile(ctx);
    case 'list':    return _list(ctx);
    case 'freeze':  return _freeze(ctx);
    case 'remove':
    case 'rm':      if (!argv[2]) { await ctx.stderr('pkg: remove needs <alias>\n'); return 1; }
                    return _remove(ctx, argv[2]);
    default:        await ctx.stderr(`pkg: unknown subcommand "${sub}" (try 'pkg help')\n`);
                    return 1;
  }
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
    local:    _local,
    return:   _return,
    shift:    _shift,
    clear:    _clear,
    eval:     _eval,
    source:   _source,
    '.':      _source,
    getopts:  _getopts,
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
    cp:       _cp,
    mv:       _mv,
    stat:     _stat,
    find:     _find,
    tree:     _tree,
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
    tr:       _tr,
    // Disk / hash / encoding
    du:       _du,
    df:       _df,
    base64:   _base64,
    md5sum:   _md5sum,
    sha256sum: _sha256sum,
    // pkg-spec §5: install / list / freeze / remove modules into /lib.
    pkg:      _pkg,
  }));
}

// ── individual builtins ──

async function _colon() { return 0; }

async function _echo(argv, ctx) {
  const args = argv.slice(1);
  let newline = true;
  let interpret = false;
  // `-n` no trailing newline; `-e` enable backslash interpretation
  // (bash default off); `-E` explicitly off. Flag combos like `-ne`
  // accepted. Anything else is treated as a positional argument.
  while (args.length && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    if (args[0].includes('e')) interpret = true;
    if (args[0].includes('E')) interpret = false;
    args.shift();
  }
  let text = args.join(' ');
  if (interpret) text = _printfBackslashArg(text);
  await ctx.stdout(text + (newline ? '\n' : ''));
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

// POSIX test grammar (precedence low → high):
//
//   expr      := or-expr
//   or-expr   := and-expr ( '-o' and-expr )*
//   and-expr  := not-expr ( '-a' not-expr )*
//   not-expr  := '!' not-expr | atom
//   atom      := '(' expr ')' | unary-atom | binary-atom | nonempty-atom
//
// Recursive descent. The compiled predicate is a `(ctx) → Promise<bool>`
// that the outer _test runs once, then translates bool → exit code
// (0 = true, 1 = false, 2 = parse error).
const _TEST_UNARY_OPS = new Set([
  '-z', '-n', '-e', '-f', '-d', '-s', '-r', '-w', '-x',
]);
const _TEST_BINARY_OPS = new Set([
  '=', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge',
]);

async function _test(argv, ctx) {
  const args = argv.slice(1);
  if (args.length === 0) return 1;
  // 1-arg fast path: true iff non-empty. Skipping the parser here lets
  // `[ ( ]` or `[ -a ]` etc. work as plain non-empty tests (POSIX-friendly
  // — single-arg test never invokes operator parsing).
  if (args.length === 1) return args[0].length > 0 ? 0 : 1;
  let predicate;
  try {
    predicate = _testCompile(args);
  } catch (e) {
    await ctx.stderr(`test: ${e.message}\n`);
    return 2;
  }
  try {
    const r = await predicate(ctx);
    return r ? 0 : 1;
  } catch (e) {
    await ctx.stderr(`test: ${e.message || e}\n`);
    return 2;
  }
}

function _testCompile(tokens) {
  const state = { tokens, i: 0 };
  const expr = _testParseOr(state);
  if (state.i !== tokens.length) {
    throw new Error(`unexpected token "${tokens[state.i]}"`);
  }
  return expr;
}

function _testParseOr(state) {
  let left = _testParseAnd(state);
  while (state.tokens[state.i] === '-o') {
    state.i++;
    const right = _testParseAnd(state);
    const l = left, r = right;
    left = async (ctx) => (await l(ctx)) || (await r(ctx));
  }
  return left;
}

function _testParseAnd(state) {
  let left = _testParseNot(state);
  while (state.tokens[state.i] === '-a') {
    state.i++;
    const right = _testParseNot(state);
    const l = left, r = right;
    left = async (ctx) => (await l(ctx)) && (await r(ctx));
  }
  return left;
}

function _testParseNot(state) {
  if (state.tokens[state.i] === '!') {
    state.i++;
    const inner = _testParseNot(state);
    return async (ctx) => !(await inner(ctx));
  }
  return _testParseAtom(state);
}

function _testParseAtom(state) {
  const t = state.tokens[state.i];
  if (t === undefined) throw new Error('missing operand');
  if (t === '(') {
    state.i++;
    const inner = _testParseOr(state);
    if (state.tokens[state.i] !== ')') throw new Error("missing ')'");
    state.i++;
    return inner;
  }
  // 3-arg binary atom: lookahead at i+1.
  const next = state.tokens[state.i + 1];
  if (next !== undefined && _TEST_BINARY_OPS.has(next)) {
    const a = state.tokens[state.i];
    const op = state.tokens[state.i + 1];
    const b = state.tokens[state.i + 2];
    if (b === undefined) throw new Error(`${op}: missing right operand`);
    state.i += 3;
    return async (ctx) => (await _testBinary(a, op, b, ctx)) === 0;
  }
  // 2-arg unary atom.
  if (_TEST_UNARY_OPS.has(t)) {
    const op = state.tokens[state.i];
    const val = state.tokens[state.i + 1];
    if (val === undefined) throw new Error(`${op}: missing argument`);
    state.i += 2;
    return async (ctx) => (await _testUnary(op, val, ctx)) === 0;
  }
  // 1-arg atom: true iff non-empty. Consumes one token regardless of
  // its content (so a bare `X` or `Y` inside a larger expr works).
  state.i++;
  return async () => t.length > 0;
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
// Typed-pipe contract: if stdin drains to a Typed object, fall back to
// its text rendering via toString(). Builtins that don't know about
// types transparently get the canonical text representation.
async function _bReadInput(paths, ctx) {
  if (!paths || paths.length === 0) {
    const v = await drainInput(ctx);
    return typeof v === 'string' ? v : String(v);
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

// ── cp / mv / stat — thin wrappers over the VFS surface ──
//
// cp [-r] SRC... DST
//   Single SRC, DST is file → copy SRC's bytes to DST (overwrite ok).
//   Multiple SRC or DST is a directory → copy each SRC into DST/<basename>.
//   -r recurses through directory sources, recreating the tree.
//
// mv SRC... DST
//   Same destination rules as cp. Uses vfs.rename when source and dest
//   resolve to the same backend; falls back to copy-then-unlink across
//   backends (the VFS layer typically handles this transparently when
//   you call rename, so we lean on that and fall back only on error).
//
// stat PATH...
//   Prints type, size, and path. Default format is one line per file.
async function _cp(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('cp: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    r: { short: 'r' }, R: { short: 'R' }, f: { short: 'f' },
  });
  const recursive = opts.r || opts.R;
  if (positionals.length < 2) {
    await ctx.stderr('cp: missing operand (need SRC... DST)\n');
    return 1;
  }
  const dst = positionals[positionals.length - 1];
  const srcs = positionals.slice(0, -1);
  const dstPath = _bResolvePath(dst, ctx);
  let dstIsDir = false;
  try {
    const st = await ctx.vfs.stat(dstPath);
    dstIsDir = st.type === 'directory';
  } catch { /* dst doesn't exist; treat as a file target if single src */ }
  if (srcs.length > 1 && !dstIsDir) {
    await ctx.stderr(`cp: ${dst}: not a directory (need multi-source destination)\n`);
    return 1;
  }
  let anyError = 0;
  for (const src of srcs) {
    const srcPath = _bResolvePath(src, ctx);
    const target = dstIsDir
      ? _bJoinPath(dstPath, _bBasename(srcPath))
      : dstPath;
    try {
      await _cpEntry(ctx, srcPath, target, recursive);
    } catch (e) {
      await ctx.stderr(`cp: ${src}: ${e.message || 'cannot copy'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _cpEntry(ctx, srcPath, dstPath, recursive) {
  const st = await ctx.vfs.stat(srcPath);
  if (st.type === 'directory') {
    if (!recursive) throw new Error('is a directory (use -r)');
    await ctx.vfs.mkdir(dstPath, { recursive: true });
    const entries = await ctx.vfs.readdir(srcPath);
    for (const e of entries) {
      const name = typeof e === 'string' ? e : e.name;
      await _cpEntry(ctx, _bJoinPath(srcPath, name), _bJoinPath(dstPath, name), recursive);
    }
    return;
  }
  // File: copy bytes. Try binary first, fall back to text if the
  // backend doesn't support a raw binary read (some don't).
  let content;
  try {
    content = await ctx.vfs.readFile(srcPath);
  } catch {
    content = await ctx.vfs.readFile(srcPath, 'text');
  }
  await ctx.vfs.writeFile(dstPath, content);
}

async function _mv(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('mv: no VFS configured\n'); return 1; }
  const { positionals } = _bParseArgs(argv, {
    f: { short: 'f' }, n: { short: 'n' },
  });
  if (positionals.length < 2) {
    await ctx.stderr('mv: missing operand (need SRC... DST)\n');
    return 1;
  }
  const dst = positionals[positionals.length - 1];
  const srcs = positionals.slice(0, -1);
  const dstPath = _bResolvePath(dst, ctx);
  let dstIsDir = false;
  try {
    const st = await ctx.vfs.stat(dstPath);
    dstIsDir = st.type === 'directory';
  } catch { /* dst doesn't exist */ }
  if (srcs.length > 1 && !dstIsDir) {
    await ctx.stderr(`mv: ${dst}: not a directory (need multi-source destination)\n`);
    return 1;
  }
  let anyError = 0;
  for (const src of srcs) {
    const srcPath = _bResolvePath(src, ctx);
    const target = dstIsDir
      ? _bJoinPath(dstPath, _bBasename(srcPath))
      : dstPath;
    try {
      // VFS.rename handles same-backend moves natively and may also
      // handle cross-backend (some implementations do copy+unlink
      // internally). If it fails, fall back to recursive copy + remove.
      try {
        await ctx.vfs.rename(srcPath, target);
        continue;
      } catch { /* fall through to copy+unlink */ }
      await _cpEntry(ctx, srcPath, target, /*recursive*/ true);
      // Unlink source (recursive for directories).
      const st = await ctx.vfs.stat(srcPath);
      if (st.type === 'directory') await _rmRecursive(ctx.vfs, srcPath);
      else await ctx.vfs.unlink(srcPath);
    } catch (e) {
      await ctx.stderr(`mv: ${src}: ${e.message || 'cannot move'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _stat(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('stat: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    c: { short: 'c', arg: true }, // -c FORMAT: a stripped-down strftime-like spec
  });
  if (positionals.length === 0) {
    await ctx.stderr('stat: missing operand\n');
    return 1;
  }
  let anyError = 0;
  for (const p of positionals) {
    const path = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(path);
      const line = opts.c
        ? _statFormat(opts.c, st, p)
        : _statDefault(st, p);
      await ctx.stdout(line + '\n');
    } catch (e) {
      await ctx.stderr(`stat: ${p}: ${e.message || 'cannot stat'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

function _statDefault(st, displayPath) {
  // GNU stat prints a multi-line block; we use a single-line shape
  // that's friendlier to shell pipelines (still parseable). Format:
  //   "<type> <size> <path>"
  // type is one of 'file', 'directory', 'link' (when VFS exposes it).
  const type = st.type || 'unknown';
  const size = st.size ?? 0;
  return `${type.padEnd(9)} ${String(size).padStart(10)}  ${displayPath}`;
}

function _statFormat(fmt, st, displayPath) {
  // POSIX-ish format codes — a subset of GNU's `stat -c`:
  //   %n  filename
  //   %s  size in bytes
  //   %F  type ("regular file", "directory", ...)
  //   %y  mtime (when VFS exposes it; falls back to '-')
  //   %%  literal %
  return fmt.replace(/%./g, (m) => {
    switch (m) {
      case '%n': return displayPath;
      case '%s': return String(st.size ?? 0);
      case '%F': return st.type === 'directory' ? 'directory'
                       : st.type === 'file'      ? 'regular file'
                       : (st.type || 'unknown');
      case '%y': return st.mtime ?? '-';
      case '%%': return '%';
      default:   return m;
    }
  });
}

function _bJoinPath(a, b) {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

function _bBasename(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// ── find — recursive directory walk with predicates ──
//
// find [PATH...] [EXPR...]
//
// Walks each PATH (default: cwd), evaluates EXPR against every entry,
// prints matches one per line. Supported predicates:
//
//   -name PAT       basename glob (* ? [...])
//   -path PAT       full-path glob
//   -iname PAT      case-insensitive -name
//   -type f|d       file vs directory
//   -maxdepth N     don't descend beyond N levels (PATH itself is depth 0)
//   -mindepth N     skip entries shallower than N
//   -size [+-]N[ckMG]  size comparison (c=bytes, k=KiB, M=MiB, G=GiB; default c)
//   -empty          shorthand for `( -type f -size 0c ) -or ( -type d -empty-dir )`
//                   (v0: only the file case; empty directories not detected)
//   -print          explicit print (default action)
//   -print0         null-separated output (-exec scripts love it)
//
// Logical combinators (precedence: ! > -and > -or; -and is implicit):
//
//   ! EXPR | -not EXPR
//   EXPR -and EXPR | EXPR EXPR
//   EXPR -or EXPR
//   ( EXPR )       (each paren needs to be its own argv element)
//
// Notable v0 omissions: -exec, -execdir, -prune, -newer/-mtime, -user,
// regex predicates beyond glob. These are sized-by-need additions.
async function _find(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('find: no VFS configured\n'); return 1; }
  // Split argv into start paths + predicate tokens. POSIX: paths come
  // first, predicates start at the first arg beginning with `-`, `!`,
  // `(`, or matching a known token. (We keep it simple — assume the
  // first arg starting with `-`/`!`/`(`/`,` is the predicate start.)
  const args = argv.slice(1);
  const paths = [];
  let predStart = 0;
  while (predStart < args.length) {
    const a = args[predStart];
    if (a.startsWith('-') || a === '!' || a === '(' || a === ')' || a === ',') break;
    paths.push(a);
    predStart++;
  }
  if (paths.length === 0) paths.push('.');
  const predTokens = args.slice(predStart);
  let predicate;
  try {
    predicate = _findCompile(predTokens);
  } catch (e) {
    await ctx.stderr(`find: ${e.message}\n`);
    return 1;
  }
  const sep = predicate.print0 ? '\0' : '\n';
  let anyError = 0;
  for (const startPath of paths) {
    const abs = _bResolvePath(startPath, ctx);
    try {
      const st = await ctx.vfs.stat(abs);
      await _findWalk({
        absPath: abs,
        displayPath: startPath,
        type: st.type,
        size: st.size ?? 0,
        depth: 0,
      }, predicate, ctx, sep);
    } catch (e) {
      await ctx.stderr(`find: ${startPath}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _findWalk(entry, predicate, ctx, sep) {
  // Apply predicate to this entry. The compiled predicate is a function:
  //   (entry) => { match: bool, print: bool }
  // When `print` is true (explicit -print/-print0 in the expr, or the
  // default action because no print-equivalent appeared), we emit the
  // path. We do this BEFORE descending so directory output matches
  // POSIX find pre-order traversal.
  if (entry.depth >= predicate.minDepth) {
    const r = predicate.fn(entry);
    if (r) {
      await ctx.stdout(entry.displayPath + sep);
    }
  }
  if (entry.type !== 'directory') return;
  if (predicate.maxDepth >= 0 && entry.depth >= predicate.maxDepth) return;
  let names;
  try {
    const entries = await ctx.vfs.readdir(entry.absPath);
    names = entries.map(e => typeof e === 'string' ? e : e.name).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const childAbs = entry.absPath.endsWith('/') ? entry.absPath + name : entry.absPath + '/' + name;
    const childDisp = entry.displayPath.endsWith('/') ? entry.displayPath + name : entry.displayPath + '/' + name;
    let stat;
    try { stat = await ctx.vfs.stat(childAbs); }
    catch { continue; }
    await _findWalk({
      absPath: childAbs,
      displayPath: childDisp,
      type: stat.type,
      size: stat.size ?? 0,
      depth: entry.depth + 1,
    }, predicate, ctx, sep);
  }
}

// Compile a predicate-token list into { fn, maxDepth, minDepth, print0 }.
// fn(entry) returns true iff the entry should be printed. maxDepth/
// minDepth/print0 are pulled out of the token stream rather than
// being encoded in fn — depth gates traversal, separators format output.
// An empty token list matches everything (POSIX `find .` behaviour).
function _findCompile(tokens) {
  const state = { tokens, i: 0, maxDepth: -1, minDepth: 0, print0: false };
  if (tokens.length === 0) {
    return { fn: () => true, maxDepth: -1, minDepth: 0, print0: false };
  }
  const fn = _findParseOr(state);
  if (state.i !== state.tokens.length) {
    throw new Error(`unexpected token "${state.tokens[state.i]}"`);
  }
  return {
    fn,
    maxDepth: state.maxDepth,
    minDepth: state.minDepth,
    print0: state.print0,
  };
}

// Grammar (recursive descent):
//   or   := and ( -or and )*
//   and  := not ( ( -and | <implicit> ) not )*
//   not  := ( '!' | -not ) not | primary
//   primary := '(' or ')' | predicate | action
function _findParseOr(s) {
  let left = _findParseAnd(s);
  while (s.i < s.tokens.length && (s.tokens[s.i] === '-or' || s.tokens[s.i] === '-o')) {
    s.i++;
    const right = _findParseAnd(s);
    const l = left, r = right;
    left = (e) => l(e) || r(e);
  }
  return left;
}

function _findParseAnd(s) {
  let left = _findParseNot(s);
  while (s.i < s.tokens.length) {
    const t = s.tokens[s.i];
    if (t === '-or' || t === '-o' || t === ')' || t === ',') break;
    if (t === '-and' || t === '-a') s.i++;
    const right = _findParseNot(s);
    const l = left, r = right;
    left = (e) => l(e) && r(e);
  }
  return left;
}

function _findParseNot(s) {
  const t = s.tokens[s.i];
  if (t === '!' || t === '-not') {
    s.i++;
    const inner = _findParseNot(s);
    return (e) => !inner(e);
  }
  return _findParsePrimary(s);
}

function _findParsePrimary(s) {
  const t = s.tokens[s.i];
  if (t === undefined) throw new Error('unexpected end of expression');
  if (t === '(') {
    s.i++;
    const inner = _findParseOr(s);
    if (s.tokens[s.i] !== ')') throw new Error("missing ')'");
    s.i++;
    return inner;
  }
  // Predicates & actions: each consumes its tokens and returns a
  // matcher. Actions set s.hadPrint when relevant.
  switch (t) {
    case '-name': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, false);
      return (e) => re.test(_basename(e.displayPath));
    }
    case '-iname': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, true);
      return (e) => re.test(_basename(e.displayPath));
    }
    case '-path': case '-wholename': {
      const pat = s.tokens[++s.i]; s.i++;
      const re = _findGlobToRe(pat, false);
      return (e) => re.test(e.displayPath);
    }
    case '-type': {
      const tp = s.tokens[++s.i]; s.i++;
      return (e) => (tp === 'f' && e.type === 'file') || (tp === 'd' && e.type === 'directory');
    }
    case '-size': {
      const spec = s.tokens[++s.i]; s.i++;
      const cmp = _findCompileSize(spec);
      return (e) => cmp(e.size);
    }
    case '-empty': {
      s.i++;
      return (e) => e.type === 'file' && e.size === 0;
    }
    case '-maxdepth': {
      s.maxDepth = parseInt(s.tokens[++s.i], 10); s.i++;
      return () => true;
    }
    case '-mindepth': {
      s.minDepth = parseInt(s.tokens[++s.i], 10); s.i++;
      return () => true;
    }
    case '-print': {
      s.i++;
      return () => true;
    }
    case '-print0': {
      s.i++;
      s.print0 = true;
      return () => true;
    }
    case '-true': { s.i++; return () => true; }
    case '-false': { s.i++; return () => false; }
    default:
      throw new Error(`unknown predicate "${t}"`);
  }
}

function _basename(p) {
  const slash = p.lastIndexOf('/');
  return slash < 0 ? p : p.slice(slash + 1);
}

function _findGlobToRe(pattern, ignoreCase) {
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
        if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = close;
      }
    }
    else if ('.+^$(){}|\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}

function _findCompileSize(spec) {
  // POSIX -size spec: [+-]N[bckwMG]. We honour c (bytes), k (KiB),
  // M (MiB), G (GiB). Defaults to 512-byte blocks per POSIX, but we
  // diverge: default unit is bytes — matches everyone's mental model.
  const m = String(spec).match(/^([+-])?(\d+)([ckMG]?)$/);
  if (!m) return () => false;
  const sign = m[1];
  const n = parseInt(m[2], 10);
  const unit = m[3] || 'c';
  const mult = unit === 'k' ? 1024 : unit === 'M' ? 1024 * 1024 : unit === 'G' ? 1024 * 1024 * 1024 : 1;
  const threshold = n * mult;
  if (sign === '+') return (sz) => sz > threshold;
  if (sign === '-') return (sz) => sz < threshold;
  return (sz) => sz === threshold;
}

// tree — list contents of a directory in a tree-like, box-drawn format.
// Flags: `-L N` depth limit, `-a` show dotfiles, `-d` directories only,
// `--noreport` suppress the trailing summary. Multiple roots are walked
// in turn. The summary counts only directories *encountered while walking*
// (excludes the root, matching real `tree`).
async function _tree(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('tree: no VFS configured\n'); return 1; }

  let maxDepth = Infinity, showHidden = false, dirsOnly = false, noReport = false;
  const paths = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-L' || a === '--level') {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        await ctx.stderr(`tree: invalid level: ${args[i]}\n`);
        return 1;
      }
      maxDepth = n;
    } else if (a === '--noreport') {
      noReport = true;
    } else if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      // Short flag cluster: -a, -d, -da, -ad, etc.
      for (const ch of a.slice(1)) {
        if (ch === 'a') showHidden = true;
        else if (ch === 'd') dirsOnly = true;
        else {
          await ctx.stderr(`tree: unknown option: -${ch}\n`);
          return 1;
        }
      }
    } else {
      paths.push(a);
    }
  }
  if (paths.length === 0) paths.push('.');

  let dirCount = 0, fileCount = 0;

  async function walk(dir, prefix, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await ctx.vfs.readdir(dir, { stat: true }); }
    catch (e) {
      await ctx.stderr(`tree: ${dir}: ${e.message || 'cannot read'}\n`);
      return;
    }
    entries = entries
      .map((e) => typeof e === 'string' ? { name: e, type: 'file' } : e)
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .filter((e) => !dirsOnly || e.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const last = (i === entries.length - 1);
      const branch = last ? '└── ' : '├── ';
      const slash = e.type === 'directory' ? '/' : '';
      await ctx.stdout(prefix + branch + e.name + slash + '\n');
      if (e.type === 'directory') {
        dirCount++;
        const childPath = dir === '/' ? '/' + e.name : dir + '/' + e.name;
        await walk(childPath, prefix + (last ? '    ' : '│   '), depth + 1);
      } else {
        fileCount++;
      }
    }
  }

  for (const p of paths) {
    const abs = _bResolvePath(p, ctx);
    try {
      const st = await ctx.vfs.stat(abs);
      await ctx.stdout(p + '\n');
      if (st.type === 'directory') await walk(abs, '', 1);
      else fileCount++;
    } catch (e) {
      await ctx.stderr(`tree: ${p}: ${e.message || 'cannot access'}\n`);
      return 1;
    }
  }

  if (!noReport) {
    const dPlural = dirCount === 1 ? 'directory' : 'directories';
    const fPlural = fileCount === 1 ? 'file' : 'files';
    await ctx.stdout(`\n${dirCount} ${dPlural}, ${fileCount} ${fPlural}\n`);
  }
  return 0;
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
  // BSD/GNU shorthand: `head -N` means `head -n N`. _bParseArgs has no
  // way to express "digit run is a flag value," so normalize first.
  const normalized = argv.map(a => /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]).flat();
  const { opts, positionals } = _bParseArgs(normalized, { n: { short: 'n', arg: true, default: '10' } });
  const n = Math.max(0, parseInt(opts.n, 10) || 0);
  // Streaming path when reading from a pipe queue: pull chunks, emit
  // complete lines as they arrive, throw _pipeClosed back upstream once
  // we have N. This is what makes `find /huge | head -1` early-return
  // — upstream's next push sees a closed queue, bails, returns 0.
  const stdinIsQueue = positionals.length === 0
    && ctx.stdin
    && typeof ctx.stdin === 'object'
    && typeof ctx.stdin[Symbol.asyncIterator] === 'function';
  if (stdinIsQueue) {
    return await _headStream(ctx.stdin, n, ctx);
  }
  try {
    const text = await _bReadInput(positionals, ctx);
    const lines = text.split('\n');
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

async function _headStream(queue, n, ctx) {
  let leftover = '';
  let emitted = 0;
  const out = [];
  try {
    for await (const chunk of queue) {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      const combined = leftover + text;
      const parts = combined.split('\n');
      leftover = parts.pop(); // tail without trailing \n stays in leftover
      for (const line of parts) {
        out.push(line);
        emitted++;
        if (emitted >= n) break;
      }
      if (emitted >= n) {
        // Close the queue so upstream's next push sees _pipeClosed.
        if (typeof queue.close === 'function') queue.close();
        break;
      }
    }
    if (emitted < n && leftover.length > 0) {
      out.push(leftover);
      emitted++;
    }
  } catch (e) {
    if (!e || !e._pipeClosed) {
      await ctx.stderr(`head: ${e.message || e}\n`);
      return 1;
    }
  }
  if (out.length > 0) await ctx.stdout(out.join('\n') + '\n');
  return 0;
}

async function _tail(argv, ctx) {
  const normalized = argv.map(a => /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]).flat();
  const { opts, positionals } = _bParseArgs(normalized, { n: { short: 'n', arg: true, default: '10' } });
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
  let nChars = -1;        // -n N: read at most N chars (default: full line)
  let delim = '\n';       // -d D: terminate on first char of D (bash uses D[0])
  let optS = false;       // -s: silent — passed to the interactive readLine hook
  let optT = null;        // -t SECONDS: timeout, also handled by the hook
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--' && argv[i].length > 1) {
    const flag = argv[i];
    if (flag === '-r') { raw = true; i++; continue; }
    if (flag === '-p') { prompt = argv[i + 1] ?? ''; i += 2; continue; }
    if (flag.startsWith('-p') && flag.length > 2) { prompt = flag.slice(2); i++; continue; }
    if (flag === '-s') { optS = true; i++; continue; }
    if (flag === '-n') {
      const n = parseInt(argv[i + 1], 10);
      if (!Number.isFinite(n) || n < 0) {
        await ctx.stderr(`read: -n: invalid count\n`);
        return 2;
      }
      nChars = n;
      i += 2;
      continue;
    }
    if (flag === '-d') {
      delim = argv[i + 1] ?? '\n';
      i += 2;
      continue;
    }
    if (flag === '-t') {
      const t = parseFloat(argv[i + 1]);
      if (!Number.isFinite(t) || t < 0) {
        await ctx.stderr(`read: -t: invalid timeout\n`);
        return 2;
      }
      optT = t;
      i += 2;
      continue;
    }
    if (flag === '--') { i++; break; }
    await ctx.stderr(`read: ${flag}: unknown option\n`);
    return 2;
  }
  const vars = argv.slice(i);
  const varNames = vars.length > 0 ? vars : ['REPLY'];
  // `read` is line-oriented and needs to mutate the consumed stdin. If
  // stdin arrived as a stream queue (from a pipeline), drain to text
  // first; subsequent `read` calls in the same command keep slicing
  // ctx.stdin string.
  if (typeof ctx.stdin !== 'string') {
    const v = await drainInput(ctx);
    ctx.stdin = typeof v === 'string' ? v : String(v);
  }
  // No stdin queued? Fall through to the interactive `readLine` hook
  // if the host wired one up — that's the path the worker shim uses
  // to bridge to the adapter's line editor (prompt, echo, backspace).
  // Without a hook, EOF is the only answer.
  if (ctx.stdin.length === 0) {
    if (typeof ctx.readLine !== 'function') {
      // Show prompt before reporting EOF — matches bash's `read -p P`
      // shape, which prints the prompt unconditionally.
      if (prompt) {
        try { await ctx.stderr(prompt); } catch { /* ignore */ }
      }
      return 1;
    }
    let res;
    try {
      res = await ctx.readLine({
        prompt,
        silent: optS,
        nChars: nChars >= 0 ? nChars : null,
        delim: delim === '\n' ? null : delim,
        timeout: optT,
        raw,
      });
    } catch (e) {
      await ctx.stderr(`read: ${e.message || e}\n`);
      return 1;
    }
    if (!res || res.eof) return 1;
    if (res.timeout) return 142; // bash convention for -t timeout expiry
    const lineFromHost = typeof res.line === 'string' ? res.line : '';
    return await _readBindVars(lineFromHost, ctx, varNames, raw);
  }
  if (prompt) {
    try { await ctx.stderr(prompt); } catch { /* ignore */ }
  }
  // Consume one record from stdin. Mutate ctx.stdin so subsequent reads
  // in the same command context (e.g. `while read; do ...; done < file`)
  // continue from where we left off.
  let line;
  if (nChars >= 0) {
    // -n: read up to N characters, ignoring delim. nChars=0 reads
    // nothing but still returns 0 (consistent with bash).
    const take = Math.min(nChars, ctx.stdin.length);
    line = ctx.stdin.slice(0, take);
    ctx.stdin = ctx.stdin.slice(take);
  } else {
    // -d (default '\n'): terminate on first occurrence of delim[0].
    // Empty delim ('') means read everything until EOF.
    const ch = delim.length > 0 ? delim[0] : '';
    const idx = ch === '' ? -1 : ctx.stdin.indexOf(ch);
    if (idx < 0) {
      line = ctx.stdin;
      ctx.stdin = '';
    } else {
      line = ctx.stdin.slice(0, idx);
      ctx.stdin = ctx.stdin.slice(idx + 1);
    }
  }
  return await _readBindVars(line, ctx, varNames, raw);
}

// Apply the post-acquire processing common to both stdin-slice and
// interactive-readLine paths: optional backslash de-escape (skipped
// under -r), then IFS-aware splitting into var bindings.
async function _readBindVars(line, ctx, varNames, raw) {
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

// ── eval / source / getopts — script-time builtins ──
//
// `eval` joins its args with spaces and re-parses+executes that string
// in the CURRENT shell context. Mutations to env / cwd / functions
// leak to the caller — that's the whole point. Re-parsing means the
// argument can contain pipes, redirects, control flow, etc.
//
// `source FILE [ARG...]` (and the POSIX `.` alias) reads FILE from
// the VFS and runs its contents in the current scope. Optional args
// after the filename become positional params for the duration of
// the source, then restore on return (mirroring how a function call
// scopes positional). Locals defined in the sourced file leak out
// unless declared `local` inside a function in that file.
async function _eval(argv, ctx) {
  if (argv.length < 2) return 0;
  const source = argv.slice(1).join(' ');
  const { parse } = await import('./parser.js');
  const { execute } = await import('./executor.js');
  const savedPropagate = ctx._propagateExit;
  ctx._propagateExit = true;
  try {
    const ast = parse(source);
    const r = await execute(ast, ctx);
    return r.exitCode;
  } catch (e) {
    if (e && e._exit) throw e;
    if (e && e._return) throw e;
    await ctx.stderr(`eval: ${e.message || e}\n`);
    return 1;
  } finally {
    ctx._propagateExit = savedPropagate;
  }
}

async function _source(argv, ctx) {
  if (argv.length < 2) {
    await ctx.stderr('source: filename required\n');
    return 2;
  }
  if (!ctx.vfs) {
    await ctx.stderr('source: no VFS configured\n');
    return 1;
  }
  const file = argv[1];
  const path = _bResolvePath(file, ctx);
  let text;
  try {
    text = await ctx.vfs.readFile(path, 'text');
  } catch (e) {
    await ctx.stderr(`source: ${file}: ${e.message || 'cannot read'}\n`);
    return 1;
  }
  // Args after the filename rebind $1..$N for the duration. Save the
  // caller's positional, restore in finally so an early `return` or
  // `exit` from the sourced file still unwinds cleanly.
  const sourceArgs = argv.slice(2);
  const savedPositional = ctx.positional;
  const savedPropagate = ctx._propagateExit;
  if (sourceArgs.length > 0) ctx.positional = sourceArgs;
  ctx._propagateExit = true;
  const { parse } = await import('./parser.js');
  const { execute } = await import('./executor.js');
  let exitCode = 0;
  try {
    const ast = parse(text);
    const r = await execute(ast, ctx);
    exitCode = r.exitCode;
  } catch (e) {
    if (e && e._exit) throw e;
    if (e && e._return) {
      exitCode = e.exitCode;
    } else {
      await ctx.stderr(`source: ${e.message || e}\n`);
      exitCode = 1;
    }
  } finally {
    ctx.positional = savedPositional;
    ctx._propagateExit = savedPropagate;
  }
  return exitCode;
}

// getopts OPTSTRING NAME [ARG...]
//
// POSIX flag-parsing helper for shell scripts. OPTSTRING is a letter
// per allowed flag (`a` = bare `-a`, `b:` = `-b ARG`). NAME receives
// the current flag letter; $OPTARG receives the value (when required);
// $OPTIND tracks the next position. Returns 0 while more options
// remain, 1 when done. Typical usage:
//
//   while getopts "n:v" opt; do
//     case "$opt" in
//       n) name=$OPTARG ;;
//       v) verbose=1 ;;
//       *) echo bad; exit 2 ;;
//     esac
//   done
//   shift $((OPTIND - 1))
//
// Args default to $@. State (OPTIND) persists in env between calls.
async function _getopts(argv, ctx) {
  if (argv.length < 3) {
    await ctx.stderr('getopts: usage: getopts optstring name [arg...]\n');
    return 2;
  }
  const optstring = argv[1];
  const name = argv[2];
  // Arg source: explicit > positional.
  const args = argv.length > 3 ? argv.slice(3) : (ctx.positional || []);
  // OPTIND is 1-based in POSIX.
  let optind = parseInt(ctx.env.get('OPTIND') || '1', 10);
  if (!Number.isFinite(optind) || optind < 1) optind = 1;
  const argIdx = optind - 1;
  if (argIdx >= args.length) return 1;
  const cur = args[argIdx];
  if (typeof cur !== 'string' || cur.length < 2 || cur[0] !== '-' || cur === '--') {
    if (cur === '--') ctx.env.set('OPTIND', String(optind + 1));
    return 1;
  }
  const ch = cur[1];
  // Find ch in optstring; treat leading ':' as silent-error mode (we accept it
  // but don't differentiate output styles).
  const silent = optstring.startsWith(':');
  const search = silent ? optstring.slice(1) : optstring;
  const pos = search.indexOf(ch);
  if (pos < 0 || ch === ':') {
    ctx.env.set(name, '?');
    ctx.env.set('OPTARG', ch);
    if (!silent) await ctx.stderr(`getopts: illegal option -- ${ch}\n`);
    ctx.env.set('OPTIND', String(optind + 1));
    return 0;
  }
  const takesArg = search[pos + 1] === ':';
  if (takesArg) {
    // Value can be glued (-nVAL) or in the next argv slot.
    if (cur.length > 2) {
      ctx.env.set('OPTARG', cur.slice(2));
      ctx.env.set(name, ch);
      ctx.env.set('OPTIND', String(optind + 1));
    } else if (argIdx + 1 < args.length) {
      ctx.env.set('OPTARG', args[argIdx + 1]);
      ctx.env.set(name, ch);
      ctx.env.set('OPTIND', String(optind + 2));
    } else {
      // Missing required arg.
      if (silent) {
        ctx.env.set(name, ':');
        ctx.env.set('OPTARG', ch);
      } else {
        await ctx.stderr(`getopts: option requires argument -- ${ch}\n`);
        ctx.env.set(name, '?');
        ctx.env.set('OPTARG', '');
      }
      ctx.env.set('OPTIND', String(optind + 1));
    }
    return 0;
  }
  // Bare flag. May be clustered (`-abc` = -a -b -c) but POSIX says each
  // call returns ONE letter; we handle clustering by consuming chars
  // from the same argv slot until exhausted, only advancing OPTIND
  // when the slot is done.
  if (cur.length > 2) {
    // More flags in this slot — strip the first char and put the rest back.
    args[argIdx] = '-' + cur.slice(2);
    // Note: this mutates the args array. For ctx.positional that's fine
    // (POSIX getopts canonically mutates the positional view).
  } else {
    ctx.env.set('OPTIND', String(optind + 1));
  }
  ctx.env.set(name, ch);
  ctx.env.set('OPTARG', '');
  return 0;
}

// ── local / return / shift — function-frame builtins ──
//
// local NAME[=value] ... — only valid inside a function. Shadows any
// caller binding of NAME for the duration of the current frame; on
// frame pop, the executor restores the prior value (or deletes the
// name if it was previously unset). `local NAME` without `=` keeps
// the existing visible value but still marks it for shadowed
// restoration (so the caller is insulated from later mutation).
async function _local(argv, ctx) {
  if (!ctx._localFrames || ctx._localFrames.length === 0) {
    await ctx.stderr('local: can only be used inside a function\n');
    return 1;
  }
  const frame = ctx._localFrames[ctx._localFrames.length - 1];
  let anyError = 0;
  for (const arg of argv.slice(1)) {
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      await ctx.stderr(`local: ${name}: not a valid identifier\n`);
      anyError = 1;
      continue;
    }
    if (!frame.savedBindings.has(name)) {
      frame.savedBindings.set(name, ctx.env.has(name) ? ctx.env.get(name) : undefined);
    }
    if (eq >= 0) {
      ctx.env.set(name, arg.slice(eq + 1));
    } else if (!ctx.env.has(name)) {
      // `local NAME` with no = and no prior binding: initialize empty,
      // matching bash/dash. (POSIX is silent; this is the consensus.)
      ctx.env.set(name, '');
    }
  }
  return anyError;
}

// return [N] — exit the current function with status N (defaults to
// the last command's exit code). Outside a function, behaves as `exit`
// would (POSIX leaves this undefined; we follow bash's pragmatic shape).
async function _return(argv, ctx) {
  const raw = argv[1];
  const n = raw !== undefined ? Number(raw) : ctx.lastStatus;
  const code = Number.isFinite(n) ? (n & 0xff) : 0;
  // Outside any function frame, treat as exit (POSIX-undefined; bash
  // says "error", but exit-shape is more useful in scripts that get
  // sourced via `.`).
  if (!ctx._localFrames || ctx._localFrames.length === 0) {
    throw { exitCode: code, _exit: true };
  }
  throw { exitCode: code, _return: true };
}

// shift [N] — drop the first N positional parameters (default 1).
// Returns 1 if N is larger than the current count (no shift performed),
// matching POSIX. Useful with `local x=$1; shift` to consume args.
async function _shift(argv, ctx) {
  const n = argv[1] !== undefined ? parseInt(argv[1], 10) : 1;
  if (!Number.isFinite(n) || n < 0) {
    await ctx.stderr('shift: invalid count\n');
    return 1;
  }
  const cur = ctx.positional || [];
  if (n > cur.length) return 1;
  ctx.positional = cur.slice(n);
  return 0;
}

// clear — wipe the terminal. VT100: ESC[2J clears the screen, ESC[H
// homes the cursor. Pure stdout — works on any terminal-shaped sink.
async function _clear(_argv, ctx) {
  await ctx.stdout('\x1b[2J\x1b[H');
  return 0;
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

// ── tr — character translate / delete ──
//
// tr SET1 SET2        translate each SET1 char to the corresponding SET2 char
// tr -d SET           delete every SET char from input
// tr -s SET           squeeze runs of SET chars into one
// tr -c SET1 SET2     complement (operate on chars NOT in SET1)
//
// SET supports character ranges via `-` (e.g. `a-z`, `0-9`) and POSIX
// classes via `[:class:]` (alpha, digit, lower, upper, space, alnum,
// punct, xdigit). Anything more elaborate (escapes, [=eq=]) is v0-future.
async function _tr(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    d: { short: 'd' }, s: { short: 's' }, c: { short: 'c' },
  });
  if (positionals.length === 0) {
    await ctx.stderr('tr: missing operand\n');
    return 1;
  }
  let set1 = _trExpandSet(positionals[0]);
  if (opts.c) {
    // Complement: build the "set of chars NOT in set1" lazily via a predicate.
    const inSet1 = new Set(set1);
    set1 = null; // signal "complement mode" downstream
    var inSet = (ch) => !inSet1.has(ch);
  } else {
    const s1 = new Set(set1);
    var inSet = (ch) => s1.has(ch);
  }
  const text = await _bReadInput([], ctx);
  let out = '';
  if (opts.d) {
    // Delete chars in set.
    for (const ch of text) if (!inSet(ch)) out += ch;
  } else if (positionals.length >= 2) {
    // Translate set1 → set2.
    const set2 = _trExpandSet(positionals[1]);
    const last2 = set2[set2.length - 1] || '';
    const set1Arr = set1 || []; // complement+translate uncommon; skip
    const map = new Map();
    if (set1Arr.length > 0) {
      for (let k = 0; k < set1Arr.length; k++) {
        map.set(set1Arr[k], set2[k] ?? last2);
      }
    }
    for (const ch of text) {
      if (inSet(ch)) {
        // In complement mode, any out-of-set char maps to the last char of set2.
        out += set1 ? (map.get(ch) ?? ch) : last2;
      } else {
        out += ch;
      }
    }
  } else if (opts.s) {
    // Squeeze runs of set chars.
    let prev = '';
    for (const ch of text) {
      if (inSet(ch) && ch === prev) continue;
      out += ch;
      prev = ch;
    }
  } else {
    await ctx.stderr('tr: need SET2 unless -d or -s\n');
    return 1;
  }
  // Optional squeeze pass after translate.
  if (opts.s && positionals.length >= 2 && !opts.d) {
    let squeezed = '';
    let prev = '';
    const set2 = _trExpandSet(positionals[1]);
    const sq = new Set(set2);
    for (const ch of out) {
      if (sq.has(ch) && ch === prev) continue;
      squeezed += ch;
      prev = ch;
    }
    out = squeezed;
  }
  await ctx.stdout(out);
  return 0;
}

const _TR_CLASSES = {
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  digit: '0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  space: ' \t\n\r\v\f',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  xdigit: '0123456789ABCDEFabcdef',
};

function _trExpandSet(spec) {
  // Expand POSIX classes first, then ranges. Returns an array of chars.
  let s = spec;
  s = s.replace(/\[:(\w+):\]/g, (_, cls) => _TR_CLASSES[cls] || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      // Common escapes.
      const next = s[i + 1];
      if (next === 'n') out.push('\n');
      else if (next === 't') out.push('\t');
      else if (next === 'r') out.push('\r');
      else if (next === '\\') out.push('\\');
      else out.push(next);
      i++;
      continue;
    }
    if (i + 2 < s.length && s[i + 1] === '-') {
      // Range a-z.
      const from = s.charCodeAt(i);
      const to = s.charCodeAt(i + 2);
      if (to >= from) {
        for (let cc = from; cc <= to; cc++) out.push(String.fromCharCode(cc));
        i += 2;
        continue;
      }
    }
    out.push(s[i]);
  }
  return out;
}

// ── du / df — disk usage ──
//
// du [-s] [-h] [PATH...]     total bytes per PATH (recursive); -s = summary
// df [-h]                    per-mount usage; size from VFS where exposed
//
// We don't have real block sizes — just sum file sizes from stat. -h
// (human) formats with K/M/G/T suffixes. df enumerates VFS mounts;
// without a real "total" / "used" surface from the VFS, we just report
// what we can walk.
async function _du(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('du: no VFS configured\n'); return 1; }
  const { opts, positionals } = _bParseArgs(argv, {
    s: { short: 's' }, h: { short: 'h' },
  });
  const paths = positionals.length > 0 ? positionals : ['.'];
  let anyError = 0;
  for (const p of paths) {
    try {
      const abs = _bResolvePath(p, ctx);
      const total = await _duWalk(ctx, abs, opts);
      const size = opts.h ? _humanSize(total) : String(total);
      await ctx.stdout(`${size.padEnd(8)}${p}\n`);
    } catch (e) {
      await ctx.stderr(`du: ${p}: ${e.message || 'cannot access'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _duWalk(ctx, path, opts) {
  const st = await ctx.vfs.stat(path);
  if (st.type !== 'directory') return st.size ?? 0;
  let total = 0;
  let entries;
  try { entries = await ctx.vfs.readdir(path); } catch { return 0; }
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e.name;
    const child = path.endsWith('/') ? path + name : path + '/' + name;
    let cst;
    try { cst = await ctx.vfs.stat(child); } catch { continue; }
    if (cst.type === 'directory') {
      const sub = await _duWalk(ctx, child, opts);
      total += sub;
      if (!opts.s) {
        const sizeStr = opts.h ? _humanSize(sub) : String(sub);
        await ctx.stdout(`${sizeStr.padEnd(8)}${child}\n`);
      }
    } else {
      total += cst.size ?? 0;
    }
  }
  return total;
}

async function _df(argv, ctx) {
  if (!ctx.vfs) { await ctx.stderr('df: no VFS configured\n'); return 1; }
  const { opts } = _bParseArgs(argv, { h: { short: 'h' } });
  const mounts = (ctx.vfs._mounts && typeof ctx.vfs._mounts.entries === 'function')
    ? [...ctx.vfs._mounts.entries()]
    : [['/', null]];
  await ctx.stdout('Mount     Used    \n');
  for (const [path /*, backend */] of mounts) {
    let used = 0;
    try { used = await _duWalk(ctx, path, { s: true }); } catch { /* ignore */ }
    const usedStr = opts.h ? _humanSize(used) : String(used);
    await ctx.stdout(`${String(path).padEnd(9)} ${usedStr.padEnd(8)}\n`);
  }
  return 0;
}

function _humanSize(n) {
  if (n < 1024) return `${n}`;
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + units[i];
}

// ── base64 / md5sum / sha256sum — encoding & hashing ──
//
// base64 [-d]           encode (default) or decode stdin/file
// md5sum [FILE...]      MD5 hash via Web Crypto (when available; fallback
//                       to a pure-JS minimal impl)
// sha256sum [FILE...]   SHA-256 via Web Crypto (always-available in Node 16+
//                       and modern browsers)
async function _base64(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, { d: { short: 'd' } });
  const text = await _bReadInput(positionals, ctx);
  if (opts.d) {
    // Decode.
    let result;
    try {
      const stripped = text.replace(/\s+/g, '');
      if (typeof atob === 'function') {
        result = atob(stripped);
      } else {
        result = Buffer.from(stripped, 'base64').toString('binary');
      }
    } catch (e) {
      await ctx.stderr(`base64: decode error: ${e.message}\n`);
      return 1;
    }
    await ctx.stdout(result);
    return 0;
  }
  // Encode.
  let encoded;
  if (typeof btoa === 'function') {
    encoded = btoa(text);
  } else {
    encoded = Buffer.from(text, 'binary').toString('base64');
  }
  // Wrap at 76 chars per RFC; bash's base64 does this by default.
  const lines = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  await ctx.stdout(lines.join('\n') + '\n');
  return 0;
}

async function _md5sum(argv, ctx) {
  return await _hashCmd('md5', argv, ctx);
}

async function _sha256sum(argv, ctx) {
  return await _hashCmd('sha256', argv, ctx);
}

async function _hashCmd(algorithm, argv, ctx) {
  // Multiple files: each line shows `<hex>  <name>`. Stdin: `<hex>  -`.
  const files = argv.slice(1);
  if (files.length === 0) {
    const text = await _bReadInput([], ctx);
    const hex = await _hashHex(algorithm, text);
    await ctx.stdout(`${hex}  -\n`);
    return 0;
  }
  let anyError = 0;
  for (const f of files) {
    try {
      const text = await ctx.vfs.readFile(_bResolvePath(f, ctx), 'text');
      const hex = await _hashHex(algorithm, text);
      await ctx.stdout(`${hex}  ${f}\n`);
    } catch (e) {
      await ctx.stderr(`${algorithm}sum: ${f}: ${e.message || 'cannot read'}\n`);
      anyError = 1;
    }
  }
  return anyError;
}

async function _hashHex(algorithm, text) {
  // Web Crypto: SHA-256 always works in modern Node + browsers. MD5
  // isn't supported by Web Crypto (deprecated for security), so for
  // md5 we use a pure-JS implementation inline. SHA-1 / SHA-512 would
  // route to Web Crypto if added later.
  if (algorithm === 'md5') return _md5Hex(text);
  const algoName = algorithm === 'sha256' ? 'SHA-256'
                 : algorithm === 'sha1'   ? 'SHA-1'
                 : 'SHA-512';
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest(algoName, enc.encode(text));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// Minimal pure-JS MD5 — RFC 1321. Not cryptographically safe; we ship
// it because md5sum is common in scripts as a checksum (not a cipher).
function _md5Hex(text) {
  // Convert string to UTF-8 bytes.
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const len = bytes.length;
  // Pad: append 0x80, then zeros until length ≡ 56 mod 64, then 64-bit length.
  const padLen = (len % 64 < 56 ? 56 : 120) - (len % 64);
  const total = len + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes, 0);
  buf[len] = 0x80;
  // Length in BITS, little-endian, 64 bits (high 32 bits zero — we won't
  // hash >4GB strings).
  const bitLen = len * 8;
  buf[total - 8] = bitLen & 0xff;
  buf[total - 7] = (bitLen >>> 8) & 0xff;
  buf[total - 6] = (bitLen >>> 16) & 0xff;
  buf[total - 5] = (bitLen >>> 24) & 0xff;
  // Process 64-byte blocks.
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const k = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const s = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
  ];
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  for (let i = 0; i < total; i += 64) {
    const m = new Array(16);
    for (let j = 0; j < 16; j++) {
      const off = i + j * 4;
      m[j] = (buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
    }
    let A = a, B = b, C = c, D = d;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if      (j < 16) { f = F(B, C, D); g = j; }
      else if (j < 32) { f = G(B, C, D); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = H(B, C, D); g = (3 * j + 5) % 16; }
      else             { f = I(B, C, D); g = (7 * j) % 16; }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + f + k[j] + m[g]) | 0, s[j])) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const toHexLE = (n) => {
    let h = '';
    for (let i = 0; i < 4; i++) h += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return h;
  };
  return toHexLE(a) + toHexLE(b) + toHexLE(c) + toHexLE(d);
}

// xargs: build commands from stdin tokens. v0 supports -n (batch size)
// and uses the dispatch in ctx to invoke the named command.
async function _xargs(argv, ctx) {
  const { opts, positionals } = _bParseArgs(argv, {
    n: { short: 'n', arg: true },
    I: { short: 'I', arg: true },
    zero: { short: '0' },
  });
  const cmdArgv = positionals.length === 0 ? ['echo'] : positionals;
  // Drain via the typed-aware helper — handles streaming-queue input
  // (the common pipeline shape) plus plain string / typed values.
  const stdinDrained = await drainInput(ctx);
  const stdin = typeof stdinDrained === 'string' ? stdinDrained : String(stdinDrained);
  // `-0` reads NUL-separated input — the canonical pairing for
  // `find -print0 | xargs -0`, which is the only safe way to pass
  // filenames containing whitespace or quotes through xargs.
  const tokens = opts.zero
    ? stdin.split('\0').filter(Boolean)
    : stdin.split(/\s+/).filter(Boolean);
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

// Wire an adapter to a GeasClient's stdout/stderr/block sinks +
// interactive-read hook. Convenience so consumers don't have to spell
// out the same callbacks at every createGeasClient call.
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
    onWantInput: makeLineEditor(adapter),
  };
}

// Build a line-editor function bound to an adapter. The returned async
// function matches the `onWantInput` shape: takes line options
// ({prompt, silent, nChars, delim, timeout, raw, onHistory}) and
// resolves to {line} on Enter, {eof: true} on Ctrl+D with empty
// buffer, or {timeout: true} on -t expiry.
//
// Editing controls (the lowest-common-denominator subset):
//   Enter / \r / \n      submit current buffer
//   Backspace / 0x7f     delete last char (echo \b \b)
//   Ctrl+D / 0x04        EOF when buffer empty; otherwise ignored
//   Ctrl+C / 0x03        cancel (resolves with eof — caller treats as
//                        "read interrupted")
//   Up / Down arrow      history recall, IF the caller passes an
//                        `onHistory(dir)` callback (dir: -1 older,
//                        +1 newer) returning the line to show
//   printable chars      append to buffer + echo (unless silent)
//
// CSI escape sequences (cursor keys, function keys) are recognised and
// swallowed cleanly — only Up/Down do anything, and only when
// onHistory is supplied. The editor does NOT do mid-line cursor
// movement, kill-ring, or reverse-search — that's @gcu/readline
// territory. This is "good enough for `read VAR` and a REPL prompt."
function makeLineEditor(adapter) {
  if (!adapter || typeof adapter.onInput !== 'function') {
    return null;
  }
  return function readLine(lineOpts = {}) {
    const { prompt, silent, nChars, delim, timeout, onHistory } = lineOpts;
    return new Promise((resolve) => {
      let buffer = '';
      let done = false;
      let timer = null;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { unsub && unsub(); } catch { /* ignore */ }
        if (!silent && (result.line != null || result.eof)) {
          // Echo the line-terminating newline so the cursor moves down
          // before whatever the program prints next.
          try { adapter.write('\r\n'); } catch { /* ignore */ }
        }
        resolve(result);
      };

      // Replace the visible buffer with `next` — erase the old chars
      // with destructive backspaces, then echo the new text. Used by
      // history recall.
      const replaceBuffer = (next) => {
        if (!silent && buffer.length > 0) {
          try { adapter.write('\b \b'.repeat(buffer.length)); } catch { /* ignore */ }
        }
        buffer = next;
        if (!silent && buffer.length > 0) {
          try { adapter.write(buffer); } catch { /* ignore */ }
        }
      };

      const onChar = (text) => {
        if (done || typeof text !== 'string') return;
        let i = 0;
        while (i < text.length && !done) {
          const ch = text[i];
          // CSI escape sequence: ESC '[' params final-byte. Parse the
          // whole thing so its bytes don't leak into the buffer.
          if (ch === '\x1b' && text[i + 1] === '[') {
            let j = i + 2;
            while (j < text.length && !/[A-Za-z~]/.test(text[j])) j++;
            const finalByte = text[j]; // may be undefined if split chunk
            i = j + 1;
            if ((finalByte === 'A' || finalByte === 'B') && typeof onHistory === 'function') {
              const recalled = onHistory(finalByte === 'A' ? -1 : 1);
              if (typeof recalled === 'string') replaceBuffer(recalled);
            }
            // Other CSI sequences (left/right/home/end/delete) are
            // swallowed silently — no mid-line editing in v0.
            continue;
          }
          // Lone ESC (or an escape sequence we don't model) — skip it.
          if (ch === '\x1b') { i++; continue; }
          if (ch === '\r' || ch === '\n') {
            finish({ line: buffer });
            return;
          }
          if (ch === '\x7f' || ch === '\b') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              if (!silent) {
                try { adapter.write('\b \b'); } catch { /* ignore */ }
              }
            }
            i++;
            continue;
          }
          if (ch === '\x04') {
            // Ctrl+D: EOF only when buffer is empty (POSIX shape).
            if (buffer.length === 0) { finish({ eof: true }); return; }
            i++;
            continue;
          }
          if (ch === '\x03') {
            // Ctrl+C: cancel. Echo `^C` so the user sees feedback,
            // then resolve as eof so `read` returns non-zero.
            try { adapter.write('^C'); } catch { /* ignore */ }
            finish({ eof: true });
            return;
          }
          // Skip other control chars.
          if (ch.charCodeAt(0) < 0x20) { i++; continue; }
          buffer += ch;
          if (!silent) {
            try { adapter.write(ch); } catch { /* ignore */ }
          }
          if (nChars != null && buffer.length >= nChars) {
            finish({ line: buffer });
            return;
          }
          if (delim && ch === delim[0]) {
            // Match bash: the delim char is NOT included in the result.
            finish({ line: buffer.slice(0, -1) });
            return;
          }
          i++;
        }
      };

      // Subscribe BEFORE writing the prompt so a fast typer can't race
      // ahead of us.
      const unsub = adapter.onInput(onChar);
      if (prompt) {
        try { adapter.write(prompt); } catch { /* ignore */ }
      }
      if (timeout != null && timeout > 0) {
        timer = setTimeout(() => finish({ timeout: true }), timeout * 1000);
      }
    });
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

  // Interactive read state. Each pending read has a unique id; the
  // main side answers with `input-line` / `input-eof` / `input-timeout`
  // tagged by requestId. Lines that arrive ahead of any read request
  // queue in `inputBuffer` (so `client.input("hello\n")` from a test
  // harness or programmatic driver works without an adapter loop).
  let nextReadId = 0;
  const pendingReads = new Map();
  const inputBuffer = [];
  const readLine = (lineOpts) => {
    if (inputBuffer.length > 0) {
      return Promise.resolve({ line: inputBuffer.shift() });
    }
    const id = ++nextReadId;
    return new Promise((resolve, reject) => {
      pendingReads.set(id, { resolve, reject });
      target.postMessage({ type: 'want-input', requestId: id, opts: lineOpts || {} });
    });
  };

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
          readLine,
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
          // Report the post-exec cwd so the client can render a
          // working-directory-aware prompt without a separate query.
          target.postMessage({ type: 'done', id: msg.id, exitCode: r.exitCode ?? 0, cwd: shell.cwd });
        } catch (err) {
          target.postMessage({
            type: 'done',
            id: msg.id,
            exitCode: 1,
            error: err && err.message ? err.message : String(err),
            cwd: shell.cwd,
          });
        }
        return;
      }
      // Programmatic input: text becomes a "line." If a `read` is
      // waiting, resolve the oldest one; otherwise queue ahead so the
      // next `read` finds it.
      case 'input': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (pendingReads.size > 0) {
          const firstId = pendingReads.keys().next().value;
          const slot = pendingReads.get(firstId);
          pendingReads.delete(firstId);
          slot.resolve({ line: text });
        } else {
          inputBuffer.push(text);
        }
        return;
      }
      // Adapter-mediated input. Matches a specific pending read by id
      // and resolves it. Three reply kinds: a successful line, EOF
      // (Ctrl+D with empty buffer), or timeout (-t expiry).
      case 'input-line': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ line: typeof msg.line === 'string' ? msg.line : '' });
        }
        return;
      }
      case 'input-eof': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ eof: true });
        }
        return;
      }
      case 'input-timeout': {
        const slot = pendingReads.get(msg.requestId);
        if (slot) {
          pendingReads.delete(msg.requestId);
          slot.resolve({ timeout: true });
        }
        return;
      }
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
    // Interactive read handler. Called when the worker requests input
    // for a `read` builtin. Shape: ({prompt, silent, nChars, delim,
    // timeout, raw}) => Promise<{line?, eof?, timeout?}>.
    //
    // If null, the client posts an EOF reply for every request so
    // `read` returns 1 — matches "no terminal attached" semantics for
    // pure-programmatic clients that haven't wired an adapter.
    onWantInput = null,
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
  // Last known working directory of the worker-hosted shell. Updated
  // from every `done` message so a host REPL can render a cwd-aware
  // prompt without round-tripping a `pwd`.
  let lastCwd = cwd;

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
        // The worker reports cwd on both success and error paths.
        if (typeof msg.cwd === 'string') lastCwd = msg.cwd;
        if (msg.error) slot.reject(new Error(msg.error));
        else slot.resolve({ exitCode: msg.exitCode, cwd: msg.cwd });
        return;
      }
      case 'want-input': {
        // Route to the host's handler (typically a line editor over
        // the terminal adapter). If no handler is wired, reply EOF so
        // the worker's `read` falls back to "no input available."
        const reqId = msg.requestId;
        const lineOpts = msg.opts || {};
        (async () => {
          if (typeof onWantInput !== 'function') {
            worker.postMessage({ type: 'input-eof', requestId: reqId });
            return;
          }
          try {
            const res = await onWantInput(lineOpts);
            if (!res) {
              worker.postMessage({ type: 'input-eof', requestId: reqId });
            } else if (res.timeout) {
              worker.postMessage({ type: 'input-timeout', requestId: reqId });
            } else if (res.eof) {
              worker.postMessage({ type: 'input-eof', requestId: reqId });
            } else {
              worker.postMessage({
                type: 'input-line',
                requestId: reqId,
                line: typeof res.line === 'string' ? res.line : '',
              });
            }
          } catch {
            worker.postMessage({ type: 'input-eof', requestId: reqId });
          }
        })();
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

    // Last-known working directory of the worker shell. Updated after
    // every exec; a REPL host reads this to draw a cwd-aware prompt.
    get cwd() { return lastCwd; },

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

// -- proc-adapter.js --

// @gcu/proc ↔ @gcu/geas adapter.
//
// Bridges proc's Process / module-service shape to the Worker-shape that
// setupGeasWorker (worker side) and createGeasClient (main side) already
// expect. Two helpers — both small enough that the worker-side one is
// expected to be called from an inline wrapper around the geas bundle.
//
// Main side:
//   const proc = await pm.spawn({ module: workerBlobUrl, mode: 'service' });
//   const worker = procToWorker(proc);
//   const client = createGeasClient({ worker, vfs, ... });
//
// Worker side (inside the module-service entrypoint):
//   export default geasProcEntry({ createShell, isTyped, setupGeasWorker });
//
// (The dependencies of geasProcEntry are passed in because the
// module-service entrypoint runs INSIDE the inlined-bundle scope where
// createShell/isTyped/setupGeasWorker are local bindings, not imports.)

// Wrap a proc Process as a Worker-shaped object. The result quacks like a
// browser Worker (postMessage / addEventListener('message') / terminate),
// which is the interface createGeasClient consumes.
function procToWorker(proc) {
  return {
    postMessage(msg) { proc.send(msg); },
    addEventListener(type, fn) {
      if (type === 'message') {
        proc.on((data) => fn({ data }));
      }
      // 'error' / 'messageerror' currently not forwarded — proc's lifecycle
      // surface (proc.state, proc.error, proc.wait()) covers those.
    },
    removeEventListener() {
      // proc.on returns an unsubscribe; we don't track it here because
      // createGeasClient calls removeEventListener once on teardown
      // immediately followed by proc.kill — terminate cleans up the
      // listeners regardless.
    },
    terminate() {
      try { proc.kill('KILL'); } catch (_) { /* ignore */ }
    },
  };
}

// Build a default-export entrypoint for a geas worker that runs under
// proc's module-service mode. The returned function takes the proc ctx
// (with stdin/stdout/stderr/signal/send/on/exit), builds a Worker-shaped
// target around it, hands that to setupGeasWorker, and parks on the
// signal until killed.
//
// deps: { createShell, isTyped, setupGeasWorker } — passed in because
// this module is bundled separately from the inlined geas bundle that
// owns those symbols.
function geasProcEntry(deps) {
  const { createShell, isTyped, setupGeasWorker } = deps;
  if (typeof setupGeasWorker !== 'function') {
    throw new Error('geasProcEntry: setupGeasWorker is required');
  }
  if (typeof createShell !== 'function') {
    throw new Error('geasProcEntry: createShell is required');
  }
  return async function geasEntrypoint(ctx) {
    const target = {
      postMessage(msg) { ctx.send(msg); },
      addEventListener(type, fn) {
        if (type === 'message') {
          ctx.on((data) => fn({ data }));
        }
      },
      removeEventListener() { /* no-op — proc tears down on exit */ },
    };
    setupGeasWorker(target, { createShell, isTyped });
    // Park until killed. setupGeasWorker registered all its handlers
    // already; nothing to do here except keep the entrypoint alive so
    // proc doesn't post EXIT prematurely.
    if (ctx.signal.aborted) return;
    await new Promise((resolve) => {
      ctx.signal.addEventListener('abort', resolve);
    });
  };
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
  // Normalize ONCE and hold the result — every exec reuses this same
  // ctx, so cwd / env / functions / lastStatus all persist between
  // commands (a fresh-normalize-per-exec would drop `cd`'s effect,
  // since cwd is a primitive copied by value).
  const ctx = normalizeContext({
    vfs:        opts.vfs ?? null,
    env:        opts.env instanceof Map ? opts.env : new Map(Object.entries(opts.env || {})),
    cwd:        opts.cwd ?? '/',
    stdin:      '',
    stdout:     opts.stdout ?? (() => { throw new Error('createShell: stdout required'); }),
    stderr:     opts.stderr ?? opts.stdout ?? (() => { throw new Error('createShell: stderr required'); }),
    builtins:   _mergeBuiltins(opts.builtins),
    // POSIX shell convention: an unrecognised command prints
    // "{name}: command not found" to stderr and exits 127. The executor's
    // bare default just returns 127; createShell is the user-facing
    // factory, so this is the right place for the matching stderr write.
    onCommand:  opts.onCommand ?? (async (name, _argv, subCtx) => {
      await subCtx.stderr(`${name}: command not found\n`);
      return 127;
    }),
    functions:  new Map(),
    lastStatus: 0,
    // Interactive read hook. When `read` runs with no stdin available
    // and this is set, it awaits a line from here instead of returning
    // EOF. Shape: (opts) => Promise<{ line?, eof?, timeout? }>. opts
    // carries prompt, silent, nChars, delim, timeout, raw — the read
    // flags that affect line acquisition.
    readLine:   typeof opts.readLine === 'function' ? opts.readLine : null,
  });
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

export { tokenize, parse, parseWordParts, execute, defaultBuiltins, createShell, mkTyped, isTyped, NODE, createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, makeLineEditor, createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback, procToWorker, geasProcEntry };
