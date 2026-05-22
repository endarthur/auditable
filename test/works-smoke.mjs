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
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css',
};

let exportedHtml = null;   // set by the export round-trip test below

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p === '/exported-workspace.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(exportedHtml || '<!doctype html>');
    return;
  }
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

// Find a surface's iframe Frame by its tab id. Surfaces load from blob URLs
// (§15.1 embedded payloads), so they can't be matched by file name.
async function surfaceFrame(tabId) {
  const handle = await page.evaluateHandle(
    (id) => (window.WKS.surfaces.get(id) || {}).iframe, tabId);
  const el = handle.asElement();
  return el ? await el.contentFrame() : null;
}

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
const textFrame = await surfaceFrame(textOpen.tabId);
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
    tabId,
    brokerPeers: (snap.peers || []).length,
    brokerHasSubs: Array.isArray(snap.subscriptions),
    ready: rec ? rec.ready : false,
  };
});

const inspectorFrame = await surfaceFrame(inspectorOpen.tabId);
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

// ── Notebook surface ──────────────────────────────────────────────────
// A notebook project opened as a surface: it boots auditable.html in the
// iframe, hydrates its cells from the workspace over A-Bus, and flushes
// back through the Works Host.
const nbOpen = await page.evaluate(async () => {
  const W = window.WKS;
  await W.vfs.mkdir('/projects/SmokeNB', { recursive: true });
  await W.vfs.writeFile('/projects/SmokeNB/project.json',
    JSON.stringify({ kind: 'notebook', id: 'nb-smoke', title: 'Smoke NB' }));
  await W.vfs.writeFile('/projects/SmokeNB/notebook.txt',
    '/// auditable\n/// title: Smoke NB\n\n/// md\n# notebook surface smoke\n\n/// code\ndisplay(6 * 7)\n');

  const tabId = await W.openPath('/projects/SmokeNB');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 25000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return rec
    ? { tabId, uniqueName: rec.uniqueName, ready: rec.ready, kind: rec.kind }
    : { ready: false };
});

// Reach into the notebook iframe — did it hydrate cells from the workspace?
const nbFrame = await surfaceFrame(nbOpen.tabId);
let nbCells = -1;
if (nbFrame) {
  nbCells = await nbFrame.evaluate(() => ((window.S && window.S.cells) || []).length);
}

// Flush the notebook; confirm its notebook.txt round-tripped to the workspace.
const nbFlush = await page.evaluate(async (uniqueName) => {
  const W = window.WKS;
  try {
    await W.worksBus.call(
      { to: uniqueName, path: '/', interface: 'Surface', member: 'Flush' }, []);
  } catch (e) { return { error: e.message }; }
  let onDisk = null;
  try { onDisk = await W.vfs.readFile('/projects/SmokeNB/notebook.txt', 'utf8'); } catch { /* */ }
  return { onDisk };
}, nbOpen.uniqueName);

// ── Import notebook (.txt + .html, current + legacy formats) ──────────
// File → Import notebook…: a .txt source file or a standalone .html
// becomes a /projects/<name> directory that opens as a notebook surface.
const exampleHtml = fs.readFileSync(
  path.join(root, 'examples/basics/example_app_export.html'), 'utf8');

