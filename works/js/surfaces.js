// Surface spawning + tracking. A surface is an iframe that is an A-Bus peer
// implementing the §5.2 Surface contract. The shell keeps one A-Bus channel
// per surface and addresses each by its unique name.

import { WKS, setStatus } from './state.js';
import { kindDef, kindForExtension, kindForPath, surfaceUrl, surfaceAvailable, availableKindForExtension } from './surface-registry.js';

const _byUnique = new Map();   // A-Bus unique name → tab id
let _activeTabId = null;       // the focused tab (last activated) — drives the shell menubar's contextual surface actions

// Capability grants the shell issues to its own trusted built-in surfaces at
// spawn (capability-security §4). Keyed by surface kind → the scoped caps that
// kind legitimately needs to reach gated services. This is the TCB vouching for
// built-ins; anything not listed gets no privileged capability. Keep it minimal.
const PRIVILEGED_GRANTS = {
  inspector: [{ to: 'works', interface: 'Inspect', member: '*' }],
};

// The focused surface record (or null) — the tab the shell menubar acts on.
export function getActiveSurface() {
  return _activeTabId ? (WKS.surfaces.get(_activeTabId) || null) : null;
}

// Call a method on the active surface's `Notebook` A-Bus interface — the shell
// menubar driving the focused notebook (Run All, etc.). No-op (returns false)
// when the active surface isn't a notebook. Fire-and-forget; errors are logged.
export function callActiveNotebook(member, args = []) {
  const rec = getActiveSurface();
  if (!rec || rec.kind !== 'notebook') return false;
  WKS.worksBus.call({ to: rec.uniqueName, path: '/', interface: 'Notebook', member }, args)
    .catch((e) => console.warn('[works] notebook ' + member + ' failed:', e));
  return true;
}

// A snapshot of the open surfaces — what an observer (the shell menubar, an
// agent's worksListSurfaces) can see on the desktop. `active` flags the focused
// tab. Read-only; no realm access.
export function listSurfaces() {
  const out = [];
  for (const rec of WKS.surfaces.values())
    out.push({ kind: rec.kind, path: rec.path, title: rec.title, active: rec.tabId === _activeTabId });
  return out;
}

// Resolve once a tab's surface has signalled Ready (or after `timeout` ms) — so
// the shell can drive a freshly-opened surface without racing its boot.
function waitTabReady(tabId, timeout = 4000) {
  const rec = WKS.surfaces.get(tabId);
  if (!rec) return Promise.resolve(false);
  if (rec.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const r = WKS.surfaces.get(tabId);
      if (!r) { clearInterval(iv); resolve(false); }
      else if (r.ready) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(false); }
    }, 50);
  });
}

// Open a notebook (if `path` is given) and run all its cells; with no path, run
// the focused notebook. Drives the surface by its own tab — not "whatever's
// active" — so it's race-free for a just-opened notebook. Returns { ran, … }.
export async function runNotebookAt(path) {
  let tabId = null;
  if (path) {
    tabId = await openPath(path);
    if (!tabId) return { ran: false, reason: 'no surface for ' + path };
    await waitTabReady(tabId);
  } else {
    const rec = getActiveSurface();
    tabId = rec && rec.tabId;
  }
  const rec = tabId && WKS.surfaces.get(tabId);
  if (!rec || rec.kind !== 'notebook') return { ran: false, reason: 'not a notebook' };
  try {
    await WKS.worksBus.call(
      { to: rec.uniqueName, path: '/', interface: 'Notebook', member: 'RunAll' }, []);
    return { ran: true, path: rec.path };
  } catch (e) {
    return { ran: false, reason: String((e && e.message) || e) };
  }
}

// Close the surface (tab) showing `path`, if open. Goes through rails' normal
// close (which flushes via the Surface contract). Returns whether one closed.
export function closeSurfaceAt(path) {
  for (const r of WKS.surfaces.values()) {
    if (r.path === path) { WKS.rails.closeTab(r.tabId); return true; }
  }
  return false;
}

// Call a member on a notebook's `Notebook` A-Bus interface, resolved by PATH:
// reuse an already-open notebook for that path, else open one and wait for it
// to be Ready. Returns the member's result (await-able, unlike the fire-and-
// forget callActiveNotebook). Used by the numen-for-Works notebook bridge.
export async function callNotebookAt(path, member, args = []) {
  let rec = null;
  for (const r of WKS.surfaces.values())
    if (r.path === path && r.kind === 'notebook') { rec = r; break; }
  if (!rec) {
    const tabId = await openPath(path);
    if (!tabId) throw new Error('no notebook surface for ' + path);
    await waitTabReady(tabId);
    rec = WKS.surfaces.get(tabId);
  }
  if (!rec || rec.kind !== 'notebook') throw new Error('not a notebook: ' + path);
  return WKS.worksBus.call({ to: rec.uniqueName, path: '/', interface: 'Notebook', member }, args);
}

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const newTabId = () => 't' + Math.random().toString(36).slice(2, 10);

