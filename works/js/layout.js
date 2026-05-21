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
      d.innerHTML =
        '<p>No surfaces open.</p>' +
        '<p class="works-empty-hint">Open a project from the sidebar.</p>';
      return d;
    },
  });

  // Persist the layout (debounced) whenever it changes.
  WKS.rails.on('layout:change', () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveLayout, 250);
  });
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
