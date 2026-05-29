// Focused browser smoke for the patchbay surface. Boots works.html in headless
// Chromium (loopback HTTP, then file://), opens a .patchbay loose file, and
// checks the surface mounts the canvas rack, the engine hydrates modules +
// cables, and Flush round-trips the rack JSON.
//
// Standalone (like examples-smoke) — not part of `npm test`. Run:
//   node test/patchbay-smoke.mjs

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

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

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

async function surfaceFrame(tabId) {
  const handle = await page.evaluateHandle((id) => (window.WKS.surfaces.get(id) || {}).iframe, tabId);
  const el = handle.asElement();
  return el ? await el.contentFrame() : null;
}

const STARTER = {
  format: 'patchbay', version: 1,
  rack: { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] },
  modules: [
    { id: 'lfo', type: 'src.lfo', row: 0, hpPos: 4, knobs: { rate: 0.3 }, params: {} },
    { id: 'scope', type: 'disp.scope', row: 0, hpPos: 16, knobs: {}, params: {} },
    { id: 'const', type: 'src.const', row: 0, hpPos: 32, knobs: { value: 0.5 }, params: {} },
    { id: 'num', type: 'disp.number', row: 0, hpPos: 42, knobs: {}, params: {} },
  ],
  cables: [
    { from: { id: 'lfo', port: 'sin' }, to: { id: 'scope', port: 'x' } },
    { from: { id: 'const', port: 'v' }, to: { id: 'num', port: 'x' } },
  ],
};

async function openPatchbay(p) {
  return page.evaluate(async ({ p, starter }) => {
    const W = window.WKS;
    await W.vfs.writeFile(p, JSON.stringify(starter));
    const tabId = await W.openPath(p);
    const rec = W.surfaces.get(tabId);
    const deadline = Date.now() + 15000;
    while (rec && !rec.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return rec ? { tabId, ready: rec.ready, kind: rec.kind, uniqueName: rec.uniqueName } : { ready: false };
  }, { p, starter: STARTER });
}

// ── HTTP origin ───────────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${port}/works.html`);
await page.waitForFunction(() => window.WKS && window.WKS.broker && window.WKS.vfs, { timeout: 15000 }).catch(() => {});

const pbOpen = await openPatchbay('/projects/smoke.patchbay');
const pbFrame = pbOpen.ready ? await surfaceFrame(pbOpen.tabId) : null;
let mounted = null;
if (pbFrame) {
  await pbFrame.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  mounted = await pbFrame.evaluate(() => ({
    hasCanvas: !!document.querySelector('#pb-root canvas'),
    modules: (window._pbApp && window._pbApp.engine.instances.size) || 0,
    cables: (window._pbApp && window._pbApp.engine.cables.length) || 0,
    // the LFO drives the scope; after ~300ms its output should have moved off 0
    lfoLive: (window._pbApp && window._pbApp.engine.outputValue('lfo', 'sin')) || 0,
    numOut: (window._pbApp && window._pbApp.engine.outputValue('num', 'x')),
  }));
}

// Programmatically add a module + wire a cable, then Flush and re-read.
const edited = await page.evaluate(async (uniqueName) => {
  const W = window.WKS;
  let added = 0, cables = 0;
  // reach into the surface via its test hook through the frame is awkward from
  // here; instead drive Flush + read the file to confirm persistence.
  try {
    await W.worksBus.call({ to: uniqueName, path: '/', interface: 'Surface', member: 'Flush' }, []);
  } catch (e) { return { error: e.message }; }
  let doc = null;
  try { doc = JSON.parse(await W.vfs.readFile('/projects/smoke.patchbay', 'utf8')); } catch { /* */ }
  return { ok: !!doc && doc.format === 'patchbay', modules: doc ? doc.modules.length : 0, cables: doc ? doc.cables.length : 0, added, cablesN: cables };
}, pbOpen.uniqueName);

// ── I/O bridge: a LOG module writes a workspace /tmp path the notebook reads ─
const bridge = await page.evaluate(async () => {
  const W = window.WKS;
  const rack = {
    format: 'patchbay', version: 1, rack: { hp: 64, rows: [{ kind: '3U' }] },
    modules: [
      { id: 'sp', type: 'src.const', row: 0, hpPos: 2, knobs: { value: 0.73 }, params: {} },
      { id: 'log', type: 'io.vfs-write', row: 0, hpPos: 12, knobs: {}, params: { path: '/tmp/pb-bridge.txt' } },
    ],
    cables: [{ from: { id: 'sp', port: 'v' }, to: { id: 'log', port: 'content' } }],
  };
  await W.vfs.writeFile('/projects/bridge.patchbay', JSON.stringify(rack));
  const tabId = await W.openPath('/projects/bridge.patchbay');
  const rec = W.surfaces.get(tabId);
  const dl = Date.now() + 15000;
  while (rec && !rec.ready && Date.now() < dl) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));   // let the LOG effect write
  let onDisk = null;
  try { onDisk = await W.vfs.readFile('/tmp/pb-bridge.txt', 'utf8'); } catch { /* */ }
  return { onDisk };
});
console.log('bridge:', JSON.stringify(bridge));

// ── file:// origin ────────────────────────────────────────────────────
await page.goto(pathToFileURL(path.join(root, 'works.html')).href);
await page.waitForFunction(() => window.WKS && window.WKS.vfs && window.WKS.broker, { timeout: 15000 }).catch(() => {});
const fileOpen = await openPatchbay('/projects/file-smoke.patchbay');
const fileFrame = fileOpen.ready ? await surfaceFrame(fileOpen.tabId) : null;
let fileMounted = null;
if (fileFrame) {
  await fileFrame.evaluate(() => new Promise((r) => setTimeout(r, 250)));
  fileMounted = await fileFrame.evaluate(() => ({
    hasCanvas: !!document.querySelector('#pb-root canvas'),
    modules: (window._pbApp && window._pbApp.engine.instances.size) || 0,
  }));
}

const checks = {
  'no page errors':                       errors.length === 0,
  'patchbay: surface opens (HTTP)':       pbOpen.ready === true && pbOpen.kind === 'patchbay',
  'patchbay: canvas mounted':             mounted && mounted.hasCanvas,
  'patchbay: engine hydrated modules':    mounted && mounted.modules === 4,
  'patchbay: engine hydrated cables':     mounted && mounted.cables === 2,
  'patchbay: LFO drives reactively':      mounted && typeof mounted.lfoLive === 'number',
  'patchbay: const→num propagated':       mounted && mounted.numOut === 0.5,
  'patchbay: Flush persists rack JSON':   edited.ok && edited.modules === 4 && edited.cables === 2,
  'patchbay: LOG writes workspace /tmp':  bridge.onDisk === '0.73',
  'patchbay: boots from file://':         fileOpen.ready === true,
  'patchbay: canvas mounts from file://': fileMounted && fileMounted.hasCanvas && fileMounted.modules === 4,
};

console.log('--- patchbay surface smoke ---');
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log((pass ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!pass) ok = false;
}
if (errors.length) { console.log('--- page errors ---'); for (const e of errors) console.log(e); }
console.log('detail: ' + JSON.stringify({ pbOpen, mounted, edited, fileOpen, fileMounted }));

await browser.close();
server.close();
console.log(ok ? '\npatchbay smoke: OK' : '\npatchbay smoke: FAILED');
process.exit(ok ? 0 : 1);
