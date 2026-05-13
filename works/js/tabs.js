import { WKS, $ } from './state.js';
import { readEntry, dbGet, dbPut, openDB } from './fs.js';
import { isLightweight, hydrate, isAuditableTxt, parseTxt, hydrateNotebook } from './notebook.js';
import { renderTree } from './tree.js';

// ── TABS ──

async function openTab(rootIndex, path, title, opts) {
  // dedup: check if already open (pinned or preview)
  const existing = WKS.tabs.find(t => t.rootIndex === rootIndex && t.path === path);
  if (existing) {
    // if opening permanently and it's a preview, pin it
    if (opts?.permanent && existing.preview) pinTab(existing.id);
    if (!opts?.silent) switchTab(existing.id);
    return;
  }

  const preview = opts?.preview || false;

  // if opening as preview, replace existing preview tab
  if (preview) {
    const oldPreview = WKS.tabs.find(t => t.preview);
    if (oldPreview) {
      if (oldPreview.blobUrl) URL.revokeObjectURL(oldPreview.blobUrl);
      if (oldPreview.iframe) oldPreview.iframe.remove();
      WKS.tabs.splice(WKS.tabs.indexOf(oldPreview), 1);
    }
  }

  const id = WKS.tabId++;
  const tab = {
    id,
    rootIndex,
    path,
    title: title || path.split('/').pop(),
    blobUrl: null,
    iframe: null,
    dirty: false,
    preview,
  };

  WKS.tabs.push(tab);
  await loadTabContent(tab);
  if (!opts?.silent) {
    switchTab(id);
    saveWorkspaceState();
  }
  renderTabBar();
}

function pinTab(tabId) {
  const tab = WKS.tabs.find(t => t.id === tabId);
  if (!tab || !tab.preview) return;
  tab.preview = false;
  renderTabBar();
  saveWorkspaceState();
}

async function loadTabContent(tab) {
  try {
    let html = await readEntry(tab.rootIndex, tab.path);
    if (html === null) {
      console.error('file not found:', tab.path);
      return;
    }

    // hydrate lightweight notebooks from Box storage
    if (isLightweight(html)) {
      html = await hydrate(html);
    } else if (isAuditableTxt(html)) {
      const notebook = parseTxt(html);
      html = await hydrateNotebook(notebook);
    }

    // inject localStorage shim for blob URL iframes
    const storageKey = tab.rootIndex + ':' + tab.path;
    const saved = await loadStorage(storageKey);
    html = injectStorageShim(html, saved);

    // create blob URL
    const blob = new Blob([html], { type: 'text/html' });
    tab.blobUrl = URL.createObjectURL(blob);

    // create iframe
    const iframe = document.createElement('iframe');
    iframe.className = 'works-iframe';
    iframe.src = tab.blobUrl;
    iframe.dataset.tabId = tab.id;

    const viewport = $('#works-viewport');
    viewport.appendChild(iframe);
    tab.iframe = iframe;
  } catch (err) {
    console.error('failed to load tab:', err);
  }
}

function injectStorageShim(html, initialData) {
  const escaped = JSON.stringify(initialData || {}).replace(/<\//g, '<\\/');
  const shim = `<script>(function(){
var d=${escaped},k=Object.keys(d);
var s={getItem:function(n){return d.hasOwnProperty(n)?d[n]:null},
setItem:function(n,v){d[n]=String(v);k=Object.keys(d);p()},
removeItem:function(n){delete d[n];k=Object.keys(d);p()},
clear:function(){d={};k=[];p()},
key:function(i){return k[i]||null},
get length(){return k.length}};
function p(){window.parent.postMessage({type:'works:storage',payload:d},'*')}
try{window.localStorage}catch(e){
Object.defineProperty(window,'localStorage',{get:function(){return s},configurable:true});
Object.defineProperty(window,'sessionStorage',{get:function(){return s},configurable:true})}
})();<\/script>`;
  // inject after <head> or at start of <html>
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length;
    return html.slice(0, idx) + '\n' + shim + '\n' + html.slice(idx);
  }
  // fallback: inject after <!DOCTYPE...><html...>
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, idx) + '\n' + shim + '\n' + html.slice(idx);
  }
  return shim + '\n' + html;
}

function switchTab(tabId) {
  WKS.activeTabId = tabId;
  showIframe(tabId);
  renderTabBar();
  updateStatusBar();
  saveWorkspaceState();
  // recalculate textarea sizes — needed in case autoResize ran during load with stale layout
  const tab = WKS.tabs.find(t => t.id === tabId);
  if (tab?.iframe?.contentWindow) {
    setTimeout(() => {
      try { tab.iframe.contentWindow.postMessage({ type: 'works:resize' }, '*'); } catch {}
    }, 100);
  }
}

function showIframe(tabId) {
  const viewport = $('#works-viewport');
  if (!viewport) return;
  for (const iframe of viewport.querySelectorAll('.works-iframe')) {
    iframe.classList.toggle('active', iframe.dataset.tabId === String(tabId));
  }
}

