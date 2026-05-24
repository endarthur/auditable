// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/readline/src/  Build: node ext/readline/build.js
// @gcu/readline — GNU-readline-minimum line editor with fish-style autosuggest
// and tab completion. Drop-in for @gcu/geas's makeLineEditor.

// -- keys.js --

// keys.js — parse a stream of input bytes into key events.
//
// The line editor sees one stream: chunks of UTF-8 text from the
// adapter's onInput callback. We split that into key events the
// dispatcher knows about:
//
//   { name: 'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' |
//           'Delete' | 'Backspace' | 'Enter' | 'Tab' | 'Esc' |
//           'PasteStart' | 'PasteEnd' }
//   { name: 'Ctrl-A' .. 'Ctrl-Z', 'Ctrl-?' (Backspace), etc. }
//   { name: 'Alt-<base>' }   — Alt-modified keys: Alt-B, Alt-F, Alt-R,
//                              Alt-Backspace (\x1b\x7f), Alt-Left, ...
//   { ch: '<char>' }         — printable insert
//   { paste: '<text>' }      — bracketed-paste payload, single event
//                              regardless of length
//
// Bracketed paste mode: the terminal wraps pasted text in
//   ESC[200~ ... ESC[201~
// so a multi-line paste lands as one `paste` event the editor can
// insert atomically (no completion/history triggers fire mid-paste).
//
// CSI sequences with `;modifier` suffix (e.g. ESC[1;5D for Ctrl-Left)
// are recognised: 2=Shift, 3=Alt, 5=Ctrl, 6=Ctrl+Shift, etc.

const CSI_FINAL_RE = /[A-Za-z~]/;

// CSI base codes (no modifier) → name
const CSI_BASE = {
  A: 'Up', B: 'Down', C: 'Right', D: 'Left',
  H: 'Home', F: 'End',
  Z: 'Shift-Tab',
};

// CSI 1;<mod> <final> sequences — modifier-encoded cursor keys.
// Modifier byte: 2=Shift, 3=Alt, 4=Shift+Alt, 5=Ctrl, 6=Shift+Ctrl,
// 7=Alt+Ctrl, 8=Shift+Alt+Ctrl. We care about Ctrl + Alt only.
const MOD_PREFIX = {
  3: 'Alt-', 5: 'Ctrl-', 7: 'Ctrl-Alt-',
};

// CSI <num> ~ keys — Delete, PageUp/Down, etc.
const CSI_TILDE = {
  3: 'Delete', 5: 'PageUp', 6: 'PageDown',
  // 200 / 201 → bracketed paste, handled specially in the parser.
};

/**
 * Parse `chunk` into key events. Returns { events, leftover } where
 * `leftover` is a partial sequence that didn't terminate in this chunk
 * (caller prepends it to the next chunk).
 *
 * `state` is { pasting: bool, pasteBuf: string } persisted across calls
 * so a bracketed-paste split across two onInput callbacks survives.
 */
