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

// Compute the visual cell width of a string. v1: every char = 1 cell.
// Wide / emoji / combining chars are wrong but not catastrophic in a
// shell context.
function _cellWidth(s) {
  return s.length;
}

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
