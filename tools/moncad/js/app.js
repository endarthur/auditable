// moncad — bootstrap. Wires the WebGL2 renderer + the frame-aware viewport + the
// Canvas2D overlay + the command-registry spine + its surfaces (toolbar, palette) into a
// running board, and opens real DXF through @gcu/dxf. Draw tools, snapping, and the
// menubar/command-line come next.

import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { Overlay } from './overlay.js';
import { CommandRegistry } from './commands.js';
import { sceneFromDxf } from './scene.js';
import { makeToolbar, makePalette } from './surfaces.js';
import { makeFrame, toWorld } from '@gcu/frame';
import { read, explode } from '@gcu/dxf';

const $ = (s) => document.querySelector(s);

// ── demo scene (local coords; a UTM frame supplies the world readout) ──────────────
function buildDemo() {
  const L = [], P = [];
  const seg = (a, b, w, c) => L.push(a[0], a[1], b[0], b[1], w, c[0], c[1], c[2], c[3]);
  const pt = (p, s, c) => P.push(p[0], p[1], s, c[0], c[1], c[2], c[3]);
  const GRID = [0.17, 0.17, 0.17, 1], AXIS = [0.40, 0.40, 0.40, 1];
  const GEO = [0.82, 0.82, 0.84, 1], ACC = [0.84, 0.47, 0.23, 1], PT = [0.42, 0.63, 0.81, 1];
  for (let i = -100; i <= 100; i += 10) { seg([i, -100], [i, 100], 1, GRID); seg([-100, i], [100, i], 1, GRID); }
  seg([-100, 0], [100, 0], 1.5, AXIS); seg([0, -100], [0, 100], 1.5, AXIS);
  const r = [[-40, -25], [40, -25], [40, 25], [-40, 25]];
  for (let i = 0; i < 4; i++) seg(r[i], r[(i + 1) % 4], 2, GEO);
  seg(r[0], r[2], 1.5, ACC);
  for (const v of r) pt(v, 7, PT);
  pt([0, 0], 5, ACC);
  return {
    frame: makeFrame({ origin: [600000, 7700000, 0], crs: 'EPSG:31983', units: 'm' }),
    lines: new Float32Array(L), points: new Float32Array(P), bounds: { min: [-100, -100], max: [100, 100] },
  };
}

// keystroke → the registry's normalized form
function eventKey(e) {
  const m = [];
  if (e.ctrlKey) m.push('ctrl'); if (e.altKey) m.push('alt'); if (e.shiftKey) m.push('shift'); if (e.metaKey) m.push('meta');
  let k = e.key.toLowerCase();
  if (k === ' ') k = 'space'; if (k === '+') k = '='; if (k === 'escape') k = 'esc';
  return [...m, k].join('+');
}

