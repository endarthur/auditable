// Terminal cell builtin: ui.terminal({...}) mounts a @gcu/term Terminal
// (parser + state model) + DomRenderer (DOM cell grid) + Input (keyboard
// / mouse / paste) inside the cell's output. All four lifecycles are
// tied to the cell's invalidation promise so a re-run cleanly tears down
// the previous instance.
//
// The returned object is the Terminal itself with two extra methods
// monkey-patched on: `lineBuffer(opts)` returns a new LineBuffer bound
// to this terminal, and `dispose()` is overridden to also tear down
// renderer + input + tick loop.

import { Terminal, DomRenderer, Input, LineBuffer } from '#term';

export function makeTerminal(cell, ctx) {
  const { outputEl, invalidation } = ctx;

  return function terminal(opts = {}) {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const cssVarTheme = opts.cssVarTheme ?? true;
    const maxScrollback = opts.maxScrollback ?? 1000;
    // Default ON in the cell builtin (off in the underlying library).
    // Notebook authors get the friendlier Windows-Terminal / iTerm2 UX
    // without thinking about it; explicit { copyOnSelect: false } opts out.
    const copyOnSelect = opts.copyOnSelect ?? true;

    // Mount the host markup the renderer + input need. The container
    // class names match what term.css selects on (.termhost, .screen,
    // textarea inside .termhost).
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
    outputEl.appendChild(host);

    const term = new Terminal(cols, rows, { maxScrollback });
    const renderer = new DomRenderer(term, screen, { cssVarTheme });
    const input = new Input(term, screen, hidden, renderer, { copyOnSelect });

    // Cursor blink + dirty-frame loop. One requestAnimationFrame per
    // terminal — cheap, and stops on dispose. ~530ms is the standard
    // blink cadence.
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

    // Wire optional onData callback up-front so the cell author can pass
    // it inline rather than chaining .onData after construction.
    if (typeof opts.onData === 'function') term.onData(opts.onData);

    // Override dispose to tear down the full stack. The original Terminal
    // dispose just clears listeners + buffers; we also need renderer +
    // input + tick.
    const termDispose = term.dispose.bind(term);
    term.dispose = function () {
      stopped = true;
      try { input.dispose(); } catch (_) {}
      try { renderer.dispose(); } catch (_) {}
      try { host.remove(); } catch (_) {}
      termDispose();
    };

    // Convenience: lb = term.lineBuffer({ prompt, onSubmit, ... }).
    term.lineBuffer = (lbOpts) => new LineBuffer(term, lbOpts);

    // Auto-dispose on cell re-run. Single subscription per terminal.
    invalidation.then(() => term.dispose());

    return term;
  };
}