function parseKeys(chunk, state) {
  const events = [];
  const s = state || (state = { pasting: false, pasteBuf: '' });
  let i = 0;

  while (i < chunk.length) {
    // Mid-paste: accumulate until the end sentinel.
    if (s.pasting) {
      // Look for ESC[201~ in the stream.
      const endIdx = chunk.indexOf('\x1b[201~', i);
      if (endIdx === -1) {
        s.pasteBuf += chunk.slice(i);
        return { events, leftover: '' };
      }
      s.pasteBuf += chunk.slice(i, endIdx);
      events.push({ paste: s.pasteBuf });
      s.pasting = false;
      s.pasteBuf = '';
      i = endIdx + '\x1b[201~'.length;
      continue;
    }

    const ch = chunk[i];

    // ESC starts an escape sequence (CSI or Alt-key).
    if (ch === '\x1b') {
      // Pure ESC at end of chunk — defer to next chunk in case more
      // bytes are coming.
      if (i + 1 >= chunk.length) {
        return { events, leftover: chunk.slice(i) };
      }
      const next = chunk[i + 1];

      // ESC [ ...  — CSI sequence.
      if (next === '[') {
        // Find the final byte (letter or ~). If missing in this chunk,
        // defer.
        let j = i + 2;
        while (j < chunk.length && !CSI_FINAL_RE.test(chunk[j])) j++;
        if (j >= chunk.length) {
          return { events, leftover: chunk.slice(i) };
        }
        const params = chunk.slice(i + 2, j);
        const final = chunk[j];
        i = j + 1;

        // Bracketed-paste start?
        if (final === '~' && params === '200') {
          s.pasting = true;
          s.pasteBuf = '';
          continue;
        }
        if (final === '~' && params === '201') {
          // Stray end marker (we weren't pasting). Drop silently.
          continue;
        }

        // Modifier-encoded cursor key: ESC [ 1 ; <mod> <final>
        if (final !== '~' && params.startsWith('1;')) {
          const mod = parseInt(params.slice(2), 10);
          const base = CSI_BASE[final];
          if (base && MOD_PREFIX[mod]) {
            events.push({ name: MOD_PREFIX[mod] + base });
            continue;
          }
          // Unknown modifier — drop the base unmodified rather than
          // silently swallowing the user's intent.
          if (base) events.push({ name: base });
          continue;
        }

        // Plain cursor / Home / End / etc.
        if (final !== '~' && CSI_BASE[final]) {
          events.push({ name: CSI_BASE[final] });
          continue;
        }

        // ESC [ <num> ~
        if (final === '~') {
          const code = parseInt(params, 10);
          if (CSI_TILDE[code]) {
            events.push({ name: CSI_TILDE[code] });
            continue;
          }
        }

        // Unknown CSI — drop silently. Keeps stray sequences from
        // landing in the buffer as literal text.
        continue;
      }

      // ESC <single char> — Alt-<char> (xterm convention).
      // Special case: ESC followed by DEL (0x7f) is Alt-Backspace.
      if (next === '\x7f') {
        events.push({ name: 'Alt-Backspace' });
        i += 2;
        continue;
      }
      // ESC ESC = lone Escape twice → treat the first as Escape, defer
      // the second (it might still be the start of CSI in the next chunk).
      if (next === '\x1b') {
        events.push({ name: 'Esc' });
        i += 1;
        continue;
      }
      // Printable after ESC — Alt-<char>. Lowercase for normalisation.
      events.push({ name: 'Alt-' + next.toLowerCase() });
      i += 2;
      continue;
    }

    // Control characters (0x00 - 0x1f, plus 0x7f).
    const code = ch.charCodeAt(0);
    if (code === 0x7f || code === 0x08) {
      events.push({ name: 'Backspace' });
      i++;
      continue;
    }
    if (code === 0x0d || code === 0x0a) {
      events.push({ name: 'Enter' });
      i++;
      continue;
    }
    if (code === 0x09) {
      events.push({ name: 'Tab' });
      i++;
      continue;
    }
    if (code < 0x20) {
      // Ctrl-A = 0x01, Ctrl-Z = 0x1a. Ctrl-@ = 0x00. Map to 'Ctrl-<letter>'.
      const letter = code === 0 ? '@' : String.fromCharCode(0x60 + code);
      events.push({ name: 'Ctrl-' + letter });
      i++;
      continue;
    }

    // Printable. Group consecutive printables into one ch-string for
    // efficiency on fast typing (Chrome dispatches IME chunks as runs).
    let j = i;
    while (j < chunk.length) {
      const cc = chunk.charCodeAt(j);
      if (cc < 0x20 || cc === 0x7f || cc === 0x1b) break;
      j++;
    }
    if (j > i) {
      events.push({ ch: chunk.slice(i, j) });
      i = j;
    } else {
      i++;
    }
  }

  return { events, leftover: '' };
}

// -- editor.js --

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

