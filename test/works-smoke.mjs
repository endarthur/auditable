// Browser smoke test for works.html — the Auditable Works shell skeleton
// (Chunk 1). Serves the repo over a loopback HTTP origin, boots works.html
// in headless Chromium, and checks the shell stands up: A-Bus broker,
// workspace VFS, rails host, menu bar.
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

// The shell sets window.WKS at the end of boot.
await page.waitForFunction(
  () => window.WKS && window.WKS.broker && window.WKS.vfs,
  { timeout: 15000 },
).catch(() => {});

const report = await page.evaluate(async () => {
  const W = window.WKS || {};
  let projectsExists = false;
  try { projectsExists = await W.vfs.exists('/projects'); } catch { /* */ }
  return {
    hasWKS:      !!window.WKS,
    broker:      !!W.broker,
    vfs:         !!W.vfs,
    rails:       !!W.rails,
    menubar:     !!W.menubar,
    projectsExists,
    status:      document.getElementById('works-status')?.textContent || '',
    menubarFilled: (document.getElementById('works-menubar')?.childElementCount || 0) > 0,
    railsHost:   !!document.getElementById('works-rails'),
  };
});

const checks = {
  'no page errors':            errors.length === 0,
  'window.WKS present':        report.hasWKS,
  'A-Bus broker created':      report.broker,
  'workspace VFS created':     report.vfs,
  '/projects dir exists':      report.projectsExists,
  'rails host created':        report.rails,
  'rails host element in DOM': report.railsHost,
  'menu bar created':          report.menubar,
  'menu bar rendered':         report.menubarFilled,
  'shell reports ready':       report.status === 'Auditable Works — ready',
};

console.log('--- works.html (Chunk 1 shell skeleton) ---');
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log((pass ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!pass) ok = false;
}
if (errors.length) {
  console.log('--- page errors ---');
  for (const e of errors) console.log(e);
}
console.log('status line: ' + JSON.stringify(report.status));

await browser.close();
server.close();
console.log(ok ? '\nworks smoke: OK' : '\nworks smoke: FAILED');
process.exit(ok ? 0 : 1);
