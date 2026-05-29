// @gcu/patchbay — surface glue. mountPatchbay(ctx) builds the canvas + chrome
// (toolbar, insert palette, properties panel) into ctx.root, wires the engine /
// renderer / interaction together, drives the rAF render loop, reads theme
// tokens, and returns { flush, dispose, isDirty } for the surface contract.
//
// ctx = { root, bus, tab, sr, MenuBar?, doc?, onDirty? }
//   root   — element to render into (iframe body, or a privileged shadow root)
//   bus    — A-Bus peer (for the works VFS service + I/O modules)
//   tab    — { id, path, kind }
//   sr     — { signal, computed, effect, batch }
//   MenuBar — @gcu/menu MenuBar class (injected; the bundle can't import it).
//             Absent → no menubar chrome (right-click add still works).
//   doc    — optional preloaded rack document (else loaded via LooseFileStore)
//   onDirty(bool) — optional dirty-state callback (drives the tab dot)

import { createEngine } from './engine.js';
import { createPb } from './pb.js';
import { createRenderer, DEFAULT_COLORS, RAIL_LEFT, HP } from './render.js';
import { attachInteraction } from './interact.js';
import { LooseFileStore, serializeRack, deserializeRack, blankRack } from './store.js';
import { registerStdlib, STDLIB_MODULES } from './stdlib.js';
import { getModuleDef, listModuleDefs } from './sdk.js';
import { listStyles } from './styles.js';

// --sw-* token → renderer color role.
const TOKEN_MAP = {
  bgDeep: '--sw-bg-deep', bg: '--sw-bg', bgRaised: '--sw-bg-raised', bgBright: '--sw-bg-bright',
  text: '--sw-text', textMid: '--sw-text-mid', textSoft: '--sw-text-soft',
  border: '--sw-border', rule: '--sw-rule',
  orange: '--sw-orange', teal: '--sw-teal', green: '--sw-green',
  amber: '--sw-amber', red: '--sw-red', indigo: '--sw-indigo',
};
function readThemeColors(el) {
  const cs = (typeof getComputedStyle !== 'undefined') ? getComputedStyle(el) : null;
  if (!cs) return { ...DEFAULT_COLORS };
  const out = { ...DEFAULT_COLORS };
  for (const [role, varName] of Object.entries(TOKEN_MAP)) {
    const v = cs.getPropertyValue(varName).trim();
    if (v) out[role] = v;
  }
  out.jack = out.indigo;
  return out;
}

function slug(type) { return type.split('.').pop().replace(/[^a-z0-9]+/gi, '-'); }
function freshId(engine, type) {
  const base = slug(type);
  if (!engine.instances.has(base)) return base;
  for (let i = 2; ; i++) if (!engine.instances.has(`${base}_${i}`)) return `${base}_${i}`;
}
function freeSlot(engine, rack, def) {
  const occ = (row, hp) => {
    for (const o of engine.instances.values()) {
      if (o.row !== row) continue;
      if (hp < o.hpPos + o.def.hp && hp + def.hp > o.hpPos) return true;
    }
    return false;
  };
  for (let row = 0; row < rack.rows.length; row++) {
    for (let hp = 0; hp <= rack.hp - def.hp; hp++) if (!occ(row, hp)) return { row, hpPos: hp };
  }
  return { row: 0, hpPos: 0 };
}

