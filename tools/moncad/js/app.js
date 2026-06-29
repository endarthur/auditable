// moncad — bootstrap. Wires the WebGL2 renderer + the frame-aware viewport + the
// Canvas2D overlay + the command-registry spine + its surfaces (toolbar, palette) into a
// running board over a live WORKING MODEL (a @gcu/dxf-shaped Document). Opens real DXF,
// draws polylines with snapped clicks + a rubber-band, and saves the model back to DXF.
// Precision input, the command line, and snap-control come next (SPEC §7, §10).

import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { Overlay } from './overlay.js';
import { CommandRegistry } from './commands.js';
import { sceneFromDxf, localSegments, placeInstance } from './scene.js';
import { makeToolbar, makePalette, makeCommandLine, makeSnapChips, makeContextMenu, makeMenubar, makeLayersPanel } from './surfaces.js';
import { SnapIndex } from './snap.js';
import { Model, LAYER_PALETTE } from './model.js';
import { TOOLS } from './tools.js';
import { parsePoint } from './input.js';
import { SnapState, pickSnap, SNAP_TYPES, SNAP_LABELS, OVERRIDE_WORDS } from './snap-control.js';
import { pickFeature, pickWindow } from './pick.js';
import { makeEditTool } from './edit-ops.js';
import { computeGrid, snapToGrid } from './grid.js';
import { featuresToTable, tableToCsv, sridFromCrs } from './feature-export.js';

import { makeFrame, toWorld } from '@gcu/frame';
import { read, write, explode } from '@gcu/dxf';
import { stringify as wktStringify } from '@gcu/wkt';
import { translate, rotate, mirror, scale as rScale, circle as rCircle, spanCurve, trim, extend, fillet, chamfer, filletCorner, chamferCorner, offset, makeTolerance } from '@gcu/regula';

