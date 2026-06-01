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
// The text surface is CodeMirror 6 — read/edit via the exposed EditorView
// (window._cmView), not a <textarea> (the surface dropped that in the CM6 move).
const textFrame = await surfaceFrame(textOpen.tabId);
let loadedContent = null;
if (textFrame) {
  loadedContent = await textFrame.evaluate(
    () => (window._cmView ? window._cmView.state.doc.toString() : null));
  await textFrame.evaluate(() => {
    const v = window._cmView;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'edited by smoke' } });
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

  // Mount an OPFS folder at /mnt/smoke-mount; OPFS gives us a real
  // FileSystemDirectoryHandle without a picker, and it persists in the
  // meta IDB across the reload below.
  const opfsRoot = await navigator.storage.getDirectory();
  const dir = await opfsRoot.getDirectoryHandle('smoke-mount', { create: true });
  const fh = await dir.getFileHandle('hello.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('from disk');
  await w.close();
  await W.mountHandle(dir, 'smoke-mount');

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

  // The /mnt/smoke-mount mount must have reconnected from the saved
  // handle, and its file must read through.
  const mountActive = [...W.vfs._mounts.keys()].includes('/mnt/smoke-mount');
  let mountContent = null;
  try { mountContent = await W.vfs.readFile('/mnt/smoke-mount/hello.txt', 'utf8'); }
  catch { /* */ }

  // After a reload nothing calls spawnSurface — so any live surface came
  // from restoreLayout → renderPanel re-creating it.
  return { projExists, note, treeHasProj, tabsRestored: W.surfaces.size,
    mountActive, mountContent };
});

// Standalone unmount check — the mount goes away, the disk content stays.
const mountTeardown = await page.evaluate(async () => {
  const W = window.WKS;
  const opfsRoot = await navigator.storage.getDirectory();
  const dir = await opfsRoot.getDirectoryHandle('smoke-mount');   // already exists
  await W.unmountAt('/mnt/smoke-mount');
  const mountGone = ![...W.vfs._mounts.keys()].includes('/mnt/smoke-mount');
  // Read the file directly via the OPFS handle — it must still be there.
  let diskStillThere = false;
  try {
    const fh = await dir.getFileHandle('hello.txt');
    diskStillThere = (await (await fh.getFile()).text()) === 'from disk';
  } catch { /* */ }
  return { mountGone, diskStillThere };
});

