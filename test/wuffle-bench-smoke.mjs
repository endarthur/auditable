// bench smoke — drives the DEV tree with ?bench and proves the desktop bench
// (ext/leadacid/bench.js) mocks /native faithfully through the real lead-acid.js
// shim: feature-detect, push streams, body sidecar, and each mocked plugin.
// This is what lets instruments develop on the desktop with no phone.
// Run: node test/wuffle-bench-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

let pass = 0, fail = 0;
const chk = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
const p = await browser.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`http://127.0.0.1:${PORT}/tools/wuffle/index.html?bench`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__wuffle && window.__wuffle.shell, null, { timeout: 15000 });

// 1. the bench installed + the shim feature-detects it (shell.present === true)
const active = await p.evaluate(() => ({ bench: !!window.__bench, present: window.__wuffle.shell.present }));
chk(`bench active + shell.present true (bench ${active.bench}, present ${active.present})`, active.bench && active.present);

// 2. shell/info + keepAwake round-trip through the mocked request/reply lane
const info = await p.evaluate(async () => {
  const v = await window.__wuffle.shell.version();
  const k = await (await window.__wuffle.shell.native('shell/keepawake?on=true', { method: 'POST' })).json();
  return { v, ok: k.ok };
});
chk(`shell/info + keepawake (version ${info.v}, keepawake ${info.ok})`, info.v === 'bench' && info.ok === true);

// 3. push stream: open the mocked sensor stream, collect events over the port
const streamed = await p.evaluate(async () => {
  const times = [];
  const s = await window.__wuffle.shell.stream('sensor/stream?types=rotation&rateHz=30');
  s.on('rotation', () => times.push(performance.now()));
  await new Promise(r => setTimeout(r, 800));
  s.close();
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  return { n: times.length, max: gaps.length ? Math.max(...gaps) : 0 };
});
chk(`push stream delivers over the port (${streamed.n} events/0.8s, max gap ${streamed.max.toFixed(0)}ms)`,
  streamed.n > 10 && streamed.max < 150);

// 4. body sidecar + attest: sign through the port body-sidecar, verify w/ WebCrypto
const signed = await p.evaluate(async () => {
  const payload = new TextEncoder().encode('bench attest test');
  const r = await window.__wuffle.shell.attest.sign(payload);
  const dec = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', dec(r.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, dec(r.sig), payload);
  const bad = new Uint8Array(payload); bad[0] ^= 1;
  const okBad = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, dec(r.sig), bad);
  return { ok, okBad, security: r.security };
});
chk(`body sidecar + attest sign/verify (valid ${signed.ok}, tampered-rejected ${!signed.okBad}, ${signed.security})`,
  signed.ok && !signed.okBad);

// 5. fs ranged read from a fixture (set via __benchFixtures before load would be
//    ideal; here we drive the route directly with a token we inject at runtime)
const ranged = await p.evaluate(async () => {
  // inject a pattern fixture: byte[i] = i mod 251
  const n = 4096, buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = i % 251;
  window.__bench.fixtures.files['t.bin'] = buf;
  const src = window.__wuffle.shell.fileSource('t.bin', n);
  const slice = await src.readRange(1000, 64);
  let okBytes = slice.length === 64;
  for (let i = 0; i < 64; i++) if (slice[i] !== (1000 + i) % 251) okBytes = false;
  return { okBytes, len: slice.length };
});
chk(`fs ranged read from fixture (len ${ranged.len}, pattern ${ranged.okBytes})`, ranged.okBytes);

// 6. no page errors through all of it
chk(`no page errors (${errs.length ? errs.join(' ; ') : 'none'})`, errs.length === 0);

await browser.close();
server.close();
console.log(`\nwuffle-bench-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
