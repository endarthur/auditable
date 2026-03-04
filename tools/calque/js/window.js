// Floating editor window — drag, resize, minimize, persist

function createWindow() {
  const win = document.createElement('div');
  win.className = 'cq-window';
  win.id = 'cq-editor-win';

  win.innerHTML = `<div class="cq-win-tb">
<span class="cq-win-title">source</span>
<div class="cq-win-btns">
<button class="cq-win-btn" id="cq-win-min" title="minimize">\u2013</button>
<button class="cq-win-btn" id="cq-win-close" title="hide">\u00d7</button>
</div>
</div>
<div class="cq-win-body" id="cq-win-body"></div>
<div class="cq-win-resize" id="cq-win-resize"></div>`;

  document.body.appendChild(win);

  // Restore position from localStorage
  const saved = localStorage.getItem('cq-win-pos');
  if (saved) {
    try {
      const p = JSON.parse(saved);
      win.style.left = p.x + 'px';
      win.style.top = p.y + 'px';
      win.style.width = p.w + 'px';
      win.style.height = p.h + 'px';
    } catch(e) { setDefaultPos(win); }
  } else {
    setDefaultPos(win);
  }

  // Drag via titlebar
  const tb = win.querySelector('.cq-win-tb');
  let dragging = false, dx = 0, dy = 0;

  tb.addEventListener('mousedown', e => {
    if (e.target.closest('.cq-win-btn')) return;
    dragging = true;
    dx = e.clientX - win.offsetLeft;
    dy = e.clientY - win.offsetTop;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    win.style.left = (e.clientX - dx) + 'px';
    win.style.top = (e.clientY - dy) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; savePos(win); }
  });

  // Resize via handle
  const rh = win.querySelector('#cq-win-resize');
  let resizing = false;

  rh.addEventListener('mousedown', e => {
    resizing = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const w = Math.max(320, e.clientX - win.offsetLeft);
    const h = Math.max(180, e.clientY - win.offsetTop);
    win.style.width = w + 'px';
    win.style.height = h + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = false;
      savePos(win);
      if (CQ.editorView) CQ.editorView.requestMeasure();
    }
  });

  // Minimize
  const minBtn = win.querySelector('#cq-win-min');
  minBtn.addEventListener('click', () => {
    win.classList.toggle('minimized');
    if (!win.classList.contains('minimized') && CQ.editorView) {
      CQ.editorView.requestMeasure();
    }
  });

  // Close/hide
  const closeBtn = win.querySelector('#cq-win-close');
  closeBtn.addEventListener('click', () => {
    win.classList.add('hidden');
  });

  return win;
}

function setDefaultPos(win) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  win.style.width = Math.min(500, vw * 0.4) + 'px';
  win.style.height = (vh - 120) + 'px';
  win.style.left = (vw - Math.min(500, vw * 0.4) - 24) + 'px';
  win.style.top = '40px';
}

function savePos(win) {
  localStorage.setItem('cq-win-pos', JSON.stringify({
    x: win.offsetLeft, y: win.offsetTop,
    w: win.offsetWidth, h: win.offsetHeight,
  }));
}

function showEditorWindow() {
  const win = $('#cq-editor-win');
  if (win) {
    win.classList.remove('hidden');
    if (CQ.editorView) CQ.editorView.focus();
  }
}

function hideEditorWindow() {
  const win = $('#cq-editor-win');
  if (win) win.classList.add('hidden');
}

function isEditorVisible() {
  const win = $('#cq-editor-win');
  return win && !win.classList.contains('hidden');
}
