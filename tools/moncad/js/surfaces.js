// moncad surfaces — friendly views over the one command registry (SPEC §3).
//
// The toolbar (curated buttons, tooltips teaching the key) and the command palette
// (type-to-find, fuzzy) both route through `reg.execute()`. A command registered once
// appears in both, with its keybinding honestly shown — a button IS its command, no
// drift. (The menubar, via @gcu/menu, and the command line slot in here next.)

export function makeToolbar(reg, ctx, mount, items) {
  mount.innerHTML = '';
  const btns = [];
  for (const id of items) {
    if (id === null) { const s = document.createElement('span'); s.className = 'tb-sep'; mount.appendChild(s); continue; }
    const cmd = reg.get(id); if (!cmd) continue;
    const b = document.createElement('button');
    b.className = 'tb-btn'; b.textContent = cmd.icon || cmd.title;
    const key = reg.keyFor(id);
    b.title = cmd.title + (key ? `  (${key.toUpperCase()})` : '');     // the tooltip teaches the key
    b.addEventListener('click', () => reg.execute(id, ctx));
    mount.appendChild(b); btns.push({ id, b });
  }
  const refresh = () => { for (const { id, b } of btns) b.disabled = !reg.isEnabled(id, ctx); };
  refresh();
  return { refresh };
}

// The command line (SPEC §3) — the typed surface with guided prompts. Friendly because it
// walks you through (`Specify next point or [Close/Undo]:`), and it's where the AutoLISP
// coordinate family (`10,5`, `@10,5`, `@10<45`) is entered. Pure glue: it owns no logic,
// just routes Enter/Escape to the app's handlers and renders the active prompt. The app
// decides what a submitted line means (a coordinate, a keyword, or a command), keeping the
// parse (input.js) and the tool state out of the DOM layer.
export function makeCommandLine(els, h) {
  const { input, prompt } = els;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value; input.value = ''; h.onSubmit(v); }
    else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; h.onCancel(); }
    else if (h.onKey && h.onKey(e)) { e.preventDefault(); }   // F3 / Tab reach the board even while the line is focused
    e.stopPropagation();      // typed keys are the command line's, not the board's shortcuts
  });
  return {
    focus: () => input.focus(),
    blur: () => input.blur(),
    clear: () => { input.value = ''; },
    setPrompt: (t) => { prompt.textContent = t; },
  };
}

// The snap-control chips (SPEC §7): a row of status-bar toggles for the master switch +
// each running snap type, right where you already read the snap state. They're a surface
// over the same registry — clicking a chip runs `snap.toggle` / `snap.<type>`, the
// identical command F3 / the palette fire — so the chip and the keystroke can't drift.
// refresh() reflects the live SnapState (on = info accent, off = dim, master-off = muted).
export function makeSnapChips(reg, ctx, mount, snap, types, labels) {
  mount.innerHTML = '';
  const chips = [];
  const master = document.createElement('button');
  master.className = 'chip chip-master'; master.textContent = 'SNAP';
  const mk = reg.keyFor('snap.toggle');
  master.title = 'Master snap toggle' + (mk ? ` (${mk.toUpperCase()})` : '');
  master.addEventListener('click', () => reg.execute('snap.toggle', ctx));
  mount.appendChild(master); chips.push({ kind: 'master', el: master });
  for (const t of types) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = labels[t];
    b.title = reg.get('snap.' + t)?.title || t;
    b.addEventListener('click', () => reg.execute('snap.' + t, ctx));
    mount.appendChild(b); chips.push({ kind: t, el: b });
  }
  const gridChip = document.createElement('button');     // grid snap — a separate mode (§7), not in the running set
  gridChip.className = 'chip'; gridChip.textContent = 'GRID'; gridChip.title = 'Grid snap';
  gridChip.addEventListener('click', () => reg.execute('snap.grid', ctx));
  mount.appendChild(gridChip); chips.push({ kind: 'grid', el: gridChip });
  const refresh = () => {
    master.classList.toggle('off', !snap.master);
    for (const c of chips) {
      if (c.kind === 'master') continue;
      const on = c.kind === 'grid' ? snap.gridSnap : (snap.master && snap.has(c.kind));
      c.el.classList.toggle('on', on);
      c.el.classList.toggle('off', !on);
    }
  };
  refresh();
  return { refresh };
}

