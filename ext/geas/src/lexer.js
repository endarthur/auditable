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

export function tokenize(input) {
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
