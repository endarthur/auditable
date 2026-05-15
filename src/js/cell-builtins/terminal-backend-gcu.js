// Default terminal backend: wraps @gcu/term's Terminal + DomRenderer + Input
// into the canonical TerminalHandle surface.
//
// @gcu/term-specific features (lineBuffer, onText, onBell, modes,
// onTitleChange, etc.) remain accessible via the handle's proxy fall-through
// to `handle.native`; cells using them accept @gcu/term coupling.

import { Terminal, DomRenderer, Input, LineBuffer } from '#term';
import { registerBackend, makeHandle } from './terminal-backend.js';

function createGcuTermBackend(opts, container) {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const cssVarTheme = opts.cssVarTheme ?? true;
  const maxScrollback = opts.maxScrollback ?? 1000;
  // Default ON in the cell builtin (off in the underlying library).
  // Notebook authors get the friendlier Windows-Terminal / iTerm2 UX
  // without thinking about it; explicit { copyOnSelect: false } opts out.
  const copyOnSelect = opts.copyOnSelect ?? true;

  // Mount host markup. Class names match what term.css selects on.
  const host = document.createElement('div');
  host.className = 'termhost';
  const screen = document.createElement('div');
  screen.className = 'screen';
  screen.setAttribute('role', 'log');
  screen.setAttribute('aria-live', 'polite');
  screen.setAttribute('aria-atomic', 'false');
  const hidden = document.createElement('textarea');
  hidden.setAttribute('autocapitalize', 'off');
  hidden.setAttribute('autocorrect', 'off');
  hidden.setAttribute('spellcheck', 'false');
  host.appendChild(screen);
  host.appendChild(hidden);
  container.appendChild(host);

  const term = new Terminal(cols, rows, { maxScrollback });
  const renderer = new DomRenderer(term, screen, { cssVarTheme });
  const input = new Input(term, screen, hidden, renderer, { copyOnSelect });

  // Cursor blink + dirty-frame loop. One requestAnimationFrame per
  // terminal — cheap, and stops on dispose. ~530ms is the standard cadence.
  let lastBlink = performance.now();
  let stopped = false;
  function tick(now) {
    if (stopped) return;
    if (now - lastBlink > 530) {
      renderer.cursorOn = !renderer.cursorOn;
      lastBlink = now;
      term.dirty = true;
    }
    if (term.dirty) {
      try { renderer.render(); }
      catch (_) { stopped = true; return; }
      term.dirty = false;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Wire optional onData callback so the cell author can pass it inline.
  if (typeof opts.onData === 'function') term.onData(opts.onData);

  // Convenience: `lb = term.lineBuffer({prompt, onSubmit})`. Lives on the
  // native Terminal so the proxy's fall-through finds it. @gcu/term-specific
  // — xterm.js handles line discipline differently and would not expose this.
  term.lineBuffer = (lbOpts) => new LineBuffer(term, lbOpts);

  let disposed = false;
  const resizeListeners = [];

  const canonical = {
    backendType: 'gcu-term',
    get native() { return term; },
    get rows() { return term.rows; },
    get cols() { return term.cols; },

    write(data) { term.write(data); },

    // Canonical onInput: subscribe to user input (decoded as string).
    // For @gcu/term, this is `onText` (which decodes the outbound byte stream).
    onInput(cb) { return term.onText(cb); },

    onResize(cb) {
      resizeListeners.push(cb);
      return () => {
        const i = resizeListeners.indexOf(cb);
        if (i >= 0) resizeListeners.splice(i, 1);
      };
    },

    focus() { hidden.focus(); },

    // Clear visible screen + home cursor (CSI 2J then CSI H).
    clear() { term.write('\x1b[2J\x1b[H'); },

    // Full reset (ESC c, "RIS").
    reset() { term.write('\x1bc'); },

    resize(newRows, newCols) {
      term.resize(newCols, newRows);
      try { renderer.resize(); } catch (_) {}
      for (const cb of resizeListeners) {
        try { cb({ rows: newRows, cols: newCols }); } catch (_) {}
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopped = true;
      try { input.dispose(); } catch (_) {}
      try { renderer.dispose(); } catch (_) {}
      try { host.remove(); } catch (_) {}
      try { term.dispose(); } catch (_) {}
      resizeListeners.length = 0;
    },
  };

  return makeHandle(canonical, term);
}

registerBackend('gcu-term', createGcuTermBackend);

export { createGcuTermBackend };
