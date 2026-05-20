// The file-tree explorer over /projects/. Chunk 1 is a placeholder; the
// real tree — project.json kind detection, context menus, double-click to
// open a surface — arrives in Chunk 3.

import { WKS } from './state.js';

export function setupTree() {
  const el = document.getElementById('works-tree');
  if (!el) return;
  el.innerHTML = '<div class="works-tree-empty">No projects yet.</div>';
}
