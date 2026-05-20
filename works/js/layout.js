// The rails host — @gcu/rails arranges surface iframes as docked tabs and
// floats. Empty in Chunk 1; surfaces become panels from Chunk 2 on.

import { createRails } from '#rails';
import { WKS } from './state.js';

export function setupLayout() {
  const el = document.getElementById('works-rails');

  WKS.rails = createRails(el, {
    initialState: { rails: [], floats: [] },

    // A tab's panel. Chunk 1 has no surfaces, so this is a placeholder;
    // from Chunk 2 it returns the surface iframe.
    renderPanel(tab) {
      const d = document.createElement('div');
      d.className = 'works-panel-placeholder';
      d.textContent = tab.title || 'surface';
      return d;
    },

    // Shown when no tabs are open.
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