// The id of the stack (docked or float) that holds `tabId`, or null. Lets a
// surface ask the shell to spawn a sibling INTO its own stack (the launcher
// opening a card next to itself) without rails exposing a tab→stack lookup.
export function stackIdForTab(tabId) {
  const st = WKS.rails && WKS.rails.state;
  if (!st || !tabId) return null;
  for (const rail of st.rails || [])
    for (const stack of rail.stacks || [])
      if ((stack.tabs || []).some((t) => t.id === tabId)) return stack.id;
  for (const float of st.floats || [])
    if (float.stack && (float.stack.tabs || []).some((t) => t.id === tabId)) return float.stack.id;
  return null;
}

// A rails MoveTarget that lands a new tab in the same stack as `tabId`, or
// undefined (→ default placement) when the stack can't be resolved.
export function targetForTab(tabId) {
  const stackId = stackIdForTab(tabId);
  return stackId ? { to: 'stack', stackId } : undefined;
}

// Create a surface (iframe + A-Bus channel + record) for a given tab id.
// Used by spawnSurface for a brand-new tab, and by layout.js renderPanel
// when a tab is being restored from a saved layout.
export function createSurface(tabId, kind, opts = {}) {
  const def = kindDef(kind);
  if (!def) throw new Error('unknown surface kind: ' + kind);

  const iframe = document.createElement('iframe');
  iframe.className = 'works-surface-frame';
  // Real isolation (works-capability-security-spec §3 / §9 ★ TCB boundary):
  // sandbox WITHOUT allow-same-origin → an opaque origin, so a surface
  // physically cannot reach the shell realm (window.parent.WKS) — only
  // postMessage/A-Bus. The broker connection + VFS already ride A-Bus and
  // event.source identity checks are cross-origin-safe, so this is
  // low-breakage; the red-team probe in works-smoke is the regression guard.
  // Token set (audited against every surface's needs, not just the works
  // subset smoke runs): allow-downloads (export), allow-modals (native
  // alert/confirm/prompt — text discard-confirm, settings reset-confirm, hex
  // goto-prompt), allow-popups + -to-escape-sandbox (settings' external
  // target=_blank links open as real tabs, not sandboxed-null). NONE of these
  // grant realm reach — the credential-isolation TCB (no allow-same-origin)
  // holds. Permissions-Policy `allow`: device APIs (wasm4 gamepad, terminal +
  // others' clipboard). Set before src so it governs the one-and-only load.
  iframe.setAttribute('sandbox',
    'allow-scripts allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox');
  iframe.setAttribute('allow', 'gamepad; clipboard-read; clipboard-write');
  // The surface's embedded payload (§15.1), decompressed to a blob URL at
  // boot. Set before the iframe enters the DOM, so its one and only load is
  // the real surface — no about:blank phase, no double-fired welcome.
  iframe.src = surfaceUrl(kind);

  // One A-Bus channel per surface: the shell keeps port1 (broker side),
  // the surface receives port2 in its welcome.
  const ch = new MessageChannel();
  const uniqueName = WKS.broker.connect(ch.port1);
  _byUnique.set(uniqueName, tabId);

  // Capability-security §4: the shell (the TCB) vouches for its own built-in
  // surfaces — privileged capabilities are granted here by trusted kind, at
  // spawn, scoped to exactly what that kind needs. Untrusted principals
  // (notebooks, installed .gcupkg surfaces) get nothing here; they go through
  // the consent flow instead. Today: only the inspector reaches gated Inspect.
  for (const cap of (PRIVILEGED_GRANTS[kind] || [])) WKS.broker.grant(uniqueName, cap);

  const rec = {
    tabId, kind, uniqueName, iframe,
    path: opts.path || '/', title: opts.title || def.label,
    ready: false, dirty: false,
  };
  WKS.surfaces.set(tabId, rec);

  // Hand the surface its port + bootstrap once its document has loaded.
  iframe.addEventListener('load', () => {
    iframe.contentWindow.postMessage(
      {
        type: 'abus:welcome',
        port: ch.port2,
        tab: { id: tabId, path: rec.path, kind },
        home: WKS.home,   // the storage-home descriptor — surfaces may mount it directly
      },
      '*', [ch.port2]);
  });

  return rec;
}

