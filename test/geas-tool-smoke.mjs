// Smoke test for tools/geas/index.html — serves it over HTTP (the geas
// tool needs a real HTTP origin; blob-URL module workers don't run on
// file://), boots it in headless Chromium, drives a few commands
// through the REPL, and asserts on the rendered terminal text.
//
// Not part of `npm test` — it's a slow Playwright run, like
// test/examples-smoke.mjs. Run directly:  node test/geas-tool-smoke.mjs
//
// The static server binds 127.0.0.1 explicitly so it stays loopback-only
// and doesn't trip the Windows Defender Firewall prompt.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', 'tools', 'geas');
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    const mime = ext === '.html' ? 'text/html'
               : ext === '.json' ? 'application/json'
               : ext === '.js'   ? 'text/javascript'
               : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});
// Loopback-only bind — no firewall prompt, no external exposure.
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});
page.on('worker', (w) => {
  console.log('worker spawned:', w.url().slice(0, 60));
});

await page.goto(url);

await page.waitForFunction(
  () => document.getElementById('status')?.textContent === 'ready',
  { timeout: 20000 },
).catch(() => {});

const status = await page.evaluate(() => document.getElementById('status')?.textContent);
console.log('status:', status);

const screenText = () => page.evaluate(() => document.getElementById('screen')?.innerText || '');
console.log('--- after boot ---');
console.log(JSON.stringify(await screenText()));

async function typeLine(text) {
  await page.locator('#hidden').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

if (status === 'ready') {
  await typeLine('echo hello from geas');
  await typeLine('ls /home');
  await typeLine('seq 1 3');
  await typeLine('cd /tmp');
  await typeLine('pwd');
  // Interactive read: type the command, then the line it should consume.
  await typeLine('read name; echo "got=$name"');
  await typeLine('claude');
  await page.waitForTimeout(500);
}

console.log('--- after commands ---');
const final = await screenText();
console.log(final);

const checks = {
  'reached ready':        status === 'ready',
  'echo output present':  final.includes('hello from geas'),
  'ls shows welcome.txt': final.includes('welcome.txt'),
  'seq output present':   /1[\s\S]*2[\s\S]*3/.test(final),
  'cd updates prompt':    final.includes('/tmp $'),
  'pwd reports /tmp':     /\/tmp\s*$/m.test(final) || final.includes('/tmp\n'),
  'interactive read':    final.includes('got=claude'),
  'no page errors':       errors.length === 0,
};
console.log('--- checks ---');
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'PASS' : 'FAIL') + ' — ' + k);
  if (!v) ok = false;
}
if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors) console.log(e);
}

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
