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
