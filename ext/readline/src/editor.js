// editor.js — buffer + cursor model and editing operations.
//
// Pure state machine: every operation returns nothing, mutates the
// editor. The render layer reads `buffer`, `cursor`, and the optional
// `suggestion` to draw the line. History recall and tab completion
// also live here (history is a buffer-state concern; completion is a
// dispatch into a caller-provided callback that we splice into the
// buffer).

const WORD_RE = /[\w]/;   // POSIX \w: a-zA-Z0-9_. Good enough for path / cmd / arg word skip.

function _isWordChar(c) { return c != null && WORD_RE.test(c); }

export function createEditor() {
  return {
    buffer: '',
    cursor: 0,
    killRing: [],         // Bash-style kill ring; Ctrl-Y yanks the head.
    yankPos: -1,          // -1 = no yank in progress (used by Alt-Y to rotate).
    history: [],
    historyIdx: -1,       // -1 means "live buffer", else index into history.
    liveBuffer: '',       // saved when historyUp leaves the live edit.
    suggestion: '',       // ghost text shown after the cursor (autosuggest).
  };
}

// ── cursor motion ────────────────────────────────────────────────────

export function moveLeft(ed) {
  if (ed.cursor > 0) ed.cursor--;
}

export function moveRight(ed) {
  if (ed.cursor < ed.buffer.length) ed.cursor++;
}

export function moveWordLeft(ed) {
  // Bash behaviour: skip non-word chars then the word.
  let i = ed.cursor;
  while (i > 0 && !_isWordChar(ed.buffer[i - 1])) i--;
  while (i > 0 && _isWordChar(ed.buffer[i - 1])) i--;
  ed.cursor = i;
}

export function moveWordRight(ed) {
  let i = ed.cursor;
  while (i < ed.buffer.length && !_isWordChar(ed.buffer[i])) i++;
  while (i < ed.buffer.length && _isWordChar(ed.buffer[i])) i++;
  ed.cursor = i;
}

export function moveHome(ed) { ed.cursor = 0; }
export function moveEnd(ed)  { ed.cursor = ed.buffer.length; }

// ── editing ──────────────────────────────────────────────────────────

export function insertText(ed, text) {
  ed.buffer = ed.buffer.slice(0, ed.cursor) + text + ed.buffer.slice(ed.cursor);
  ed.cursor += text.length;
  ed.yankPos = -1;
  ed.suggestion = '';
}

export function deleteLeft(ed) {
  if (ed.cursor === 0) return;
  ed.buffer = ed.buffer.slice(0, ed.cursor - 1) + ed.buffer.slice(ed.cursor);
  ed.cursor--;
  ed.yankPos = -1;
}

export function deleteRight(ed) {
  if (ed.cursor === ed.buffer.length) return;
  ed.buffer = ed.buffer.slice(0, ed.cursor) + ed.buffer.slice(ed.cursor + 1);
  ed.yankPos = -1;
}

function _kill(ed, fromIdx, toIdx) {
  if (fromIdx === toIdx) return;
  const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  const killed = ed.buffer.slice(lo, hi);
  ed.buffer = ed.buffer.slice(0, lo) + ed.buffer.slice(hi);
  ed.cursor = lo;
  // Push to kill ring (head is freshest).
  ed.killRing.unshift(killed);
  if (ed.killRing.length > 32) ed.killRing.length = 32;   // soft cap
  ed.yankPos = -1;
}

export function killWordLeft(ed) {
  const start = ed.cursor;
  moveWordLeft(ed);
  _kill(ed, ed.cursor, start);
}

export function killWordRight(ed) {
  const start = ed.cursor;
  moveWordRight(ed);
  const end = ed.cursor;
  ed.cursor = start;
  _kill(ed, start, end);
}

export function killToStart(ed) { _kill(ed, 0, ed.cursor); }
export function killToEnd(ed)   { _kill(ed, ed.cursor, ed.buffer.length); }

