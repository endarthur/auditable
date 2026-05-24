// regex.js — translate ed-flavoured patterns to JS RegExp.
//
// Ed defaults to BRE (Basic Regular Expressions). The differences from
// JS regex that matter in practice:
//
//   - `\(` `\)`        — groups (parentheses are literal in BRE)
//   - `\|`             — alternation (pipe is literal in BRE)
//   - `\{m,n\}`        — counted repetition
//   - `\<` `\>`        — word boundaries (JS uses `\b` for both)
//   - `+` `?`          — literal characters in BRE (JS treats as operators)
//   - `\+` `\?`        — repetition operators in some BRE flavours
//   - `.` `^` `$` `*`  — same as JS
//   - `[abc]` `[^abc]` — same as JS
//   - `\n` in replace  — backreference (not newline)
//
// We translate the ed-style escapes into JS regex source. Anyone targeting
// strict POSIX BRE will hit edge cases; we ship the convenient subset that
// covers what's actually typed at an ed prompt.

export function edToJsRegex(edPattern, flags) {
  let out = '';
  let i = 0;
  while (i < edPattern.length) {
    const c = edPattern[i];
    if (c === '\\') {
      const next = edPattern[i + 1];
      switch (next) {
        case '(': out += '(';  i += 2; continue;
        case ')': out += ')';  i += 2; continue;
        case '|': out += '|';  i += 2; continue;
        case '{': out += '{';  i += 2; continue;
        case '}': out += '}';  i += 2; continue;
        case '<': out += '\\b'; i += 2; continue;
        case '>': out += '\\b'; i += 2; continue;
        case '+': out += '+';  i += 2; continue;
        case '?': out += '?';  i += 2; continue;
        case '.': out += '\\.'; i += 2; continue;
        case '*': out += '\\*'; i += 2; continue;
        case '[': out += '\\['; i += 2; continue;
        case ']': out += '\\]'; i += 2; continue;
        case '^': out += '\\^'; i += 2; continue;
        case '$': out += '\\$'; i += 2; continue;
        case '/': out += '/';   i += 2; continue;
        default:
          // \n, \t, \\, \d etc. — pass through verbatim.
          out += '\\' + (next != null ? next : '');
          i += next != null ? 2 : 1;
          continue;
      }
    }
    if (c === '(' || c === ')' || c === '|' || c === '{' || c === '}'
        || c === '+' || c === '?') {
      // Literal in BRE → escape for JS.
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return new RegExp(out, flags);
}

// Apply an ed substitution: `repl` may contain `&` (whole match) and
// `\1` .. `\9` (backreferences). We rewrite to JS replacement syntax
// (`$&`, `$1`..) then call String.prototype.replace.
function _edReplToJs(repl) {
  let out = '';
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c === '\\') {
      const next = repl[i + 1];
      if (next >= '0' && next <= '9') {
        out += '$' + next;
        i += 2;
        continue;
      }
      if (next === '&') { out += '&'; i += 2; continue; }
      if (next === '\\') { out += '\\\\'; i += 2; continue; }
      // Other escapes pass through (\n → newline etc.)
      out += '\\' + (next != null ? next : '');
      i += next != null ? 2 : 1;
      continue;
    }
    if (c === '&')  { out += '$&';   i++; continue; }
    if (c === '$')  { out += '$$';   i++; continue; }
    out += c;
    i++;
  }
  return out;
}

export function applySubstitute(line, re, repl, global) {
  const jsRepl = _edReplToJs(repl);
  if (global) {
    const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return line.replace(gre, jsRepl);
  }
  return line.replace(re, jsRepl);
}
