// @gcu/patchbay — surface glue. mountPatchbay(ctx) builds the canvas + chrome
// (toolbar, insert palette, properties panel) into ctx.root, wires the engine /
// renderer / interaction together, drives the rAF render loop, reads theme
// tokens, and returns { flush, dispose, isDirty } for the surface contract.
//
// ctx = { root, bus, tab, sr, doc?, onDirty? }
//   root   — element to render into (iframe body, or a privileged shadow root)
//   bus    — A-Bus peer (for the works VFS service + I/O modules)
//   tab    — { id, path, kind }
//   sr     — { signal, computed, effect, batch }
//   doc    — optional preloaded rack document (else loaded via LooseFileStore)
//   onDirty(bool) — optional dirty-state callback (drives the tab dot)

import { createEngine } from './engine.js';
import { createPb } from './pb.js';
import { createRenderer, DEFAULT_COLORS, RAIL_LEFT, HP } from './render.js';
import { attachInteraction } from './interact.js';
import { LooseFileStore, serializeRack, deserializeRack, blankRack } from './store.js';
import { registerStdlib, STDLIB_MODULES } from './stdlib.js';
import { getModuleDef, listModuleDefs } from './sdk.js';

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

  // ── DOM scaffold ──
  const host = doc.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--sw-bg,#15171A);';
  const canvas = doc.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;user-select:none;';
  host.appendChild(canvas);

  const css = `
    .pb-bar{position:absolute;top:8px;left:8px;display:flex;gap:6px;z-index:5;align-items:center}
    .pb-btn{background:var(--sw-bg-raised,#1D2024);border:1px solid var(--sw-border,#2F3338);color:var(--sw-text,#DDD);
      border-radius:4px;padding:6px 10px;font:10px/1 "Space Mono",monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
    .pb-btn:hover{background:var(--sw-bg-bright,#25282D)}
    .pb-btn.on{background:rgba(212,103,46,.22);border-color:var(--sw-orange,#D4672E);color:var(--sw-orange,#D4672E)}
    .pb-pop{position:absolute;z-index:8;background:rgba(20,23,26,.97);border:1px solid var(--sw-border,#2F3338);
      border-radius:6px;padding:5px;min-width:158px;max-height:74vh;overflow:auto;box-shadow:0 8px 28px rgba(0,0,0,.5);
      font:12px/1.4 Barlow,system-ui,sans-serif;display:none}
    .pb-pop.open{display:block}
    .pb-grp{font:600 9px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--sw-orange,#D4672E);padding:7px 6px 2px}
    .pb-item{display:flex;justify-content:space-between;gap:12px;padding:5px 8px;border-radius:4px;cursor:pointer;color:var(--sw-text,#DDD)}
    .pb-item:hover{background:var(--sw-bg-bright,#25282D)}
    .pb-item .t{color:var(--sw-text-soft,#6E6C68);font:10px/1.5 "Space Mono",monospace}
    .pb-item.danger{color:var(--sw-red,#D05048)}
    .pb-props{position:absolute;top:8px;right:8px;width:208px;z-index:5;background:rgba(29,32,36,.94);
      border:1px solid var(--sw-border,#2F3338);border-radius:5px;padding:10px;color:var(--sw-text,#DDD);
      font:12px/1.5 Barlow,system-ui,sans-serif;display:none}
    .pb-props h4{margin:0 0 6px;font:700 12px "Space Mono",monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--sw-orange,#D4672E)}
    .pb-props label{display:block;font-size:10px;color:var(--sw-text-soft,#6E6C68);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 2px}
    .pb-props input{width:100%;background:var(--sw-bg-deep,#0E1012);border:1px solid var(--sw-border,#2F3338);
      color:var(--sw-text,#DDD);border-radius:3px;padding:4px 6px;font:11px "Space Mono",monospace;box-sizing:border-box}
    .pb-props input[type=range]{padding:0}
    .pb-props select{width:100%;background:var(--sw-bg-deep,#0E1012);border:1px solid var(--sw-border,#2F3338);
      color:var(--sw-text,#DDD);border-radius:3px;padding:4px 6px;font:11px "Space Mono",monospace;box-sizing:border-box}
    .pb-del{margin-top:12px;width:100%;background:rgba(208,80,72,.15);border-color:var(--sw-red,#D05048);color:var(--sw-red,#D05048)}
    .pb-hud{position:absolute;bottom:8px;right:8px;z-index:5;font:9.5px "Space Mono",monospace;color:var(--sw-text-soft,#6E6C68);
      background:rgba(29,32,36,.88);border:1px solid var(--sw-border,#2F3338);border-radius:4px;padding:5px 8px}
  `;
  const styleEl = doc.createElement('style'); styleEl.textContent = css; host.appendChild(styleEl);

  const bar = doc.createElement('div'); bar.className = 'pb-bar';
  const paletteBtn = doc.createElement('button'); paletteBtn.className = 'pb-btn'; paletteBtn.textContent = '+ module';
  const fitBtn = doc.createElement('button'); fitBtn.className = 'pb-btn'; fitBtn.textContent = 'fit';
  bar.append(paletteBtn, fitBtn); host.appendChild(bar);

  // Palette popover (toolbar) + context menu (right-click) — both list module
  // types grouped by category and share renderModuleList.
  const palette = doc.createElement('div'); palette.className = 'pb-pop';
  palette.style.top = '44px'; palette.style.left = '8px';
  host.appendChild(palette);
  const ctxMenu = doc.createElement('div'); ctxMenu.className = 'pb-pop'; host.appendChild(ctxMenu);

  const props = doc.createElement('div'); props.className = 'pb-props'; host.appendChild(props);
  const hud = doc.createElement('div'); hud.className = 'pb-hud'; host.appendChild(hud);
  root.appendChild(host);

  const PREFIX_LABEL = { src: 'Sources', math: 'Math', logic: 'Logic', ctrl: 'Control', disp: 'Display', io: 'I/O' };
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
  function hideMenus() { palette.classList.remove('open'); paletteBtn.classList.remove('on'); ctxMenu.classList.remove('open'); }

  // ── engine + renderer + interaction ──
  let dirty = false;
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
  }
  if (rackDoc) applyDoc(rackDoc);
  else {
    applyDoc(blankRack());
    if (tab && tab.path) store.load().then((d) => { if (d) { engine.destroy(); applyDoc(d); } }).catch(() => {});
  }

  const interaction = attachInteraction(renderer, engine, canvas, {
    onChange: markDirty,
    onSelect: (id) => renderProps(id),
  });

  // ── insert (palette + context menu) / fit ──
  function addModuleAt(type, place) {
    const def = getModuleDef(type); if (!def) return;
    engine.addInstance(freshId(engine, type), type, place || freeSlot(engine, renderer.rack, def));
    markDirty();
  }
  function slotAtWorld(def, wx, wy) {
    const ys = renderer.rowYs();
    let row = 0, bd = Infinity;
    for (let i = 0; i < ys.length; i++) { const d = Math.abs(wy - ys[i]); if (d < bd) { bd = d; row = i; } }
    const hpPos = Math.max(0, Math.min(renderer.rack.hp - def.hp, Math.round((wx - RAIL_LEFT) / HP)));
    return renderer.overlaps({ def, row, hpPos }, row, hpPos) ? freeSlot(engine, renderer.rack, def) : { row, hpPos };
  }

  paletteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctxMenu.classList.remove('open');
    const open = !palette.classList.contains('open');
    if (open) renderModuleList(palette, (type) => addModuleAt(type));   // stays open for multi-add
    palette.classList.toggle('open', open);
    paletteBtn.classList.toggle('on', open);
  });
  fitBtn.addEventListener('click', () => renderer.fitToViewport());

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    palette.classList.remove('open'); paletteBtn.classList.remove('on');
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const { x: wx, y: wy } = renderer.screenToWorld(sx, sy);
    const hitMod = renderer.findModuleAt(wx, wy);
    ctxMenu.innerHTML = '';
    if (hitMod) {
      interaction.select(hitMod.id);
      const it = doc.createElement('div'); it.className = 'pb-item danger';
      it.textContent = 'Delete ' + hitMod.def.title;
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        engine.removeInstance(hitMod.id); interaction.select(null); renderProps(null); markDirty(); hideMenus();
      });
      ctxMenu.appendChild(it);
    } else {
      renderModuleList(ctxMenu, (type) => { addModuleAt(type, slotAtWorld(getModuleDef(type), wx, wy)); hideMenus(); });
    }
    ctxMenu.style.left = Math.max(4, Math.min(sx, host.clientWidth - 172)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(sy, host.clientHeight - 80)) + 'px';
    ctxMenu.classList.add('open');
  });

  // Dismiss popovers on any plain click outside them. Chips + the toolbar
  // button stopPropagation, so picks don't self-close (multi-add) and the
  // toggle isn't immediately undone.
  const onDocClick = () => hideMenus();
  doc.addEventListener('click', onDocClick);

  // ── properties panel ──
  function renderProps(id) {
    const inst = id && engine.instances.get(id);
    if (!inst) { props.style.display = 'none'; return; }
    props.style.display = 'block';
    props.innerHTML = '';
    const h = doc.createElement('h4'); h.textContent = inst.def.title; props.appendChild(h);
    const sub = doc.createElement('div'); sub.style.cssText = 'font:10px "Space Mono",monospace;color:var(--sw-text-soft,#6E6C68);margin-bottom:4px';
    sub.textContent = inst.type + '  ·  ' + inst.id; props.appendChild(sub);

    for (const [pn, pspec] of Object.entries(inst.def.params)) {
      const lab = doc.createElement('label'); lab.textContent = pspec.label || pn; props.appendChild(lab);
      let inp;
      if (pspec.kind === 'select' && Array.isArray(pspec.options)) {
        inp = doc.createElement('select');
        for (const o of pspec.options) { const opt = doc.createElement('option'); opt.value = o; opt.textContent = o; inp.appendChild(opt); }
        inp.value = inst.params[pn] != null ? inst.params[pn] : pspec.default;
        inp.addEventListener('change', () => { engine.setParam(inst.id, pn, inp.value); markDirty(); });
      } else {
        inp = doc.createElement('input');
        inp.type = pspec.kind === 'number' ? 'number' : 'text';
        inp.value = inst.params[pn] != null ? inst.params[pn] : '';
        inp.addEventListener('change', () => {
          const v = pspec.kind === 'number' ? parseFloat(inp.value) : inp.value;
          engine.setParam(inst.id, pn, v); markDirty();
        });
      }
      props.appendChild(inp);
    }
    for (const k of inst.def.knobs) {
      const lab = doc.createElement('label'); lab.textContent = k.label + ' (' + (Math.round(engine.knobValue(inst.id, k.name) * 100) / 100) + ')';
      props.appendChild(lab);
      const inp = doc.createElement('input'); inp.type = 'range'; inp.min = k.min; inp.max = k.max;
      inp.step = (k.max - k.min) / 200; inp.value = engine.knobValue(inst.id, k.name);
      inp.addEventListener('input', () => { engine.setKnob(inst.id, k.name, parseFloat(inp.value)); lab.textContent = k.label + ' (' + (Math.round(parseFloat(inp.value) * 100) / 100) + ')'; markDirty(); });
      props.appendChild(inp);
    }
    const del = doc.createElement('button'); del.className = 'pb-btn pb-del'; del.textContent = 'delete module';
    del.addEventListener('click', () => { engine.removeInstance(inst.id); interaction.select(null); renderProps(null); markDirty(); });
    props.appendChild(del);
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
    interaction.detach();
    engine.destroy();
    try { root.removeChild(host); } catch { /* ignore */ }
  }

  return {
    flush, dispose,
    isDirty: () => dirty,
    engine, renderer,                 // exposed for tests / debugging
    addModule: (type) => { const d = getModuleDef(type); if (d) { const s = freeSlot(engine, renderer.rack, d); engine.addInstance(freshId(engine, type), type, s); markDirty(); } },
    STDLIB_MODULES,
  };
}