const importResult = await page.evaluate(async (exampleHtml) => {
  const W = window.WKS;

  // .txt — the source form lands as notebook.txt verbatim.
  const txt = '/// auditable\n/// title: Imported TXT\n\n/// md\n# txt\n\n/// code\ndisplay(2)\n';
  const txtPath = await W.importNotebook(txt, 'whatever.txt');
  const txtMeta = JSON.parse(await W.vfs.readFile(txtPath + '/project.json', 'utf8'));
  const txtNb = await W.vfs.readFile(txtPath + '/notebook.txt', 'utf8');

  // .html, current format — an AUDITABLE-VFS dump is unpacked, data
  // siblings and all.
  const dump = {
    '/projects/self/notebook.txt': { type: 'file', kind: 'text',
      content: '/// auditable\n/// title: Imported VFS\n\n/// code\ndisplay(1 + 1)\n' },
    '/projects/self/data.csv': { type: 'file', kind: 'text', content: 'a,b\n1,2\n' },
  };
  const vfsHtml = '<!DOCTYPE html><html><head><title>Auditable — Imported VFS</title>'
    + '</head><body><!--AUDITABLE-VFS\n' + JSON.stringify(dump) + '\nAUDITABLE-VFS-->'
    + '</body></html>';
  const vfsPath = await W.importNotebook(vfsHtml, 'export.html');
  const vfsNb = await W.vfs.readFile(vfsPath + '/notebook.txt', 'utf8');
  const vfsData = await W.vfs.readFile(vfsPath + '/data.csv', 'utf8');

  // .html, legacy format — AUDITABLE-DATA/MODULES/SETTINGS converted to a
  // project: cells → notebook.txt, module source → the shared /lib store.
  const legacyHtml = '<!DOCTYPE html><!--AUDITABLE-NOTEBOOK-->'
    + '<html><head><title>Auditable — Legacy NB</title></head><body>'
    + '<!--AUDITABLE-DATA\n' + JSON.stringify([
        { type: 'md', code: '# legacy' }, { type: 'code', code: 'display(3)' }])
    + '\nAUDITABLE-DATA-->\n'
    + '<!--AUDITABLE-MODULES\n' + JSON.stringify({
        '@test/mod': { source: 'export const x = 1;', cellId: 'c1' } })
    + '\nAUDITABLE-MODULES-->\n'
    + '<!--AUDITABLE-SETTINGS\n{"theme":"dark","fontSize":13,"width":"860"}\nAUDITABLE-SETTINGS-->'
    + '</body></html>';
  const legacyPath = await W.importNotebook(legacyHtml, 'legacy.html');
  const legacyNb = await W.vfs.readFile(legacyPath + '/notebook.txt', 'utf8');
  let legacyModSource = null;
  try {
    legacyModSource = await W.vfs.readFile(
      '/lib/' + encodeURIComponent('@test/mod') + '/source', 'utf8');
  } catch { /* */ }

  // a real examples/ notebook (legacy format) imports cleanly.
  const realPath = await W.importNotebook(exampleHtml, 'example_app_export.html');
  const realNb = await W.vfs.readFile(realPath + '/notebook.txt', 'utf8');

  // an encrypted notebook is refused, not silently mangled.
  let cryptoRefused = false;
  try {
    await W.importNotebook(
      '<html><head><title>Auditable — Encrypted</title></head><body>'
      + '<!--AUDITABLE-CRYPTO\n{}\nAUDITABLE-CRYPTO-->\n</body></html>', 'locked.html');
  } catch { cryptoRefused = true; }

  // the imported legacy notebook opens as a notebook surface.
  await W.openPath(legacyPath);
  await new Promise((r) => setTimeout(r, 250));
  let opened = null;
  for (const rec of W.surfaces.values()) if (rec.path === legacyPath) opened = rec;

  return {
    txtPath, txtKind: txtMeta.kind, txtTitle: txtMeta.title, txtNbMatches: txtNb === txt,
    vfsPath, vfsNbHasCell: vfsNb.includes('display(1 + 1)'),
    vfsDataMatches: vfsData === 'a,b\n1,2\n',
    legacyPath, legacyNbOk: legacyNb.includes('# legacy') && legacyNb.includes('display(3)'),
    legacyModSource,
    realPath, realNbOk: realNb.startsWith('/// auditable') && /\/\/\/ (code|md)/.test(realNb),
    cryptoRefused,
    opened: !!opened, openedKind: opened && opened.kind,
  };
}, exampleHtml);

// The imported real example must boot as a notebook surface and hydrate
// its cells — the actual "open the examples in Works" goal.
const realOpen = await page.evaluate(async (realPath) => {
  const W = window.WKS;
  const tabId = await W.openPath(realPath);
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 25000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return rec ? { tabId, ready: rec.ready } : { ready: false };
}, importResult.realPath);

