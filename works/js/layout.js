// The rails host — @gcu/rails arranges surface iframes as docked tabs and
// floats. A surface tab's panel is the surface's iframe; rails never
// reparents it, so the iframe and its A-Bus connection survive every drag.
//
// The rails layout is persisted (debounced) to /home/.works/layout.json
// and restored at boot (auditable-works-spec §12.2).

import { createRails } from '#rails';
import { WKS } from './state.js';
import { createSurface } from './surfaces.js';

const LAYOUT_PATH = '/home/.works/layout.json';
let _saveTimer = null;

export function setupLayout() {
  const el = document.getElementById('works-rails');

  WKS.rails = createRails(el, {
    initialState: { rails: [], floats: [] },

    renderPanel(tab) {
      if (tab.kind === 'surface') {
        let rec = WKS.surfaces.get(tab.id);
        if (!rec && tab.surfaceKind) {
          // A tab restored from a saved layout — create its surface now.
          rec = createSurface(tab.id, tab.surfaceKind,
            { path: tab.path, title: tab.title });
        }
        if (rec) return rec.iframe;
      }
      const d = document.createElement('div');
      d.className = 'works-panel-placeholder';
      d.textContent = tab.title || 'surface';
      return d;
    },

    renderEmpty() {
      const d = document.createElement('div');
      d.className = 'works-empty';
      const p = document.createElement('p');
      p.textContent = 'No surfaces open.';
      const hint = document.createElement('p');
      hint.className = 'works-empty-hint';
      hint.textContent = 'Open a project from the sidebar, or:';
      const btn = document.createElement('button');
      btn.className = 'works-empty-launcher';
      btn.textContent = '✦  Launcher';
      btn.addEventListener('click', () => { try { WKS.spawnSurface('launcher', { title: 'Launcher' }); } catch { /* */ } });
      d.append(p, hint, btn);
      return d;
    },
  });

  // Persist the layout (debounced) whenever it changes. `layout:change`
  // covers adds / removes / moves / resizes; `tab:activate` (clicking a
  // tab to switch active) is a separate event that rails doesn't roll
  // into layout:change. Without saving on activate too, switching tabs
  // never reaches disk and reloads pop back to whichever tab was active
  // at the last add/remove.
  const _scheduleSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveLayout, 250);
  };
  WKS.rails.on('layout:change', _scheduleSave);
  WKS.rails.on('tab:activate',  _scheduleSave);
}

// True when no tab is open anywhere (no rail stack has tabs, no float). Drives
// the boot "open the Launcher on an empty workspace" behavior.
export function isLayoutEmpty() {
  const st = WKS.rails && WKS.rails.state;
  if (!st) return true;
  const railHasTabs = (st.rails || []).some((r) => (r.stacks || []).some((s) => (s.tabs || []).length));
  const floatHasTabs = (st.floats || []).some((f) => f.stack && (f.stack.tabs || []).length);
  return !railHasTabs && !floatHasTabs;
}

async function saveLayout() {
  try {
    await WKS.vfs.writeFile(LAYOUT_PATH, WKS.rails.serialize());
  } catch { /* a transient VFS error — the next change retries */ }
}

// Restore the saved layout at boot. deserialize re-creates the rails tree;
// each tab's surface is created lazily by renderPanel on activation.
export async function restoreLayout() {
  try {
    if (!(await WKS.vfs.exists(LAYOUT_PATH))) return;
    const json = await WKS.vfs.readFile(LAYOUT_PATH, 'utf8');
    if (json) WKS.rails.deserialize(json);
  } catch (e) {
    console.error('Works: layout restore failed:', e);
  }
}
