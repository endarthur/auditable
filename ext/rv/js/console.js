// Terminal console — xterm.js wrapper

function createConsole(el) {
  const inputQueue = [];
  let term = null;
  let fitAddon = null;
  let buf = '';
  let flushTimer = null;

  function init() {
    if (term) return;
    term = new Terminal({
      scrollback: 2000,
      convertEol: false,
      cursorBlink: true,
      theme: {
        background: '#1a1a1a',
        foreground: '#c8c8c8',
        cursor: '#c89b3c',
        selectionBackground: '#c89b3c44'
      }
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    requestAnimationFrame(() => fitAddon.fit());
    term.onData(data => {
      for (let i = 0; i < data.length; i++) inputQueue.push(data.charCodeAt(i));
    });
    term.onBinary(data => {
      for (let i = 0; i < data.length; i++) inputQueue.push(data.charCodeAt(i));
    });
    window.addEventListener('resize', () => { if (fitAddon) fitAddon.fit(); });
  }

  function flush() {
    if (!buf || !term) return;
    term.write(buf);
    buf = '';
    flushTimer = null;
  }

  function onTx(ch) {
    buf += String.fromCharCode(ch);
    if (!flushTimer) flushTimer = setTimeout(flush, 4);
  }

  return {
    onTx,
    inputQueue,
    init,
    clear() { if (term) term.reset(); buf = ''; },
    flush,
    get term() { return term; },
    fit() { if (fitAddon) fitAddon.fit(); }
  };
}
