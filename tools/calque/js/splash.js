// Project management + splash screen

const EXAMPLES = {
  'Sales Report': STARTER,
  'Budget': `Income {
  source = ["Salary", "Freelance", "Dividends"]
  monthly = [5000, 1200, 300]
  annual = monthly * 12
}

Expenses {
  category = ["Rent", "Food", "Transport", "Savings"]
  monthly = [1500, 600, 200, 800]
  annual = monthly * 12
}

Balance {
  total_income = sum(Income.monthly)
  total_expenses = sum(Expenses.monthly)
  net = total_income - total_expenses
  status = if net > 0 then "surplus" else "deficit"
}`,
  'Math': `Sequences {
  n = 1..10
  squares = n ^ 2
  cubes = n ^ 3
  factorials = scan(1..10, 1, (a, b) -> a * b)
}

Stats {
  data = [4, 8, 15, 16, 23, 42]
  avg = mean(data)
  total = sum(data)
  hi = max(data)
  lo = min(data)
  spread = hi - lo
}`,
  'Strings': `People {
  first = ["Alice", "Bob", "Carol"]
  last = ["Smith", "Jones", "Lee"]
  full = first & " " & last
  initials = left(first, 1) & left(last, 1)
  name_len = len(full)
}

Summary {
  count = count(People.first)
  longest = max(People.name_len)
}`,
};

// ── Project CRUD ──

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getProjects() {
  try { return JSON.parse(localStorage.getItem('cq-projects') || '[]'); }
  catch { return []; }
}

function setProjects(list) {
  localStorage.setItem('cq-projects', JSON.stringify(list));
}

function projectCreate(source, name) {
  const id = genId();
  const list = getProjects();
  list.unshift({ id, name: name || 'untitled', ts: Date.now() });
  if (list.length > 20) {
    const removed = list.splice(20);
    for (const r of removed) localStorage.removeItem('cq-project:' + r.id);
  }
  setProjects(list);
  localStorage.setItem('cq-project:' + id, source);
  localStorage.setItem('cq-active', id);
  CQ.projectId = id;
  return id;
}

function projectSave() {
  if (!CQ.projectId) return;
  localStorage.setItem('cq-project:' + CQ.projectId, CQ.source);
  const list = getProjects();
  const entry = list.find(p => p.id === CQ.projectId);
  if (entry) {
    entry.ts = Date.now();
    setProjects(list);
  }
}

function projectUpdateName(name) {
  if (!CQ.projectId) return;
  const list = getProjects();
  const entry = list.find(p => p.id === CQ.projectId);
  if (entry) {
    entry.name = name;
    setProjects(list);
  }
}

function projectLoad(id) {
  const src = localStorage.getItem('cq-project:' + id);
  if (src == null) return null;
  localStorage.setItem('cq-active', id);
  CQ.projectId = id;
  return src;
}

function projectRemove(id) {
  let list = getProjects();
  list = list.filter(p => p.id !== id);
  setProjects(list);
  localStorage.removeItem('cq-project:' + id);
  if (localStorage.getItem('cq-active') === id) {
    localStorage.removeItem('cq-active');
  }
}

// ── Time formatting ──

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return d + ' days ago';
  return new Date(ts).toLocaleDateString();
}

// ── Splash screen ──

function showSplash(onSelect) {
  const projects = getProjects();
  const activeId = localStorage.getItem('cq-active');

  const overlay = document.createElement('div');
  overlay.id = 'cq-splash';
  overlay.className = 'cq-splash';

  let recentHtml = '';
  if (projects.length) {
    recentHtml = `<div class="cq-splash-section">Recent</div>
<div class="cq-splash-list">
${projects.map(p => `<div class="cq-splash-entry" data-id="${p.id}">
  <span class="cq-splash-name">${esc(p.name)}</span>
  <span class="cq-splash-time">${timeAgo(p.ts)}</span>
  <button class="cq-splash-rm" data-rm="${p.id}" title="Remove">\u00d7</button>
</div>`).join('')}
</div>`;
  }

  const hasActive = activeId && projects.some(p => p.id === activeId);

  const exOpts = Object.keys(EXAMPLES).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

  overlay.innerHTML = `<div class="cq-splash-box">
  <div class="cq-splash-title">c a l q u e</div>
  <div class="cq-splash-actions">
    <button class="cq-splash-btn" data-action="new">New</button>
    <button class="cq-splash-btn" data-action="open">Open\u2026</button>
    <select class="cq-splash-select" data-action="example">
      <option value="" disabled selected>Examples</option>
      ${exOpts}
    </select>
  </div>
  ${recentHtml}
  ${hasActive ? '<div class="cq-splash-resume"><button class="cq-splash-btn cq-splash-resume-btn" data-action="resume">Resume Last</button></div>' : ''}
</div>`;

  function dismiss() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasActive) {
        dismiss();
        onSelect('resume');
      }
    }
  }

  overlay.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      const rid = rm.dataset.rm;
      projectRemove(rid);
      rm.closest('.cq-splash-entry').remove();
      // If list is now empty, remove section
      if (!overlay.querySelector('.cq-splash-entry')) {
        const sec = overlay.querySelector('.cq-splash-section');
        const list = overlay.querySelector('.cq-splash-list');
        if (sec) sec.remove();
        if (list) list.remove();
      }
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      if (action === 'new' || action === 'resume' || action === 'open') {
        dismiss();
        onSelect(action);
      }
      return;
    }

    const entry = e.target.closest('.cq-splash-entry');
    if (entry) {
      dismiss();
      onSelect('load', entry.dataset.id);
    }
  });

  const sel = overlay.querySelector('.cq-splash-select');
  if (sel) {
    sel.addEventListener('change', () => {
      const name = sel.value;
      if (name && EXAMPLES[name]) {
        dismiss();
        onSelect('example', name);
      }
    });
  }

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Inline rename prompt ──

function showRenamePrompt(current, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'cq-modal-overlay';
  overlay.innerHTML = `<div class="cq-modal">
  <div class="cq-modal-title">Project Name</div>
  <input class="cq-rename-input" type="text" value="${esc(current)}" spellcheck="false">
  <div class="cq-rename-actions">
    <button class="cq-modal-close" data-action="cancel">Cancel</button>
    <button class="cq-modal-close cq-rename-ok" data-action="ok">OK</button>
  </div>
</div>`;

  const input = overlay.querySelector('input');
  const finish = (accept) => {
    overlay.remove();
    if (accept) {
      const name = input.value.trim() || 'untitled';
      onDone(name);
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });

  overlay.addEventListener('click', e => {
    const action = e.target.dataset.action;
    if (action === 'ok') finish(true);
    else if (action === 'cancel') finish(false);
    else if (e.target === overlay) finish(false);
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => { input.select(); input.focus(); });
}

function renameProject() {
  const projects = getProjects();
  const p = projects.find(e => e.id === CQ.projectId);
  const current = (p && p.name) || CQ.fileName || 'untitled';
  showRenamePrompt(current, name => {
    projectUpdateName(name);
    CQ.fileName = name;
    updateTitle();
    setStatus('msg', 'renamed to ' + name);
  });
}

function isProjectUntitled() {
  if (!CQ.projectId) return true;
  const projects = getProjects();
  const p = projects.find(e => e.id === CQ.projectId);
  return !p || p.name === 'untitled';
}