// ── Notebook surface ──────────────────────────────────────────────────
// A notebook project opened as a surface: it boots auditable.html in the
// iframe, hydrates its cells from the workspace over A-Bus, and flushes
// back through the Works Host.
const nbOpen = await page.evaluate(async () => {
  const W = window.WKS;
  // Re-mount the OPFS folder so the notebook surface's Shell.ListMounts
  // boot path sees a /mnt entry. (The earlier mountTeardown block
  // intentionally unmounted it to verify Unmount; we restore for this test.)
  const opfsRoot = await navigator.storage.getDirectory();
  const dir = await opfsRoot.getDirectoryHandle('smoke-mount');
  await W.mountHandle(dir, 'smoke-mount');
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

// Notebook surface sees the shell's /usr/lib builtins as @gcu/* modules
// in its _installedModules — `await load('@gcu/xterm')` works natively.
let nbBuiltins = null;
if (nbFrame) {
  nbBuiltins = await nbFrame.evaluate(() => {
    const m = window._installedModules || {};
    return {
      hasXterm: !!m['@gcu/xterm'],
      hasGeas:  !!m['@gcu/geas'],
      hasVfs:   !!m['@gcu/vfs'],
      hasAbus:  !!m['@gcu/abus'],
      xtermBuiltinFlag: !!(m['@gcu/xterm'] && m['@gcu/xterm'].builtin),
    };
  });
}

// Notebook surface mirrors shell-side /mnt mounts through the A-Bus proxy
// so workspace-absolute reads (notebook.fs.readFile('/mnt/.../x')) resolve
// even when the surface's `/` is a delegated direct-I/O backend that
// wouldn't otherwise see the shell's mount overlays.
let nbMirroredMount = null;
let nbLiveMount = null;
if (nbFrame) {
  // Boot-time mirror — Shell.ListMounts at provideVFS() seeds /mnt/<name>.
  nbMirroredMount = await nbFrame.evaluate(async () => {
    let mountContent = null;
    try { mountContent = await window._notebookVFS.readFile('/mnt/smoke-mount/hello.txt', 'utf8'); }
    catch { /* */ }
    return {
      hasMirror: window._notebookVFS._mounts.has('/mnt/smoke-mount'),
      mountContent,
    };
  });

  // Live-signal path — mount after the surface is up, surface auto-mirrors
  // via Shell.MountChanged.
  await page.evaluate(async () => {
    const W = window.WKS;
    const opfsRoot = await navigator.storage.getDirectory();
    const dir = await opfsRoot.getDirectoryHandle('smoke-mount-live', { create: true });
    const fh = await dir.getFileHandle('live.txt', { create: true });
    const w = await fh.createWritable();
    await w.write('live'); await w.close();
    await W.mountHandle(dir, 'smoke-mount-live');
  });
  await page.waitForTimeout(200);   // signal hop + mirror mount + AbusBackend init
  nbLiveMount = await nbFrame.evaluate(async () => {
    let content = null;
    try { content = await window._notebookVFS.readFile('/mnt/smoke-mount-live/live.txt', 'utf8'); }
    catch { /* */ }
    return {
      hasMirror: window._notebookVFS._mounts.has('/mnt/smoke-mount-live'),
      content,
    };
  });
}

// pkg auto-rehydrate. Write a fake module + meta straight into the
// workspace /lib from the shell side (simulates `pkg install` from
// somewhere else without going through geas). The notebook surface,
// already open, should see the new key in _installedModules without a
// reload.
let nbAutoRehydrate = null;
if (nbFrame) {
  await page.evaluate(async () => {
    const W = window.WKS;
    await W.vfs.mkdir('/lib/npm/rehydrate-probe', { recursive: true });
    await W.vfs.writeFile('/lib/npm/rehydrate-probe/source',
      'export const probe = () => "ok";');
    await W.vfs.writeFile('/lib/npm/rehydrate-probe/meta.json',
      JSON.stringify({ alias: 'npm:rehydrate-probe', kind: 'js',
        url: 'https://esm.sh/rehydrate-probe', size: 33 }));
  });
  await page.waitForTimeout(400);   // debounce + signal hop + rehydrate
  nbAutoRehydrate = await nbFrame.evaluate(() => ({
    hasEntry: !!(window._installedModules
      && window._installedModules['npm:rehydrate-probe']),
  }));
}

// Shell cells (`!cmd` → notebook.shell + display). Opens a dedicated
// notebook with a `!`-cell that autorun-on-load fires, then reaches into
// the surface iframe and reads the cell's output area. Exercises the
// full Geas + @gcu/proc stack from inside a notebook surface in Works.
const nbShellTab = await page.evaluate(async () => {
  const W = window.WKS;
  await W.vfs.mkdir('/projects/SmokeShell', { recursive: true });
  await W.vfs.writeFile('/projects/SmokeShell/project.json',
    JSON.stringify({ kind: 'notebook', id: 'nb-smokeshell', title: 'Smoke Shell' }));
  // Two code cells: the !-cell (shell-cmd test) and the local:-cell
  // (pkg-spec §3.4 test). Cells are run explicitly via window.runAll after
  // the surface is ready — run-on-load defaults to off, and there is no
  // `runOnLoad` txt header (an earlier bogus one parsed as a junk cell).
  await W.vfs.writeFile('/projects/SmokeShell/notebook.txt',
    '/// auditable\n/// title: Smoke Shell\n\n'
    + '/// code\n!echo hi from geas\necho second line\n\n'
    + "/// code\nconst _ws = '/tmp/local-smoke-mod.js';\n"
    + "await notebook.fs.write(_ws, 'export const answer = () => 42;');\n"
    + "const _mod = await load('local:' + _ws);\n"
    + "display('local-loaded: ' + _mod.answer());\n");
  const tabId = await W.openPath('/projects/SmokeShell');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 25000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return rec ? { tabId, ready: rec.ready } : { ready: false };
});

const nbShellFrame = nbShellTab.ready ? await surfaceFrame(nbShellTab.tabId) : null;
let nbShellOutput = null;
let nbLocalLoad = null;
if (nbShellFrame) {
  // Run-on-load is off by default; trigger execution explicitly.
  await nbShellFrame.evaluate(() => { if (window.runAll) window.runAll(); });
  nbShellOutput = await nbShellFrame.evaluate(async () => {
    // The !-cell runs via runAll. Poll the FIRST code cell's output for up
    // to 10s (geas worker spawn + exec).
    const deadline = Date.now() + 10000;
    let out = '';
    while (Date.now() < deadline) {
      const cell = window.S?.cells?.filter((c) => c.type === 'code')[0];
      out = (cell && cell.el?.querySelector('.cell-output')?.textContent) || '';
      if (out.includes('hi from geas')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { out };
  });
  nbLocalLoad = await nbShellFrame.evaluate(async () => {
    // The second code cell exercises load('local:/tmp/...').
    const deadline = Date.now() + 5000;
    let out = '';
    while (Date.now() < deadline) {
      const cell = window.S?.cells?.filter((c) => c.type === 'code')[1];
      out = (cell && cell.el?.querySelector('.cell-output')?.textContent) || '';
      if (out.includes('local-loaded')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { out };
  });
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
  // pkg-spec §4: lockfile written at /lib/.gcu-lock.json after every Flush.
  // SmokeNB doesn't install anything so modules: {} is expected; we just
  // want to confirm the file shape lands on disk.
  let lockfile = null;
  try {
    const raw = await W.vfs.readFile('/lib/.gcu-lock.json', 'utf8');
    lockfile = JSON.parse(raw);
  } catch { /* */ }
  return { onDisk, lockfile };
}, nbOpen.uniqueName);

// ── Import notebook (.txt + .html, current + legacy formats) ──────────
// File → Import notebook…: a .txt source file or a standalone .html
// becomes a /projects/<name> directory that opens as a notebook surface.
// Read verbatim — on Windows git autocrlf checks this out with CRLF, which
// exercises importNotebook's CRLF→LF normalization (it must accept either).
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

// ── Terminal surface — geas in a worker, xterm.js display ─────────────
// Spawn the terminal, wait for Ready (worker boot + geas init), then drive
// `echo` and `ls /projects` through the client and confirm both the
// builtin output and a VFS-proxied readdir reach the xterm buffer.
const termOpen = await page.evaluate(async () => {
  const W = window.WKS;
  const tabId = W.spawnSurface('terminal', { title: 'Terminal' });
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 30000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { tabId, ready: !!(rec && rec.ready) };
});

const termFrame = await surfaceFrame(termOpen.tabId);
let termRun = { error: 'no frame' };
if (termFrame) {
  termRun = await termFrame.evaluate(async () => {
    const client = window._geasClient;
    const term = window._term;
    if (!client || !term) return { error: 'no test hook' };
    const snapshot = () => {
      const buf = term.buffer.active;
      let text = '';
      for (let i = 0; i < buf.length; i++) {
        text += buf.getLine(i).translateToString(true) + '\n';
      }
      return text;
    };
    try { await client.exec('echo hello-from-smoke'); }
    catch (e) { return { error: 'echo failed: ' + e.message }; }
    await new Promise((r) => setTimeout(r, 150));   // let stdout flush

    // ls /projects exercises the surface VFS → A-Bus → workspace path.
    try { await client.exec('ls /projects'); }
    catch (e) { return { error: 'ls failed: ' + e.message }; }
    await new Promise((r) => setTimeout(r, 150));

    // An unknown command must print "name: command not found" — silent
    // failures are user-hostile (POSIX 2.5.2). Fix is in createShell's
    // default onCommand.
    try { await client.exec('does-not-exist-cmd'); }
    catch (e) { return { error: 'unknown-cmd path threw: ' + e.message }; }
    await new Promise((r) => setTimeout(r, 150));

    return { text: snapshot() };
  });
}

// ── pkg CLI (pkg-spec chunk 4) — install local: + list + freeze + remove
const termPkg = termFrame ? await termFrame.evaluate(async () => {
  const client = window._geasClient;
  const term = window._term;
  if (!client || !term) return { error: 'no test hook' };
  const snapshot = (start = 0) => {
    const buf = term.buffer.active;
    let text = '';
    for (let i = start; i < buf.length; i++) {
      text += buf.getLine(i).translateToString(true) + '\n';
    }
    return text;
  };
  const startLine = term.buffer.active.length;

  // 1. Write a tiny JS module to /tmp on the surface VFS — the geas
  //    worker's vfs is the same VFS via serveVFS, so this lands at /tmp
  //    in the worker's view.
  const vfs = window._surfaceVfs || window._notebookVFS;
  if (!vfs) return { error: 'no VFS handle' };
  await vfs.writeFile('/tmp/pkg-test-mod.js',
    'export const ping = () => "pong";');

  // 2. pkg install local:/tmp/pkg-test-mod.js
  try { await client.exec('pkg install local:/tmp/pkg-test-mod.js'); }
  catch (e) { return { error: 'pkg install failed: ' + e.message }; }
  await new Promise((r) => setTimeout(r, 200));

  // 3. pkg list — should mention the alias
  try { await client.exec('pkg list'); }
  catch (e) { return { error: 'pkg list failed: ' + e.message }; }

  // 4. Confirm the lockfile entry via VFS read — POLL for it to appear
  // (same reason as the remove poll below: the worker→A-Bus→shell write
  // hop lags under full-suite load; a fixed wait was intermittently early).
  let lockfile = null;
  const installDeadline = Date.now() + 3000;
  while (Date.now() < installDeadline) {
    try {
      lockfile = JSON.parse(await vfs.readFile('/lib/.gcu-lock.json', 'utf8'));
      if (lockfile.modules && lockfile.modules['local:/tmp/pkg-test-mod.js']) break;
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 50));
  }

  // 5. pkg remove — poll for the lockfile-entry-gone state instead of
  // a fixed wait. A-Bus VFS.Write fires after the worker reports done,
  // but the message-loop hop to the shell can lag on busy runs; this
  // was the source of an intermittent FAIL.
  try { await client.exec('pkg remove local:/tmp/pkg-test-mod.js'); }
  catch (e) { return { error: 'pkg remove failed: ' + e.message }; }
  let lockfileAfter = null;
  const removeDeadline = Date.now() + 2000;
  while (Date.now() < removeDeadline) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      lockfileAfter = JSON.parse(await vfs.readFile('/lib/.gcu-lock.json', 'utf8'));
      if (!lockfileAfter.modules['local:/tmp/pkg-test-mod.js']) break;
    } catch { /* */ }
  }

  return {
    lockfileHasEntry: !!(lockfile && lockfile.modules
      && lockfile.modules['local:/tmp/pkg-test-mod.js']),
    lockfileAfterRemove: !!(lockfileAfter && lockfileAfter.modules
      && !lockfileAfter.modules['local:/tmp/pkg-test-mod.js']),
  };
}) : { error: 'no term frame' };

// ── Tree context actions — New file / Export project / Import file ────
const ctx = await page.evaluate(async () => {
  const W = window.WKS;

  // New file… — creates an empty file at a folder path.
  const newFilePath = await W.newFile('/projects', 'ctx-test.csv');
  const newFileExists = await W.vfs.exists(newFilePath);

  // Export project → a standalone notebook .html. Pack a project with a
  // data sibling, then verify the export contains the data block + title,
  // and round-trips back through importNotebook.
  await W.newProject('/projects', 'Export Test');
  await W.vfs.writeFile('/projects/Export Test/data.csv', 'a,b\n1,2\n');

  // pkg-spec §7: workspace /lib modules are inlined into the export so
  // the standalone notebook can resolve load() calls without re-fetching.
  // Stage a fake pkg-installed module before exporting and verify the
  // dump carries its bytes.
  await W.vfs.mkdir('/lib/npm/export-probe', { recursive: true });
  await W.vfs.writeFile('/lib/npm/export-probe/source',
    'export const tag = () => "exported";');
  await W.vfs.writeFile('/lib/npm/export-probe/meta.json',
    JSON.stringify({ alias: 'npm:export-probe', kind: 'js',
      url: 'https://esm.sh/export-probe', size: 35 }));

  const exportedHtml = await W.buildProjectExportHtml('/projects/Export Test');
  const hasBlock = exportedHtml.includes('<!--AUDITABLE-VFS');
  const hasTitle = exportedHtml.includes('<title>Auditable — Export Test</title>');
  // The dump is JSON.stringify'd into the AUDITABLE-VFS block; the source
  // text's `"exported"` becomes the JSON-escaped `\"exported\"`.
  const hasModule = exportedHtml.includes('/lib/npm/export-probe/source')
                 && exportedHtml.includes('export const tag = () => \\"exported\\"');

  // Round-trip: re-import the exported HTML as a new project — its data
  // sibling must come back intact.
  const rtPath = await W.importNotebook(exportedHtml, 'Export Test.html');
  const rtData = await W.vfs.readFile(rtPath + '/data.csv', 'utf8');

  // Import as notebook — feed a VFS file (the right-click case for a file
  // sitting under a mounted folder) through the importer.
  await W.vfs.writeFile('/home/inline.txt',
    '/// auditable\n/// title: From File\n\n/// code\ndisplay(42)\n');
  const fromFilePath = await W.importFileAsNotebook('/home/inline.txt');
  const fromFileMeta = JSON.parse(
    await W.vfs.readFile(fromFilePath + '/project.json', 'utf8'));

  return {
    newFilePath, newFileExists,
    exportPath: '/projects/Export Test',
    hasBlock, hasTitle, hasModule,
    rtPath, rtDataMatches: rtData === 'a,b\n1,2\n',
    fromFilePath, fromFileTitle: fromFileMeta.title,
  };
});

// ── Preview surface — CSV / JSON / Markdown / image ───────────────────
// Drop a file of each kind at the workspace and openPath it; the
// surface registry should dispatch to 'preview', the surface reads the
// file through the works VFS service, and renders.
const previewSetup = await page.evaluate(async () => {
  const W = window.WKS;
  await W.vfs.writeFile('/projects/sample.csv',
    'id,name,value,date\n1,alpha,3.14,2024-01-15\n2,beta,2.72,2024-02-20\n3,gamma,1.41,2024-03-10\n');
  await W.vfs.writeFile('/projects/sample.json',
    JSON.stringify({ name: 'preview-test', tags: ['a', 'b', 'c'],
      nested: { count: 42, flag: true } }, null, 2));
  await W.vfs.writeFile('/projects/sample.md',
    '# Preview Test\n\nThis is a **paragraph** with `inline code`.\n\n## Section\n\n- list item\n');
  return {};
});

async function openAndRead(path) {
  const tabId = await page.evaluate(async (p) => {
    const W = window.WKS;
    const id = await W.openPath(p);
    const rec = W.surfaces.get(id);
    const deadline = Date.now() + 15000;
    while (rec && !rec.ready && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
    }
    return rec && rec.ready ? id : null;
  }, path);
  if (!tabId) return { ready: false };
  const frame = await surfaceFrame(tabId);
  if (!frame) return { ready: true, html: null };
  const kind = await page.evaluate(
    (id) => window.WKS.surfaces.get(id).kind, tabId);
  // The preview surface reads the file + renders asynchronously after Ready,
  // so poll #root for rendered content (past the initial "Loading…") rather
  // than assuming it's painted at a fixed delay. Never throw on a null root.
  let html = null;
  const dl = Date.now() + 6000;
  while (Date.now() < dl) {
    html = await frame.evaluate(() => {
      // preview surface renders into #root; doc surface (owns .md) into #preview.
      const r = document.getElementById('root') || document.getElementById('preview');
      return r ? r.innerHTML : null;
    });
    if (html && !/id="loading"/.test(html)) break;
    await frame.evaluate(() => new Promise((r) => setTimeout(r, 80)));
  }
  return { ready: true, html, kind };
}

const csvPv  = await openAndRead('/projects/sample.csv');
const jsonPv = await openAndRead('/projects/sample.json');
const mdPv   = await openAndRead('/projects/sample.md');

// CSV header click → rows sort by that column. Verify the value column
// (descending) reorders the rows so the first data row is `gamma 1.41`
// (smallest) — column 2 is "value", numeric.
const csvSort = await page.evaluate(async () => {
  const W = window.WKS;
  // The sample.csv preview surface is already open from the test above;
  // find its tab and reach into its frame.
  let tabId = null;
  for (const [id, rec] of W.surfaces) if (rec.path === '/projects/sample.csv') tabId = id;
  return { tabId };
});
let csvSorted = null;
if (csvSort.tabId) {
  const frame = await surfaceFrame(csvSort.tabId);
  if (frame) {
    csvSorted = await frame.evaluate(async () => {
      // Click the "value" header (column 2) twice to sort descending. Re-
      // query the th each time — innerHTML re-renders the thead, so the
      // old node is detached and a stale ref won't bubble events.
      const clickValueHeader = async () => {
        document.querySelectorAll('table.csv thead th')[2].click();
        await new Promise((r) => setTimeout(r, 50));
      };
      await clickValueHeader();
      await clickValueHeader();
      const firstRow = [...document.querySelectorAll('table.csv tbody tr')[0]
        .querySelectorAll('td')].map((c) => c.textContent);
      const indicatorOnValue = !!document.querySelectorAll('table.csv thead th')[2]
        .querySelector('.sort-ind');
      return { firstRow, indicatorOnValue };
    });
  }
}

// ── Tree: Duplicate project ───────────────────────────────────────────
const dup = await page.evaluate(async () => {
  const W = window.WKS;
  const dst = await W.duplicateProject('/projects/Quad', 'Quad duplicated');
  if (!dst) return { dst };
  const meta = JSON.parse(await W.vfs.readFile(dst + '/project.json', 'utf8'));
  const origMeta = JSON.parse(
    await W.vfs.readFile('/projects/Quad/project.json', 'utf8'));
  const dstNb = await W.vfs.readFile(dst + '/notebook.txt', 'utf8');
  const origNb = await W.vfs.readFile('/projects/Quad/notebook.txt', 'utf8');
  return {
    dst, dstId: meta.id, dstTitle: meta.title, origId: origMeta.id,
    contentMatches: dstNb === origNb,
  };
});

// ── Patchbay surface — reactive rack over the sideact engine ──────────
// Open a .patchbay loose file; the surface mounts the canvas rack, the engine
// hydrates the modules + cables, and Flush round-trips the rack JSON.
const pbOpen = await page.evaluate(async () => {
  const W = window.WKS;
  const starter = {
    format: 'patchbay', version: 1,
    rack: { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] },
    modules: [
      { id: 'lfo', type: 'src.lfo', row: 0, hpPos: 4, knobs: { rate: 0.3 }, params: {} },
      { id: 'scope', type: 'disp.scope', row: 0, hpPos: 16, knobs: {}, params: {} },
    ],
    cables: [{ from: { id: 'lfo', port: 'sin' }, to: { id: 'scope', port: 'x' } }],
  };
  await W.vfs.writeFile('/projects/smoke.patchbay', JSON.stringify(starter));
  const tabId = await W.openPath('/projects/smoke.patchbay');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 15000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return rec ? { tabId, ready: rec.ready, kind: rec.kind, uniqueName: rec.uniqueName } : { ready: false };
});

const pbFrame = pbOpen.ready ? await surfaceFrame(pbOpen.tabId) : null;
let pbMounted = null;
if (pbFrame) {
  await pbFrame.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  pbMounted = await pbFrame.evaluate(() => ({
    hasCanvas: !!document.querySelector('#pb-root canvas'),
    modules: (window._pbApp && window._pbApp.engine.instances.size) || 0,
    cables: (window._pbApp && window._pbApp.engine.cables.length) || 0,
  }));
}

const pbFlush = await page.evaluate(async (uniqueName) => {
  const W = window.WKS;
  try {
    await W.worksBus.call(
      { to: uniqueName, path: '/', interface: 'Surface', member: 'Flush' }, []);
  } catch (e) { return { error: e.message }; }
  let doc = null;
  try { doc = JSON.parse(await W.vfs.readFile('/projects/smoke.patchbay', 'utf8')); } catch { /* */ }
  return { ok: !!doc && doc.format === 'patchbay', modules: doc ? doc.modules.length : 0 };
}, pbOpen.uniqueName);

// ── Pipeline service (shell-side @gcu/flowsheet engine over @gcu/sluice+recon) ──
// Prove §7a's core: a flowsheet graph runs SHELL-SIDE over a VFS file; only the
// small result crosses A-Bus. [load.csv → recon.sniff → stats], pulled by name.
const pipeline = await page.evaluate(async () => {
  const W = window.WKS;
  // A multi-KB CSV so the scan chunks into several pieces → the worker pool
  // actually engages (tiny inputs scan inline). Au_gpt = i/1000 → mean 0.9995.
  let csv = 'X,Y,Z,Au_gpt,LITO\n';
  for (let i = 0; i < 2000; i++) csv += `${1000 + i * 10},2005,302.5,${(i * 0.001).toFixed(3)},${i % 2 ? 'A' : 'B'}\n`;
  await W.vfs.writeFile('/projects/smoke.csv', csv);
  const graph = { nodes: [
    { id: 'src', type: 'load.csv', params: { path: '/projects/smoke.csv' } },
    { id: 'snf', type: 'recon.sniff', wiring: { table: { node: 'src', port: 'table' } } },
    { id: 'st', type: 'stats', params: { column: 'Au_gpt' },
      wiring: { table: { node: 'src', port: 'table' }, manifest: { node: 'snf', port: 'manifest' } } },
  ] };
  const call = (member, args) => W.worksBus.call(
    { to: 'pipeline', path: '/', interface: 'Pipeline', member }, args);
  let types = null, valid = null, manifest = null, stats = null, worker = null, swath = null, cf = null, err = null;
  try {
    types = await call('NodeTypes', []);
    valid = await call('Validate', [graph]);
    manifest = await call('Pull', [graph, 'snf', 'manifest']);
    stats = await call('Pull', [graph, 'st', 'stats']);
    worker = await call('WorkerInfo', []);
    swath = await call('Pull', [{ nodes: [
      { id: 'src', type: 'load.csv', params: { path: '/projects/smoke.csv' } },
      { id: 'snf', type: 'recon.sniff', wiring: { table: { node: 'src', port: 'table' } } },
      { id: 'sw', type: 'swath', params: { axis: 'X', grade: 'Au_gpt', binWidth: 5000 },
        wiring: { table: { node: 'src', port: 'table' }, manifest: { node: 'snf', port: 'manifest' } } },
    ] }, 'sw', 'swath']);
    // calc → filter → stats, streaming (the ops fuse into the scan + cross to
    // workers). AuEq = Au_gpt·2 (0..3.998); keep AuEq>1 (i>500 → 1499 rows);
    // mean AuEq over i 501..1999 = 2·1250/1000 = 2.5.
    cf = await call('Pull', [{ nodes: [
      { id: 'src', type: 'load.csv', params: { path: '/projects/smoke.csv' } },
      { id: 'snf', type: 'recon.sniff', wiring: { table: { node: 'src', port: 'table' } } },
      { id: 'ca', type: 'calc', params: { name: 'AuEq', expr: 'Au_gpt * 2' }, wiring: { table: { node: 'src', port: 'table' } } },
      { id: 'fl', type: 'filter', params: { expr: 'AuEq > 1' }, wiring: { table: { node: 'ca', port: 'table' } } },
      { id: 'cst', type: 'stats', params: { column: 'AuEq' },
        wiring: { table: { node: 'fl', port: 'table' }, manifest: { node: 'snf', port: 'manifest' } } },
    ] }, 'cst', 'stats']);
  } catch (e) { err = e.message; }
  const b0 = swath && swath[0] && swath[0].value && swath[0].value.g;
  return {
    types, validOk: valid && valid.ok, err,
    coordX: manifest && manifest.coordCols && manifest.coordCols.x,
    auUnit: manifest && (manifest.columns.find((c) => c.name === 'Au_gpt') || {}).unit,
    mean: stats && stats.v && stats.v.mean,
    count: stats && stats.v && stats.v.count,
    pooled: worker && worker.pooled, scanMode: worker && worker.lastScanMode,
    swathBins: Array.isArray(swath) ? swath.length : 0,
    swathHasMean: !!(b0 && typeof b0.mean === 'number' && b0.count > 0),
    calcFilter: !!(cf && cf.v && cf.v.count === 1499 && Math.abs(cf.v.mean - 2.5) < 1e-6),
  };
});

// ── Data Workbench surface (exploration UI over the pipeline service) ──
// Spawn the surface, drive its path input → it pulls recon schema + sluice
// summary stats from the `pipeline` service and renders them.
const wbOpen = await page.evaluate(async () => {
  const W = window.WKS;
  const tabId = W.spawnSurface('workbench', { title: 'Data Workbench' });
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 20000;
  while (rec && !rec.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { tabId, ready: !!(rec && rec.ready) };
});
let wbView = { ok: false };
let gtView = { ok: false };
let wbTransform = { derivedShown: false, rowCount: false };
if (wbOpen.ready) {
  const fr = await surfaceFrame(wbOpen.tabId);
  if (fr) {
    await fr.evaluate(() => {           // smoke.csv was written by the pipeline section above
      document.getElementById('path').value = '/projects/smoke.csv';
      document.getElementById('load').click();
    });
    let deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      wbView = await fr.evaluate(() => {
        const out = document.getElementById('out');
        const text = out ? out.textContent : '';
        return {
          hasAuColumn: text.includes('Au_gpt'),
          hasLito: text.includes('LITO'),
          cols: out ? out.querySelectorAll('td.name').length : 0,
        };
      });
      if (wbView.hasAuColumn && wbView.cols >= 5) { wbView.ok = true; break; }
      await page.waitForTimeout(150);
    }
    // Drive the grade-tonnage view: click its Compute button, await the curve.
    if (wbView.ok) {
      await fr.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Compute');
        if (b) b.click();
      });
      deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        gtView = await fr.evaluate(() => {
          const r = document.getElementById('gt-result');
          return { hasSvg: !!(r && r.querySelector('svg')), hasTable: !!(r && r.querySelector('table')) };
        });
        if (gtView.hasSvg && gtView.hasTable) { gtView.ok = true; break; }
        await page.waitForTimeout(150);
      }
    }
    // Drive the Transform UI: add a derived column (AuEq = Au_gpt*2) + a filter
    // (AuEq > 1), Apply, and confirm the derived column is first-class (shown)
    // and the "N of M rows kept" readout appears.
    if (wbView.ok) {
      await fr.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent === '+ derived column')?.click();
        const row = document.querySelector('#derives-wrap .derive-row');
        row.querySelector('[data-role=name]').value = 'AuEq';
        row.querySelector('[data-role=expr]').value = 'Au_gpt * 2';
        document.getElementById('filter-input').value = 'AuEq > 1';
        [...document.querySelectorAll('button')].find((b) => b.textContent === 'Apply + Analyze')?.click();
      });
      const deadline2 = Date.now() + 20000;
      while (Date.now() < deadline2) {
        wbTransform = await fr.evaluate(() => {
          const out = document.getElementById('out');
          const text = out ? out.textContent : '';
          return { derivedShown: text.includes('AuEq'), rowCount: /rows kept/.test(text) };
        });
        if (wbTransform.derivedShown && wbTransform.rowCount) break;
        await page.waitForTimeout(150);
      }
    }
  }
}