// Spawn a surface of `kind` into a new rails tab. Returns the tab id.
export function spawnSurface(kind, opts = {}, target) {
  const tabId = newTabId();
  const rec = createSurface(tabId, kind, opts);
  WKS.rails.addTab({
    id: tabId, title: rec.title, kind: 'surface',
    // Consumer payload — serialized with the layout, read back by
    // renderPanel to re-create the surface on restore.
    surfaceKind: kind, path: rec.path,
  }, target);   // target (a rails MoveTarget) lands the tab in a specific stack
  WKS.rails.activateTab(tabId);
  _activeTabId = tabId;
  return tabId;
}

// Open a VFS path in a surface, resolving its kind via the registry. One
// tab per path — re-opening an already-open path just activates its tab.
export async function openPath(p, target) {
  for (const rec of WKS.surfaces.values()) {
    if (rec.path === p) { WKS.rails.activateTab(rec.tabId); return rec.tabId; }
  }

  let kind = null;
  let title = basename(p);
  try {
    if (await WKS.vfs.exists(p + '/project.json')) {
      const meta = JSON.parse(await WKS.vfs.readFile(p + '/project.json'));
      kind = meta.kind;
      title = meta.title || title;
    } else if (await WKS.vfs.exists(p + '/book.json')) {
      // A directory holding a book.json opens in the reader (books follow the
      // project shape but are marked by book.json, not project.json).
      kind = 'book';
      try { title = (JSON.parse(await WKS.vfs.readFile(p + '/book.json')).title) || title; } catch {}
    } else {
      // Fast path first: extension + extensionlessName match. If that
      // misses, fall through to the detect-callback cascade (Slice 2 —
      // EXTENSION_SPEC §3.8.3). Async because detect needs VFS reads.
      kind = kindForExtension(basename(p));
      if (!kind) kind = await kindForPath(p, { vfs: WKS.vfs });
    }
  } catch { /* fall through to the no-surface case */ }

  if (!kind || !kindDef(kind)) {
    setStatus('No surface for ' + p);
    return null;
  }
  // Registered but payload-less — a lean build that knows the kind without
  // carrying its surface (works-core + 'notebook' until the notebook ships
  // as an installable package). For extension-dispatched files, fall through
  // to another registered kind that IS carried (.md: doc absent → preview's
  // rendered markdown). Otherwise degrade to a status, not a throw.
  if (!surfaceAvailable(kind)) {
    const alt = availableKindForExtension(basename(p));
    if (alt) { kind = alt; }
    else {
      setStatus('The ' + kind + ' surface isn\'t in this build — install it to open ' + basename(p));
      return null;
    }
  }
  return spawnSurface(kind, { path: p, title }, target);
}

// Reflect a surface's Surface-interface signals onto its tab + record.
export function setupSurfaces() {
  WKS.worksBus.subscribe({ interface: 'Surface' }, (msg) => {
    const tabId = _byUnique.get(msg.from);
    if (!tabId) return;
    const rec = WKS.surfaces.get(tabId);
    if (!rec) return;
    const arg = (msg.args || [])[0];
    if (msg.member === 'Ready') {
      rec.ready = true;
    } else if (msg.member === 'TitleChanged') {
      rec.title = arg;
      WKS.rails.updateTab(tabId, { title: arg });
    } else if (msg.member === 'DirtyChanged') {
      rec.dirty = !!arg;
    }
  });

  // When a tab is genuinely closed (not just moved between stacks), drop
  // the surface record + broker uniqueName mapping. Without this, openPath
  // sees the stale record on a later request for the same path, calls
  // WKS.rails.activateTab on a tab id rails has already discarded, and the
  // user sees nothing happen. That broke "close preview surface → recreate
  // the underlying file → reopen" workflows for volatile paths like /sys/*.
  WKS.rails.on('tab:close', ({ tab, preserved }) => {
    if (preserved || !tab) return;          // dnd move between stacks
    if (tab.id === _activeTabId) _activeTabId = null;
    const rec = WKS.surfaces.get(tab.id);
    if (!rec) return;
    if (rec.uniqueName) _byUnique.delete(rec.uniqueName);
    WKS.surfaces.delete(tab.id);
  });

  // Track the focused tab so the menubar's contextual surface actions (Run All
  // on the active notebook, etc.) know what to act on.
  WKS.rails.on('tab:activate', ({ tab }) => { if (tab) _activeTabId = tab.id; });
}
