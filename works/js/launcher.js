// The Launcher — Works' "what do you want to make?" entry point (the JupyterLab
// Launcher analog). The launcher SURFACE (works/surfaces/launcher.html) is pure
// presentation: it asks the shell for the available items and renders a grid;
// clicking one calls back here. All curation + availability lives shell-side
// (where surfaceAvailable is known), so the surface stays dumb and the same
// launcher adapts to any build/provisioning (works-core shows fewer cards than
// works-all). Exposed to surfaces via the `works` service's Shell.LaunchItems /
// Shell.Launch methods.

import { spawnSurface, openPath } from './surfaces.js';
import { newProject } from './tree.js';
import { surfaceAvailable } from './surface-registry.js';

// The curated creatables. `kind` gates on whether THIS build carries the
// surface; `run` performs the create/spawn. Order = display order.
const ITEMS = [
  { id: 'notebook', kind: 'notebook', label: 'Notebook', icon: '▦',
    desc: 'A reactive computational notebook — JS, Python, and more in one document.',
    run: async () => { const p = await newProject('/projects'); if (p) await openPath(p); } },
  { id: 'terminal', kind: 'terminal', label: 'Terminal', icon: '▶',
    desc: 'A geas shell over the workspace filesystem.',
    run: () => spawnSurface('terminal', { title: 'Terminal' }) },
  { id: 'workbench', kind: 'workbench', label: 'Data Workbench', icon: '▤',
    desc: 'Schema, summary stats, grade-tonnage, and swaths over CSV / OMF block models.',
    run: () => spawnSurface('workbench', { title: 'Data Workbench' }) },
  { id: 'library', kind: 'library', label: 'Browse Library', icon: '▥',
    desc: 'Install content packs and extensions from registry sources.',
    run: () => spawnSurface('library', { title: 'Library' }) },
  { id: 'docs', kind: 'docs', label: 'Documentation', icon: '◳',
    desc: 'GCU guides and reference.',
    run: () => spawnSurface('docs', { title: 'Documentation' }) },
  { id: 'settings', kind: 'settings', label: 'Settings', icon: '⚙',
    desc: 'Theme, fonts, and workspace preferences.',
    run: () => spawnSurface('settings', { title: 'Settings' }) },
];

// The items this build can actually create — the surface renders these.
export function launchItems() {
  return ITEMS.filter((it) => surfaceAvailable(it.kind))
    .map(({ id, label, icon, desc }) => ({ id, label, icon, desc }));
}

// Perform a launch by id (no-op for an unknown / unavailable id).
export async function launch(id) {
  const it = ITEMS.find((x) => x.id === id);
  if (!it || !surfaceAvailable(it.kind)) return;
  await it.run();
}