// ── Workspace export / import round-trip (Chunk 5b) ───────────────────
// Serialize the live workspace, build a self-contained HTML, then open it —
// it must boot the desktop over the embedded snapshot.
// @gcu/librarian (v2 CSR engine) — exercise the EMBEDDED bundle in-browser.
// The shell installs each shared lib to /usr/lib/@gcu/<name>/source at boot;
// blob-import librarian + docview from there and run the real consumer paths
// (multi-field ranked search + snippet, the lean folded path, scan, incremental,
// pack/unpack, and docview.buildSearchIndex — the doc/reader search consumer).
const librarian = await page.evaluate(async () => {
  const W = window.WKS;
  const out = { err: null };
  try {
    const libSrc = await W.vfs.readFile('/usr/lib/@gcu/librarian/source', 'utf8');
    const L = (await import(URL.createObjectURL(new Blob([libSrc], { type: 'text/javascript' })))).Librarian;
    out.csr = L.index({ docs: [{ id: 'a', title: 'Encryption' }] })._csr === true;

    const docs = [
      { id: 'd1', title: 'Encryption', body: 'aes-gcm encryption protects notebook data with a passphrase', file: 'a.md', anchor: 'enc' },
      { id: 'd2', title: 'Mounts', body: 'disk folders mounted at a path' },
      { id: 'd3', title: 'Filesystem', body: 'the virtual filesystem unifies storage' },
    ];
    // multi (default) — ranked hit + aligned snippet + preserved meta.
    const idx = L.index({ docs, fields: { title: { boost: 4 }, body: { boost: 1 } } });
    const r = L.search(idx, 'encryption');
    out.multiRank = r[0] && r[0].id === 'd1';
    out.snippet = !!(r[0] && /<mark>/.test(r[0].snippet || ''));
    out.meta = !!(r[0] && r[0].doc && r[0].doc.file === 'a.md');
    out.fuzzy = L.search(idx, 'encrytion', { fuzzy: 1 })[0]?.id === 'd1';
    // prefix option (default on; prefix:false → whole-term only) + scoped filter.
    out.prefixOpt = L.search(idx, 'encry', { fuzzy: 0 }).length > 0
      && L.search(idx, 'encry', { fuzzy: 0, prefix: false }).length === 0;
    out.filterOpt = L.search(idx, 'notebook', { filter: (id) => id === 'd1' }).every((h) => h.id === 'd1');

    // lean folded path + scan + incremental + pack round-trip.
    const lean = L.index({ docs, mode: 'folded', fields: { title: { boost: 4 }, body: { boost: 1 } }, storeText: false, positions: false });
    out.leanRank = L.search(lean, 'encryption')[0]?.id === 'd1';
    out.scan = L.scan(L.buildBlob(docs), 'notebook').some((h) => h.id === 'd1');
    L.addDoc(lean, { id: 'd4', body: 'kriging variogram grade' });
    out.addDoc = L.search(lean, 'kriging')[0]?.id === 'd4';
    const idx2 = L.unpack(L.pack(L.index({ docs, fields: { title: { boost: 4 }, body: { boost: 1 } } })));
    out.pack = L.search(idx2, 'filesystem')[0]?.id === 'd3';

    // docview.buildSearchIndex — the doc/reader search consumer, CSR-backed.
    const dvSrc = await W.vfs.readFile('/usr/lib/@gcu/docview/source', 'utf8');
    const DV = await import(URL.createObjectURL(new Blob([dvSrc], { type: 'text/javascript' })));
    const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dvIdx = DV.buildSearchIndex(L, [{ path: 'guide.md', title: 'Guide', md: '# Intro\n\nbody text\n\n## Encryption\n\naes-gcm keeps notebook data safe\n' }], slugify);
    const dr = L.search(dvIdx, 'encryption');
    out.docview = !!(dr[0] && dr[0].id === 'guide.md#encryption' && dr[0].doc.anchor === 'encryption');
  } catch (e) { out.err = String(e && e.message || e); }
  return out;
});

