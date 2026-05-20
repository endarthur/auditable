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
};

console.log('--- works.html (Chunk 1 + 2) ---');
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