function boot() {
  const glCanvas = $('#gl'), olCanvas = $('#overlay'), board = $('#board');
  const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) { $('#nogl').style.display = 'flex'; return; }

  let frame = null;
  const view = new Viewport();
  const renderer = new Renderer(gl);
  const overlay = new Overlay(olCanvas.getContext('2d'));
  let bounds = { min: [-100, -100], max: [100, 100] };

  let pending = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderer.draw(view); overlay.draw(view); });
  };

  function setScene(sc, fit = true) {
    frame = sc.frame;
    bounds = sc.bounds;
    renderer.setLines(sc.lines);
    renderer.setPoints(sc.points);
    $('#frameInfo').textContent = `${frame.crs || '—'} · origin ${Math.round(frame.origin[0])},${Math.round(frame.origin[1])}`;
    if (fit) view.fit(bounds);
    render();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = board.clientWidth, h = board.clientHeight;
    for (const c of [glCanvas, olCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
    view.resize(glCanvas.width, glCanvas.height, dpr);
    render();
  }

  // open a DXF file → read → explode → scene → render, adopting its frame
  const fileInput = $('#fileInput');
  async function openDxf(file) {
    try {
      const doc = explode(read(await file.text()));
      const sc = sceneFromDxf(doc);
      if (!sc.lines.length && !sc.points.length) { setStatus('no drawable geometry in that DXF'); return; }
      setScene(sc);
      ctx.hasDoc = true; toolbar.refresh();
      setStatus(`${file.name} · ${(sc.lines.length / 9) | 0} segments · ${doc.warnings.length} warnings`);
    } catch (e) { setStatus('DXF read failed: ' + e.message); }
  }
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) openDxf(fileInput.files[0]); fileInput.value = ''; });
  const setStatus = (t) => { $('#status').textContent = t; };

  // ── the spine: commands, then the surfaces that view them ───────────────────────
  let palette;
  const ctx = { hasDoc: false };
  const cmds = new CommandRegistry().registerAll([
    { id: 'file.open', title: 'Open DXF…', category: 'File', icon: 'Open', keys: 'ctrl+o', run: () => fileInput.click() },
    { id: 'file.demo', title: 'Load Demo Scene', category: 'File', run: () => { setScene(buildDemo()); ctx.hasDoc = false; toolbar.refresh(); setStatus('demo scene'); } },
    { id: 'view.zoomExtents', title: 'Zoom Extents', category: 'View', icon: 'Extents', keys: 'e', run: () => { view.fit(bounds); render(); } },
    { id: 'view.zoomIn', title: 'Zoom In', category: 'View', icon: '+', keys: '=', run: () => { view.zoomAt([view.width / 2, view.height / 2], 1.2); render(); } },
    { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', icon: '−', keys: '-', run: () => { view.zoomAt([view.width / 2, view.height / 2], 1 / 1.2); render(); } },
    { id: 'view.palette', title: 'Command Palette', category: 'View', icon: '⌘', keys: 'ctrl+p', run: () => palette.toggle() },
  ]);
  palette = makePalette(cmds, ctx, { root: $('#palette'), input: $('#palInput'), list: $('#palList') });
  const toolbar = makeToolbar(cmds, ctx, $('#toolbar'),
    ['file.open', null, 'view.zoomExtents', 'view.zoomIn', 'view.zoomOut', null, 'view.palette']);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;       // the palette owns its own keys
    const id = cmds.forKey(eventKey(e));
    if (id) { e.preventDefault(); cmds.execute(id, ctx); }
  });

  // ── input: pan (drag), zoom (wheel), readout (move) ──────────────────────────────
  const devicePt = (e) => { const r = glCanvas.getBoundingClientRect(); return [(e.clientX - r.left) * view.dpr, (e.clientY - r.top) * view.dpr]; };
  let dragging = false, last = null;
  olCanvas.addEventListener('mousedown', (e) => { dragging = true; last = devicePt(e); olCanvas.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', () => { dragging = false; olCanvas.style.cursor = 'none'; });
  olCanvas.addEventListener('mousemove', (e) => {
    const s = devicePt(e);
    if (dragging) { view.panBy(s[0] - last[0], s[1] - last[1]); last = s; }
    overlay.setCursor(s); readout(s); render();
  });
  olCanvas.addEventListener('mouseleave', () => { overlay.setCursor(null); render(); });
  olCanvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoomAt(devicePt(e), e.deltaY < 0 ? 1.1 : 1 / 1.1); readout(devicePt(e)); render(); }, { passive: false });

  // the instrument panel: LOCAL math, WORLD (UTM) display — the precision point made visible
  function readout(s) {
    if (!frame) return;
    const world = toWorld(view.toWorld(s), frame);
    $('#coords').textContent = `${world[0].toFixed(2)}  ${world[1].toFixed(2)}`;
    $('#zoom').textContent = `1 px ≈ ${(view.dpr / view.scale).toFixed(3)} ${frame.units}`;
  }

  // drag-and-drop a DXF anywhere on the board
  board.addEventListener('dragover', (e) => { e.preventDefault(); });
  board.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openDxf(f); });

  window.addEventListener('resize', resize);
  resize();
  setScene(buildDemo());
  setStatus('demo scene · Open a DXF, or drag one in');
}

boot();