const realFrame = await surfaceFrame(realOpen.tabId);
let realCells = -1;
if (realFrame) {
  realCells = await realFrame.evaluate(() => ((window.S && window.S.cells) || []).length);
}

// ── Workspace export / import round-trip (Chunk 5b) ───────────────────
// Serialize the live workspace, build a self-contained HTML, then open it —
// it must boot the desktop over the embedded snapshot.
exportedHtml = await page.evaluate(async () => {
  const W = window.WKS;
  return W.buildWorksHtml(await W.serializeWorkspace(W.vfs));
});
const exportLooksRight = /<!--WORKS-VFS/.test(exportedHtml) && /<\/html>/.test(exportedHtml);

await page.goto(`http://127.0.0.1:${port}/exported-workspace.html`);
await page.waitForFunction(
  () => window.WKS && window.WKS.vfs, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(600);
const imported = await page.evaluate(async () => {
  const W = window.WKS;
  let nbExists = false, note = null;
  try { nbExists = await W.vfs.exists('/projects/SmokeNB/notebook.txt'); } catch { /* */ }
  try { note = await W.vfs.readFile('/projects/persist-note.txt', 'utf8'); } catch { /* */ }
  return { home: W.home && W.home.kind, nbExists, note };
});

// ── file:// portability (§15.1) ───────────────────────────────────────
// works.html must run from file:// — every surface is an embedded payload,
// blob-URL'd on spawn, so it loads same-origin with the shell. The rest of
// this smoke runs over HTTP, which never exercises this.
await page.goto(pathToFileURL(path.join(root, 'works.html')).href);
await page.waitForFunction(
  () => window.WKS && window.WKS.vfs && window.WKS.broker,
  { timeout: 15000 }).catch(() => {});
const fileMode = await page.evaluate(async () => {
  const W = window.WKS;
  if (!W || !W.vfs) return { booted: false, proto: location.protocol };
  const tabId = W.spawnSurface('stub', { path: '/projects', title: 'Stub' });
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 12000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { booted: true, proto: location.protocol, surfaceReady: !!(rec && rec.ready) };
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
  'kind resolved from project.json':  tree.surfaceKind === 'notebook',
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
  // Notebook surface
  'notebook surface opens':           nbOpen.ready === true,
  'notebook surface kind resolved':   nbOpen.kind === 'notebook',
  'notebook hydrates cells from VFS': nbCells === 2,
  'notebook Flush round-trips':       !!nbFlush.onDisk && nbFlush.onDisk.includes('notebook surface smoke'),
  // Import notebook (.txt + .html, current + legacy formats)
  'import .txt creates a notebook project': importResult.txtPath === '/projects/Imported TXT'
      && importResult.txtKind === 'notebook' && importResult.txtTitle === 'Imported TXT',
  'import .txt keeps the source verbatim':  importResult.txtNbMatches,
  'import .html (VFS) unpacks the dump':    importResult.vfsPath === '/projects/Imported VFS'
      && importResult.vfsNbHasCell,
  'import .html (VFS) restores data files': importResult.vfsDataMatches,
  'import .html (legacy) converts cells':   importResult.legacyPath === '/projects/Legacy NB'
      && importResult.legacyNbOk,
  'import .html (legacy) writes modules':   importResult.legacyModSource === 'export const x = 1;',
  'import a real examples/ notebook':       importResult.realNbOk
      && importResult.realPath.startsWith('/projects/'),
  'import refuses an encrypted notebook':   importResult.cryptoRefused,
  'imported notebook opens as a surface':   importResult.opened
      && importResult.openedKind === 'notebook',
  'imported example boots + hydrates':      realOpen.ready === true && realCells > 0,
  // Workspace export / import (Chunk 5b)
  'export builds a self-contained HTML':   exportLooksRight,
  'imported workspace uses a memory home': imported.home === 'memory',
  'imported workspace has its projects':   imported.nbExists,
  'imported workspace keeps its files':    imported.note === 'survives reload',
  // file:// portability (§15.1)
  'works.html boots from file://':         fileMode.booted && fileMode.proto === 'file:',
  'a surface loads from file://':          fileMode.surfaceReady === true,
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