async function closeTab(tabId) {
  const idx = WKS.tabs.findIndex(t => t.id === tabId);
  if (idx < 0) return;
  const tab = WKS.tabs[idx];

  if (tab.dirty && !await dialogConfirm('unsaved changes in ' + tab.title + '. close anyway?', { okLabel: 'close', danger: true })) return;

  // cleanup
  if (tab.blobUrl) URL.revokeObjectURL(tab.blobUrl);
  if (tab.iframe) tab.iframe.remove();
  WKS.tabs.splice(idx, 1);

  // switch to adjacent tab
  if (WKS.activeTabId === tabId) {
    if (WKS.tabs.length > 0) {
      const nextIdx = Math.min(idx, WKS.tabs.length - 1);
      switchTab(WKS.tabs[nextIdx].id);
    } else {
      WKS.activeTabId = null;
      showEmptyState();
    }
  }

  renderTabBar();
  saveWorkspaceState();
}

function renderTabBar() {
  const bar = $('#works-tabbar');
  if (!bar) return;
  bar.innerHTML = '';

  for (const tab of WKS.tabs) {
    const el = document.createElement('div');
    el.className = 'works-tab'
      + (tab.id === WKS.activeTabId ? ' active' : '')
      + (tab.preview ? ' preview' : '');
    el.dataset.tabId = tab.id;

    el.addEventListener('click', () => switchTab(tab.id));
    el.addEventListener('dblclick', () => pinTab(tab.id));

    // drag reorder
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', tab.id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = bar.querySelector('.dragging');
      if (!dragging || dragging === el) return;
      const rect = el.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (e.clientX < mid) el.before(dragging);
      else el.after(dragging);
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      // rebuild tab order from DOM
      const order = [...bar.querySelectorAll('.works-tab')].map(d => Number(d.dataset.tabId));
      WKS.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveWorkspaceState();
    });

    const label = document.createElement('span');
    label.className = 'works-tab-label';
    label.textContent = (tab.dirty ? '\u25cf ' : '') + tab.title;
    el.appendChild(label);

    const close = document.createElement('button');
    close.className = 'works-tab-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(close);

    bar.appendChild(el);
  }
}

function markDirty(tabId) {
  const tab = WKS.tabs.find(t => t.id === tabId);
  if (!tab) return;
  // editing pins a preview tab
  if (tab.preview) tab.preview = false;
  if (tab.dirty) return;
  tab.dirty = true;
  renderTabBar();
}

function markClean(tabId) {
  const tab = WKS.tabs.find(t => t.id === tabId);
  if (!tab || !tab.dirty) return;
  tab.dirty = false;
  renderTabBar();
}

function findTabBySource(source) {
  return WKS.tabs.find(t => t.iframe && t.iframe.contentWindow === source);
}

function showEmptyState() {
  const viewport = $('#works-viewport');
  if (!viewport) return;
  // only show if no iframes visible
  if (WKS.tabs.length === 0) {
    let empty = viewport.querySelector('.works-empty');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'works-empty';
      empty.innerHTML = '<div class="works-empty-inner">' +
        '<div class="works-empty-title">auditable files</div>' +
        '<div class="works-empty-hint">open a folder or create a box to begin</div>' +
        '</div>';
      viewport.appendChild(empty);
    }
    empty.style.display = 'flex';
  }
}

function hideEmptyState() {
  const empty = document.querySelector('.works-empty');
  if (empty) empty.style.display = 'none';
}

function updateStatusBar() {
  const status = $('#works-status-path');
  if (!status) return;
  const tab = WKS.tabs.find(t => t.id === WKS.activeTabId);
  if (tab) {
    const root = WKS.roots[tab.rootIndex];
    const rootName = root ? root.name : '?';
    status.textContent = rootName + '/' + tab.path;
  } else {
    status.textContent = '';
  }
}

function setStatus(msg) {
  const el = $('#works-status-msg');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

async function reloadTab(tabId) {
  const tab = WKS.tabs.find(t => t.id === tabId);
  if (!tab) return;
  // revoke old blob
  if (tab.blobUrl) URL.revokeObjectURL(tab.blobUrl);
  if (tab.iframe) tab.iframe.remove();
  tab.blobUrl = null;
  tab.iframe = null;
  await loadTabContent(tab);
  showIframe(tabId);
}

// ── STORAGE SHIM PERSISTENCE ──

async function loadStorage(key) {
  try {
    await openDB();
    return await dbGet('storage', key) || {};
  } catch { return {}; }
}

function saveStorage(key, data) {
  openDB().then(() => dbPut('storage', data, key)).catch(() => {});
}

function storageKeyForTab(tab) {
  return tab.rootIndex + ':' + tab.path;
}

function handleStorageMessage(tab, data) {
  saveStorage(storageKeyForTab(tab), data);
}
