// render.js — draw the editor buffer to the terminal adapter.
//
// Strategy: full-line redraw on every state change. Sounds wasteful but
// at typing speed it's invisible, and it side-steps a pile of
// per-operation incremental-redraw bugs (insert mid-line, kill-ring
// paste, history recall, etc.). xterm.js absorbs it without breaking
// a sweat.
//
// Layout for one prompt line:
//
//   <prompt><colored buffer><dim suggestion>\x1b[K   ← rest-of-line clear
//
// Cursor is then positioned by counting how many columns to back up
// from the post-line position.
//
// v1 ignores soft-wrap (lines wider than the terminal). The renderer
// assumes prompt+buffer+suggestion fit in one row. Wrap handling adds
// a lot of state and isn't load-bearing for the common case.

const ESC = '\x1b';
const CLEAR_TO_END = ESC + '[K';

// ANSI 256-colour codes used for autosuggest dim text. Truecolor is
// nicer but xterm.js handles 8-bit better in some configurations.
const DIM_FG = ESC + '[38;5;240m';   // grey, readable on dark + light
const RESET = ESC + '[0m';

// Compute the visual cell width of a string. Cheap range-based table
// covering the common cases — ASCII = 1, CJK + main emoji ranges = 2,
// combining marks + variation selectors = 0. Doesn't handle ZWJ
// sequences (👨‍💻 measures as 4 instead of 2); for that we'd need
// Intl.Segmenter to walk graphemes — deferred until someone reaches
// for it. xterm.js renders all of these correctly; only our cursor
// positioning math needs the width.
function _codepointWidth(cp) {
  // Zero-width: combining marks, zero-width joiners/spaces, variation
  // selectors (incl. the supplementary VS-17..256 range).
  if (cp >= 0x0300 && cp <= 0x036F) return 0;
  if (cp >= 0x200B && cp <= 0x200F) return 0;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return 0;
  if (cp >= 0xE0100 && cp <= 0xE01EF) return 0;
  // Wide: Hangul + CJK + main emoji + fullwidth.
  if (cp >= 0x1100 && cp <= 0x115F) return 2;     // Hangul Jamo
  if (cp >= 0x2E80 && cp <= 0x303E) return 2;     // CJK Radicals, Kangxi, …
  if (cp >= 0x3041 && cp <= 0x33FF) return 2;     // Hiragana, Katakana, CJK Symbols
  if (cp >= 0x3400 && cp <= 0x4DBF) return 2;     // CJK Extension A
  if (cp >= 0x4E00 && cp <= 0x9FFF) return 2;     // CJK Unified Ideographs
  if (cp >= 0xA000 && cp <= 0xA4CF) return 2;     // Yi
  if (cp >= 0xAC00 && cp <= 0xD7A3) return 2;     // Hangul Syllables
  if (cp >= 0xF900 && cp <= 0xFAFF) return 2;     // CJK Compatibility Ideographs
  if (cp >= 0xFE30 && cp <= 0xFE4F) return 2;     // CJK Compatibility Forms
  if (cp >= 0xFF00 && cp <= 0xFF60) return 2;     // Fullwidth Forms
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2;     // Fullwidth Signs
  if (cp >= 0x1F300 && cp <= 0x1F64F) return 2;   // Misc Symbols + main emoji
  if (cp >= 0x1F680 && cp <= 0x1F9FF) return 2;   // Transport + supplemental emoji
  if (cp >= 0x20000 && cp <= 0x2FFFD) return 2;   // CJK Extensions B–F
  if (cp >= 0x30000 && cp <= 0x3FFFD) return 2;   // CJK Extension G
  return 1;
}

function _cellWidth(s) {
  let w = 0;
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    w += _codepointWidth(cp);
    i += cp > 0xFFFF ? 2 : 1;
  }
  return w;
}

// Exposed for tests.
export const cellWidth = _cellWidth;
export const codepointWidth = _codepointWidth;

// Apply a list of `{start, end, ansi}` highlight spans to `text`.
// Spans must be sorted, non-overlapping, in [0, text.length].
function _applyHighlight(text, spans) {
  if (!spans || spans.length === 0) return text;
  let out = '';
  let pos = 0;
  for (const sp of spans) {
    if (sp.start < pos) continue;   // skip malformed
    if (sp.start > pos) out += text.slice(pos, sp.start);
    out += sp.ansi + text.slice(sp.start, sp.end) + RESET;
    pos = sp.end;
  }
  if (pos < text.length) out += text.slice(pos);
  return out;
}

/**
 * Render the editor to the adapter. `prompt` is the prompt string
 * (assumed to contain no SGR sequences that would confuse the column
 * count — if the caller wants colour in the prompt, that's their
 * problem to keep in sync).
 *
 * `opts.highlight(text) → spans` — optional syntax tokens.
 *
 * Returns nothing; pure side effect on the adapter.
 *
 * The render state is kept on `ed._renderState`:
 *   { lastWidth: number }
 * which is just "how many cells we drew last time, after the prompt"
 * so the next redraw can clear cleanly.
 */
export function render(ed, prompt, adapter, opts) {
  const highlight = opts && opts.highlight;

  // Compute the styled buffer + plain visible region for width.
  const buf = ed.buffer;
  const colored = highlight ? _applyHighlight(buf, highlight(buf)) : buf;
  const suggestion = ed.suggestion || '';
  const suggColored = suggestion ? DIM_FG + suggestion + RESET : '';

  // Plain widths (ignore SGR for column counts).
  const bufW = _cellWidth(buf);
  const suggW = _cellWidth(suggestion);
  const totalW = bufW + suggW;

  // Write: CR, prompt, coloured buffer, dim suggestion, clear-to-end.
  adapter.write('\r' + prompt + colored + suggColored + CLEAR_TO_END);

  // Cursor positioning. We're currently at (post-prompt + totalW).
  // We want to be at (post-prompt + cursor). Back up the difference.
  const cursorW = _cellWidth(buf.slice(0, ed.cursor));
  const backup = totalW - cursorW;
  if (backup > 0) adapter.write(ESC + '[' + backup + 'D');

  ed._renderState = { lastWidth: totalW };
}

/**
 * Newline after submit/cancel. Leaves the cursor at the start of a
 * fresh line so the next REPL prompt prints clean.
 */
export function renderNewline(adapter) {
  adapter.write('\r\n');
}
