// buffer.js — the in-memory document model for ed.
//
// `lines` is a 0-indexed array of strings (no trailing newlines). The
// classic ed `current line` cursor is 1-indexed; 0 means "buffer is
// empty." `dirty` flips on any mutation; `undo` snapshots state before
// every buffer-changing command so `u` rolls back exactly one step
// (POSIX one-level undo).

export function createBuffer() {
  return {
    lines: [],
    cur: 0,
    filename: null,
    dirty: false,
    lastSearch: null,
    lastSubstitute: null,   // { re: RegExp, repl: string, flags: string }
    lastError: '',
    prompt: '* ',
    showPrompt: true,       // GNU-ish default; --posix turns it off
    posix: false,
    verboseErrors: true,    // toggled by `H` in posix mode
    cutBuffer: [],          // for `d`/`c`'s implicit cut + `u` reach
    quitPending: false,     // first `q` with dirty buffer warns; second confirms
    // Single-level undo snapshot. Captured BEFORE each mutating command.
    undoSnap: null,
  };
}

// Snapshot current state for `u`. Called before any mutation.
export function snapshot(buf) {
  buf.undoSnap = {
    lines: buf.lines.slice(),
    cur: buf.cur,
    dirty: buf.dirty,
    lastSearch: buf.lastSearch,
    lastSubstitute: buf.lastSubstitute,
  };
}

export function undo(buf) {
  if (!buf.undoSnap) return false;
  const snap = buf.undoSnap;
  // Snapshot CURRENT state as the new undo so `u` is its own inverse.
  const inverse = {
    lines: buf.lines.slice(),
    cur: buf.cur,
    dirty: buf.dirty,
    lastSearch: buf.lastSearch,
    lastSubstitute: buf.lastSubstitute,
  };
  buf.lines = snap.lines;
  buf.cur = snap.cur;
  buf.dirty = snap.dirty;
  buf.lastSearch = snap.lastSearch;
  buf.lastSubstitute = snap.lastSubstitute;
  buf.undoSnap = inverse;
  return true;
}

// Insert `newLines` into `buf` AFTER `at` (1-indexed; 0 = before line 1).
// Updates cur to the last inserted line. Marks dirty.
export function insertAfter(buf, at, newLines) {
  if (newLines.length === 0) return;
  buf.lines.splice(at, 0, ...newLines);
  buf.cur = at + newLines.length;
  buf.dirty = true;
}

// Delete inclusive range [from, to] (1-indexed). Updates cur to the
// line that was just after the deleted block (or last line if at end).
export function deleteRange(buf, from, to) {
  const cut = buf.lines.splice(from - 1, to - from + 1);
  buf.cutBuffer = cut;
  buf.cur = Math.min(from, buf.lines.length);
  if (buf.cur < 1 && buf.lines.length > 0) buf.cur = 1;
  buf.dirty = true;
  return cut;
}

// Move inclusive range [from, to] to AFTER `dest` (1-indexed).
// Errors if dest falls inside the range.
export function moveRange(buf, from, to, dest) {
  if (dest >= from - 1 && dest <= to) {
    throw new Error('invalid destination');
  }
  const cut = buf.lines.splice(from - 1, to - from + 1);
  // After the cut, line numbers from `from` onward have shifted down by
  // cut.length. Adjust dest accordingly.
  const adjustedDest = dest >= to ? dest - cut.length : dest;
  buf.lines.splice(adjustedDest, 0, ...cut);
  buf.cur = adjustedDest + cut.length;
  buf.dirty = true;
}

// Copy (transfer) inclusive range [from, to] to AFTER `dest` (1-indexed).
export function transferRange(buf, from, to, dest) {
  const copy = buf.lines.slice(from - 1, to);
  buf.lines.splice(dest, 0, ...copy);
  buf.cur = dest + copy.length;
  buf.dirty = true;
}

// Replace one line. Used by `s` per-line and `c` after insert.
export function replaceLine(buf, n, text) {
  buf.lines[n - 1] = text;
  buf.cur = n;
  buf.dirty = true;
}
