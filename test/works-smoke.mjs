// Browser smoke test for works.html — the Auditable Works shell.
// Serves the repo over a loopback HTTP origin, boots works.html in headless
// Chromium, and checks:
//   Chunk 1 — the shell stands up (broker, VFS, rails host, menu bar).
//   Chunk 2 — a surface spawns, handshakes, honours the contract, and can
//             reach the workspace VFS through the `works` service.
//
// Not part of `npm test` — a Playwright run. Run directly:
//   node test/works-smoke.mjs

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/works.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto(url);

await page.waitForFunction(
  () => window.WKS && window.WKS.broker && window.WKS.vfs,
  { timeout: 15000 },
).catch(() => {});

// ── Chunk 1 — the shell skeleton ──────────────────────────────────────
const shell = await page.evaluate(async () => {
  const W = window.WKS || {};
  let projectsExists = false;
  try { projectsExists = await W.vfs.exists('/projects'); } catch { /* */ }
  return {
    hasWKS: !!window.WKS, broker: !!W.broker, vfs: !!W.vfs,
    rails: !!W.rails, menubar: !!W.menubar, worksBus: !!W.worksBus,
    projectsExists,
    status: document.getElementById('works-status')?.textContent || '',
    menubarFilled: (document.getElementById('works-menubar')?.childElementCount || 0) > 0,
  };
});