// The layers panel — moncad's first inspector/properties surface (the deep tier of the GCU
// command model). A GIS-flavoured panel over a CAD-faithful data model: visibility, a
// colour swatch (click cycles), the active layer (where new geometry lands), and a per-layer
// opacity slider (the borrowed GIS affordance). `getModel()` returns the live Model (it's
// replaced on open/new). Handlers route every interaction back to the app.
const ACI7 = { 1: '#e23', 2: '#dc3', 3: '#3c5', 4: '#3cc', 5: '#46e', 6: '#c4d', 7: '#ddd' };
function swatchCss(c) {
  if (!c) return '#888';
  if (c.mode === 'rgb') return `rgb(${c.r},${c.g},${c.b})`;
  if (c.mode === 'aci') return ACI7[c.index] || '#aaa';
  return '#888';
}
export function makeLayersPanel(getModel, mount, h) {
  function row(L) {
    const r = document.createElement('div'); r.className = 'ly-row' + (L.name === h.active() ? ' active' : '');
    const vis = document.createElement('span'); vis.className = 'ly-vis'; vis.textContent = L.visible ? '◉' : '○'; vis.title = 'Show / hide';
    vis.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); h.onVisible(L.name); });
    const sw = document.createElement('span'); sw.className = 'ly-sw'; sw.style.background = swatchCss(L.color); sw.title = 'Colour (click to cycle)';
    sw.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); h.onColor(L.name); });
    const nm = document.createElement('span'); nm.className = 'ly-name'; nm.textContent = L.name; nm.title = 'Set current layer';
    nm.addEventListener('mousedown', (e) => { e.preventDefault(); h.onActive(L.name); });
    const op = document.createElement('input'); op.type = 'range'; op.min = '0'; op.max = '100'; op.value = String(Math.round((L.opacity != null ? L.opacity : 1) * 100)); op.className = 'ly-op'; op.title = 'Opacity';
    op.addEventListener('input', () => h.onOpacity(L.name, op.value / 100));
    r.append(vis, sw, nm, op);
    return r;
  }
  function refresh() {
    mount.innerHTML = '';
    const head = document.createElement('div'); head.className = 'ly-head';
    const t = document.createElement('span'); t.textContent = 'Layers';
    const add = document.createElement('button'); add.className = 'ly-add'; add.textContent = '+'; add.title = 'New layer';
    add.addEventListener('mousedown', (e) => { e.preventDefault(); h.onNew(); });
    head.append(t, add); mount.appendChild(head);
    for (const L of getModel().layerList()) mount.appendChild(row(L));
  }
  return { refresh };
}

// The context menu (SPEC §3) — the noun-first surface: right-click brings the verbs to the
// selection. Bespoke over the same registry (like the toolbar/palette/command-line here),
// so a right-click item and its keystroke can't drift and moncad keeps one styling. `items`
// is a list of command ids (null = separator); each is `when(ctx)`-filtered, so the menu is
// genuinely contextual. Clicking routes through reg.execute.
export function makeContextMenu(reg, ctx, root) {
  let open = false;
  const hide = () => { open = false; root.classList.remove('show'); root.innerHTML = ''; };
  function show(items, x, y) {
    root.innerHTML = '';
    let pendingSep = false, any = false;
    for (const id of items) {
      if (id === null) { pendingSep = any; continue; }
      const cmd = reg.get(id); if (!cmd || (cmd.when && !cmd.when(ctx))) continue;
      if (pendingSep) { const s = document.createElement('div'); s.className = 'ctx-sep'; root.appendChild(s); pendingSep = false; }
      const row = document.createElement('div'); row.className = 'ctx-item';
      const key = reg.keyFor(id);
      row.innerHTML = '<span class="ctx-t"></span><span class="ctx-k"></span>';
      row.children[0].textContent = cmd.title;
      row.children[1].textContent = key ? key.toUpperCase() : '';
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); hide(); reg.execute(id, ctx); });
      root.appendChild(row); any = true;
    }
    if (!any) return;
    open = true; root.classList.add('show');
    // place at the cursor, nudged back on-screen if it would overflow
    root.style.left = Math.min(x, window.innerWidth - root.offsetWidth - 4) + 'px';
    root.style.top = Math.min(y, window.innerHeight - root.offsetHeight - 4) + 'px';
  }
  window.addEventListener('mousedown', (e) => { if (open && !root.contains(e.target)) hide(); });
  window.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { e.stopPropagation(); hide(); } });
  return { show, hide, isOpen: () => open };
}

