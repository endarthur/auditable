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
  const refresh = () => {
    master.classList.toggle('off', !snap.master);
    for (const c of chips) {
      if (c.kind === 'master') continue;
      const on = snap.master && snap.has(c.kind);
      c.el.classList.toggle('on', on);
      c.el.classList.toggle('off', !on);
    }
  };
  refresh();
  return { refresh };
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
