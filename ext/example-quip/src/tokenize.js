// quip tokenizer — returns CM6-shaped tokens that the editor (or any
// EXTENSION_SPEC §3.1 / §3.2 consumer) can use for highlighting.
//
// Token kinds emitted: `comment`, `name` (LHS of =), `operator` (=),
// `variable` (the `{var}` references), `string` (the template body),
// `escape` (literal {{ }} pairs).

export function tokenizeQuip(code) {
  const tokens = [];
  const lines = String(code).split('\n');
  let offset = 0;
  for (const line of lines) {
    _tokenizeLine(line, offset, tokens);
    offset += line.length + 1;   // +1 for the consumed \n
  }
  return tokens;
}

function _tokenizeLine(line, base, out) {
  const trimmed = line.trim();
  // Comments
  if (trimmed.startsWith('#')) {
    const start = base + line.indexOf('#');
    out.push({ from: start, to: base + line.length, kind: 'comment' });
    return;
  }
  if (trimmed === '') return;

  const eq = line.indexOf('=');
  if (eq < 0) {
    // Malformed — treat the whole line as a parse error region.
    out.push({ from: base, to: base + line.length, kind: 'error' });
    return;
  }

  // Name: from first non-whitespace to the last non-whitespace before =.
  const lhs = line.slice(0, eq);
  const nameStart = lhs.search(/\S/);
  const nameEnd = lhs.replace(/\s+$/, '').length;
  if (nameStart >= 0 && nameEnd > nameStart) {
    out.push({ from: base + nameStart, to: base + nameEnd, kind: 'name' });
  }
  out.push({ from: base + eq, to: base + eq + 1, kind: 'operator' });

  // Template body — scan for {var} interpolations and literal {{ }}.
  const rhs = line.slice(eq + 1);
  const rhsBase = base + eq + 1;
  let i = 0;
  let runStart = 0;
  while (i < rhs.length) {
    const ch = rhs[i];
    if (ch === '{' && rhs[i + 1] === '{') {
      if (i > runStart) out.push({ from: rhsBase + runStart, to: rhsBase + i, kind: 'string' });
      out.push({ from: rhsBase + i, to: rhsBase + i + 2, kind: 'escape' });
      i += 2;
      runStart = i;
      continue;
    }
    if (ch === '}' && rhs[i + 1] === '}') {
      if (i > runStart) out.push({ from: rhsBase + runStart, to: rhsBase + i, kind: 'string' });
      out.push({ from: rhsBase + i, to: rhsBase + i + 2, kind: 'escape' });
      i += 2;
      runStart = i;
      continue;
    }
    if (ch === '{') {
      const end = rhs.indexOf('}', i + 1);
      if (end < 0) { i++; continue; }
      if (i > runStart) out.push({ from: rhsBase + runStart, to: rhsBase + i, kind: 'string' });
      out.push({ from: rhsBase + i, to: rhsBase + end + 1, kind: 'variable' });
      i = end + 1;
      runStart = i;
      continue;
    }
    i++;
  }
  if (runStart < rhs.length) {
    out.push({ from: rhsBase + runStart, to: rhsBase + rhs.length, kind: 'string' });
  }
}
