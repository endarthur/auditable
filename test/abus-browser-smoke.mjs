// Browser smoke test for ext/abus/smoke.html — serves the repo over a
// loopback HTTP origin (browsers block ES modules + module workers on
// file://), boots smoke.html in headless Chromium, and reads back the
// pass/fail report it renders.
//
// This is the cross-realm verification the Node suite (test/abus.test.mjs)
// cannot do: real iframe and Web Worker port transports.
//
// Not part of `npm test` — it's a Playwright run, like
// test/geas-tool-smoke.mjs. Run directly:  node test/abus-browser-smoke.mjs
//
// The static server binds 127.0.0.1 explicitly so it stays loopback-only
// and doesn't trip the Windows Defender Firewall prompt.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');   // repo root — smoke.html imports ./src/*

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
// Loopback-only bind — no firewall prompt, no external exposure.
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/ext/abus/smoke.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto(url);

// smoke.html resolves every check, then flips #summary to .ok or .bad.
await page.waitForFunction(() => {
  const s = document.getElementById('summary');
  return s && (s.className === 'ok' || s.className === 'bad');
}, { timeout: 20000 }).catch(() => {});

const report = await page.evaluate(() => {
  const s = document.getElementById('summary');
  const rows = [...document.querySelectorAll('.row')].map((el) => {
    const tag = el.querySelector('.tag');
    return {
      ok: tag ? tag.classList.contains('p') : false,
      label: [...el.children].slice(1).map((c) => c.textContent).join(' '),
    };
  });
  return { summary: s ? s.textContent : '(no summary)', state: s ? s.className : '', rows };
});

console.log('--- ext/abus/smoke.html ---');
for (const r of report.rows) console.log((r.ok ? 'PASS' : 'FAIL') + ' — ' + r.label);
console.log('summary:', report.summary);

if (errors.length) {
  console.log('--- page errors ---');
  for (const e of errors) console.log(e);
}

await browser.close();
server.close();

const ok = report.state === 'ok' && report.rows.length > 0 && errors.length === 0;
console.log(ok ? '\nbrowser smoke: OK' : '\nbrowser smoke: FAILED');
process.exit(ok ? 0 : 1);
