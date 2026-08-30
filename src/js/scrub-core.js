// scrub-core.js — pure helpers for scrubbable number literals (zero imports).
// Language-agnostic on purpose: numbers look like numbers in every language we
// host (js, adder, soft, glsl-in-template, sql), so detection is a line-local
// regex, not a parse.

const NUM_RE = /\d+\.\d+(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?/g;

// Find the numeric literal span containing column `col` in `line`.
// Returns { start, end, text } (line-local columns) or null. A '-' joins the
// span only when it is IMMEDIATELY adjacent to the number and the char right
// before it is not alphanumeric, '_', ')' or ']' — so `f(-2.5)`, `to -5` and
// `return -5` read as signs, while `a - 5` and `a-5` stay subtractions.
export function findNumberSpan(line, col) {
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(line))) {
    let start = m.index;
    const end = start + m[0].length;
    if (col < start || col > end) continue;
    if (start > 0 && line[start - 1] === '-') {
      const prev = start >= 2 ? line[start - 2] : '';
      if (!/[\w)\]]/.test(prev)) start -= 1;
    }
    return { start, end, text: line.slice(start, end) };
  }
  return null;
}

// Apply `steps` drag steps to the literal, formatted in its own style. The
// step comes from the literal's own textual form — `50` steps by 1, `0.75`
// by 0.01 — and `mult` (Shift) scales it ×10. Fixed-form keeps its decimal
// count, exponent-form steps the mantissa and keeps the exponent verbatim
// (1.5e3 → 1.6e3), integers stay integers.
export function applySteps(text, steps, mult = 1) {
  const m = /^(-?)(\d*)(?:\.(\d+))?([eE][+-]?\d+)?$/.exec(text);
  if (!m) return text;
  const decimals = m[3] ? m[3].length : 0;
  if (m[4]) {
    const mant = parseFloat((m[1] || '') + (m[2] || '0') + (m[3] ? '.' + m[3] : ''));
    return (mant + steps * mult * Math.pow(10, -decimals)).toFixed(decimals) + m[4];
  }
  const v = parseFloat(text) + steps * mult * Math.pow(10, -decimals);
  // toFixed also cleans up float dust: 0.75 + 3×0.01 prints 0.78, not 0.78000…01
  return v.toFixed(decimals);
}
