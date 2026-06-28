// moncad — bootstrap. Wires the WebGL2 renderer + the frame-aware viewport + the
// Canvas2D overlay + the command-registry spine + its surfaces (toolbar, palette) into a
// running board over a live WORKING MODEL (a @gcu/dxf-shaped Document). Opens real DXF,
// draws polylines with snapped clicks + a rubber-band, and saves the model back to DXF.
// Precision input, the command line, and snap-control come next (SPEC §7, §10).

import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { Overlay } from './overlay.js';
import { CommandRegistry } from './commands.js';
import { sceneFromDxf } from './scene.js';
import { makeToolbar, makePalette, makeCommandLine, makeSnapChips } from './surfaces.js';
import { SnapIndex } from './snap.js';
import { Model } from './model.js';
import { TOOLS } from './tools.js';
import { parsePoint } from './input.js';
import { SnapState, pickSnap, SNAP_TYPES, SNAP_LABELS, OVERRIDE_WORDS } from './snap-control.js';

import { makeFrame, toWorld } from '@gcu/frame';
import { read, write, explode } from '@gcu/dxf';

const $ = (s) => document.querySelector(s);

// ── demo model: real @gcu/dxf features in a UTM frame, so there's geometry to snap to
// and draw against (a rectangle, a diagonal, a centre node). Authored in local coords,
// stored world-canonical — same contract a drawn or opened feature obeys. ───────────────
function demoModel() {
  const frame = makeFrame({ origin: [600000, 7700000, 0], crs: 'EPSG:31983', units: 'm' });
  const o = frame.origin, W = (lx, ly) => [o[0] + lx, o[1] + ly, 0];
  const rect = [[-40, -25], [40, -25], [40, 25], [-40, 25]];
  const rv = new Float64Array(rect.length * 3);
  rect.forEach((p, i) => { const w = W(p[0], p[1]); rv[i * 3] = w[0]; rv[i * 3 + 1] = w[1]; rv[i * 3 + 2] = 0; });
  const a = W(-40, -25), b = W(40, 25), c = W(0, 0);
  const features = [
    { type: 'polyline', geometry: { kind: 'polyline', vertices: rv, bulges: null, closed: true }, properties: { layer: '0', color: { mode: 'aci', index: 7 } } },
    { type: 'line', geometry: { kind: 'polyline', vertices: Float64Array.from([a[0], a[1], 0, b[0], b[1], 0]), bulges: null, closed: false }, properties: { layer: '0', color: { mode: 'aci', index: 1 } } },
    { type: 'point', geometry: { kind: 'point', position: c }, properties: { layer: '0' } },
  ];
  const m = new Model({ frame, layers: {}, blocks: {}, features, warnings: [] });
  m.name = 'demo';
  return m;
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

  let model = null, frame = null;
  const view = new Viewport();
  const renderer = new Renderer(gl);
  const overlay = new Overlay(olCanvas.getContext('2d'));
  let bounds = { min: [-100, -100], max: [100, 100] };
  let snapIndex = new SnapIndex([]);
  let activeTool = null;
  let lastMouse = null;  // last cursor position (device px) — anchors a typed-point's rubber-band
  let cycleIdx = 0;      // Tab-cycle index into the eligible snap candidates at the cursor
  const snap = loadSnap();   // the SnapState: master + running types + aperture + one-shot

  let pending = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderer.draw(view); overlay.draw(view); });
  };

  // Push the model's derived view (renderer buffers + snap index) — the canonical→derived
  // step (SPEC §4). `fit` reframes the camera (open / new); a bare edit keeps the view.
  function derive(fit) {
    const sc = sceneFromDxf(model.doc);
    frame = sc.frame;
    bounds = (sc.lines.length || sc.points.length) ? sc.bounds : { min: [-50, -50], max: [50, 50] };
    snapIndex = new SnapIndex(sc.snaps || []);
    renderer.setLines(sc.lines);
    renderer.setPoints(sc.points);
    $('#frameInfo').textContent = `${frame.crs || '—'} · origin ${Math.round(frame.origin[0])},${Math.round(frame.origin[1])}`;
    if (fit) view.fit(bounds);
    render();
  }

  function loadModel(m, fit = true) {
    cancelTool();
    model = m;
    derive(fit);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = board.clientWidth, h = board.clientHeight;
    for (const c of [glCanvas, olCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
    view.resize(glCanvas.width, glCanvas.height, dpr);
    render();
  }

  const setStatus = (t) => { $('#status').textContent = t; };

  // ── open / save real DXF ─────────────────────────────────────────────────────────
  const fileInput = $('#fileInput');
  async function openDxf(file) {
    try {
      const doc = explode(read(await file.text()));
      if (!doc.features.length) { setStatus('no geometry in that DXF'); return; }
      const m = new Model(doc); m.name = file.name.replace(/\.dxf$/i, '');
      loadModel(m);
      ctx.hasDoc = true; toolbar.refresh();
      setStatus(`${file.name} · ${doc.features.length} features · ${doc.warnings.length} warnings`);
    } catch (e) { setStatus('DXF read failed: ' + e.message); }
  }
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) openDxf(fileInput.files[0]); fileInput.value = ''; });

  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function saveDxf() {
    try { download((model.name || 'drawing') + '.dxf', write(model.doc), 'application/dxf'); setStatus(`saved ${model.features.length} features`); }
    catch (e) { setStatus('DXF save failed: ' + e.message); }
  }

  // ── tool lifecycle — one drive loop, any tool ────────────────────────────────────
  function refreshPrompt() { cmdline.setPrompt(activeTool ? activeTool.prompt : 'Command:'); }
  function startTool(name) {
    const make = TOOLS[name]; if (!make) return;
    cancelTool();
    activeTool = make({
      frame,
      onCommit: (f) => { model.add(f); derive(false); },
      onDone: () => endTool(),
    });
    refreshPrompt();
    cmdline.focus();          // the command line is live the moment a tool starts — type or click
    render();
  }
  function endTool() { activeTool = null; overlay.setRubber(null); refreshPrompt(); cmdline.blur(); render(); }
  function cancelTool() { if (activeTool) activeTool.cancel(); }   // → onDone → endTool

  // the local point under the cursor, snapped per the SnapState (master / running types /
  // one-shot override), with Tab cycling the eligible candidates. count drives the ⇥ hint.
  function snapAt(s) {
    const local = view.toWorld(s);
    const { live, allowed } = snap.resolve();
    if (!live) return { local, hit: null, count: 0 };
    const cands = snapIndex.queryAll(local, snap.aperture * view.dpr / view.scale);
    const { hit, count } = pickSnap(cands, allowed, cycleIdx);
    return { local: hit ? hit.p : local, hit, count };
  }
  function placePoint(s) {
    const { local } = snapAt(s);
    activeTool.point(local);          // may auto-finish (line/circle) → endTool nulls activeTool
    consumeOneShot();
    refreshPrompt();
    if (activeTool) { updateRubber(s); cmdline.focus(); }
    render();
  }
  // project the tool's local rubber-band geometry (from a screen cursor) to the overlay
  function updateRubber(s) {
    if (!activeTool) { overlay.setRubber(null); return; }
    const { local } = s ? snapAt(s) : { local: null };
    const g = activeTool.preview(local);
    overlay.setRubber({
      lines: g.lines.map(([a, b]) => [view.toScreen(a), view.toScreen(b)]),
      points: g.points.map((p) => view.toScreen(p)),
    });
  }

  // ── the command line: a submitted line is a coordinate, a keyword, or a command ──
  function cmdSubmit(text) {
    const t = String(text).trim();
    if (activeTool) {
      if (t === '') { activeTool.finish(); return; }                                  // Enter on empty → finish
      const ov = OVERRIDE_WORDS[t.toLowerCase()];                                     // one-shot snap override (cen / end / non …)
      if (ov !== undefined) { snap.setOneShot(ov); setStatus(`snap once: ${t.toLowerCase()}`); refreshPrompt(); afterTypedPoint(); return; }
      if (activeTool.text && activeTool.text(t)) { refreshPrompt(); afterTypedPoint(); return; }   // tool scalar (circle radius)
      if (activeTool.keyword && activeTool.keyword(t.toLowerCase())) { refreshPrompt(); afterTypedPoint(); return; }
      const r = parsePoint(t, activeTool.last(), frame);                              // a coordinate
      if (r.ok) { activeTool.point(r.local); consumeOneShot(); refreshPrompt(); afterTypedPoint(); }
      else setStatus(r.error);
      if (activeTool) cmdline.focus();
      return;
    }
    if (!t) return;                                                                   // idle: run a command by id/alias/fuzzy
    const cmd = cmds.get(t) || (cmds.forAlias(t) && cmds.get(cmds.forAlias(t))) || cmds.search(t, ctx)[0];
    if (cmd) cmds.execute(cmd.id, ctx);
    else setStatus(`unknown command: ${t}`);
  }
  function cmdCancel() { if (activeTool) cancelTool(); else cmdline.blur(); }
  // refresh the rubber-band + render after a typed point (no mouse move to trigger it)
  function afterTypedPoint() { if (activeTool) { updateRubber(lastMouse); cmdline.focus(); } render(); }

  // ── snap-control (SPEC §7): master, per-type chips, one-shot override, cycle ──────
  function loadSnap() { try { return new SnapState(JSON.parse(localStorage.getItem('moncad.snap')) || {}); } catch { return new SnapState(); } }
  function persistSnap() { try { localStorage.setItem('moncad.snap', JSON.stringify(snap.serialize())); } catch { /* networkless / private mode: just don't persist */ } }
  function afterSnapChange() { persistSnap(); snapChips.refresh(); if (lastMouse) { readout(lastMouse, true); if (activeTool) updateRubber(lastMouse); } render(); }
  function toggleMaster() { snap.toggleMaster(); cycleIdx = 0; afterSnapChange(); }
  function toggleType(t) { snap.toggleType(t); cycleIdx = 0; afterSnapChange(); }
  function setAperture(px) { snap.setAperture(px); afterSnapChange(); }
  function cycleSnap() { cycleIdx++; if (lastMouse) { readout(lastMouse, true); if (activeTool) updateRubber(lastMouse); render(); } }
  function consumeOneShot() { if (snap.oneShot !== null) { snap.clearOneShot(); snapChips.refresh(); } }
  // F3 / Tab routed from the command line through the same registry the chips + keys use
  function commandLineKey(e) {
    if (e.key === 'F3') { cmds.execute('snap.toggle', ctx); return true; }
    if (e.key === 'Tab') { cmds.execute('snap.cycle', ctx); return true; }
    return false;
  }

  // ── the spine: commands, then the surfaces that view them ───────────────────────
  let palette;
  const ctx = { hasDoc: true };
  const cmds = new CommandRegistry().registerAll([
    { id: 'file.new', title: 'New Drawing', category: 'File', icon: 'New', run: () => { const m = new Model(); m.name = 'drawing'; loadModel(m); ctx.hasDoc = false; toolbar.refresh(); setStatus('new drawing'); } },
    { id: 'file.open', title: 'Open DXF…', category: 'File', icon: 'Open', keys: 'ctrl+o', run: () => fileInput.click() },
    { id: 'file.save', title: 'Save DXF…', category: 'File', icon: 'Save', keys: 'ctrl+s', run: () => saveDxf() },
    { id: 'file.demo', title: 'Load Demo', category: 'File', run: () => { loadModel(demoModel()); ctx.hasDoc = true; toolbar.refresh(); setStatus('demo model'); } },
    { id: 'draw.line', title: 'Line', category: 'Draw', icon: 'Line', keys: 'l', alias: ['l', 'line'], run: () => startTool('line') },
    { id: 'draw.polyline', title: 'Polyline', category: 'Draw', icon: 'Pline', keys: 'p', alias: ['p', 'pl', 'pline', 'polyline'], run: () => startTool('polyline') },
    { id: 'draw.circle', title: 'Circle', category: 'Draw', icon: 'Circle', keys: 'c', alias: ['c', 'ci', 'circle'], run: () => startTool('circle') },
    { id: 'draw.point', title: 'Point', category: 'Draw', icon: 'Point', alias: ['po', 'point', 'node'], run: () => startTool('point') },
    { id: 'edit.undo', title: 'Undo', category: 'Edit', keys: 'ctrl+z', run: () => { if (model.undo()) { derive(false); setStatus('undo'); } } },
    { id: 'edit.redo', title: 'Redo', category: 'Edit', keys: 'ctrl+y', run: () => { if (model.redo()) { derive(false); setStatus('redo'); } } },
    { id: 'view.zoomExtents', title: 'Zoom Extents', category: 'View', icon: 'Extents', keys: 'e', run: () => { view.fit(bounds); render(); } },
    { id: 'view.zoomIn', title: 'Zoom In', category: 'View', icon: '+', keys: '=', run: () => { view.zoomAt([view.width / 2, view.height / 2], 1.2); render(); } },
    { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', icon: '−', keys: '-', run: () => { view.zoomAt([view.width / 2, view.height / 2], 1 / 1.2); render(); } },
    { id: 'view.palette', title: 'Command Palette', category: 'View', icon: '⌘', keys: 'ctrl+p', run: () => palette.toggle() },
    { id: 'snap.toggle', title: 'Snapping (master)', category: 'Snap', keys: 'f3', run: () => toggleMaster() },
    { id: 'snap.end', title: 'Snap: Endpoint', category: 'Snap', alias: ['end', 'endp'], run: () => toggleType('end') },
    { id: 'snap.mid', title: 'Snap: Midpoint', category: 'Snap', alias: ['mid'], run: () => toggleType('mid') },
    { id: 'snap.center', title: 'Snap: Centre', category: 'Snap', alias: ['cen', 'centre'], run: () => toggleType('center') },
    { id: 'snap.node', title: 'Snap: Node', category: 'Snap', alias: ['nod'], run: () => toggleType('node') },
    { id: 'snap.cycle', title: 'Cycle Snap Candidate', category: 'Snap', keys: 'tab', run: () => cycleSnap() },
    { id: 'snap.apertureUp', title: 'Snap Aperture +', category: 'Snap', keys: ']', run: () => setAperture(snap.aperture + 2) },
    { id: 'snap.apertureDown', title: 'Snap Aperture −', category: 'Snap', keys: '[', run: () => setAperture(snap.aperture - 2) },
  ]);
  palette = makePalette(cmds, ctx, { root: $('#palette'), input: $('#palInput'), list: $('#palList') });
  const cmdline = makeCommandLine({ input: $('#cmdInput'), prompt: $('#cmdPrompt') }, { onSubmit: cmdSubmit, onCancel: cmdCancel, onKey: commandLineKey });
  const snapChips = makeSnapChips(cmds, ctx, $('#snapchips'), snap, SNAP_TYPES, SNAP_LABELS);
  const toolbar = makeToolbar(cmds, ctx, $('#toolbar'),
    ['file.new', 'file.open', 'file.save', null, 'draw.line', 'draw.polyline', 'draw.circle', 'draw.point', null, 'view.zoomExtents', 'view.zoomIn', 'view.zoomOut', null, 'view.palette']);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;       // the palette owns its own keys
    // an active tool claims Esc / Enter / Close / Undo; everything else (zoom, …) still fires
    if (activeTool) {
      if (e.key === 'Escape') { e.preventDefault(); cancelTool(); return; }
      if (e.key === 'Enter') { e.preventDefault(); activeTool.finish(); return; }
      const k = e.key.toLowerCase();
      if (!e.ctrlKey && !e.metaKey && (k === 'c' || k === 'u') && activeTool.keyword(k)) { e.preventDefault(); setStatus(activeTool.prompt); render(); return; }
    }
    const id = cmds.forKey(eventKey(e));
    if (id) { e.preventDefault(); cmds.execute(id, ctx); }
  });

  // ── input: place points (tool) / pan (drag) / zoom (wheel) / readout (move) ───────
  const devicePt = (e) => { const r = glCanvas.getBoundingClientRect(); return [(e.clientX - r.left) * view.dpr, (e.clientY - r.top) * view.dpr]; };
  let dragging = false, last = null;
  olCanvas.addEventListener('mousedown', (e) => {
    if (activeTool && e.button === 0) { placePoint(devicePt(e)); return; }   // left-click places; no pan mid-draw
    if (e.button !== 0 && e.button !== 1) return;
    dragging = true; last = devicePt(e); olCanvas.style.cursor = 'grabbing';
  });
  olCanvas.addEventListener('dblclick', (e) => { if (activeTool) { e.preventDefault(); activeTool.finish(); } });
  olCanvas.addEventListener('contextmenu', (e) => e.preventDefault());   // right-click is moncad's (the context-menu surface), not the browser's
  window.addEventListener('mouseup', () => { dragging = false; olCanvas.style.cursor = 'none'; });
  olCanvas.addEventListener('mousemove', (e) => {
    const s = devicePt(e); lastMouse = s; cycleIdx = 0;   // a new position restarts Tab-cycle from the best candidate
    if (dragging) { view.panBy(s[0] - last[0], s[1] - last[1]); last = s; }
    overlay.setCursor(s); readout(s, !dragging);
    if (activeTool && !dragging) updateRubber(s);
    render();
  });
  olCanvas.addEventListener('mouseleave', () => { overlay.setCursor(null); overlay.setSnap(null); render(); });
  olCanvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoomAt(devicePt(e), e.deltaY < 0 ? 1.1 : 1 / 1.1); readout(devicePt(e)); if (activeTool) updateRubber(devicePt(e)); render(); }, { passive: false });

  // the instrument panel: LOCAL math, WORLD (UTM) display — the precision point made visible.
  // The snap glyph + type come from the SnapState-resolved pick; ⇥ flags more candidates.
  function readout(s, snapEval = true) {
    if (!frame || !s) return;
    const r = snapEval ? snapAt(s) : { local: view.toWorld(s), hit: null, count: 0 };
    overlay.setSnap(r.hit ? view.toScreen(r.hit.p) : null, r.hit && r.hit.type);
    const world = toWorld(r.local, frame);
    $('#coords').textContent = `${world[0].toFixed(2)}  ${world[1].toFixed(2)}`;
    $('#snap').textContent = r.hit ? (r.hit.type + (r.count > 1 ? ' ⇥' : '')) : '';
    $('#zoom').textContent = `1 px ≈ ${(view.dpr / view.scale).toFixed(3)} ${frame.units}`;
  }

  // drag-and-drop a DXF anywhere on the board
  board.addEventListener('dragover', (e) => { e.preventDefault(); });
  board.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openDxf(f); });

  window.addEventListener('resize', resize);
  resize();
  loadModel(demoModel());
  setStatus('demo model · L to draw a polyline · Open or drag in a DXF');
}

boot();