export function mountPatchbay(ctx) {
  registerStdlib();
  const { root, bus, tab, sr } = ctx;
  const onDirty = ctx.onDirty || (() => {});
  const doc = root.ownerDocument || document;

  const { MenuBar } = ctx;

  // ── DOM scaffold ── flex column: menubar (if MenuBar injected) + canvas wrap.
  const host = doc.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--sw-bg,#15171A);display:flex;flex-direction:column;';
  const menubarHost = doc.createElement('div'); menubarHost.className = 'pb-menubar';
  const wrap = doc.createElement('div');
  wrap.style.cssText = 'position:relative;flex:1;min-height:0;overflow:hidden;';
  const canvas = doc.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;user-select:none;';
  wrap.appendChild(canvas);

  const css = `
    .pb-menubar{flex:none;background:var(--sw-bg-raised,#1D2024);border-bottom:1px solid var(--sw-border,#2F3338)}
    .pb-pop{position:absolute;z-index:8;background:rgba(20,23,26,.97);border:1px solid var(--sw-border,#2F3338);
      border-radius:6px;padding:5px;min-width:158px;max-height:74vh;overflow:auto;box-shadow:0 8px 28px rgba(0,0,0,.5);
      font:12px/1.4 Barlow,system-ui,sans-serif;display:none}
    .pb-pop.open{display:block}
    .pb-grp{font:600 9px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--sw-orange,#D4672E);padding:7px 6px 2px}
    .pb-search{width:100%;box-sizing:border-box;margin-bottom:5px;background:var(--sw-bg-deep,#0E1012);border:1px solid var(--sw-border,#2F3338);
      color:var(--sw-text,#DDD);border-radius:4px;padding:6px 8px;font:12px Barlow,system-ui,sans-serif;outline:none}
    .pb-search:focus{border-color:var(--sw-orange,#D4672E)}
    .pb-item{display:flex;justify-content:space-between;gap:12px;padding:5px 8px;border-radius:4px;cursor:pointer;color:var(--sw-text,#DDD)}
    .pb-item:hover{background:var(--sw-bg-bright,#25282D)}
    .pb-item .t{color:var(--sw-text-soft,#6E6C68);font:10px/1.5 "Space Mono",monospace}
    .pb-item.danger{color:var(--sw-red,#D05048)}
    /* Right-docked slide-out inspector for the selected module. */
    .pb-insp{position:absolute;top:8px;right:8px;bottom:8px;width:250px;z-index:6;
      background:rgba(20,23,26,.97);border:1px solid var(--sw-border,#2F3338);border-radius:6px;
      box-shadow:0 8px 28px rgba(0,0,0,.5);color:var(--sw-text,#DDD);font:12px/1.5 Barlow,system-ui,sans-serif;
      display:flex;flex-direction:column;transform:translateX(calc(100% + 16px));transition:transform .18s ease;overflow:hidden}
    .pb-insp.open{transform:translateX(0)}
    .pb-insp-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:10px 12px 8px;
      border-bottom:1px solid var(--sw-border,#2F3338)}
    .pb-insp-hd h4{margin:0;font:700 14px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.05em}
    .pb-insp-hd .ty{font:10px/1.5 "Space Mono",monospace;color:var(--sw-text-soft,#6E6C68)}
    .pb-insp-x{background:none;border:0;color:var(--sw-text-soft,#6E6C68);font-size:16px;cursor:pointer;line-height:1;padding:0 2px}
    .pb-insp-x:hover{color:var(--sw-text,#DDD)}
    .pb-insp-body{padding:6px 12px 12px;overflow:auto;flex:1}
    .pb-sec{font:600 9px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.12em;
      color:var(--sw-orange,#D4672E);margin:12px 0 4px;padding-bottom:3px;border-bottom:1px solid var(--sw-border-soft,#23262b)}
    .pb-insp label{display:block;font-size:10px;color:var(--sw-text-soft,#6E6C68);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 2px}
    .pb-insp label .v{float:right;color:var(--sw-text,#DDD);text-transform:none}
    .pb-insp input,.pb-insp select{width:100%;background:var(--sw-bg-deep,#0E1012);border:1px solid var(--sw-border,#2F3338);
      color:var(--sw-text,#DDD);border-radius:3px;padding:4px 6px;font:11px "Space Mono",monospace;box-sizing:border-box}
    .pb-insp input[type=range]{padding:0}
    .pb-readout{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font:11px "Space Mono",monospace}
    .pb-readout .n{color:var(--sw-text-soft,#6E6C68)}
    .pb-readout .rv{color:var(--sw-teal,#3A9BA3)}
    .pb-del{margin-top:14px;width:100%;background:rgba(208,80,72,.15);border:1px solid var(--sw-red,#D05048);color:var(--sw-red,#D05048);
      border-radius:4px;padding:6px 10px;font:10px/1 "Space Mono",monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
    .pb-hud{position:absolute;bottom:8px;right:8px;z-index:5;font:9.5px "Space Mono",monospace;color:var(--sw-text-soft,#6E6C68);
      background:rgba(29,32,36,.88);border:1px solid var(--sw-border,#2F3338);border-radius:4px;padding:5px 8px}
    .pb-swatches{position:absolute;left:8px;bottom:8px;z-index:5;display:flex;gap:5px;align-items:center;
      background:rgba(29,32,36,.88);border:1px solid var(--sw-border,#2F3338);border-radius:5px;padding:5px 7px}
    .pb-swatches .lbl{font:8px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--sw-text-soft,#6E6C68);margin-right:1px}
    .pb-sw{width:14px;height:14px;border-radius:50%;cursor:pointer;border:2px solid transparent;box-sizing:border-box}
    .pb-sw:hover{border-color:var(--sw-text-soft,#6E6C68)}
    .pb-sw.sel{border-color:var(--sw-text,#DDD)}
    .pb-sw.auto{background:repeating-conic-gradient(var(--sw-text-soft,#6E6C68) 0 25%, transparent 0 50%);background-size:7px 7px}
  `;
  const styleEl = doc.createElement('style'); styleEl.textContent = css; host.appendChild(styleEl);

  // Right-click context menu (cursor-placement add / delete). Lists module
  // types grouped by category via renderModuleList (shared with the Add menu).
  const ctxMenu = doc.createElement('div'); ctxMenu.className = 'pb-pop'; wrap.appendChild(ctxMenu);
  // Searchable add (Add → Find module… / Ctrl+K): input + filtered list.
  const searchPop = doc.createElement('div'); searchPop.className = 'pb-pop';
  searchPop.style.cssText = 'top:8px;left:50%;transform:translateX(-50%);width:264px';
  const searchInput = doc.createElement('input'); searchInput.className = 'pb-search'; searchInput.placeholder = 'find module…';
  const searchList = doc.createElement('div');
  searchPop.append(searchInput, searchList); wrap.appendChild(searchPop);

  const insp = doc.createElement('div'); insp.className = 'pb-insp';
  const inspHd = doc.createElement('div'); inspHd.className = 'pb-insp-hd';
  const inspTitle = doc.createElement('div');
  const inspH4 = doc.createElement('h4'); const inspTy = doc.createElement('div'); inspTy.className = 'ty';
  inspTitle.append(inspH4, inspTy);
  const inspX = doc.createElement('button'); inspX.className = 'pb-insp-x'; inspX.textContent = '×';
  inspHd.append(inspTitle, inspX);
  const inspBody = doc.createElement('div'); inspBody.className = 'pb-insp-body';
  insp.append(inspHd, inspBody);
  wrap.appendChild(insp);
  const hud = doc.createElement('div'); hud.className = 'pb-hud'; wrap.appendChild(hud);

  // Wire-color pen: pick the colour the next cable you draw will take
  // (auto = the source module's accent). Bottom-left swatch strip.
  const WIRE_COLORS = ['orange', 'teal', 'green', 'amber', 'red', 'indigo'];
  let wireColor = null;   // null = auto (source accent)
  const swatches = doc.createElement('div'); swatches.className = 'pb-swatches';
  const lbl = doc.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'wire'; swatches.appendChild(lbl);
  const swEls = [];
  function mkSwatch(role) {
    const sw = doc.createElement('div'); sw.className = 'pb-sw' + (role ? '' : ' auto');
    sw.title = role || 'auto (source colour)';
    if (role) sw.style.background = 'var(--sw-' + role + ')';
    sw.addEventListener('click', () => { wireColor = role; swEls.forEach((s) => s.el.classList.toggle('sel', s.role === role)); });
    swEls.push({ el: sw, role }); swatches.appendChild(sw);
  }
  mkSwatch(null);
  WIRE_COLORS.forEach(mkSwatch);
  swEls[0].el.classList.add('sel');
  wrap.appendChild(swatches);

  if (MenuBar) host.appendChild(menubarHost);
  host.appendChild(wrap);
  root.appendChild(host);

  const PREFIX_LABEL = { src: 'Sources', math: 'Math', logic: 'Logic', proc: 'Process', ctrl: 'Control', panel: 'Panel', disp: 'Display', io: 'I/O' };
  function moduleGroups() {
    const groups = new Map();
    for (const def of listModuleDefs()) {
      const g = PREFIX_LABEL[def.type.split('.')[0]] || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(def);
    }
    return groups;
  }
  function renderModuleList(el, onPick) {
    el.innerHTML = '';
    for (const [grp, defs] of moduleGroups()) {
      const h = doc.createElement('div'); h.className = 'pb-grp'; h.textContent = grp; el.appendChild(h);
      for (const def of defs) {
        const it = doc.createElement('div'); it.className = 'pb-item';
        const name = doc.createElement('span'); name.textContent = def.title;
        const t = doc.createElement('span'); t.className = 't'; t.textContent = def.type;
        it.append(name, t);
        it.addEventListener('click', (e) => { e.stopPropagation(); onPick(def.type); });
        el.appendChild(it);
      }
    }
  }
  function hideMenus() { ctxMenu.classList.remove('open'); }

  // ── searchable add (find module) ──
  function filteredDefs(q) {
    const ql = (q || '').trim().toLowerCase();
    return listModuleDefs().filter((d) => !ql || d.title.toLowerCase().includes(ql) || d.type.toLowerCase().includes(ql));
  }
  function renderSearch(q) {
    searchList.innerHTML = '';
    for (const d of filteredDefs(q).slice(0, 40)) {
      const it = doc.createElement('div'); it.className = 'pb-item';
      const n = doc.createElement('span'); n.textContent = d.title;
      const t = doc.createElement('span'); t.className = 't'; t.textContent = d.type;
      it.append(n, t);
      it.addEventListener('mousedown', (e) => { e.preventDefault(); addModuleAt(d.type); closeSearch(); });
      searchList.appendChild(it);
    }
  }
  function openAddSearch() { hideMenus(); searchInput.value = ''; renderSearch(''); searchPop.classList.add('open'); searchInput.focus(); }
  function closeSearch() { searchPop.classList.remove('open'); }
  searchInput.addEventListener('input', () => renderSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeSearch();
    else if (e.key === 'Enter') { const d = filteredDefs(searchInput.value)[0]; if (d) { addModuleAt(d.type); closeSearch(); } }
  });

  // ── engine + renderer + interaction ──
  let dirty = false;
  let showFlow = false;     // View → Show flow (signal-flow animation, Phase 4)
  let inspectedId = null;   // the module the inspector is pinned to (explicit open only)
  let undoStack = [], redoStack = [], lastCommitted = null;   // undo: rack-doc snapshots
  const markDirty = () => { if (!dirty) { dirty = true; onDirty(true); } };
  const engine = createEngine(sr, { bus, sr });
  const pb = createPb(canvas.getContext('2d'));
  const renderer = createRenderer({ canvas, engine, pb, colors: readThemeColors(doc.documentElement) });

  // load rack
  const store = new LooseFileStore(bus, tab && tab.path);
  let rackDoc = ctx.doc || null;
  function applyDoc(d) {
    const rack = deserializeRack(d || blankRack(), engine);
    renderer.setRack(rack);
    renderer.resize(); renderer.fitToViewport();
    lastCommitted = currentDoc();          // baseline for undo; a fresh load resets history
    undoStack.length = 0; redoStack.length = 0;
  }
  if (rackDoc) applyDoc(rackDoc);
  else {
    applyDoc(blankRack());
    if (tab && tab.path) store.load().then((d) => { if (d) { engine.destroy(); applyDoc(d); } }).catch(() => {});
  }

  // ── undo / redo ── snapshot the rack doc at each commit point; restore by
  // rebuilding the engine. commit() = an undoable checkpoint (also marks
  // dirty); markDirty() alone is for live/continuous edits (slider drags).
  function currentDoc() { return serializeRack(engine, renderer.rack); }
  function commit() {
    if (lastCommitted) { undoStack.push(lastCommitted); if (undoStack.length > 80) undoStack.shift(); }
    redoStack = [];
    lastCommitted = currentDoc();
    markDirty();
  }
  function restoreDoc(d) {
    closeInspector(); interaction.select(null);
    engine.destroy();
    renderer.setRack(deserializeRack(d, engine));
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(lastCommitted); lastCommitted = undoStack.pop();
    restoreDoc(lastCommitted); markDirty();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(lastCommitted); lastCommitted = redoStack.pop();
    restoreDoc(lastCommitted); markDirty();
  }

  const interaction = attachInteraction(renderer, engine, canvas, {
    onChange: commit,
    // Selection only highlights; the inspector opens on an explicit action
    // (double-click here, or right-click → Configure / Edit → Configure).
    onConfigure: (id) => openInspector(id),
    wireColor: () => wireColor,
  });

  // ── insert (palette + context menu) / fit ──
  function addModuleAt(type, place) {
    const def = getModuleDef(type); if (!def) return;
    engine.addInstance(freshId(engine, type), type, place || freeSlot(engine, renderer.rack, def));
    commit();
  }
  function slotAtWorld(def, wx, wy) {
    const ys = renderer.rowYs();
    let row = 0, bd = Infinity;
    for (let i = 0; i < ys.length; i++) { const d = Math.abs(wy - ys[i]); if (d < bd) { bd = d; row = i; } }
    const hpPos = Math.max(0, Math.min(renderer.rack.hp - def.hp, Math.round((wx - RAIL_LEFT) / HP)));
    return renderer.overlaps({ def, row, hpPos }, row, hpPos) ? freeSlot(engine, renderer.rack, def) : { row, hpPos };
  }

  function duplicateModule(id) {
    const inst = engine.instances.get(id); if (!inst) return;
    const knobs = {}; for (const n in inst.knobs) knobs[n] = inst.knobs[n].read();
    const place = freeSlot(engine, renderer.rack, inst.def);
    engine.addInstance(freshId(engine, inst.type), inst.type, { ...place, knobs, params: { ...inst.params } });
    commit();
  }

  // Copy / paste a single module (type + knob / control / param / appearance).
  let _clipboard = null;
  function snapshotInst(inst) {
    const knobs = {}; for (const n in inst.knobs) knobs[n] = inst.knobs[n].read();
    const controls = {};
    for (const n in inst.controls) controls[n] = inst.controls[n].def.kind === 'button' ? 0 : inst.controls[n].read();
    return { type: inst.type, knobs, controls, params: { ...inst.params }, color: inst.color, style: inst.style };
  }
  function copySelected() {
    const inst = interaction.state.selectedId && engine.instances.get(interaction.state.selectedId);
    if (inst) _clipboard = snapshotInst(inst);
  }
  function pasteClipboard() {
    if (!_clipboard) return;
    const def = getModuleDef(_clipboard.type); if (!def) return;
    const place = freeSlot(engine, renderer.rack, def);
    engine.addInstance(freshId(engine, _clipboard.type), _clipboard.type, { ...place, ..._clipboard });
    commit();
  }

  // Inspector is opened only by an explicit action (double-click / right-click
  // Configure / Edit menu), never by mere selection — it stays pinned to one
  // module until closed or that module is removed.
  function openInspector(id) { if (engine.instances.has(id)) { inspectedId = id; renderInspector(id); } }
  function closeInspector() { inspectedId = null; renderInspector(null); }
  function removeModule(id) {
    engine.removeInstance(id);
    if (interaction.state.selectedId === id) interaction.select(null);
    if (inspectedId === id) closeInspector();
    commit();
  }

  // ── rack mutators (Rack settings panel) ──
  function addRow(kind) {
    const r = renderer.rack;
    renderer.setRack({ ...r, rows: [...r.rows, { kind }] });
    renderer.fitToViewport(); commit();
  }
  function removeRowAt(i) {
    const r = renderer.rack;
    if (r.rows.length <= 1) return;
    // modules in the removed row fall to the previous row; later rows shift up.
    for (const inst of engine.instances.values()) {
      if (inst.row === i) inst.row = Math.max(0, i - 1);
      else if (inst.row > i) inst.row -= 1;
    }
    renderer.setRack({ ...r, rows: r.rows.filter((_, idx) => idx !== i) });
    renderer.fitToViewport(); commit();
  }
  // Set the rack width in HP (absolute), clamping module positions to fit.
  function setRackWidth(hp) {
    hp = Math.max(16, Math.min(256, hp | 0));
    const r = renderer.rack;
    for (const inst of engine.instances.values()) {
      inst.hpPos = Math.max(0, Math.min(hp - inst.def.hp, inst.hpPos));
    }
    renderer.setRack({ ...r, hp });
    renderer.fitToViewport();
  }

  // ── menubar (injected MenuBar) ──
  function moduleAddMenu() {
    const out = [{ label: 'Find module…', action: 'add:find', shortcut: 'Ctrl+K' }, '---'];
    for (const [grp, defs] of moduleGroups()) {
      out.push({ label: grp, children: defs.map((d) => ({ label: d.title, action: 'add:' + d.type })) });
    }
    return out;
  }
  // Action dispatch — shared by the menubar, the Ctrl+S handler, and tests.
  function runAction(a) {
    if (a === 'add:find') { setTimeout(openAddSearch, 0); return; }   // defer past the menu's own click
    if (a.startsWith('add:')) return addModuleAt(a.slice(4));
    const sel = interaction.state.selectedId;
    switch (a) {
      case 'file:save': flush(); break;
      case 'edit:undo': undo(); break;
      case 'edit:redo': redo(); break;
      case 'edit:copy': copySelected(); break;
      case 'edit:paste': pasteClipboard(); break;
      case 'edit:configure': if (sel) openInspector(sel); break;
      case 'edit:dup': if (sel) duplicateModule(sel); break;
      case 'edit:del': if (sel) removeModule(sel); break;
      case 'view:fit': renderer.fitToViewport(); break;
      case 'view:rails': interaction.setRailsOn(!interaction.state.railsOn); break;
      case 'view:flow': showFlow = !showFlow; break;
      case 'rack:settings': openRackSettings(); break;
      case 'rack:add3u': addRow('3U'); break;
      case 'rack:add1u': addRow('1U'); break;
    }
  }

  let menubar = null;
  if (MenuBar) {
    // NOTE: top-level MenuBar sections use `items:` (what _openSection reads);
    // `children:` is only for nested submenu entries (the Add categories below).
    menubar = new MenuBar(menubarHost, () => [
      { label: 'File', items: () => [
        { label: 'Save', action: 'file:save', shortcut: 'Ctrl+S' },
      ] },
      { label: 'Add', items: () => moduleAddMenu() },
      { label: 'Edit', items: () => [
        { label: 'Undo', action: 'edit:undo', shortcut: 'Ctrl+Z', disabled: !undoStack.length },
        { label: 'Redo', action: 'edit:redo', shortcut: 'Ctrl+Shift+Z', disabled: !redoStack.length },
        '---',
        { label: 'Copy',  action: 'edit:copy', shortcut: 'Ctrl+C', disabled: !interaction.state.selectedId },
        { label: 'Paste', action: 'edit:paste', shortcut: 'Ctrl+V', disabled: !_clipboard },
        '---',
        { label: 'Configure…', action: 'edit:configure', disabled: !interaction.state.selectedId },
        { label: 'Duplicate',  action: 'edit:dup', disabled: !interaction.state.selectedId },
        { label: 'Delete',     action: 'edit:del', disabled: !interaction.state.selectedId },
      ] },
      { label: 'View', items: () => [
        { label: 'Fit to window', action: 'view:fit' },
        '---',
        { label: 'Rails',     action: 'view:rails', checked: interaction.state.railsOn },
        { label: 'Show flow', action: 'view:flow',  checked: showFlow },
      ] },
      { label: 'Rack', items: () => [
        { label: 'Rack settings…', action: 'rack:settings' },
        '---',
        { label: 'Add 3U row',     action: 'rack:add3u' },
        { label: 'Add 1U row',     action: 'rack:add1u' },
      ] },
    ]);
    menubar.on('action', runAction);
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const { x: wx, y: wy } = renderer.screenToWorld(sx, sy);
    const hitMod = renderer.findModuleAt(wx, wy);
    ctxMenu.innerHTML = '';
    if (hitMod) {
      interaction.select(hitMod.id);
      const mkItem = (label, fn, danger) => {
        const it = doc.createElement('div'); it.className = 'pb-item' + (danger ? ' danger' : '');
        it.textContent = label;
        it.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); hideMenus(); });
        ctxMenu.appendChild(it);
      };
      mkItem('Configure ' + hitMod.def.title, () => openInspector(hitMod.id));
      mkItem('Duplicate', () => duplicateModule(hitMod.id));
      mkItem('Delete', () => removeModule(hitMod.id), true);
    } else {
      const hitCable = renderer.findCableAt(wx, wy);
      if (hitCable) {
        const it = doc.createElement('div'); it.className = 'pb-item danger'; it.textContent = 'Remove cable';
        it.addEventListener('click', (ev) => { ev.stopPropagation(); engine.removeCable(hitCable); commit(); hideMenus(); });
        ctxMenu.appendChild(it);
      } else {
        renderModuleList(ctxMenu, (type) => { addModuleAt(type, slotAtWorld(getModuleDef(type), wx, wy)); hideMenus(); });
        const rs = doc.createElement('div'); rs.className = 'pb-item'; rs.textContent = 'Rack settings…';
        rs.addEventListener('click', (ev) => { ev.stopPropagation(); openRackSettings(); hideMenus(); });
        ctxMenu.insertBefore(rs, ctxMenu.firstChild);
      }
    }
    ctxMenu.style.left = Math.max(4, Math.min(sx, host.clientWidth - 172)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(sy, host.clientHeight - 80)) + 'px';
    ctxMenu.classList.add('open');
  });

  // Dismiss popovers on any plain click outside them. Chips + the toolbar
  // button stopPropagation, so picks don't self-close (multi-add) and the
  // toggle isn't immediately undone.
  const onDocClick = (e) => { hideMenus(); if (!searchPop.contains(e.target)) closeSearch(); };
  doc.addEventListener('click', onDocClick);

  // Ctrl/Cmd+S inside the surface. Once the canvas has focus the shell's
  // window-level handler never sees the keystroke (it fires in this iframe),
  // so the surface flushes itself — same pattern as the text editor surface.
  const onKeyDown = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); flush(); }
    else if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    else if (k === 'z') { e.preventDefault(); undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'c') { copySelected(); }
    else if (k === 'v') { pasteClipboard(); }
    else if (k === 'k') { e.preventDefault(); openAddSearch(); }
  };
  doc.addEventListener('keydown', onKeyDown);

  // ── slide-out inspector ──
  // Live-bound: sideact effects tie knob sliders + output readouts to the
  // instance signals, so dragging a knob on the canvas updates the panel in
  // real time (and vice-versa). Effects are disposed on re-select / close.
  let _inspEffects = [];
  const fmt = (v) => (typeof v === 'number' && isFinite(v)) ? (Math.round(v * 1000) / 1000)
    : (v == null ? '—' : String(v).slice(0, 16));
  function clearInspEffects() { for (const d of _inspEffects) { try { d(); } catch { /* ignore */ } } _inspEffects = []; }

  function renderInspector(id) {
    clearInspEffects();
    const inst = id && engine.instances.get(id);
    if (!inst) { insp.classList.remove('open'); return; }
    inspH4.textContent = inst.def.title;
    inspH4.style.color = readThemeColors(doc.documentElement)[inst.def.color] || 'inherit';
    inspTy.textContent = inst.type + '  ·  ' + inst.id;
    inspBody.innerHTML = '';

    const section = (name) => { const s = doc.createElement('div'); s.className = 'pb-sec'; s.textContent = name; inspBody.appendChild(s); };

    // Params (config — text / number / select)
    if (Object.keys(inst.def.params).length) {
      section('Config');
      for (const [pn, pspec] of Object.entries(inst.def.params)) {
        const lab = doc.createElement('label'); lab.textContent = pspec.label || pn; inspBody.appendChild(lab);
        let inp;
        if (pspec.kind === 'select' && Array.isArray(pspec.options)) {
          inp = doc.createElement('select');
          for (const o of pspec.options) { const opt = doc.createElement('option'); opt.value = o; opt.textContent = o; inp.appendChild(opt); }
          inp.value = inst.params[pn] != null ? inst.params[pn] : pspec.default;
          inp.addEventListener('change', () => { engine.setParam(inst.id, pn, inp.value); commit(); });
        } else {
          inp = doc.createElement('input');
          inp.type = pspec.kind === 'number' ? 'number' : 'text';
          inp.value = inst.params[pn] != null ? inst.params[pn] : '';
          inp.addEventListener('change', () => {
            engine.setParam(inst.id, pn, pspec.kind === 'number' ? parseFloat(inp.value) : inp.value); commit();
          });
        }
        inspBody.appendChild(inp);
      }
    }

    // Knobs (live-bound both ways)
    if (inst.def.knobs.length) {
      section('Knobs');
      for (const k of inst.def.knobs) {
        const lab = doc.createElement('label');
        const v = doc.createElement('span'); v.className = 'v';
        lab.textContent = k.label + ' '; lab.appendChild(v);
        const inp = doc.createElement('input'); inp.type = 'range'; inp.min = k.min; inp.max = k.max; inp.step = (k.max - k.min) / 200;
        inp.addEventListener('input', () => { engine.setKnob(inst.id, k.name, parseFloat(inp.value)); markDirty(); });
        inp.addEventListener('change', commit);   // one undo step per drag
        inspBody.append(lab, inp);
        // bind: knob signal → slider position + value label
        _inspEffects.push(sr.effect(() => {
          const val = inst.knobs[k.name].read();
          v.textContent = fmt(val);
          if (document.activeElement !== inp) inp.value = val;
        }));
      }
    }

    // Interactive controls (toggle / switch / fader / button) — live-bound.
    if (inst.def.controls.length) {
      section('Controls');
      for (const c of inst.def.controls) {
        const lab = doc.createElement('label');
        const v = doc.createElement('span'); v.className = 'v';
        lab.textContent = c.label + ' '; lab.appendChild(v);
        if (c.kind === 'fader') {
          const inp = doc.createElement('input'); inp.type = 'range'; inp.min = c.min; inp.max = c.max; inp.step = (c.max - c.min) / 200;
          inp.addEventListener('input', () => { engine.setControl(inst.id, c.name, parseFloat(inp.value)); markDirty(); });
          inp.addEventListener('change', commit);
          inspBody.append(lab, inp);
          _inspEffects.push(sr.effect(() => { const val = inst.controls[c.name].read(); v.textContent = fmt(val); if (document.activeElement !== inp) inp.value = val; }));
        } else if (c.kind === 'switch') {
          const inp = doc.createElement('select');
          for (let i = 0; i < c.count; i++) { const o = doc.createElement('option'); o.value = i; o.textContent = (c.positions && c.positions[i]) || ('pos ' + i); inp.appendChild(o); }
          inp.addEventListener('change', () => { engine.setControl(inst.id, c.name, parseInt(inp.value, 10)); commit(); });
          inspBody.append(lab, inp);
          _inspEffects.push(sr.effect(() => { const val = inst.controls[c.name].read() | 0; v.textContent = (c.positions && c.positions[val]) || val; if (document.activeElement !== inp) inp.value = val; }));
        } else {
          // toggle / button → a press button
          const btn = doc.createElement('button'); btn.className = 'pb-del'; btn.style.cssText = 'margin-top:2px;background:var(--sw-bg-deep);border-color:var(--sw-border);color:var(--sw-text)';
          inspBody.append(lab, btn);
          if (c.kind === 'button') {
            btn.textContent = 'PRESS';
            btn.addEventListener('pointerdown', () => { engine.setControl(inst.id, c.name, 1); markDirty(); });
            const rel = () => engine.setControl(inst.id, c.name, 0);
            btn.addEventListener('pointerup', rel); btn.addEventListener('pointerleave', rel);
          } else {
            btn.addEventListener('click', () => { engine.setControl(inst.id, c.name, (engine.controlValue(inst.id, c.name) | 0) ? 0 : 1); commit(); });
          }
          _inspEffects.push(sr.effect(() => {
            const on = (inst.controls[c.name].read() | 0) === 1;
            v.textContent = c.kind === 'button' ? '' : (on ? 'ON' : 'OFF');
            if (c.kind === 'toggle') { btn.textContent = on ? 'ON' : 'OFF'; btn.style.color = on ? 'var(--sw-green)' : 'var(--sw-text-soft)'; }
          }));
        }
      }
    }

    // Live output readouts
    if (Object.keys(inst.outputs).length) {
      section('Outputs');
      for (const name of Object.keys(inst.outputs)) {
        const row = doc.createElement('div'); row.className = 'pb-readout';
        const n = doc.createElement('span'); n.className = 'n'; n.textContent = name;
        const rv = doc.createElement('span'); rv.className = 'rv';
        row.append(n, rv); inspBody.appendChild(row);
        _inspEffects.push(sr.effect(() => { rv.textContent = fmt(inst.outputs[name].read()); }));
      }
    }

    // Appearance — per-instance accent + panel-style override.
    section('Appearance');
    const dropdown = (labelText, options, current, defLabel, onPick) => {
      const lab = doc.createElement('label'); lab.textContent = labelText; inspBody.appendChild(lab);
      const sel = doc.createElement('select');
      const d0 = doc.createElement('option'); d0.value = ''; d0.textContent = 'default · ' + defLabel; sel.appendChild(d0);
      for (const o of options) { const op = doc.createElement('option'); op.value = o; op.textContent = o; sel.appendChild(op); }
      sel.value = current || '';
      sel.addEventListener('change', () => onPick(sel.value || null));
      inspBody.appendChild(sel);
    };
    dropdown('Accent', WIRE_COLORS, inst.color, inst.def.color, (v) => {
      engine.setAppearance(inst.id, 'color', v); commit();
      inspH4.style.color = readThemeColors(doc.documentElement)[v || inst.def.color] || 'inherit';
    });
    dropdown('Panel style', listStyles(), inst.style, inst.def.style, (v) => {
      engine.setAppearance(inst.id, 'style', v); commit();
    });

    const del = doc.createElement('button'); del.className = 'pb-del'; del.textContent = 'delete module';
    del.addEventListener('click', () => removeModule(inst.id));
    inspBody.appendChild(del);

    insp.classList.add('open');
  }
  inspX.addEventListener('click', () => closeInspector());

  // ── rack settings (the slide-out, in rack mode) ──
  function openRackSettings() {
    inspectedId = null;
    clearInspEffects();
    const tc = readThemeColors(doc.documentElement);
    const rk = () => renderer.rack;
    inspH4.textContent = 'Rack';
    inspH4.style.color = tc.orange || 'inherit';
    const updTy = () => { inspTy.textContent = rk().hp + ' HP · ' + rk().rows.length + ' rows'; };
    updTy();
    inspBody.innerHTML = '';
    const section = (name) => { const s = doc.createElement('div'); s.className = 'pb-sec'; s.textContent = name; inspBody.appendChild(s); };

    // Width — precise slider + number.
    section('Width');
    const lab = doc.createElement('label'); const v = doc.createElement('span'); v.className = 'v'; v.textContent = rk().hp + ' HP';
    lab.textContent = 'width '; lab.appendChild(v);
    const slider = doc.createElement('input'); slider.type = 'range'; slider.min = 16; slider.max = 256; slider.step = 2; slider.value = rk().hp;
    const num = doc.createElement('input'); num.type = 'number'; num.min = 16; num.max = 256; num.value = rk().hp; num.style.marginTop = '4px';
    const applyW = (hp, commitIt) => {
      setRackWidth(hp); const w = rk().hp;
      v.textContent = w + ' HP'; slider.value = w; num.value = w; updTy();
      (commitIt ? commit : markDirty)();
    };
    slider.addEventListener('input', () => applyW(parseInt(slider.value, 10), false));
    slider.addEventListener('change', () => applyW(parseInt(slider.value, 10), true));
    num.addEventListener('change', () => applyW(parseInt(num.value, 10), true));
    inspBody.append(lab, slider, num);

    // Rows — list with per-row remove + add buttons.
    section('Rows');
    rk().rows.forEach((row, i) => {
      const line = doc.createElement('div'); line.className = 'pb-readout';
      const n = doc.createElement('span'); n.className = 'n'; n.textContent = (i + 1) + ' · ' + row.kind;
      const del = doc.createElement('span'); del.textContent = '✕';
      del.style.cssText = 'cursor:pointer;color:var(--sw-red,#D05048)' + (rk().rows.length <= 1 ? ';opacity:.3;pointer-events:none' : '');
      del.addEventListener('click', () => { removeRowAt(i); openRackSettings(); });
      line.append(n, del); inspBody.appendChild(line);
    });
    const addBtns = doc.createElement('div'); addBtns.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    for (const kind of ['3U', '1U']) {
      const b = doc.createElement('button'); b.className = 'pb-del';
      b.style.cssText = 'margin:0;background:var(--sw-bg-deep);border-color:var(--sw-border);color:var(--sw-text)';
      b.textContent = '+ ' + kind;
      b.addEventListener('click', () => { addRow(kind); openRackSettings(); });
      addBtns.appendChild(b);
    }
    inspBody.appendChild(addBtns);

    insp.classList.add('open');
  }

  // ── theme re-read on shell SettingsChanged ──
  let themeUnsub = null;
  if (bus && bus.subscribe) {
    themeUnsub = bus.subscribe({ interface: 'Shell', member: 'SettingsChanged' }, () => {
      setTimeout(() => renderer.setColors(readThemeColors(doc.documentElement)), 0);
    });
  }

  // ── render loop + resize ──
  let raf = 0;
  function frame() {
    interaction.state.showFlow = showFlow;
    renderer.draw(interaction.state);
    const z = Math.round(renderer.view.scale * 100);
    hud.textContent = engine.cables.length.toString().padStart(2, '0') + ' cab · ' + z + '%';
    raf = requestAnimationFrame(frame);
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => renderer.resize());
    ro.observe(canvas);
  } else if (typeof addEventListener !== 'undefined') {
    addEventListener('resize', () => renderer.resize());
  }
  raf = requestAnimationFrame(frame);

  // ── surface API ──
  async function flush() {
    if (!tab || !tab.path) return;
    await store.save(serializeRack(engine, renderer.rack));
    if (dirty) { dirty = false; onDirty(false); }
  }
  function dispose() {
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (typeof themeUnsub === 'function') { try { themeUnsub(); } catch { /* ignore */ } }
    doc.removeEventListener('click', onDocClick);
    doc.removeEventListener('keydown', onKeyDown);
    clearInspEffects();
    if (menubar && menubar.destroy) { try { menubar.destroy(); } catch { /* ignore */ } }
    interaction.detach();
    engine.destroy();
    try { root.removeChild(host); } catch { /* ignore */ }
  }

  return {
    flush, dispose,
    isDirty: () => dirty,
    engine, renderer, runAction,      // exposed for tests / debugging / shortcuts
    addModule: (type) => { const d = getModuleDef(type); if (d) { const s = freeSlot(engine, renderer.rack, d); engine.addInstance(freshId(engine, type), type, s); markDirty(); } },
    STDLIB_MODULES,
  };
}