// @gcu/stereonet — end-to-end in a notebook surface. A `/// stereonet` cell
// must auto-load from the /usr/lib builtin (LANGUAGE_PACKS), register, render an
// interactive net (ctx.display of the bearing SVG), and define a reactive scope
// handle a downstream code cell consumes (dcos + principal-axes stats), with
// the engine resolved via load('@gcu/bearing') from the builtin.
const stereoTab = await page.evaluate(async () => {
  const W = window.WKS;
  await W.vfs.mkdir('/projects/StereoNB', { recursive: true });
  await W.vfs.writeFile('/projects/StereoNB/project.json',
    JSON.stringify({ kind: 'notebook', id: 'nb-stereo', title: 'Stereo NB' }));
  await W.vfs.writeFile('/projects/StereoNB/notebook.txt',
    '/// auditable\n/// title: Stereo NB\n\n'
    + '/// stereonet\nname bedding\nproj equal-area\ng foliation\n'
    + 'plane 120 35\nplane 125 40\nplane 118 32\nplane 130 38\npole 210 65 #cc3333\ncontour\n\n'
    + "/// code\ndisplay('dcos=' + bedding.dcos.length"
    + " + ' S1=' + bedding.stats.eigenvalues[0].toFixed(3)"
    + " + ' K=' + bedding.stats.K.toFixed(2));\n");
  const tabId = await W.openPath('/projects/StereoNB');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 25000;
  while (rec && !rec.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return rec ? { tabId, ready: rec.ready } : { ready: false };
});

const stereoFrame = stereoTab.ready ? await surfaceFrame(stereoTab.tabId) : null;
let stereo = { ready: false };
if (stereoFrame) {
  stereo = await stereoFrame.evaluate(async () => {
    // Wait for the language pack to auto-load + register the cell type.
    let dl = Date.now() + 12000;
    while (Date.now() < dl && !window._cellTypes?.stereonet) await new Promise((r) => setTimeout(r, 100));
    const registered = !!window._cellTypes?.stereonet;
    if (window.runAll) await window.runAll();
    // Poll the cells' outputs.
    dl = Date.now() + 15000;
    let svg = false, handle = '', err = '', sliders = 0, toggles = 0, hasTokenize = false;
    while (Date.now() < dl) {
      const cells = window.S?.cells || [];
      const sCell = cells.find((c) => c.type === 'stereonet');
      const cCell = cells.find((c) => c.type === 'code');
      svg = !!(sCell && sCell.el?.querySelector('.cell-output svg'));
      // In-cell view widgets (rendered into the cell, not the output area).
      sliders = sCell ? sCell.el.querySelectorAll('audit-slider').length : 0;
      toggles = sCell ? sCell.el.querySelectorAll('audit-checkbox').length : 0;
      handle = (cCell && cCell.el?.querySelector('.cell-output')?.textContent) || '';
      err = (sCell && sCell.el?.querySelector('.cell-error')?.textContent) || ''
          || (cCell && cCell.el?.querySelector('.cell-error')?.textContent) || '';
      if ((svg && handle.includes('dcos=') && sliders >= 2) || err) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    hasTokenize = typeof window._cellTypes?.stereonet?.tokenize === 'function';
    return { ready: true, registered, svg, handle, err, sliders, toggles, hasTokenize };
  });
}

// @gcu/omf1 — the embedded OMF v1 lib must round-trip in-browser (exercises
// CompressionStream "deflate" in a blob: context).
const omf1 = await page.evaluate(async () => {
  const W = window.WKS;
  const out = { err: null };
  try {
    const src = await W.vfs.readFile('/usr/lib/@gcu/omf1/source', 'utf8');
    const M = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const proj = {
      type: 'Project', name: 't', description: '', origin: [0, 0, 0], date_created: '', date_modified: '',
      elements: [{
        type: 'VolumeElement', name: 'bm', description: '', color: null,
        geometry: { type: 'VolumeGridGeometry', origin: [0, 0, 0], axis_u: [1, 0, 0], axis_v: [0, 1, 0], axis_w: [0, 0, 1], tensor_u: new Float64Array([10, 10]), tensor_v: new Float64Array([10]), tensor_w: new Float64Array([5]) },
        data: [{ type: 'ScalarData', name: 'au', description: '', location: 'cells', colormap: null, array: new Float64Array([1, 2]) }],
      }],
    };
    const bytes = await M.writeOMF(proj);
    const back = await M.readOMF(bytes);
    const au = back.elements[0].data[0].array;
    out.roundtrip = back.elements[0].type === 'VolumeElement' && au[0] === 1 && au[1] === 2;
    out.grid = JSON.stringify(M.blockModelGrid(back.elements[0].geometry)) === '[2,1,1]';

    // load.omf flowsheet node: write the .omf to the VFS, then pull stats over
    // the block model THROUGH the pipeline service (omf → table → sniff → stats).
    await W.vfs.writeFile('/projects/smoke.omf', bytes);
    const call = (member, args) => W.worksBus.call({ to: 'pipeline', path: '/', interface: 'Pipeline', member }, args);
    out.nodeRegistered = (await call('NodeTypes', [])).includes('load.omf');
    const g = { nodes: [
      { id: 'src', type: 'load.omf', params: { path: '/projects/smoke.omf' } },
      { id: 'snf', type: 'recon.sniff', wiring: { table: { node: 'src', port: 'table' } } },
      { id: 'st', type: 'stats', params: { column: 'au' }, wiring: { table: { node: 'src', port: 'table' }, manifest: { node: 'snf', port: 'manifest' } } },
    ] };
    const st = await call('Pull', [g, 'st', 'stats']);
    out.pipeline = !!(st && st.v && st.v.count === 2 && Math.abs(st.v.mean - 1.5) < 1e-9);
  } catch (e) { out.err = String((e && e.message) || e); }
  return out;
});

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

// A terminal surface must also boot from file:// — the geas Worker is
// spawned from a blob URL the surface decompresses, which has its own
// blob:file:// origin caveats.
const fileTermOpen = await page.evaluate(async () => {
  const W = window.WKS;
  if (!W || !W.vfs) return { ready: false };
  const tabId = W.spawnSurface('terminal', { title: 'Terminal' });
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 25000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ready: !!(rec && rec.ready) };
});

// A notebook surface must also boot from file:// — exercises the home-
// delegation fallback (Chrome blocks IndexedDB inside a blob:file:// iframe
// even when the shell's file:// page can use it).
const fileNbOpen = await page.evaluate(async () => {
  const W = window.WKS;
  if (!W || !W.vfs) return { ready: false };
  await W.vfs.mkdir('/projects/FileNB', { recursive: true });
  await W.vfs.writeFile('/projects/FileNB/project.json',
    JSON.stringify({ kind: 'notebook', id: 'nb-file', title: 'File NB' }));
  await W.vfs.writeFile('/projects/FileNB/notebook.txt',
    '/// auditable\n/// title: File NB\n\n/// code\ndisplay(2 + 3)\n');
  const tabId = await W.openPath('/projects/FileNB');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 25000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ready: !!(rec && rec.ready) };
});