function createEditor() {
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

function moveLeft(ed) {
  if (ed.cursor > 0) ed.cursor--;
}

function moveRight(ed) {
  if (ed.cursor < ed.buffer.length) ed.cursor++;
}

function moveWordLeft(ed) {
  // Bash behaviour: skip non-word chars then the word.
  let i = ed.cursor;
  while (i > 0 && !_isWordChar(ed.buffer[i - 1])) i--;
  while (i > 0 && _isWordChar(ed.buffer[i - 1])) i--;
  ed.cursor = i;
}

function moveWordRight(ed) {
  let i = ed.cursor;
  while (i < ed.buffer.length && !_isWordChar(ed.buffer[i])) i++;
  while (i < ed.buffer.length && _isWordChar(ed.buffer[i])) i++;
  ed.cursor = i;
}

function moveHome(ed) { ed.cursor = 0; }
function moveEnd(ed)  { ed.cursor = ed.buffer.length; }

// ── editing ──────────────────────────────────────────────────────────

function insertText(ed, text) {
  ed.buffer = ed.buffer.slice(0, ed.cursor) + text + ed.buffer.slice(ed.cursor);
  ed.cursor += text.length;
  ed.yankPos = -1;
  ed.suggestion = '';
}

function deleteLeft(ed) {
  if (ed.cursor === 0) return;
  ed.buffer = ed.buffer.slice(0, ed.cursor - 1) + ed.buffer.slice(ed.cursor);
  ed.cursor--;
  ed.yankPos = -1;
}

function deleteRight(ed) {
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

function killWordLeft(ed) {
  const start = ed.cursor;
  moveWordLeft(ed);
  _kill(ed, ed.cursor, start);
}

function killWordRight(ed) {
  const start = ed.cursor;
  moveWordRight(ed);
  const end = ed.cursor;
  ed.cursor = start;
  _kill(ed, start, end);
}

function killToStart(ed) { _kill(ed, 0, ed.cursor); }
function killToEnd(ed)   { _kill(ed, ed.cursor, ed.buffer.length); }

// Ctrl-Y: paste the head of the kill ring. Mark yankPos so Alt-Y can
// rotate to older entries.
function yank(ed) {
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
function yankRotate(ed) {
  if (ed.yankPos < 0 || ed.killRing.length === 0) return;
  ed.yankPos = (ed.yankPos + 1) % ed.killRing.length;
  const text = ed.killRing[ed.yankPos];
  ed.buffer = ed.buffer.slice(0, ed.yankStart) + text + ed.buffer.slice(ed.yankEnd);
  ed.yankEnd = ed.yankStart + text.length;
  ed.cursor = ed.yankEnd;
}

// ── history navigation ───────────────────────────────────────────────

function historyUp(ed) {
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

function historyDown(ed) {
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
function historyPush(ed, line) {
  if (!line || ed.history[ed.history.length - 1] === line) return;
  ed.history.push(line);
  ed.historyIdx = -1;
  ed.liveBuffer = '';
}

// Reset for a fresh prompt — clears buffer/cursor + history cursor,
// keeps the history list.
function resetForPrompt(ed) {
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
function suggestFromHistory(ed) {
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

function acceptSuggestion(ed) {
  if (!ed.suggestion) return;
  ed.buffer += ed.suggestion;
  ed.cursor = ed.buffer.length;
  ed.suggestion = '';
}

// Accept only the first word of the suggestion (Alt-F-like partial
// accept). Useful when you want to commit "git" but not the full "git
// log --oneline" past the next space.
function acceptSuggestionWord(ed) {
  if (!ed.suggestion) return;
  // Take up to and including the next whitespace boundary.
  const m = ed.suggestion.match(/^\S+\s*/);
  const slice = m ? m[0] : ed.suggestion;
  ed.buffer += slice;
  ed.cursor = ed.buffer.length;
  ed.suggestion = ed.suggestion.slice(slice.length);
}

// -- render.js --

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
function render(ed, prompt, adapter, opts) {
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
function renderNewline(adapter) {
  adapter.write('\r\n');
}

// -- api.js --

// api.js — public createReadline entry point. Matches the
// makeLineEditor shape so callers can swap one for the other:
//
//   const readLine = createReadline(adapter, {
//     history,                         // array, mutated in place
//     complete: (line, cursor) => [...],
//     highlight: (line) => [{start, end, ansi}],
//     autosuggestFromHistory: true,    // default true
//     onPersistHistory: async (line) => { ... },
//   });
//   const { line, eof } = await readLine({ prompt: '$ ' });



const DEFAULTS = {
  autosuggestFromHistory: true,
};

function createReadline(adapter, opts = {}) {
  if (!adapter || typeof adapter.onInput !== 'function') {
    throw new Error('createReadline: adapter must have onInput()');
  }
  const config = { ...DEFAULTS, ...opts };

  // One persistent editor across reads — preserves kill ring + history
  // index between prompts. Reset for each prompt clears buffer/cursor
  // but keeps the kill ring (matches bash).
  const state = createEditor();
  if (Array.isArray(config.history)) state.history = config.history;

  return function readLine(lineOpts = {}) {
    const { prompt = '', silent = false, nChars, delim, timeout } = lineOpts;
    resetForPrompt(state);

    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const parserState = { pasting: false, pasteBuf: '' };
      let leftover = '';
      // Tab-completion state — first Tab fills the longest common
      // prefix or lists matches; subsequent Tabs cycle through matches.
      let completionMatches = null;
      let completionIdx = 0;
      let completionAnchor = -1;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { unsub && unsub(); } catch { /* */ }
        if (!silent && (result.line != null || result.eof)) {
          renderNewline(adapter);
        }
        if (result.line != null && !silent) {
          historyPush(state, result.line);
          if (typeof config.onPersistHistory === 'function') {
            try { config.onPersistHistory(result.line); } catch { /* */ }
          }
        }
        resolve(result);
      };

      const redraw = () => {
        if (silent) return;
        if (config.autosuggestFromHistory) suggestFromHistory(state);
        render(state, prompt, adapter, { highlight: config.highlight });
      };

      const bell = () => { try { adapter.write('\x07'); } catch { /* */ } };

      const doTab = () => {
        if (typeof config.complete !== 'function') { bell(); return; }
        const isContinuation = completionMatches != null
          && completionAnchor === state.cursor;
        if (isContinuation) {
          completionIdx = (completionIdx + 1) % completionMatches.length;
          const m = completionMatches[completionIdx];
          state.buffer = state.buffer.slice(0, completionMatches._anchorStart)
            + m + state.buffer.slice(state.cursor);
          state.cursor = completionMatches._anchorStart + m.length;
          completionAnchor = state.cursor;
          return;
        }
        const result = config.complete(state.buffer, state.cursor);
        if (!result || (Array.isArray(result) && result.length === 0)) {
          bell();
          return;
        }
        let matches, anchorStart;
        if (Array.isArray(result)) {
          matches = result;
          let i = state.cursor;
          while (i > 0 && /\S/.test(state.buffer[i - 1])) i--;
          anchorStart = i;
        } else {
          matches = result.matches || [];
          anchorStart = result.anchor != null ? result.anchor : state.cursor;
        }
        if (matches.length === 0) { bell(); return; }
        if (matches.length === 1) {
          const m = matches[0];
          state.buffer = state.buffer.slice(0, anchorStart)
            + m + state.buffer.slice(state.cursor);
          state.cursor = anchorStart + m.length;
          completionMatches = null;
          return;
        }
        const cur = state.buffer.slice(anchorStart, state.cursor);
        const lcp = _longestCommonPrefix(matches);
        if (lcp.length > cur.length) {
          state.buffer = state.buffer.slice(0, anchorStart)
            + lcp + state.buffer.slice(state.cursor);
          state.cursor = anchorStart + lcp.length;
          completionMatches = null;
          return;
        }
        // No further expansion — print list and prime cycle.
        adapter.write('\r\n' + matches.join('  ') + '\r\n');
        completionMatches = matches;
        completionMatches._anchorStart = anchorStart;
        completionIdx = -1;
        completionAnchor = state.cursor;
      };

      const onChunk = (text) => {
        if (done || typeof text !== 'string') return;
        const r = parseKeys(leftover + text, parserState);
        leftover = r.leftover;

        for (const ev of r.events) {
          if (done) break;

          if (ev.paste != null) {
            insertText(state, ev.paste);
            completionMatches = null;
            redraw();
            continue;
          }

          if (ev.ch != null) {
            for (const c of ev.ch) {
              if (nChars != null && state.buffer.length >= nChars) break;
              insertText(state, c);
              if (delim && c === delim[0]) {
                const out = state.buffer.slice(0, -1);
                finish({ line: out });
                return;
              }
            }
            completionMatches = null;
            redraw();
            if (nChars != null && state.buffer.length >= nChars) {
              finish({ line: state.buffer });
              return;
            }
            continue;
          }

          const k = ev.name;
          if (k !== 'Tab') completionMatches = null;

          switch (k) {
            case 'Enter':
              finish({ line: state.buffer });
              return;
            case 'Backspace':       deleteLeft(state); redraw(); break;
            case 'Delete':          deleteRight(state); redraw(); break;
            case 'Left':            moveLeft(state); redraw(); break;
            case 'Right':
              if (state.cursor === state.buffer.length && state.suggestion) {
                acceptSuggestion(state);
              } else {
                moveRight(state);
              }
              redraw();
              break;
            case 'Up':              historyUp(state); redraw(); break;
            case 'Down':            historyDown(state); redraw(); break;
            case 'Home':
            case 'Ctrl-a':          moveHome(state); redraw(); break;
            case 'End':
            case 'Ctrl-e':          moveEnd(state); redraw(); break;
            case 'Ctrl-Left':
            case 'Alt-b':           moveWordLeft(state); redraw(); break;
            case 'Ctrl-Right':
            case 'Alt-f':
              if (state.cursor === state.buffer.length && state.suggestion) {
                acceptSuggestionWord(state);
              } else {
                moveWordRight(state);
              }
              redraw();
              break;
            case 'Alt-Backspace':   killWordLeft(state); redraw(); break;
            case 'Alt-d':           killWordRight(state); redraw(); break;
            case 'Ctrl-u':          killToStart(state); redraw(); break;
            case 'Ctrl-k':          killToEnd(state); redraw(); break;
            case 'Ctrl-y':          yank(state); redraw(); break;
            case 'Alt-y':           yankRotate(state); redraw(); break;
            case 'Ctrl-f':
              if (state.cursor === state.buffer.length && state.suggestion) {
                acceptSuggestion(state);
              } else {
                moveRight(state);
              }
              redraw();
              break;
            case 'Ctrl-b':          moveLeft(state); redraw(); break;
            case 'Tab':             doTab(); redraw(); break;
            case 'Ctrl-d':
              if (state.buffer.length === 0) { finish({ eof: true }); return; }
              deleteRight(state);
              redraw();
              break;
            case 'Ctrl-c':
              adapter.write('^C');
              finish({ eof: true });
              return;
            case 'Esc':
              if (state.suggestion) { state.suggestion = ''; redraw(); }
              break;
            default: break;
          }
        }
      };

      const unsub = adapter.onInput(onChunk);
      try { adapter.write('\x1b[?2004h'); } catch { /* */ }
      if (!silent) {
        adapter.write(prompt);
        state._renderState = { lastWidth: 0 };
      }
      if (timeout != null && timeout > 0) {
        timer = setTimeout(() => finish({ timeout: true }), timeout * 1000);
      }
    });
  };
}

function _longestCommonPrefix(strs) {
  if (strs.length === 0) return '';
  let p = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(p)) {
      p = p.slice(0, -1);
      if (p === '') return '';
    }
  }
  return p;
}

export { parseKeys, createReadline };
