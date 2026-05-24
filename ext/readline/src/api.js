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

import { parseKeys } from './keys.js';
import {
  createEditor, resetForPrompt, insertText, deleteLeft, deleteRight,
  moveLeft, moveRight, moveWordLeft, moveWordRight, moveHome, moveEnd,
  killWordLeft, killWordRight, killToStart, killToEnd,
  yank, yankRotate, historyUp, historyDown, historyPush,
  suggestFromHistory, acceptSuggestion, acceptSuggestionWord,
} from './editor.js';
import { render, renderNewline } from './render.js';

const DEFAULTS = {
  autosuggestFromHistory: true,
};

export function createReadline(adapter, opts = {}) {
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