// A patchbay surface must also boot from file:// — a canvas surface that only
// needs A-Bus + the works VFS service (no getUserMedia/IDB), so blob:file://
// is fine.
const filePbOpen = await page.evaluate(async () => {
  const W = window.WKS;
  if (!W || !W.vfs) return { ready: false };
  await W.vfs.writeFile('/projects/file-smoke.patchbay', JSON.stringify({
    format: 'patchbay', version: 1, rack: { hp: 64, rows: [{ kind: '3U' }] },
    modules: [{ id: 'k', type: 'src.const', row: 0, hpPos: 4, knobs: { value: 0.5 }, params: {} }],
    cables: [],
  }));
  const tabId = await W.openPath('/projects/file-smoke.patchbay');
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 15000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ready: !!(rec && rec.ready) };
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
  // Mount folder (/mnt/<name>)
  'mount reconnects after reload':    persist.mountActive,
  'mount: file readable through VFS': persist.mountContent === 'from disk',
  'unmount: drops from active set':   mountTeardown.mountGone,
  'unmount: leaves disk intact':      mountTeardown.diskStillThere,
  // Notebook surface
  'notebook surface opens':           nbOpen.ready === true,
  'notebook surface kind resolved':   nbOpen.kind === 'notebook',
  'notebook hydrates cells from VFS': nbCells === 2,
  'notebook Flush round-trips':       !!nbFlush.onDisk && nbFlush.onDisk.includes('notebook surface smoke'),
  // pkg-spec §4 lockfile written at /lib/.gcu-lock.json on every Flush
  'Flush writes /lib/.gcu-lock.json': nbFlush.lockfile
                                        && nbFlush.lockfile.version === 1
                                        && typeof nbFlush.lockfile.modules === 'object',
  // Notebook sees /usr/lib builtins as @gcu/* modules
  'notebook sees /usr/lib builtins':  nbBuiltins
      && nbBuiltins.hasXterm && nbBuiltins.hasGeas
      && nbBuiltins.hasVfs && nbBuiltins.hasAbus,
  'builtin flag preserved':           nbBuiltins && nbBuiltins.xtermBuiltinFlag,
  // Shell-side /mnt mounts mirror into the notebook surface VFS
  'notebook mirrors /mnt mount (boot)':   nbMirroredMount && nbMirroredMount.hasMirror,
  'notebook reads through proxy':         nbMirroredMount && nbMirroredMount.mountContent === 'from disk',
  'notebook mirrors /mnt mount (signal)': nbLiveMount && nbLiveMount.hasMirror,
  'notebook reads new mount via signal':  nbLiveMount && nbLiveMount.content === 'live',
  // pkg auto-rehydrate — /lib write reaches _installedModules without reload
  'notebook auto-rehydrates /lib writes': nbAutoRehydrate && nbAutoRehydrate.hasEntry,
  // !cmd cell → notebook.shell → geas worker → captured stdout
  'shell cell prints stdout':             nbShellOutput && nbShellOutput.out
                                            && nbShellOutput.out.includes('hi from geas')
                                            && nbShellOutput.out.includes('second line'),
  // local: scheme — load a JS module straight from the surface VFS
  'local: scheme loads from VFS':         nbLocalLoad && nbLocalLoad.out
                                            && nbLocalLoad.out.includes('local-loaded: 42'),
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
  // Terminal surface
  'terminal: surface boots':          termOpen.ready === true,
  'terminal: echo writes to xterm':   termRun.text && termRun.text.includes('hello-from-smoke'),
  // pkg-spec chunk 4 — pkg CLI from a geas terminal. We verify the
  // structural side (lockfile shape) rather than xterm text since the
  // buffer may have scrolled. End-to-end: geas → @gcu/proc worker →
  // VFS via serveVFS → workspace /lib via A-Bus proxy → shell vfs write.
  'pkg writes to /lib/.gcu-lock.json': termPkg.lockfileHasEntry,
  'pkg remove drops lockfile entry':   termPkg.lockfileAfterRemove,
  'terminal: ls hits the workspace':  termRun.text
      && (termRun.text.includes('SmokeNB') || termRun.text.includes('Quad')),
  'terminal: unknown cmd warns':      termRun.text
      && termRun.text.includes('does-not-exist-cmd: command not found'),
  // Tree context actions
  'tree: New file… creates the file':       ctx.newFileExists
      && ctx.newFilePath === '/projects/ctx-test.csv',
  'tree: Export project builds an .html':   ctx.hasBlock && ctx.hasTitle,
  // pkg-spec §7: workspace /lib modules inlined into the export
  'tree: Export inlines workspace /lib':    ctx.hasModule,
  'tree: exported .html round-trips':       ctx.rtPath === '/projects/Export Test-2'
      && ctx.rtDataMatches,
  'tree: Import file (right-click) works':  ctx.fromFilePath === '/projects/From File'
      && ctx.fromFileTitle === 'From File',
  // Preview surface
  'preview: CSV opens as a table':    csvPv.kind === 'preview' && csvPv.html
      && /<table class="csv"/.test(csvPv.html) && csvPv.html.includes('alpha')
      && csvPv.html.includes('data-type="number"'),
  'preview: JSON opens as a tree':    jsonPv.kind === 'preview' && jsonPv.html
      && jsonPv.html.includes('<details') && jsonPv.html.includes('preview-test'),
  // .md is owned by the doc surface (registered before preview); it renders
  // markdown into its #preview pane with a live HTML view.
  'doc: Markdown renders':            mdPv.kind === 'doc' && mdPv.html
      && /<h1/.test(mdPv.html) && mdPv.html.includes('Preview Test')
      && /<strong>/.test(mdPv.html),
  'preview: CSV header sorts column': csvSorted && csvSorted.indicatorOnValue
      && csvSorted.firstRow && csvSorted.firstRow[1] === 'alpha',
  // Tree context — Duplicate project
  'tree: Duplicate clones the project': dup.dst === '/projects/Quad duplicated'
      && dup.dstTitle === 'Quad duplicated' && dup.contentMatches,
  'tree: Duplicate mints a fresh id':   dup.dstId && dup.origId
      && dup.dstId !== dup.origId,
  // Workspace export / import (Chunk 5b)
  'export builds a self-contained HTML':   exportLooksRight,
  'imported workspace uses a memory home': imported.home === 'memory',
  'imported workspace has its projects':   imported.nbExists,
  'imported workspace keeps its files':    imported.note === 'survives reload',
  // Patchbay surface
  'patchbay: surface opens':          pbOpen.ready === true && pbOpen.kind === 'patchbay',
  'patchbay: canvas + rack mounted':  pbMounted && pbMounted.hasCanvas
                                        && pbMounted.modules >= 2 && pbMounted.cables >= 1,
  'patchbay: Flush persists rack':    pbFlush.ok && pbFlush.modules >= 2,
  // file:// portability (§15.1)
  'works.html boots from file://':         fileMode.booted && fileMode.proto === 'file:',
  'a surface loads from file://':          fileMode.surfaceReady === true,
  'notebook surface boots from file://':   fileNbOpen.ready === true,
  'terminal surface boots from file://':   fileTermOpen.ready === true,
  'patchbay surface boots from file://':   filePbOpen.ready === true,
  // Pipeline service (shell-side flowsheet engine)
  'pipeline: NodeTypes lists the library': Array.isArray(pipeline.types)
      && pipeline.types.includes('load.csv') && pipeline.types.includes('stats'),
  'pipeline: Validate ok':                 pipeline.validOk === true,
  'pipeline: recon.sniff over a VFS file':  pipeline.coordX === 'X' && pipeline.auUnit === 'g/t',
  'pipeline: stats pull (engine shell-side)': pipeline.count === 2000
      && Math.abs(pipeline.mean - 0.9995) < 1e-6,
  'pipeline: scan ran on the @gcu/proc worker pool': pipeline.pooled === true
      && pipeline.scanMode === 'parallel',
  'pipeline: swath bins along X (mean grade per bin)': pipeline.swathBins > 0 && pipeline.swathHasMean,
  'pipeline: calc→filter→stats fuses into the scan': pipeline.calcFilter === true,
  'pipeline: no error':                    !pipeline.err,
  // Data Workbench surface
  'workbench: surface opens':              wbOpen.ready === true,
  'workbench: renders schema + stats from the pipeline': wbView.ok === true
      && wbView.hasAuColumn && wbView.hasLito,
  'workbench: grade-tonnage curve renders':  gtView.ok === true,
  'workbench: calc/filter transform — derived column first-class + row count': wbTransform.derivedShown && wbTransform.rowCount,
  // @gcu/librarian v2 — embedded CSR engine runs in-browser
  'librarian: index() is the CSR engine':   librarian.csr === true,
  'librarian: multi-field ranked search':   librarian.multiRank && librarian.fuzzy,
  'librarian: aligned snippet + meta':       librarian.snippet && librarian.meta,
  'librarian: lean folded path + scan':      librarian.leanRank && librarian.scan,
  'librarian: incremental addDoc':           librarian.addDoc,
  'librarian: pack/unpack round-trips':      librarian.pack,
  'librarian: docview search consumer':      librarian.docview,
  'librarian: prefix + filter search opts':  librarian.prefixOpt && librarian.filterOpt,
  'librarian: no error':                     !librarian.err,
  // @gcu/stereonet — cell type auto-loads + renders + feeds a reactive handle
  'stereonet: cell type auto-loads (LANGUAGE_PACKS)': stereo.registered === true,
  'stereonet: renders an interactive net (SVG)':       stereo.svg === true,
  'stereonet: reactive handle feeds downstream':       /dcos=5\b/.test(stereo.handle)
      && /S1=/.test(stereo.handle) && /K=/.test(stereo.handle),
  'stereonet: in-cell view sliders + group toggle':    stereo.sliders >= 2 && stereo.toggles >= 1,
  'stereonet: mini-format tokenizer registered':       stereo.hasTokenize === true,
  'stereonet: no cell error':                          !stereo.err,
  // @gcu/omf1 — embedded OMF v1 lib round-trips in-browser
  'omf1: write→read round-trips (in-browser)':          omf1.roundtrip === true && omf1.grid === true,
  'omf1: load.omf node → table → pipeline stats':       omf1.nodeRegistered === true && omf1.pipeline === true,
  'omf1: no error':                                     !omf1.err,
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