// ── geometry bridge: @gcu/dxf feature geometry (flat WORLD vertices) ↔ @gcu/regula ──
const geomToPath = (g) => {
  const v = g.vertices, n = v.length / 3, points = [];
  for (let i = 0; i < n; i++) points.push([v[i * 3], v[i * 3 + 1]]);
  return { points, bulges: g.bulges ? Array.from(g.bulges) : null, closed: g.closed };
};
const pathToGeom = (path, z = 0) => {
  const n = path.points.length, vertices = new Float64Array(n * 3);
  path.points.forEach((p, i) => { vertices[i * 3] = p[0]; vertices[i * 3 + 1] = p[1]; vertices[i * 3 + 2] = z; });
  const bulges = path.bulges && path.bulges.some((b) => b) ? Float64Array.from(path.bulges) : null;
  return { kind: 'polyline', vertices, bulges, closed: path.closed };
};
// Build an edited feature from a path, keeping the proto's properties but setting `type`
// to MATCH the geometry — the DXF writer dispatches on type, so a multi-vertex/bulge
// result must be 'polyline', not a leftover 'line' (which would emit only 2 points).
const featureFromPath = (proto, path, z = 0) => {
  const geometry = pathToGeom(path, z);
  const type = path.points.length === 2 && !geometry.bulges && !geometry.closed ? 'line' : 'polyline';
  return { ...proto, type, geometry };
};
// A feature's geometry → kernel curves, for use as trim/extend cutters.
const featureCurves = (g) => {
  if (!g) return [];
  if (g.kind === 'circle') return [rCircle([g.center[0], g.center[1]], g.radius)];
  if (g.kind !== 'polyline') return [];
  const v = g.vertices, n = v.length / 3, nspan = g.closed ? n : n - 1, out = [];
  for (let i = 0; i < nspan; i++) {
    const j = (i + 1) % n, b = g.bulges ? (g.bulges[i] || 0) : 0;
    out.push(spanCurve([v[i * 3], v[i * 3 + 1]], [v[j * 3], v[j * 3 + 1]], b));
  }
  return out;
};

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
  const selection = new Set();   // selected feature indices (the edit target)
  const SELECT_PX = 8;       // pick aperture, CSS px
  let activeLayer = '0';     // new geometry lands on this layer
  let layersOpen = true;     // the layers panel (right dock)
  // hidden OR locked layer geometry is unpickable (hidden is also off the board; locked stays
  // visible but can't be selected/edited)
  const layerSkip = (f) => { const L = model.getLayer(f.properties && f.properties.layer); return !!(L && (!L.visible || L.locked)); };
  const pickAt = (world) => pickFeature(model.features, world, SELECT_PX * view.dpr / view.scale, layerSkip, model.doc.blocks);
  // Local segments of a geometry, expanding an INSERT to its placed block body (for the edit ghost).
  const instanceSegments = (g) => {
    if (g.kind !== 'insert') return localSegments(g, frame.origin, tessEps);
    const blk = model.doc.blocks && model.doc.blocks[g.block]; if (!blk) return [];
    const out = []; for (const bf of blk.features) for (const s of instanceSegments(placeInstance(bf.geometry, g.transform, blk.base))) out.push(s);
    return out;
  };
  const corner = { fillet: 10, chamfer: 10 };   // current fillet radius / chamfer distance
  let offsetDist = 5;        // current offset distance (side comes from which side you click)
  let textHeight = 2.5;      // current TEXT height (world units)
  let gridOn = true, gridStep = 1;   // reference grid (View → Grid, g); gridStep feeds grid-snap
  const EMPTY = new Float32Array(0);
  const TESS_PX = 0.5;               // target arc/circle chord error, device px (screen-adaptive tessellation)
  let lastDeriveScale = 1, tessEps = 0.2;
  let lastDerivedModel = null, lastDerivedRev = -1;   // gate the SnapIndex rebuild: only on a real edit (new model / bumped rev), not a zoom re-derive

  // recompute the adaptive grid for the current view — but only when the view actually changed
  // (it's keyed on scale+centre+size, so a static-view redraw, e.g. a hover, skips the rebuild
  // + GPU upload entirely; the grid only moves on pan/zoom).
  let gridKey = '';
  function applyGrid() {
    if (!gridOn) { if (gridKey !== '·off') { renderer.setGrid(EMPTY); gridKey = '·off'; } return; }
    const key = view.scale + '|' + view.center[0] + '|' + view.center[1] + '|' + view.width + '|' + view.height;
    if (key === gridKey) return;
    gridKey = key;
    const g = computeGrid(view); renderer.setGrid(g.lines); gridStep = g.step;
  }

  let pending = false, hoverDirty = false;
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (hoverDirty) { hoverDirty = false; refreshHover(lastMouse); }   // the pick/hover, coalesced to ONE per frame (was per mousemove event)
      applyGrid(); renderer.draw(view); overlay.draw(view);
    });
  };
  // The per-frame interactive update: the tool rubber-band + the hover highlight — i.e. the
  // O(features) pick scan. Run from render()'s rAF (once a frame) instead of synchronously per
  // mousemove, so rapid movement doesn't fire many brute-force scans before the next paint.
  function refreshHover(s) {
    if (!s || panning || selecting) { overlay.setHighlight(null); return; }
    if (activeTool) { updateRubber(s); updateHover(s); }
    else updateSelectHover(s);
  }

  // Push the model's derived view (renderer buffers + snap index) — the canonical→derived
  // step (SPEC §4). `fit` reframes the camera (open / new); a bare edit keeps the view.
  function derive(fit) {
    if (fit) {   // a coarse pass just for bounds, fit, THEN tessellate at the fit scale (below)
      const pre = sceneFromDxf(model.doc, { eps: 1 });
      view.fit((pre.lines.length || pre.points.length) ? pre.bounds : { min: [-50, -50], max: [50, 50] });
    }
    const eps = Math.max(1e-6, TESS_PX * view.dpr / view.scale);   // chord error sub-pixel at this zoom
    const sc = sceneFromDxf(model.doc, { selected: selection, eps });
    frame = sc.frame;
    bounds = (sc.lines.length || sc.points.length) ? sc.bounds : { min: [-50, -50], max: [50, 50] };
    if (model !== lastDerivedModel || model.rev !== lastDerivedRev) {   // snap points only change on a model EDIT, not on a zoom re-tessellation → skip the index rebuild then
      snapIndex = new SnapIndex(sc.snaps || []); lastDerivedModel = model; lastDerivedRev = model.rev;
    }
    renderer.setLines(sc.lines);
    renderer.setPoints(sc.points);
    overlay.setTexts(sc.texts || []);
    $('#frameInfo').textContent = `${frame.crs || '—'} · origin ${Math.round(frame.origin[0])},${Math.round(frame.origin[1])}`;
    tessEps = eps; lastDeriveScale = view.scale;
    render();
  }
  // re-tessellate (curves stay smooth) when zoom crosses a threshold; otherwise just redraw
  function zoomed() { const r = view.scale / lastDeriveScale; if (r > 1.4 || r < 0.71) derive(false); else render(); }

  function loadModel(m, fit = true) {
    cancelTool();
    selection.clear();
    model = m;
    setActiveLayer('0');
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
      ctx.hasDoc = true; tools.refresh();
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
  // The drawing→table data bridge: selection (or all) → a feature table (wkt column +
  // attribute columns) as CSV, the GeoPandas/PostGIS-friendly form. Block instances → POINT
  // + their attributes; arcs/circles tessellated; SRID from the frame's CRS (EWKT).
  function exportFeatureTable() {
    const feats = selection.size ? [...selection].sort((a, b) => a - b).map((i) => model.features[i]) : model.features;
    const srid = sridFromCrs(frame.crs);
    const table = featuresToTable(feats, { stringify: wktStringify, ...(srid != null ? { srid } : {}) });
    if (!table.rows.length) { setStatus('nothing to export (points / lines / areas / blocks)'); return; }
    try { download((model.name || 'drawing') + '-features.csv', tableToCsv(table), 'text/csv'); setStatus(`exported ${table.rows.length} features → CSV (wkt${srid != null ? `, SRID ${srid}` : ''})`); }
    catch (e) { setStatus('export failed: ' + e.message); }
  }

  // ── tool lifecycle — one drive loop, any tool ────────────────────────────────────
  function refreshPrompt() { cmdline.setPrompt(activeTool ? activeTool.prompt : 'Command:'); }
  function startTool(name) {
    const make = TOOLS[name]; if (!make) return;
    cancelTool();
    activeTool = make({
      frame,
      onCommit: (f) => { f.properties.layer = activeLayer; model.add(f); derive(false); },   // drawn geometry lands on the current layer
      onDone: () => endTool(),
    });
    refreshPrompt();
    cmdline.focus();          // the command line is live the moment a tool starts — type or click
    render();
  }
  function endTool() { activeTool = null; overlay.setRubber(null); overlay.setHighlight(null); refreshPrompt(); cmdline.blur(); render(); }
  function cancelTool() { if (activeTool) activeTool.cancel(); }   // → onDone → endTool

  // the local point under the cursor, snapped per the SnapState (master / running types /
  // one-shot override), with Tab cycling the eligible candidates. count drives the ⇥ hint.
  function snapAt(s) {
    const local = view.toWorld(s);
    const tol = snap.aperture * view.dpr / view.scale;
    const { live, allowed } = snap.resolve();
    let hit = null, count = 0;
    if (live) { const r = pickSnap(snapIndex.queryAll(local, tol), allowed, cycleIdx); hit = r.hit; count = r.count; }
    if (!hit && snap.gridSnap) { const gp = snapToGrid(local, gridStep, tol); if (gp) hit = { p: gp, type: 'grid' }; }   // grid = a separate mode, object snaps win
    let p = hit ? hit.p : local;
    if (!hit && snap.ortho && activeTool && activeTool.last) {   // ortho: lock the free cursor to H/V from the anchor (snaps still win)
      const a = activeTool.last();
      if (a) p = Math.abs(p[0] - a[0]) >= Math.abs(p[1] - a[1]) ? [p[0], a[1]] : [a[0], p[1]];
    }
    return { local: p, hit, count };
  }
  function placePoint(s) {
    // rawPick tools (trim/extend/fillet/chamfer/offset) hit-test + edit in WORLD coords, so
    // give them the WORLD point (not the local one — they differ once the frame origin ≠ 0,
    // e.g. an opened UTM drawing); draw/affine tools work in LOCAL + convert on commit.
    const local = activeTool.rawPick ? pickWorld(s) : snapAt(s).local;
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
      const tm = activeTool.textMode && activeTool.textMode();
      if (tm && (t !== '' || (activeTool.acceptsEmpty && activeTool.acceptsEmpty()))) { activeTool.text(t); if (activeTool) cmdline.focus(); return; }   // raw text entry (empty only if the tool opts in)
      if (t === '') { activeTool.finish(); return; }                                  // Enter on empty → finish
      const ov = OVERRIDE_WORDS[t.toLowerCase()];                                     // one-shot snap override (cen / end / non …)
      if (ov !== undefined) { snap.setOneShot(ov); setStatus(`snap once: ${t.toLowerCase()}`); refreshPrompt(); afterTypedPoint(); return; }
      if (activeTool.text && activeTool.text(t)) { refreshPrompt(); afterTypedPoint(); return; }   // tool scalar (circle radius)
      if (activeTool.keyword && activeTool.keyword(t.toLowerCase())) { refreshPrompt(); afterTypedPoint(); return; }
      const r = parsePoint(t, activeTool.last(), frame);                              // a coordinate
      if (r.ok) { activeTool.point(activeTool.rawPick ? toWorld(r.local, frame) : r.local); consumeOneShot(); refreshPrompt(); afterTypedPoint(); }   // rawPick tools work in WORLD
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
  function toggleHelp(force) { $('#help').classList.toggle('show', force != null ? force : !$('#help').classList.contains('show')); }
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
    if (e.key === 'F8') { cmds.execute('snap.ortho', ctx); return true; }
    if (e.key === 'Tab') { cmds.execute('snap.cycle', ctx); return true; }
    return false;
  }

  // ── layers (the inspector surface): current layer, visibility, colour, opacity ────
  function setActiveLayer(name) { activeLayer = name; $('#activeLayer').textContent = 'layer: ' + name; layersPanel.refresh(); }
  function newLayer() {
    let n = 1; while (model.getLayer('Layer' + n)) n++;
    const name = 'Layer' + n;
    model.addLayer(name, { mode: 'aci', index: LAYER_PALETTE[(model.layerList().length - 1) % LAYER_PALETTE.length] });
    setActiveLayer(name); setStatus('new layer: ' + name);
  }
  function toggleLayers() { layersOpen = !layersOpen; document.body.classList.toggle('layers-open', layersOpen); resize(); }
  // L2 layer ops — exposed via the layer-row context menu (the noun-first move for layers).
  function selectOnLayer(name) {
    selection.clear();
    for (let i = 0; i < model.features.length; i++) { const f = model.features[i]; if (f.properties && f.properties.layer === name && !layerSkip(f)) selection.add(i); }
    afterSelect();
  }
  function isolateLayer(name) { for (const L of model.layerList()) L.visible = (L.name === name); layersPanel.refresh(); afterSelect(); setStatus('isolated ' + name); }
  function showAllLayers() { for (const L of model.layerList()) L.visible = true; layersPanel.refresh(); derive(false); setStatus('all layers shown'); }
  function toggleLock(name) { const L = model.getLayer(name); if (L) { L.locked = !L.locked; if (L.locked) for (const i of [...selection]) if (model.features[i].properties.layer === name) selection.delete(i); layersPanel.refresh(); afterSelect(); } }
  function deleteLayer(name) { if (model.removeLayer(name)) { if (activeLayer === name) activeLayer = '0'; setActiveLayer(activeLayer); derive(false); setStatus('deleted layer ' + name); } }
  function renameLayer(oldName, newName) { if (model.renameLayer(oldName, newName)) { if (activeLayer === oldName) activeLayer = newName; setActiveLayer(activeLayer); derive(false); } else layersPanel.refresh(); }
  function moveLayer(name, delta) { if (model.moveLayer(name, delta)) { layersPanel.refresh(); derive(false); } }
  function layerMenu(name) {
    const L = model.getLayer(name);
    return [
      { label: 'Set Current', run: () => layerHandlers.onActive(name) },
      { label: 'Select Objects', run: () => selectOnLayer(name) },
      null,
      { label: 'Isolate', run: () => isolateLayer(name) },
      { label: 'Show All Layers', run: () => showAllLayers() },
      null,
      { label: L && L.locked ? 'Unlock' : 'Lock', run: () => toggleLock(name) },
      { label: 'Move Up', run: () => moveLayer(name, 1) },
      { label: 'Move Down', run: () => moveLayer(name, -1) },
      null,
      { label: 'Rename…', when: () => name !== '0', run: () => layersPanel.beginRename(name) },
      { label: 'Delete', when: () => name !== '0', run: () => deleteLayer(name) },
    ];
  }
  const layerHandlers = {
    active: () => activeLayer,
    onActive: (name) => { setActiveLayer(name); setStatus('current layer: ' + name); },
    onVisible: (name) => {
      const L = model.getLayer(name); if (!L) return;
      L.visible = !L.visible;
      if (!L.visible) for (const i of [...selection]) if (model.features[i].properties.layer === name) selection.delete(i);
      layersPanel.refresh(); afterSelect();
    },
    onColor: (name, color) => { const L = model.getLayer(name); if (L && color) { L.color = color; layersPanel.refresh(); derive(false); } },
    onOpacity: (name, v) => { const L = model.getLayer(name); if (L) { L.opacity = v; derive(false); } },
    onNew: () => newLayer(),
    onRename: (oldName, newName) => renameLayer(oldName, newName),
    onContext: (name, x, y) => ctxMenu.show(layerMenu(name), x, y),
    onReorder: (name, targetName) => { if (model.reorderLayer(name, targetName)) { layersPanel.refresh(); derive(false); } },
  };

  // ── selection (rides the pick hit-test) + the affine edit tools ──────────────────
  function afterSelect() { ctx.hasSelection = selection.size > 0; tools.refresh(); setStatus(selection.size ? `${selection.size} selected` : ''); derive(false); }
  const clearSel = () => { selection.clear(); ctx.hasSelection = false; tools.refresh(); };   // selection consumed by an edit → un-grey the selection-gated tools
  const pickWorld = (s) => toWorld(view.toWorld(s), frame);   // screen px → world point
  function doPick(s, additive) {
    const i = pickAt(pickWorld(s));
    if (i < 0) { if (!additive) selection.clear(); }
    else if (additive) { selection.has(i) ? selection.delete(i) : selection.add(i); }
    else { selection.clear(); selection.add(i); }
    afterSelect();
  }
  function doWindowSelect(a, b, additive) {
    const wa = pickWorld(a), wb = pickWorld(b);
    const crossing = b[0] < a[0];   // dragged right→left = crossing (touch); left→right = window (enclose only)
    const box = [Math.min(wa[0], wb[0]), Math.min(wa[1], wb[1]), Math.max(wa[0], wb[0]), Math.max(wa[1], wb[1])];
    if (!additive) selection.clear();
    for (const i of pickWindow(model.features, box, model.doc.blocks, layerSkip, crossing)) selection.add(i);
    afterSelect();
  }
  function selectAll() { selection.clear(); for (let i = 0; i < model.features.length; i++) selection.add(i); afterSelect(); }

  function startEdit(kind) {
    if (!selection.size) { setStatus('select objects first'); return; }
    cancelTool();
    const selectedGeoms = [...selection].sort((a, b) => a - b).map((i) => ({ i, feature: model.features[i] }));
    activeTool = makeEditTool({
      kind, frame, selectedGeoms,
      xform: { translate, rotate, mirror, scale: rScale },
      toLocalSegments: (g) => instanceSegments(g),
      onResolve: (res) => {
        if (res.copy) model.addMany(res.copy);
        else if (res.edit) model.applyEdit(res.edit);
        derive(false); setStatus(`${kind} done`);
      },
      onDone: () => endTool(),
    });
    refreshPrompt(); cmdline.focus(); render();
  }
  function doDelete() {
    if (!selection.size) return;
    const n = selection.size;
    model.remove([...selection]); selection.clear();
    afterSelect(); setStatus(`deleted ${n}`);
  }

  // ── trim / extend: rawPick click tools that act on the feature under the cursor ───
  function makePickTool(name, prompt, handler, hover) {
    return {
      name, rawPick: true, get prompt() { return prompt; }, point: handler, hover,
      preview: () => ({ lines: [], points: [] }), keyword: () => false, text: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
    };
  }
  function startPickTool(tool) { cancelTool(); activeTool = tool; refreshPrompt(); cmdline.focus(); render(); }
  const startTrim = () => startPickTool(makePickTool('trim', 'Trim — click the part to remove (Esc to finish):', trimAt, trimHover));
  const startExtend = () => startPickTool(makePickTool('extend', 'Extend — click near an end to lengthen it (Esc to finish):', extendAt, extendHover));

  // ── hover preview: what a click would do, shown before you commit (local segments) ──
  const pathLocal = (path) => localSegments(pathToGeom(path), frame.origin, tessEps);
  function trimHover(world) {
    const c = pickTargetAndCutters(world); if (!c || c.bad) return null;
    const res = trim(geomToPath(c.target.geometry), c.cutters, world, c.tol);
    return res.removed && res.removedPath ? { warn: pathLocal(res.removedPath) } : null;
  }
  function extendHover(world) {
    const c = pickTargetAndCutters(world); if (!c || c.bad) return null;
    const res = extend(geomToPath(c.target.geometry), c.cutters, world, c.tol);
    if (!res.extended || !res.reach) return null;
    const o = frame.origin, R = res.reach;
    return { ok: [[[R[0][0] - o[0], R[0][1] - o[1]], [R[1][0] - o[0], R[1][1] - o[1]]]] };
  }
  function offsetHover(world) {
    const i = pickAt(world); if (i < 0) return null;
    const g = model.features[i].geometry; if (g.kind !== 'polyline') return null;
    const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) || 1;
    const res = offset(geomToPath(g), offsetSign(g, world) * offsetDist, makeTolerance(extent));
    return res.ok ? { ok: pathLocal(res.path) } : null;
  }
  function cornerHover(world) {
    const i = pickAt(world); if (i < 0) return null;
    const g = model.features[i].geometry;
    const ok = isStraightLine(g) || (g.kind === 'polyline' && g.vertices.length > 6);   // a candidate line or polyline-corner
    return ok ? { pre: localSegments(g, frame.origin, tessEps) } : null;   // blue = "you can pick this" (matches idle select-hover)
  }
  function updateHover(s) {
    if (!activeTool || !activeTool.hover || !s) { overlay.setHighlight(null); return; }
    const hl = activeTool.hover(pickWorld(s));   // hover lives only on rawPick tools → WORLD coords (see placePoint)
    if (!hl) { overlay.setHighlight(null); return; }
    const proj = (segs) => (segs || []).map(([a, b]) => [view.toScreen(a), view.toScreen(b)]);
    overlay.setHighlight({ warn: proj(hl.warn), ok: proj(hl.ok), dim: proj(hl.dim), pre: proj(hl.pre) });
  }
  // idle (no tool): outline the entity a click would select
  function updateSelectHover(s) {
    if (!s) { overlay.setHighlight(null); return; }
    const i = pickAt(pickWorld(s));
    if (i < 0 || selection.has(i)) { overlay.setHighlight(null); return; }   // already-selected is already violet
    const segs = localSegments(model.features[i].geometry, frame.origin, tessEps);
    overlay.setHighlight(segs.length ? { pre: segs.map(([a, b]) => [view.toScreen(a), view.toScreen(b)]) } : null);
  }

  // the polyline + the other features' kernel curves at a world pick, or null.
  function pickTargetAndCutters(world) {
    const i = pickAt(world);
    if (i < 0) return null;
    const target = model.features[i];
    if (target.geometry.kind !== 'polyline') return { bad: 'lines/polylines only' };
    const cutters = [];
    for (let j = 0; j < model.features.length; j++) if (j !== i) cutters.push(...featureCurves(model.features[j].geometry));
    const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) || 1;
    return { i, target, cutters, tol: makeTolerance(extent) };
  }
  function extendAt(world) {
    const c = pickTargetAndCutters(world);
    if (!c) { setStatus('extend: nothing there'); return; }
    if (c.bad) { setStatus('extend: ' + c.bad); return; }
    const res = extend(geomToPath(c.target.geometry), c.cutters, world, c.tol);
    if (!res.extended) { setStatus('extend: no boundary ahead'); return; }
    model.applyEdit([{ i: c.i, feature: featureFromPath(c.target, res.path, c.target.geometry.vertices[2] || 0) }]);
    clearSel(); derive(false); setStatus('extended');
  }
  // ── offset: pick a polyline on the side you want the parallel copy ────────────────
  // Which side did the click land on? Sign of the click against the nearest span's left
  // normal → +1 (left, d>0) or −1 (right). regula's offset is left-positive.
  function offsetSign(g, world) {
    const v = g.vertices, n = v.length / 3, nspan = g.closed ? n : n - 1;
    let best = Infinity, sign = 1;
    for (let i = 0; i < nspan; i++) {
      const j = (i + 1) % n, ax = v[i * 3], ay = v[i * 3 + 1], dx = v[j * 3] - ax, dy = v[j * 3 + 1] - ay, L2 = dx * dx + dy * dy;
      let t = L2 ? ((world[0] - ax) * dx + (world[1] - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx, py = ay + t * dy, dd = Math.hypot(world[0] - px, world[1] - py);
      if (dd < best) { best = dd; sign = ((world[0] - px) * -dy + (world[1] - py) * dx) >= 0 ? 1 : -1; }
    }
    return sign;
  }
  const startOffset = () => startPickTool({
    name: 'offset', rawPick: true,
    get prompt() { return `Offset (distance ${offsetDist}) — pick a polyline on the side you want, or type distance (Esc to finish):`; },
    point: (world) => offsetAt(world), hover: offsetHover,
    text: (raw) => { const v = Number(String(raw).trim()); if (v > 0) { offsetDist = v; refreshPrompt(); render(); return true; } return false; },
    preview: () => ({ lines: [], points: [] }), keyword: () => false,
    finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
  });
  function offsetAt(world) {
    const i = pickAt(world);
    if (i < 0) { setStatus('offset: nothing there'); return; }
    const g = model.features[i].geometry;
    if (g.kind !== 'polyline') { setStatus('offset: polylines only'); return; }
    const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) || 1;
    const res = offset(geomToPath(g), offsetSign(g, world) * offsetDist, makeTolerance(extent));
    if (!res.ok) { setStatus('offset: ' + (res.reason || 'failed')); return; }
    model.addMany([featureFromPath(model.features[i], res.path, g.vertices[2] || 0)]);
    clearSel(); derive(false); setStatus('offset');
  }

  // ── fillet / chamfer: pick two straight lines, round / bevel their corner ─────────
  const lineSeg = (g) => ({ a: [g.vertices[0], g.vertices[1]], b: [g.vertices[3], g.vertices[4]] });
  const isStraightLine = (g) => g && g.kind === 'polyline' && g.vertices.length === 6 && !(g.bulges && g.bulges[0]);
  function startCorner(kind) {
    cancelTool();
    const picks = [], unit = kind === 'fillet' ? 'radius' : 'distance';
    activeTool = {
      name: kind, rawPick: true, hover: cornerHover,
      get prompt() { return picks.length === 0 ? `${kind[0].toUpperCase() + kind.slice(1)} (${unit} ${corner[kind]}) — pick a corner (a polyline) or two lines, or type ${unit}:` : 'second line:'; },
      point: (world) => {
        const i = pickAt(world);
        if (i < 0) { setStatus(`${kind}: nothing there`); return; }
        const g = model.features[i].geometry;
        if (g.kind === 'polyline' && g.vertices.length > 6) { applyCornerToPolyline(kind, i, world); return; }   // a multi-vertex polyline → round/bevel the nearest corner in place
        if (!isStraightLine(g)) { setStatus(`${kind}: pick straight lines`); return; }
        picks.push({ i, world });
        if (picks.length === 2) applyCorner(kind, picks);
      },
      text: (raw) => { const n = Number(String(raw).trim()); if (n > 0) { corner[kind] = n; refreshPrompt(); render(); return true; } return false; },
      preview: () => ({ lines: [], points: [] }), keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  const nearestVertex = (g, world) => {
    const v = g.vertices, n = v.length / 3; let best = 0, bd = Infinity;
    for (let k = 0; k < n; k++) { const d = Math.hypot(world[0] - v[k * 3], world[1] - v[k * 3 + 1]); if (d < bd) { bd = d; best = k; } }
    return best;
  };
  function applyCornerToPolyline(kind, i, world) {
    const g = model.features[i].geometry;
    const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) || 1;
    const op = kind === 'fillet' ? filletCorner : chamferCorner;
    const res = op(geomToPath(g), nearestVertex(g, world), corner[kind], makeTolerance(extent));
    if (!res.ok) { setStatus(`${kind}: ${res.reason || "can't fillet that corner"}`); endTool(); return; }
    model.applyEdit([{ i, feature: featureFromPath(model.features[i], res.path, g.vertices[2] || 0) }]);
    clearSel(); derive(false); endTool(); setStatus(`${kind}ed corner`);
  }
  function applyCorner(kind, picks) {
    const [a, b] = picks;
    if (a.i === b.i) { setStatus(`${kind}: pick two different lines`); endTool(); return; }
    const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) || 1;
    const op = kind === 'fillet' ? fillet : chamfer;
    const res = op(lineSeg(model.features[a.i].geometry), lineSeg(model.features[b.i].geometry), corner[kind], a.world, b.world, makeTolerance(extent));
    if (!res.ok) { setStatus(`${kind}: ${res.reason || 'no corner'}`); endTool(); return; }
    const z = model.features[a.i].geometry.vertices[2] || 0;
    model.applyEdit([{ i: a.i, feature: featureFromPath(model.features[a.i], res.path, z) }]);
    model.remove([b.i]);     // the two lines merge into one filleted polyline (2 undo steps in v0)
    clearSel(); derive(false); endTool(); setStatus(`${kind}ed`);
  }

  function trimAt(world) {
    const c = pickTargetAndCutters(world);
    if (!c) { setStatus('trim: nothing there'); return; }
    if (c.bad) { setStatus('trim: ' + c.bad); return; }
    const res = trim(geomToPath(c.target.geometry), c.cutters, world, c.tol);
    if (!res.removed) { setStatus('trim: no crossing to cut to'); return; }
    const z = c.target.geometry.vertices[2] || 0;
    const kept = res.kept.filter((k) => k.points.length >= 2);
    if (!kept.length) model.remove([c.i]);
    else {
      model.applyEdit([{ i: c.i, feature: featureFromPath(c.target, kept[0], z) }]);
      if (kept.length > 1) model.addMany(kept.slice(1).map((k) => featureFromPath(c.target, k, z)));
    }
    clearSel(); derive(false); setStatus('trimmed');
  }

  // ── array: replicate the selection in a grid (columns × rows, typed spacing) ──────
  function startArrayRect() {
    if (!selection.size) { setStatus('select objects first'); return; }
    cancelTool();
    const sel = [...selection].map((i) => model.features[i]);
    const steps = [['cols', 'Columns:'], ['rows', 'Rows:'], ['dx', 'Column spacing (X):'], ['dy', 'Row spacing (Y):']];
    const params = {}; let step = 0;
    activeTool = {
      name: 'array', textMode: () => true,
      get prompt() { return steps[step] ? `Array — ${steps[step][1]}` : ''; },
      point: () => {},
      text: (raw) => {
        const v = Number(String(raw).trim());
        if (Number.isFinite(v)) { params[steps[step][0]] = v; step++; if (step >= steps.length) { applyArrayRect(sel, params); endTool(); } else { refreshPrompt(); render(); } }
        return true;
      },
      preview: () => ({ lines: [], points: [] }), keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  function applyArrayRect(sel, { cols, rows, dx, dy }) {
    cols = Math.max(1, Math.round(cols)); rows = Math.max(1, Math.round(rows));
    const copies = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      for (const f of sel) copies.push({ ...f, geometry: translate(f.geometry, [c * dx, r * dy]) });
    }
    if (copies.length) model.addMany(copies);
    clearSel(); derive(false); setStatus(copies.length ? `array: +${copies.length}` : 'array: nothing to do');
  }

  // polar array: replicate the selection around a centre (count items over a fill angle)
  function startArrayPolar() {
    if (!selection.size) { setStatus('select objects first'); return; }
    cancelTool();
    const sel = [...selection].map((i) => model.features[i]);
    let center = null, count = null;
    activeTool = {
      name: 'array', textMode: () => center != null,        // centre is a point; count + angle are typed
      get prompt() { return !center ? 'Polar array — centre point:' : (count == null ? 'Number of items:' : 'Fill angle (deg, 360):'); },
      point: (local) => { if (!center) { center = local; refreshPrompt(); render(); } },
      text: (raw) => {
        if (!center) return false;   // the centre is a coordinate/click, not text — let it fall through to the point path
        const v = Number(String(raw).trim());
        if (Number.isFinite(v)) { if (count == null) { count = Math.max(2, Math.round(v)); refreshPrompt(); render(); } else { applyArrayPolar(sel, center, count, v || 360); endTool(); } }
        return true;
      },
      preview: () => ({ lines: [], points: center ? [center] : [] }), keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => center, count: () => (center ? 1 : 0),
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  function applyArrayPolar(sel, centerLocal, count, fillDeg) {
    const o = frame.origin, c = [centerLocal[0] + o[0], centerLocal[1] + o[1]];
    const step = (Math.abs(fillDeg - 360) < 1e-6 ? fillDeg / count : fillDeg / Math.max(1, count - 1)) * Math.PI / 180;
    const copies = [];
    for (let k = 1; k < count; k++) for (const f of sel) copies.push({ ...f, geometry: rotate(f.geometry, k * step, c) });
    if (copies.length) model.addMany(copies);
    clearSel(); derive(false); setStatus(`polar array: +${copies.length}`);
  }

  // ── measure: a query tool (distance + azimuth between snapped points), no entity ──
  function startMeasure() {
    cancelTool();
    let p0 = null;
    activeTool = {
      name: 'measure',
      get prompt() { return p0 ? 'Measure — next point (Esc to finish):' : 'Measure — first point (Esc to finish):'; },
      point: (local) => { p0 = local; refreshPrompt(); },             // place / chain; the readout is live (preview)
      preview: (cursor) => {
        if (!p0 || !cursor) return { lines: [], points: p0 ? [p0] : [] };
        const dx = cursor[0] - p0[0], dy = cursor[1] - p0[1], d = Math.hypot(dx, dy);
        const az = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;   // azimuth: 0=N, 90=E, clockwise (geological)
        setStatus(`dist ${d.toFixed(3)} ${frame.units} · azimuth ${az.toFixed(1)}° · Δ ${dx.toFixed(2)}, ${dy.toFixed(2)}`);
        return { lines: [[p0, cursor]], points: [p0] };
      },
      keyword: () => false, text: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => p0, count: () => (p0 ? 1 : 0),
    };
    refreshPrompt(); cmdline.focus(); render();
  }

  // ── text: place an insertion point, then type the string (the next entry IS the text) ──
  function startText() {
    cancelTool();
    let pos = null;
    activeTool = {
      name: 'text', textMode: () => !!pos,
      get prompt() { return pos ? `Type the text (height ${textHeight}), Enter:` : `Text — insertion point (height ${textHeight}):`; },
      point: (local) => { if (!pos) { pos = local; refreshPrompt(); cmdline.focus(); render(); } },
      text: (raw) => {   // any typed string after the position is the text (textMode routes it here)
        if (!pos) { const n = Number(String(raw).trim()); if (n > 0) { textHeight = n; refreshPrompt(); return true; } return false; }
        if (raw) { commitText(pos, raw); endTool(); }
        return true;
      },
      preview: (cursor) => ({ lines: [], points: pos ? [pos] : (cursor ? [cursor] : []) }),
      keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => pos, count: () => (pos ? 1 : 0),
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  function commitText(localPos, value) {
    const o = frame.origin;
    model.add({ type: 'text', geometry: { kind: 'text', position: [localPos[0] + o[0], localPos[1] + o[1], o[2] || 0], height: textHeight, rotation: 0, value }, properties: { layer: activeLayer } });
    derive(false); setStatus('text: ' + value);
  }

  // ── blocks: define a reusable symbol from the selection, place live instances ─────
  function startMakeBlock() {
    if (!selection.size) { setStatus('select objects to make a block'); return; }
    cancelTool();
    const indices = [...selection].sort((a, b) => a - b);
    let name = null;
    activeTool = {
      name: 'block', textMode: () => name == null,
      get prompt() { return name == null ? 'Block name:' : 'Pick the base point (the insertion anchor):'; },
      text: (raw) => { if (name != null) return false; const n = String(raw).trim(); if (n) { name = n; refreshPrompt(); render(); } return true; },
      point: (local) => { if (name != null) makeBlock(name, indices, local); },
      preview: () => ({ lines: [], points: [] }), keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  function makeBlock(name, indices, baseLocal) {
    const o = frame.origin, base = [baseLocal[0] + o[0], baseLocal[1] + o[1], 0];        // world base point
    const feats = indices.map((i) => ({ ...model.features[i], geometry: translate(model.features[i].geometry, [-base[0], -base[1]]) }));   // block-local (base-relative)
    model.addBlock(name, feats, [0, 0, 0]);
    const insert = { type: 'insert', geometry: { kind: 'insert', block: name, transform: { position: base, scale: [1, 1, 1], rotation: 0 } }, properties: { layer: activeLayer } };
    model.swap(indices, [insert]);            // the selection becomes its own instance, in place
    selection.clear(); afterSelect(); endTool(); setStatus(`block "${name}" created — Insert (i) to place more`);
  }
  // Insert: choose a defined block (a chooser menu), then place live instances.
  function insertCommand() {
    const names = model.blockNames();
    if (!names.length) { setStatus('no blocks yet — select objects and Make Block first'); return; }
    if (names.length === 1) { startInsert(names[0]); return; }
    const r = board.getBoundingClientRect();
    ctxMenu.show(names.map((n) => ({ label: n, run: () => startInsert(n) })), r.left + r.width / 2, r.top + 40);
  }
  // Place an attribute DEFINITION (a tag placeholder); becomes a block template when the
  // selection (geometry + attdefs) is turned into a block.
  function startAttdef() {
    cancelTool();
    let tag = null;
    activeTool = {
      name: 'attdef', textMode: () => tag == null,
      get prompt() { return tag == null ? 'Attribute tag (e.g. HOLEID):' : 'Pick the text position:'; },
      text: (raw) => { if (tag != null) return false; const t = String(raw).trim(); if (t) { tag = t.toUpperCase(); refreshPrompt(); render(); } return true; },
      point: (local) => { if (tag != null) { const o = frame.origin; model.add({ type: 'attdef', geometry: { kind: 'attdef', position: [local[0] + o[0], local[1] + o[1], 0], height: textHeight, rotation: 0, tag, prompt: tag, value: '' }, properties: { layer: activeLayer } }); derive(false); endTool(); setStatus(`attribute "${tag}" defined — select all + Make Block`); } },
      preview: () => ({ lines: [], points: [] }), keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  function startInsert(name) {
    const blk = model.getBlock(name); if (!blk) { setStatus(`no block "${name}"`); return; }
    const attdefs = blk.features.filter((f) => f.geometry.kind === 'attdef');
    cancelTool();
    let pos = null, vals = [];      // pos: pending insertion point while prompting values
    const place = (local) => {
      const o = frame.origin;
      const attribs = attdefs.map((ad, k) => ({ tag: ad.geometry.tag, value: vals[k] != null ? vals[k] : (ad.geometry.value || '') }));
      const props = attribs.length ? { layer: activeLayer, attribs } : { layer: activeLayer };
      model.add({ type: 'insert', geometry: { kind: 'insert', block: name, transform: { position: [local[0] + o[0], local[1] + o[1], 0], scale: [1, 1, 1], rotation: 0 } }, properties: props });
      derive(false); setStatus(`inserted "${name}"`);
    };
    activeTool = {
      name: 'insert',
      textMode: () => pos != null && vals.length < attdefs.length, acceptsEmpty: () => pos != null,
      get prompt() { return pos == null ? `Insert "${name}" — point (Esc to finish):` : `Enter ${attdefs[vals.length].geometry.tag}:`; },
      point: (local) => {
        if (pos != null) return;
        if (!attdefs.length) { place(local); return; }      // no attributes → place immediately, stay active
        pos = local; vals = []; refreshPrompt(); cmdline.focus(); render();   // begin the value prompts
      },
      text: (raw) => {
        if (pos == null) return false;
        vals.push(String(raw));
        if (vals.length >= attdefs.length) { place(pos); pos = null; vals = []; }   // done → place, back to point mode
        refreshPrompt(); return true;
      },
      preview: (cursor) => {
        if (pos != null || !cursor) return { lines: [], points: pos ? [pos] : [] };
        const o = frame.origin;
        return { lines: instanceSegments({ kind: 'insert', block: name, transform: { position: [cursor[0] + o[0], cursor[1] + o[1], 0], scale: [1, 1, 1], rotation: 0 } }), points: [cursor] };
      },
      keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => pos, count: () => (pos ? 1 : 0),
    };
    refreshPrompt(); cmdline.focus(); render();
  }
  // Double-click an instance → re-prompt its attribute values (empty Enter keeps the current).
  function editAttribs(i) {
    const f = model.features[i], blk = model.getBlock(f.geometry.block);
    const attdefs = blk ? blk.features.filter((x) => x.geometry.kind === 'attdef') : [];
    if (!attdefs.length) { setStatus('this block has no attributes'); return; }
    cancelTool();
    const cur = f.properties.attribs || [], vals = [];
    activeTool = {
      name: 'editattr', textMode: () => true, acceptsEmpty: () => true,
      get prompt() { const ad = attdefs[vals.length].geometry, old = (cur.find((a) => a.tag === ad.tag) || {}).value || ''; return `${ad.tag} [${old}]:`; },
      text: (raw) => {
        const ad = attdefs[vals.length].geometry, old = (cur.find((a) => a.tag === ad.tag) || {}).value || '';
        vals.push(raw === '' ? old : String(raw));      // empty keeps the current value
        if (vals.length >= attdefs.length) {
          const attribs = attdefs.map((a, k) => ({ tag: a.geometry.tag, value: vals[k] }));
          model.applyEdit([{ i, feature: { ...f, properties: { ...f.properties, attribs } } }]);
          derive(false); endTool(); setStatus('attributes updated');
        } else refreshPrompt();
        return true;
      },
      point: () => {}, preview: () => ({ lines: [], points: [] }), keyword: () => false,
      finish: () => endTool(), cancel: () => endTool(), last: () => null, count: () => 0,
    };
    refreshPrompt(); cmdline.focus(); render();
  }

  // ── the spine: commands, then the surfaces that view them ───────────────────────
  let palette;
  const ctx = { hasDoc: true, hasSelection: false };
  const cmds = new CommandRegistry().registerAll([
    { id: 'file.new', title: 'New Drawing', category: 'File', icon: 'New', run: () => { const m = new Model(); m.name = 'drawing'; loadModel(m); ctx.hasDoc = false; tools.refresh(); setStatus('new drawing'); } },
    { id: 'file.open', title: 'Open DXF…', category: 'File', icon: 'Open', keys: 'ctrl+o', run: () => fileInput.click() },
    { id: 'file.save', title: 'Save DXF…', category: 'File', icon: 'Save', keys: 'ctrl+s', run: () => saveDxf() },
    { id: 'file.exportWkt', title: 'Export Features (WKT/CSV)…', category: 'File', alias: ['exportwkt', 'wkt', 'features', 'export'], run: () => exportFeatureTable() },
    { id: 'file.demo', title: 'Load Demo', category: 'File', run: () => { loadModel(demoModel()); ctx.hasDoc = true; tools.refresh(); setStatus('demo model'); } },
    { id: 'draw.line', title: 'Line', category: 'Draw', icon: 'Line', keys: 'l', alias: ['l', 'line'], run: () => startTool('line') },
    { id: 'draw.polyline', title: 'Polyline', category: 'Draw', icon: 'Pline', keys: 'p', alias: ['p', 'pl', 'pline', 'polyline'], run: () => startTool('polyline') },
    { id: 'draw.arc', title: 'Arc', category: 'Draw', icon: 'Arc', keys: 'a', alias: ['a', 'arc'], run: () => startTool('arc') },
    { id: 'draw.circle', title: 'Circle', category: 'Draw', icon: 'Circle', keys: 'c', alias: ['c', 'ci', 'circle'], run: () => startTool('circle') },
    { id: 'draw.point', title: 'Point', category: 'Draw', icon: 'Point', alias: ['po', 'point', 'node'], run: () => startTool('point') },
    { id: 'draw.text', title: 'Text', category: 'Draw', icon: 'Text', alias: ['text', 'txt'], run: () => startText() },
    { id: 'edit.undo', title: 'Undo', category: 'Edit', keys: 'ctrl+z', run: () => { if (model.undo()) { selection.clear(); afterSelect(); setStatus('undo'); } } },
    { id: 'edit.redo', title: 'Redo', category: 'Edit', keys: 'ctrl+y', run: () => { if (model.redo()) { selection.clear(); afterSelect(); setStatus('redo'); } } },
    { id: 'edit.selectAll', title: 'Select All', category: 'Edit', keys: 'ctrl+a', run: () => selectAll() },
    { id: 'edit.deselect', title: 'Deselect', category: 'Edit', run: () => { selection.clear(); afterSelect(); } },
    { id: 'edit.move', title: 'Move', category: 'Modify', icon: 'Move', keys: 'm', alias: ['m', 'move'], when: () => selection.size > 0, run: () => startEdit('move') },
    { id: 'edit.copy', title: 'Copy', category: 'Modify', icon: 'Copy', keys: 'shift+c', alias: ['co', 'copy'], when: () => selection.size > 0, run: () => startEdit('copy') },
    { id: 'edit.rotate', title: 'Rotate', category: 'Modify', icon: 'Rotate', keys: 'r', alias: ['ro', 'rotate'], when: () => selection.size > 0, run: () => startEdit('rotate') },
    { id: 'edit.mirror', title: 'Mirror', category: 'Modify', icon: 'Mirror', alias: ['mi', 'mirror'], when: () => selection.size > 0, run: () => startEdit('mirror') },
    { id: 'edit.scale', title: 'Scale', category: 'Modify', icon: 'Scale', alias: ['sc', 'scale'], when: () => selection.size > 0, run: () => startEdit('scale') },
    { id: 'edit.makeBlock', title: 'Make Block…', category: 'Modify', alias: ['block', 'makeblock'], when: () => selection.size > 0, run: () => startMakeBlock() },
    { id: 'edit.array', title: 'Array (grid)', category: 'Modify', icon: 'Array', alias: ['ar', 'array'], when: () => selection.size > 0, run: () => startArrayRect() },
    { id: 'edit.arrayPolar', title: 'Array (polar)', category: 'Modify', alias: ['polar', 'arraypolar'], when: () => selection.size > 0, run: () => startArrayPolar() },
    { id: 'edit.delete', title: 'Delete', category: 'Modify', keys: 'delete', alias: ['del', 'erase'], when: () => selection.size > 0, run: () => doDelete() },
    { id: 'edit.trim', title: 'Trim', category: 'Modify', icon: 'Trim', keys: 't', alias: ['tr', 'trim'], run: () => startTrim() },
    { id: 'edit.extend', title: 'Extend', category: 'Modify', icon: 'Extend', keys: 'x', alias: ['ex', 'extend'], run: () => startExtend() },
    { id: 'edit.fillet', title: 'Fillet', category: 'Modify', icon: 'Fillet', keys: 'f', alias: ['f', 'fillet'], run: () => startCorner('fillet') },
    { id: 'edit.chamfer', title: 'Chamfer', category: 'Modify', icon: 'Chamfer', alias: ['cha', 'chamfer'], run: () => startCorner('chamfer') },
    { id: 'edit.offset', title: 'Offset', category: 'Modify', icon: 'Offset', keys: 'o', alias: ['o', 'offset'], run: () => startOffset() },
    { id: 'tool.insert', title: 'Insert block', category: 'Draw', icon: 'Insert', keys: 'i', alias: ['insert', 'ins'], run: () => insertCommand() },
    { id: 'draw.attdef', title: 'Define Attribute…', category: 'Draw', alias: ['attdef', 'attribute', 'att'], run: () => startAttdef() },
    { id: 'tool.measure', title: 'Measure', category: 'Tools', icon: 'Measure', alias: ['measure', 'dist', 'mea'], run: () => startMeasure() },
    { id: 'view.zoomExtents', title: 'Zoom Extents', category: 'View', icon: 'Extents', keys: 'e', run: () => derive(true) },
    { id: 'view.zoomIn', title: 'Zoom In', category: 'View', icon: '+', keys: '=', run: () => { view.zoomAt([view.width / 2, view.height / 2], 1.2); zoomed(); } },
    { id: 'view.zoomOut', title: 'Zoom Out', category: 'View', icon: '−', keys: '-', run: () => { view.zoomAt([view.width / 2, view.height / 2], 1 / 1.2); zoomed(); } },
    { id: 'view.palette', title: 'Command Palette', category: 'View', icon: '⌘', keys: 'ctrl+p', run: () => palette.toggle() },
    { id: 'view.grid', title: 'Reference Grid', category: 'View', keys: 'g', alias: ['grid'], run: () => { gridOn = !gridOn; setStatus(gridOn ? 'grid on' : 'grid off'); render(); } },
    { id: 'view.layers', title: 'Layers Panel', category: 'View', keys: 'shift+l', alias: ['layers'], run: () => toggleLayers() },
    { id: 'layer.new', title: 'New Layer', category: 'Layer', alias: ['newlayer'], run: () => { if (!layersOpen) toggleLayers(); newLayer(); } },
    { id: 'help.docs', title: 'Documentation', category: 'Help', keys: 'f1', alias: ['help', 'docs', 'manual', '?'], run: () => toggleHelp() },
    { id: 'help.about', title: 'About moncad', category: 'Help', run: () => setStatus('moncad — a small 2D CAD instrument · gentropic.org/moncad') },
    { id: 'snap.toggle', title: 'Snapping (master)', category: 'Snap', keys: 'f3', run: () => toggleMaster() },
    { id: 'snap.ortho', title: 'Ortho (H/V lock)', category: 'Snap', keys: 'f8', alias: ['ortho'], run: () => { snap.toggleOrtho(); afterSnapChange(); setStatus(`ortho ${snap.ortho ? 'on' : 'off'}`); } },
    { id: 'snap.end', title: 'Snap: Endpoint', category: 'Snap', alias: ['end', 'endp'], run: () => toggleType('end') },
    { id: 'snap.mid', title: 'Snap: Midpoint', category: 'Snap', alias: ['mid'], run: () => toggleType('mid') },
    { id: 'snap.center', title: 'Snap: Centre', category: 'Snap', alias: ['cen', 'centre'], run: () => toggleType('center') },
    { id: 'snap.node', title: 'Snap: Node', category: 'Snap', alias: ['nod'], run: () => toggleType('node') },
    { id: 'snap.grid', title: 'Snap: Grid', category: 'Snap', alias: ['gridsnap'], run: () => { snap.toggleGrid(); afterSnapChange(); } },
    { id: 'snap.cycle', title: 'Cycle Snap Candidate', category: 'Snap', keys: 'tab', run: () => cycleSnap() },
    { id: 'snap.apertureUp', title: 'Snap Aperture +', category: 'Snap', keys: ']', run: () => setAperture(snap.aperture + 2) },
    { id: 'snap.apertureDown', title: 'Snap Aperture −', category: 'Snap', keys: '[', run: () => setAperture(snap.aperture - 2) },
  ]);
  palette = makePalette(cmds, ctx, { root: $('#palette'), input: $('#palInput'), list: $('#palList') });
  const cmdline = makeCommandLine({ input: $('#cmdInput'), prompt: $('#cmdPrompt') }, { onSubmit: cmdSubmit, onCancel: cmdCancel, onKey: commandLineKey });
  const snapChips = makeSnapChips(cmds, ctx, $('#snapchips'), snap, SNAP_TYPES, SNAP_LABELS);
  const ctxMenu = makeContextMenu(cmds, ctx, $('#ctxmenu'));
  const layersPanel = makeLayersPanel(() => model, $('#layers'), layerHandlers);
  // contextual command sets — verbs come to the selection (SPEC §3, noun-first)
  const SEL_MENU = ['edit.move', 'edit.copy', 'edit.rotate', 'edit.mirror', 'edit.scale', null, 'edit.array', 'edit.arrayPolar', 'edit.makeBlock', null, 'edit.trim', 'edit.extend', 'edit.fillet', 'edit.chamfer', 'edit.offset', null, 'edit.delete', 'edit.deselect'];
  const EMPTY_MENU = ['edit.selectAll', null, 'view.zoomExtents', 'view.grid', null, 'file.new', 'file.open', 'file.save'];
  // left tool palette: the frequent draw + modify verbs (the long tail is in the menus / palette / context)
  const tools = makeToolbar(cmds, ctx, $('#tools'),
    ['draw.line', 'draw.polyline', 'draw.arc', 'draw.circle', 'draw.point', 'draw.text', 'tool.insert', null,
      'edit.move', 'edit.copy', 'edit.rotate', 'edit.mirror', 'edit.trim', 'edit.extend', 'edit.fillet', 'edit.chamfer', 'edit.offset', 'edit.delete', null, 'tool.measure']);
  // menubar: GLOBAL only
  makeMenubar(cmds, ctx, $('#menubar'), [
    { label: 'File', items: ['file.new', 'file.open', 'file.save', null, 'file.demo'] },
    { label: 'Edit', items: ['edit.undo', 'edit.redo', null, 'edit.selectAll', 'edit.deselect'] },
    { label: 'View', items: ['view.zoomExtents', 'view.zoomIn', 'view.zoomOut', null, 'view.grid', 'snap.grid', 'view.layers', null, 'view.palette'] },
    { label: 'Help', items: ['help.docs', 'help.about'] },
  ], $('#menudrop'));

  $('#helpClose').addEventListener('click', () => toggleHelp(false));
  $('#help').addEventListener('mousedown', (e) => { if (e.target.id === 'help') toggleHelp(false); });   // backdrop closes
  $('#helpVer').textContent = $('#build').textContent;

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;       // the palette owns its own keys
    if ($('#help').classList.contains('show')) { if (e.key === 'Escape' || e.key === 'F1') { e.preventDefault(); toggleHelp(false); } return; }   // help open → Esc/F1 close it, swallow the rest
    if (e.key === '?') { e.preventDefault(); toggleHelp(true); return; }
    // an active tool claims Esc / Enter / Close / Undo; everything else (zoom, …) still fires
    if (activeTool) {
      if (e.key === 'Escape') { e.preventDefault(); cancelTool(); return; }
      if (e.key === 'Enter') { e.preventDefault(); activeTool.finish(); return; }
      const k = e.key.toLowerCase();
      if (!e.ctrlKey && !e.metaKey && (k === 'c' || k === 'u') && activeTool.keyword(k)) { e.preventDefault(); setStatus(activeTool.prompt); render(); return; }
    }
    if (!activeTool && e.key === 'Escape' && selection.size) { e.preventDefault(); selection.clear(); afterSelect(); return; }
    const id = cmds.forKey(eventKey(e));
    if (id) { e.preventDefault(); cmds.execute(id, ctx); }
  });

  // ── input: place points (tool) / pan (drag) / zoom (wheel) / readout (move) ───────
  const devicePt = (e) => { const r = glCanvas.getBoundingClientRect(); return [(e.clientX - r.left) * view.dpr, (e.clientY - r.top) * view.dpr]; };
  let panning = false, selecting = false, last = null, selStart = null;
  olCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 || e.button === 1) e.preventDefault();   // the canvas isn't focusable; without this the click blurs the command line, so a mid-tool cmdline.focus() (text / typed input after a click) wouldn't stick
    if (activeTool && e.button === 0) { placePoint(devicePt(e)); return; }            // left places mid-tool
    if (e.button === 1) { panning = true; last = devicePt(e); olCanvas.style.cursor = 'grabbing'; return; }   // middle pans
    if (e.button === 0 && !activeTool) { selecting = true; selStart = devicePt(e); }  // left selects / window-selects
  });
  olCanvas.addEventListener('dblclick', (e) => {
    if (activeTool) { e.preventDefault(); activeTool.finish(); return; }
    const i = pickAt(pickWorld(devicePt(e)));      // double-click an instance → edit its attribute values
    if (i >= 0 && model.features[i].geometry.kind === 'insert') { e.preventDefault(); editAttribs(i); }
  });
  olCanvas.addEventListener('contextmenu', (e) => {                       // right-click is moncad's, not the browser's
    e.preventDefault();
    if (activeTool) { activeTool.finish(); return; }                     // ends the active tool (polyline commits; others cancel)
    if (!selection.size) { const i = pickAt(pickWorld(devicePt(e))); if (i >= 0) { selection.add(i); afterSelect(); } }
    ctxMenu.show(selection.size ? SEL_MENU : EMPTY_MENU, e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', (e) => {
    if (panning) { panning = false; olCanvas.style.cursor = 'none'; }
    if (selecting) {
      selecting = false; overlay.setSelectBox(null);
      const end = lastMouse || selStart;
      const moved = Math.abs(end[0] - selStart[0]) > 3 * view.dpr || Math.abs(end[1] - selStart[1]) > 3 * view.dpr;
      if (moved) doWindowSelect(selStart, end, e.shiftKey); else doPick(selStart, e.shiftKey);
      render();
    }
  });
  olCanvas.addEventListener('mousemove', (e) => {
    const s = devicePt(e); lastMouse = s; cycleIdx = 0;   // a new position restarts Tab-cycle from the best candidate
    if (panning) { view.panBy(s[0] - last[0], s[1] - last[1]); last = s; }
    if (selecting) overlay.setSelectBox([selStart, s], s[0] < selStart[0]);   // right→left drag = crossing (green)
    overlay.setCursor(s); readout(s, !panning);
    if (panning || selecting) overlay.setHighlight(null);
    hoverDirty = true;          // the pick/hover (updateRubber/updateHover/updateSelectHover) runs once per frame in render()
    render();
  });
  olCanvas.addEventListener('mouseleave', () => { overlay.setCursor(null); overlay.setSnap(null); overlay.setHighlight(null); hoverDirty = false; render(); });
  olCanvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoomAt(devicePt(e), e.deltaY < 0 ? 1.1 : 1 / 1.1); readout(devicePt(e)); if (activeTool) updateRubber(devicePt(e)); zoomed(); }, { passive: false });

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
  document.body.classList.toggle('layers-open', layersOpen);   // size the board for the docked panel before the first resize
  resize();
  loadModel(demoModel());
  setStatus('demo model · L to draw a polyline · Open or drag in a DXF · F1 for help');
}

boot();
