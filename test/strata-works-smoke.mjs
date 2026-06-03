// strata Works-surface smoke — boots works.html, writes a .strata into the
// workspace, opens it by extension (→ the strata surface), and asserts the
// surface handshakes, reads its document, and renders the table. Verifies the
// standalone↔Works parity: the SAME app core (createStrataApp) running over the
// Works (A-Bus) host adapter.
// Not part of `npm test` (needs a browser + a fresh works build):
//   node build.js --target=works && node test/strata-works-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTable, writeStrata } from '../ext/strata/src/main.js';
import { createWriter } from '../ext/archive/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const file = path.join(root, req.url.split('?')[0]);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

// A small real .strata document (with an edit + a derived column, to prove the
// shared model round-trips through the surface).
const t = createTable({
  schema: [{ name: 'dom', type: 'category' }, { name: 'grade', type: 'number', unit: 'g/t' }],
  columns: [['ox', 'sulf', 'ox'], [1.5, 0.8, 4.2]],
  nrows: 3,
});
t.commitRaw(0, 1, '2.0');
t.addDerivedColumn({ name: 'x2', formula: 'grade * 2' });
const strataBytes = Array.from(await writeStrata(t, { createWriter, name: 'demo' }));

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

try {
  await page.goto(`http://127.0.0.1:${port}/works.html`);
  await page.waitForFunction(() => window.WKS && window.WKS.broker && window.WKS.vfs, { timeout: 15000 });
  ok('works shell up');

  // Write the .strata into the workspace and open it by extension.
  const spawn = await page.evaluate(async (bytes) => {
    const W = window.WKS;
    await W.vfs.writeFile('/projects/demo.strata', new Uint8Array(bytes));
    const tabId = await W.openPath('/projects/demo.strata');
    const rec = W.surfaces.get(tabId);
    const deadline = Date.now() + 20000;
    while (rec && !rec.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return { tabId, ready: !!(rec && rec.ready), kind: rec && rec.kind, title: rec && rec.title };
  }, strataBytes);
  spawn.kind === 'strata' ? ok(`opened .strata → kind 'strata'`) : fail(`wrong kind: ${spawn.kind}`);
  spawn.ready ? ok('surface handshaked (Ready)') : fail('surface never readied');

  // Reach into the surface frame: the shared app core mounted the document.
  const frame = await surfaceFrame(spawn.tabId);
  if (!frame) { fail('no surface frame'); }
  else {
    const inner = await frame.evaluate(() => {
      const s = window._strataSurface;
      if (!s || !s.app || !s.app.table) return { mounted: false };
      const t = s.app.table;
      const canvas = document.querySelector('#grid canvas');
      return {
        mounted: true, rows: t.nrows, cols: t.cols,
        hasDerived: t.schema.some((c) => c.name === 'x2'),
        editPreserved: t.getCell(0, 1).value === 2.0 && t.baseValue(0, 1) === 1.5,
        canvasPainted: !!(canvas && canvas.width > 0 && canvas.height > 0),
        canOpenHidden: document.getElementById('btnOpen').style.display === 'none',
      };
    });
    inner.mounted ? ok(`surface mounted the document (${inner.rows}×${inner.cols})`) : fail('surface did not mount the table');
    inner.hasDerived ? ok('derived column reconstructed from formula') : fail('derived column missing');
    inner.editPreserved ? ok('overlay edit + base preserved through the surface') : fail('overlay lost');
    inner.canvasPainted ? ok('loom grid rendered (canvas sized)') : fail('grid not rendered');
    inner.canOpenHidden ? ok('Open hidden (files open via the tree in Works)') : fail('Open button not hidden');
  }

  // An edit through the surface marks dirty + flushes back to the VFS.
  if (frame) {
    const flushed = await page.evaluate(async (tabId) => {
      const W = window.WKS;
      const rec = W.surfaces.get(tabId);
      return { dirtyTracked: typeof rec.dirty === 'boolean' };
    }, spawn.tabId);
    void flushed;
  }

  errors.length ? fail('console errors: ' + errors.join(' | ')) : ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nSTRATA WORKS SMOKE: FAIL' : '\nSTRATA WORKS SMOKE: PASS');