// The menubar (SPEC §3, GCU model) — GLOBAL commands only (File / Edit / View / Help); the
// draw/modify verbs live in the tool palette + context menu + palette, not here (no verb
// catalog → no Vulcan-land). Top labels open a shared dropdown (the .ctx styling); hover
// switches between open menus; disabled items grey out (when(ctx)). Same registry.
export function makeMenubar(reg, ctx, mount, menus, drop) {
  mount.innerHTML = ''; drop.classList.remove('show');
  const labels = [];
  let openIdx = -1;
  const close = () => { openIdx = -1; drop.classList.remove('show'); labels.forEach((l) => l.classList.remove('open')); };
  function openAt(i) {
    drop.innerHTML = '';
    let pendingSep = false, any = false;
    for (const id of menus[i].items) {
      if (id === null) { pendingSep = any; continue; }
      const cmd = reg.get(id); if (!cmd) continue;
      const disabled = cmd.when && !cmd.when(ctx);
      if (pendingSep) { const s = document.createElement('div'); s.className = 'ctx-sep'; drop.appendChild(s); pendingSep = false; }
      const row = document.createElement('div'); row.className = 'ctx-item' + (disabled ? ' disabled' : '');
      const key = reg.keyFor(id);
      row.innerHTML = '<span class="ctx-t"></span><span class="ctx-k"></span>';
      row.children[0].textContent = cmd.title; row.children[1].textContent = key ? key.toUpperCase() : '';
      if (!disabled) row.addEventListener('mousedown', (ev) => { ev.preventDefault(); close(); reg.execute(id, ctx); });
      drop.appendChild(row); any = true;
    }
    openIdx = i;
    labels.forEach((l, j) => l.classList.toggle('open', j === i));
    const r = labels[i].getBoundingClientRect();
    drop.style.left = r.left + 'px'; drop.style.top = r.bottom + 'px';
    drop.classList.add('show');
  }
  menus.forEach((m, i) => {
    const el = document.createElement('span'); el.className = 'mb-label'; el.textContent = m.label;
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); openIdx === i ? close() : openAt(i); });
    el.addEventListener('mouseenter', () => { if (openIdx >= 0 && openIdx !== i) openAt(i); });
    mount.appendChild(el); labels.push(el);
  });
  window.addEventListener('mousedown', (e) => { if (openIdx >= 0 && !drop.contains(e.target) && !mount.contains(e.target)) close(); });
  window.addEventListener('keydown', (e) => { if (openIdx >= 0 && e.key === 'Escape') close(); });
  return { close };
}

export function makePalette(reg, ctx, els) {
  const { root, input, list } = els;
  let items = [], sel = 0, open = false;

  function render() {
    items = reg.search(input.value, ctx);
    sel = 0;
    list.innerHTML = '';
    items.forEach((cmd, i) => {
      const row = document.createElement('div');
      row.className = 'pal-item' + (i === sel ? ' sel' : '');
      const key = reg.keyFor(cmd.id);
      row.innerHTML = `<span class="pal-t"></span><span class="pal-cat"></span><span class="pal-k"></span>`;
      row.children[0].textContent = cmd.title;
      row.children[1].textContent = cmd.category || '';
      row.children[2].textContent = key ? key.toUpperCase() : '';
      row.addEventListener('click', () => run(i));
      list.appendChild(row);
    });
  }
  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    [...list.children].forEach((r, i) => r.classList.toggle('sel', i === sel));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  }
  function run(i) { const cmd = items[i]; hide(); if (cmd) reg.execute(cmd.id, ctx); }
  function show() { open = true; root.classList.add('show'); input.value = ''; render(); input.focus(); }
  function hide() { open = false; root.classList.remove('show'); }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  root.addEventListener('mousedown', (e) => { if (e.target === root) hide(); });   // backdrop click closes
  return { show, hide, toggle: () => (open ? hide() : show()) };
}