// Ctrl-Y: paste the head of the kill ring. Mark yankPos so Alt-Y can
// rotate to older entries.
export function yank(ed) {
  if (ed.killRing.length === 0) return;
  const text = ed.killRing[0];
  const inserted = ed.cursor;
  ed.buffer = ed.buffer.slice(0, ed.cursor) + text + ed.buffer.slice(ed.cursor);
  ed.cursor += text.length;
  ed.yankPos = 0;
  ed.yankStart = inserted;
  ed.yankEnd = ed.cursor;
  ed.suggestion = '';
}

// Alt-Y: replace the just-yanked text with the next-older kill-ring
// entry. No-op if the last action wasn't a yank.
export function yankRotate(ed) {
  if (ed.yankPos < 0 || ed.killRing.length === 0) return;
  ed.yankPos = (ed.yankPos + 1) % ed.killRing.length;
  const text = ed.killRing[ed.yankPos];
  ed.buffer = ed.buffer.slice(0, ed.yankStart) + text + ed.buffer.slice(ed.yankEnd);
  ed.yankEnd = ed.yankStart + text.length;
  ed.cursor = ed.yankEnd;
}

// ── history navigation ───────────────────────────────────────────────

export function historyUp(ed) {
  if (ed.history.length === 0) return;
  if (ed.historyIdx === -1) {
    ed.liveBuffer = ed.buffer;
    ed.historyIdx = ed.history.length - 1;
  } else if (ed.historyIdx > 0) {
    ed.historyIdx--;
  } else {
    return;   // already at oldest
  }
  ed.buffer = ed.history[ed.historyIdx];
  ed.cursor = ed.buffer.length;
  ed.suggestion = '';
}

export function historyDown(ed) {
  if (ed.historyIdx === -1) return;
  if (ed.historyIdx < ed.history.length - 1) {
    ed.historyIdx++;
    ed.buffer = ed.history[ed.historyIdx];
  } else {
    ed.historyIdx = -1;
    ed.buffer = ed.liveBuffer;
    ed.liveBuffer = '';
  }
  ed.cursor = ed.buffer.length;
  ed.suggestion = '';
}

// Push the current buffer into history (called on submit). Deduplicates
// against the most recent entry — typing the same command twice doesn't
// fill history with dupes.
export function historyPush(ed, line) {
  if (!line || ed.history[ed.history.length - 1] === line) return;
  ed.history.push(line);
  ed.historyIdx = -1;
  ed.liveBuffer = '';
}

// Reset for a fresh prompt — clears buffer/cursor + history cursor,
// keeps the history list.
export function resetForPrompt(ed) {
  ed.buffer = '';
  ed.cursor = 0;
  ed.historyIdx = -1;
  ed.liveBuffer = '';
  ed.yankPos = -1;
  ed.suggestion = '';
}

// ── autosuggest from history ────────────────────────────────────────

// Find the most-recent history entry that starts with `prefix`. Empty
// prefix produces no suggestion (we don't suggest the entire last
// command on an empty line — too aggressive).
export function suggestFromHistory(ed) {
  const prefix = ed.buffer;
  if (!prefix || ed.cursor !== prefix.length) {
    ed.suggestion = '';
    return;
  }
  for (let i = ed.history.length - 1; i >= 0; i--) {
    const h = ed.history[i];
    if (h !== prefix && h.startsWith(prefix)) {
      ed.suggestion = h.slice(prefix.length);
      return;
    }
  }
  ed.suggestion = '';
}

export function acceptSuggestion(ed) {
  if (!ed.suggestion) return;
  ed.buffer += ed.suggestion;
  ed.cursor = ed.buffer.length;
  ed.suggestion = '';
}

// Accept only the first word of the suggestion (Alt-F-like partial
// accept). Useful when you want to commit "git" but not the full "git
// log --oneline" past the next space.
export function acceptSuggestionWord(ed) {
  if (!ed.suggestion) return;
  // Take up to and including the next whitespace boundary.
  const m = ed.suggestion.match(/^\S+\s*/);
  const slice = m ? m[0] : ed.suggestion;
  ed.buffer += slice;
  ed.cursor = ed.buffer.length;
  ed.suggestion = ed.suggestion.slice(slice.length);
}
