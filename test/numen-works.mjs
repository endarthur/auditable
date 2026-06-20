// End-to-end numen-for-Works: spawn the REAL numen bridge, load works.html in
// Playwright connected to it, and drive the bridge's MCP stdio side (the side
// Claude Code normally drives) to call a Works tool — asserting the page
// actually executes it and returns the workspace tree. The full live loop,
// automated. Guarded on ../numen being present. Run: node test/numen-works.mjs (NOT in npm test — needs ../numen + Playwright; guarded skip if absent)
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const bridgePath = path.join(root, '..', 'numen', 'numen-bridge.js');
if (!fs.existsSync(bridgePath)) { console.log('SKIP — ../numen/numen-bridge.js not present'); process.exit(0); }

const PORT = 7803, TOKEN = 'testtoken-' + Date.now().toString(36);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

// ── the bridge (MCP stdio side = the "client" we simulate) ──
const bridge = spawn('node', [bridgePath, '--app', 'works', '--port', String(PORT), '--token', TOKEN], { stdio: ['pipe', 'pipe', 'pipe'] });
bridge.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write('[bridge] ' + d); });
const mcpPending = new Map();
let mcpId = 0, stdoutBuf = '';
bridge.stdout.setEncoding('utf8');
bridge.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim(); stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && mcpPending.has(msg.id)) { mcpPending.get(msg.id)(msg); mcpPending.delete(msg.id); }
  }
});
const mcp = (method, params) => new Promise((resolve) => {
  const id = ++mcpId; mcpPending.set(id, resolve);
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
});
const mcpNotify = (method) => bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

let ok = false, detail = '';
try {
  // MCP handshake
  await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } });
  mcpNotify('notifications/initialized');

  // ── the page (Works shell) ──
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(d); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (m) => { if (process.env.DEBUG && m.type() === 'error') console.log('[page]', m.text()); });
  await page.goto(`http://127.0.0.1:${httpPort}/works.html`);
  await page.waitForFunction(() => window.WKS && window.WKS.broker && window.WKS.vfs && window.gcuMCP, { timeout: 15000 });

  // Seed a file, then connect the shim OUT to the bridge.
  await page.evaluate(async (cs) => {
    const W = window.WKS;
    try { await W.vfs.mkdir('/projects', { recursive: true }); } catch {}
    await W.vfs.writeFile('/projects/numen-probe.txt', 'hello over mcp');
    window.gcuMCP.connect(cs);
  }, `${PORT}:${TOKEN}`);

  // Wait for the page→bridge connection to go ready (the bridge sees the client).
  const deadline = Date.now() + 12000;
  let connected = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.gcuMCP && window.gcuMCP.state);
    if (state === 'connected') { connected = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  detail += `shim state connected=${connected}; `;

  // Give the bridge a beat to register the surface's tools, then list clients.
  await new Promise((r) => setTimeout(r, 600));
  const clients = await mcp('tools/call', { name: 'numen_listClients', arguments: {} });
  const clientsText = clients.result?.content?.[0]?.text || '';
  detail += `clients=${clientsText.replace(/\s+/g, ' ').slice(0, 80)}; `;

  // Drive the Works tool through the bridge (static dispatcher → the page).
  const call = await mcp('tools/call', { name: 'numen_callTool', arguments: { name: 'worksTree', arguments: { path: '/projects' } } });
  const text = call.result?.content?.[0]?.text || '';
  const isErr = call.result?.isError;
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  const hasProbe = !!(parsed && Array.isArray(parsed.entries) && parsed.entries.some((e) => (e && e.name ? e.name : e) === 'numen-probe.txt'));
  detail += `callErr=${!!isErr}; hasProbe=${hasProbe}`;
  ok = connected && !isErr && hasProbe;
  if (!ok && !hasProbe) detail += ` | tree=${text.replace(/\s+/g, ' ').slice(0, 160)}`;

  await browser.close();
  server.close();
} catch (e) {
  detail += 'EXCEPTION: ' + (e && e.message || e);
} finally {
  try { bridge.kill('SIGKILL'); } catch {}
}

console.log(detail);
console.log(ok
  ? '\n✓ PASS — agent → numen bridge → Works shim → gated A-Bus peer → works.VFS → result'
  : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
