// xterm.js adapter — implements the GeasTerminal interface on top of an
// `xterm.js` Terminal instance. xterm.js is the industry-standard browser
// terminal (used by VS Code, koma, Hyper, …); the adapter exists so geas
// runs in any host that already vendors it.
//
// Usage:
//
//   import { Terminal as XtermTerminal } from 'xterm';
//   import { createXtermAdapter } from '@gcu/geas/adapters/xterm';
//
//   const term = new XtermTerminal({ cols: 80, rows: 24 });
//   term.open(screenEl);
//   const adapter = createXtermAdapter({ terminal: term });
//
//   const client = createGeasClient({ worker, vfs, ...adapterHooks(adapter) });
//
// v0 capability: richBlocks=false. xterm.js renders to a Canvas/WebGL grid
// with no built-in inline-DOM-block surface, so typed pipe output degrades
// via block.text — matching @gcu/term's behaviour. (xterm.js extensions
// exist for "addons" that could host inline widgets; defer that integration
// until someone reaches for it.)

export function createXtermAdapter(opts) {
  const { terminal } = opts || {};
  if (!terminal) throw new Error('createXtermAdapter: opts.terminal is required');
  return {
    write(text) {
      terminal.write(typeof text === 'string' ? text : String(text ?? ''));
    },
    writeBlock(block) {
      if (block && typeof block.text === 'string') {
        terminal.write(block.text);
      } else {
        try { terminal.write(JSON.stringify(block)); }
        catch { terminal.write(String(block)); }
      }
    },
    onInput(cb) {
      // xterm.js: onData returns a disposable with .dispose().
      const sub = terminal.onData(cb);
      return () => { try { sub.dispose(); } catch { /* ignore */ } };
    },
    size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    onResize(cb) {
      // xterm.js fires onResize when fit / resize is called; wrap to match
      // our {cols, rows} payload shape.
      const sub = terminal.onResize((e) => cb({ cols: e.cols, rows: e.rows }));
      return () => { try { sub.dispose(); } catch { /* ignore */ } };
    },
    clear() {
      // xterm.js has a clear() method that wipes scrollback.
      if (typeof terminal.clear === 'function') terminal.clear();
      else terminal.write('\x1b[2J\x1b[H');
    },
    caps() {
      return { richBlocks: false };
    },
  };
}

// adapterHooks is defined once in adapters/term.js — import from there.
// (Both adapters expose the same shape, so a single helper suffices.)
