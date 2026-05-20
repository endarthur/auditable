// The rails host — @gcu/rails arranges surface iframes as docked tabs and
// floats. A surface tab's panel is the surface's iframe (created by
// surfaces.js); rails never reparents it, so the iframe and its A-Bus
// connection survive every drag.

import { createRails } from '#rails';
import { WKS } from './state.js';

export function setupLayout() {
  const el = document.getElementById('works-rails');

  WKS.rails = createRails(el, {
    initialState: { rails: [], floats: [] },

    renderPanel(tab) {
      if (tab.kind === 'surface') {
        const rec = WKS.surfaces.get(tab.id);
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
}
