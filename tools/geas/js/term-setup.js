// Terminal bootstrap — instantiate @gcu/term's Terminal + DomRenderer +
// Input, size the grid to the viewport, and drive the render loop.

// Measure one monospace cell so the grid columns/rows fit the window.
// A hidden probe inherits the .screen font (term-default.css), so the
// measurement matches what the renderer will actually paint.
function _measureCell() {
  const probe = document.createElement('div');
  probe.className = 'screen';
  probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre;';
  probe.textContent = 'X'.repeat(80);
  document.body.appendChild(probe);
  const cellW = probe.getBoundingClientRect().width / 80;
  probe.textContent = 'X';
  const cellH = probe.getBoundingClientRect().height;
  probe.remove();
  return { cellW, cellH };
}

function setupTerminal(termMod) {
  const { Terminal, DomRenderer, Input } = termMod;
  const screen = document.getElementById('screen');
  const hidden = document.getElementById('hidden');
  const wrap = document.getElementById('termwrap');

  const { cellW, cellH } = _measureCell();
  // Leave a little slack so the grid doesn't trip the wrap's scrollbar.
  const availW = wrap.clientWidth - 14;
  const availH = wrap.clientHeight - 14;
  const cols = Math.max(40, Math.min(220, Math.floor(availW / cellW) || 80));
  const rows = Math.max(12, Math.min(80,  Math.floor(availH / cellH) || 24));

  const terminal = new Terminal(cols, rows);
  const renderer = new DomRenderer(terminal, screen);
  const input = new Input(terminal, screen, hidden, renderer);

  // Render tick: blink the cursor at 530 ms, repaint when the model
  // marks itself dirty. requestAnimationFrame keeps it cheap when idle.
  let lastBlink = performance.now();
  function tick(now) {
    if (now - lastBlink > 530) {
      renderer.cursorOn = !renderer.cursorOn;
      lastBlink = now;
      terminal.dirty = true;
    }
    if (terminal.dirty) {
      try { renderer.render(); } catch { /* ignore a transient paint error */ }
      terminal.dirty = false;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Keep keyboard focus on the hidden textarea — that's where @gcu/term's
  // Input layer reads keystrokes from. Clicking the screen refocuses it.
  hidden.focus();
  screen.addEventListener('mousedown', () => {
    setTimeout(() => hidden.focus(), 0);
  });

  GS.terminal = terminal;
  GS.renderer = renderer;
  GS.input = input;
  return terminal;
}
