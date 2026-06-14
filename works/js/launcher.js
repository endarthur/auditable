// The Launcher — Works' "what do you want to make?" entry point (the JupyterLab
// Launcher analog). The launcher SURFACE (works/surfaces/launcher.html) is pure
// presentation: it asks the shell for the available items and renders a grid;
// clicking one calls back here. All curation + availability lives shell-side
// (where surfaceAvailable is known), so the surface stays dumb and the same
// launcher adapts to any build/provisioning (works-core shows fewer cards than
// works-all). Exposed to surfaces via the `works` service's Shell.LaunchItems /
// Shell.Launch methods.

import { spawnSurface, openPath, targetForTab } from './surfaces.js';
import { newProject } from './tree.js';
import { surfaceAvailable } from './surface-registry.js';

// The curated creatables. `kind` gates on whether THIS build carries the
// surface; `run(target)` performs the create/spawn, placing the new surface at
// `target` (a rails MoveTarget) — the launcher passes the stack it lives in so
// a card opens next to the launcher, not in some default stack. Order = display.
const ITEMS = [
  { id: 'notebook', kind: 'notebook', label: 'Notebook', icon: '▦',
    desc: 'A reactive computational notebook — JS, Python, and more in one document.',
    run: async (target) => { const p = await newProject('/projects'); if (p) await openPath(p, target); } },
  { id: 'terminal', kind: 'terminal', label: 'Terminal', icon: '▶',
    desc: 'A geas shell over the workspace filesystem.',
    run: (target) => spawnSurface('terminal', { title: 'Terminal' }, target) },
  { id: 'workbench', kind: 'workbench', label: 'Data Workbench', icon: '▤',
    desc: 'Schema, summary stats, grade-tonnage, and swaths over CSV / OMF block models.',
    run: (target) => spawnSurface('workbench', { title: 'Data Workbench' }, target) },
  { id: 'library', kind: 'library', label: 'Browse Library', icon: '▥',
    desc: 'Install content packs and extensions from registry sources.',
    run: (target) => spawnSurface('library', { title: 'Library' }, target) },
  { id: 'docs', kind: 'docs', label: 'Documentation', icon: '◳',
    desc: 'GCU guides and reference.',
    run: (target) => spawnSurface('docs', { title: 'Documentation' }, target) },
  { id: 'settings', kind: 'settings', label: 'Settings', icon: '⚙',
    desc: 'Theme, fonts, and workspace preferences.',
    run: (target) => spawnSurface('settings', { title: 'Settings' }, target) },
];

// The items this build can actually create — the surface renders these.
export function launchItems() {
  return ITEMS.filter((it) => surfaceAvailable(it.kind))
    .map(({ id, label, icon, desc }) => ({ id, label, icon, desc }));
}

// Perform a launch by id (no-op for an unknown / unavailable id). `fromTabId`
// is the calling launcher's own tab — the new surface opens in that launcher's
// stack so it appears right where the user clicked.
export async function launch(id, fromTabId) {
  const it = ITEMS.find((x) => x.id === id);
  if (!it || !surfaceAvailable(it.kind)) return;
  await it.run(fromTabId ? targetForTab(fromTabId) : undefined);
}