// ── Chunk 2 — spawn a surface, exercise the contract ──────────────────
const surface = await page.evaluate(async () => {
  const W = window.WKS;
  const tabId = W.spawnSurface('stub', { path: '/projects', title: 'Stub' });
  const rec = W.surfaces.get(tabId);

  // Wait for the surface to handshake + emit Ready.
  const deadline = Date.now() + 10000;
  while (!rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // Shell → surface call, addressed by the surface's A-Bus unique name.
  let canClose = null;
  try {
    canClose = await W.worksBus.call(
      { to: rec.uniqueName, path: '/', interface: 'Surface', member: 'CanClose' }, []);
  } catch (e) { canClose = 'error: ' + e.message; }

  // Did the surface's works/VFS write reach the real workspace VFS?
  let probe = null;
  try { probe = await W.vfs.readFile('/projects/.stub-probe'); } catch { /* */ }

  return {
    tabId, ready: rec.ready, title: rec.title,
    uniqueName: rec.uniqueName, canClose, probe,
  };
});

// ── Chunk 3 — the file tree + surface registry ────────────────────────
const tree = await page.evaluate(async () => {
  const W = window.WKS;
  // Create a project the real way (mkdir + project.json), then dispatch.
  const projPath = await W.newProject('/projects', 'Quad');
  await W.refreshTree();
  await new Promise((r) => setTimeout(r, 150));

  const rows = [...document.querySelectorAll('#works-tree .tree-row')];
  const projRow = rows.find((r) => r.dataset.path === projPath);
  const treeShowsProject = !!projRow && projRow.classList.contains('tree-project');

  const before = W.surfaces.size;
  await W.openPath(projPath);
  await new Promise((r) => setTimeout(r, 250));
  let opened = null;
  for (const rec of W.surfaces.values()) if (rec.path === projPath) opened = rec;
  const afterOpen = W.surfaces.size;

  await W.openPath(projPath);   // re-open the same path
  const afterReopen = W.surfaces.size;

  return {
    projPath, treeShowsProject,
    surfaceOpened: !!opened, surfaceKind: opened && opened.kind,
    spawned: afterOpen - before, deduped: afterReopen === afterOpen,
  };
});

// ── Text editor surface ───────────────────────────────────────────────
const textOpen = await page.evaluate(async () => {
  const W = window.WKS;
  await W.vfs.writeFile('/projects/notes.txt', 'hello world');
  const tabId = await W.openPath('/projects/notes.txt');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 10000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return rec
    ? { tabId, uniqueName: rec.uniqueName, ready: rec.ready, title: rec.title }
    : { ready: false };
});

// Reach into the surface's iframe: confirm it read the file, then edit it.
const textFrame = page.frames().find((f) => f.url().includes('text.html'));
let loadedContent = null;
if (textFrame) {
  loadedContent = await textFrame.evaluate(() => document.querySelector('textarea')?.value);
  await textFrame.evaluate(() => {
    const ta = document.querySelector('textarea');
    ta.value = 'edited by smoke';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Flush the surface; confirm the buffer reached the workspace VFS.
const textFlush = await page.evaluate(async (uniqueName) => {
  const W = window.WKS;
  try {
    await W.worksBus.call(
      { to: uniqueName, path: '/', interface: 'Surface', member: 'Flush' }, []);
  } catch (e) { return { error: e.message }; }
  let onDisk = null;
  try { onDisk = await W.vfs.readFile('/projects/notes.txt', 'utf8'); } catch { /* */ }
  return { onDisk };
}, textOpen.uniqueName);

// ── A-Bus inspector surface ───────────────────────────────────────────
const inspectorOpen = await page.evaluate(async () => {
  const W = window.WKS;
  const snap = W.broker.inspect();
  const tabId = W.spawnSurface('inspector', { title: 'A-Bus Inspector' });
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 10000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    brokerPeers: (snap.peers || []).length,
    brokerHasSubs: Array.isArray(snap.subscriptions),
    ready: rec ? rec.ready : false,
  };
});

const inspectorFrame = page.frames().find((f) => f.url().includes('inspector.html'));
let inspectorPeerRows = 0;
if (inspectorFrame) {
  await inspectorFrame.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  inspectorPeerRows = await inspectorFrame.evaluate(
    () => document.querySelectorAll('#peers .peer').length);
}

// ── Persistence across a reload (Chunk 5) ─────────────────────────────
await page.evaluate(async () => {
  const W = window.WKS;
  await W.newProject('/projects', 'PersistMe');
  await W.vfs.writeFile('/projects/persist-note.txt', 'survives reload');
  await W.openPath('/projects/persist-note.txt');
  await new Promise((r) => setTimeout(r, 500));   // open the surface + save the layout
});

await page.reload();
await page.waitForFunction(
  () => window.WKS && window.WKS.vfs && window.WKS.broker,
  { timeout: 15000 },
).catch(() => {});
await page.waitForTimeout(700);   // let restore + the active surface settle

const persist = await page.evaluate(async () => {
  const W = window.WKS;
  let projExists = false, note = null;
  try { projExists = await W.vfs.exists('/projects/PersistMe'); } catch { /* */ }
  try { note = await W.vfs.readFile('/projects/persist-note.txt', 'utf8'); } catch { /* */ }
  await W.refreshTree();
  await new Promise((r) => setTimeout(r, 150));
  const treeHasProj = [...document.querySelectorAll('#works-tree .tree-row')]
    .some((r) => r.dataset.path === '/projects/PersistMe');
  // After a reload nothing calls spawnSurface — so any live surface came
  // from restoreLayout → renderPanel re-creating it.
  return { projExists, note, treeHasProj, tabsRestored: W.surfaces.size };
});

const checks = {
  // Chunk 1
  'no page errors':            errors.length === 0,
  'window.WKS present':        shell.hasWKS,
  'A-Bus broker created':      shell.broker,
  'workspace VFS created':     shell.vfs,
  '/projects dir exists':      shell.projectsExists,
  'rails host created':        shell.rails,
  'menu bar rendered':         shell.menubarFilled,
  'works service created':     shell.worksBus,
  'shell reports ready':       shell.status === 'Auditable Works — ready',
  // Chunk 2
  'surface handshakes (Ready)':       surface.ready === true,
  'surface unique name assigned':     /^:\d+$/.test(surface.uniqueName),
  'TitleChanged reflected on tab':    surface.title === 'Stub ' + surface.tabId,
  'shell→surface call (CanClose)':    surface.canClose === true,
  'surface reached works/VFS':        surface.probe === 'hello from ' + surface.tabId,
  // Chunk 3
  'tree renders a created project':   tree.treeShowsProject,
  'openPath spawned a surface':       tree.surfaceOpened && tree.spawned === 1,
  'kind resolved from project.json':  tree.surfaceKind === 'stub',
  're-opening a path dedups':         tree.deduped,
  // Text editor surface
  'text surface opens a loose file':  textOpen.ready === true,
  'text surface title is filename':   textOpen.title === 'notes.txt',
  'text surface read file content':   loadedContent === 'hello world',
  'Flush writes buffer to the VFS':   textFlush.onDisk === 'edited by smoke',
  // A-Bus inspector surface
  'broker.inspect() returns peers':   inspectorOpen.brokerPeers > 0 && inspectorOpen.brokerHasSubs,
  'inspector surface opens':          inspectorOpen.ready === true,
  'inspector renders the registry':   inspectorPeerRows > 0,
  // Persistence (Chunk 5)
  'workspace survives a reload':      persist.projExists && persist.note === 'survives reload',
  'tree shows projects after reload': persist.treeHasProj,
  'tabs restore after reload':        persist.tabsRestored > 0,
};

console.log('--- works.html (Works rebuild — Chunks 1-3, 5 + surfaces) ---');
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log((pass ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!pass) ok = false;
}
if (errors.length) {
  console.log('--- page errors ---');
  for (const e of errors) console.log(e);
}
console.log('status: ' + JSON.stringify(shell.status)
  + ' | surface: ' + JSON.stringify(surface));

await browser.close();
server.close();
console.log(ok ? '\nworks smoke: OK' : '\nworks smoke: FAILED');
process.exit(ok ? 0 : 1);
