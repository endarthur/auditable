// @gcu/loom browser smoke — mounts the demo in headless Chromium over loopback
// HTTP, asserts it renders without console errors, then drives a select + an
// edit and checks the overlay grew. Not part of `npm test` (needs a browser).
//   node test/loom-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(root, '..');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(repo, rel);
  if (!file.startsWith(repo) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/ext/loom/demo.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._loom, null, { timeout: 5000 });
  ok('grid mounted (window._loom present)');

  // Three canvases (body + col header + row header) all sized non-zero.
  const canvasOk = await page.evaluate(() => {
    const cs = document.querySelectorAll('#grid canvas');
    return cs.length === 3 && [...cs].every((c) => c.width > 0 && c.height > 0);
  });
  canvasOk ? ok('3 canvases sized non-zero') : fail('expected 3 sized canvases');

  // Body canvas has actual painted pixels (not blank).
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#grid canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, Math.min(400, c.width), Math.min(200, c.height)).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      // background is #121212 (18,18,18); count clearly different pixels
      if (Math.abs(d[i] - 18) > 12 || Math.abs(d[i + 1] - 18) > 12 || Math.abs(d[i + 2] - 18) > 12) nonBg++;
    }
    return nonBg;
  });
  painted > 50 ? ok(`body canvas painted (${painted} non-bg px sampled)`) : fail('body canvas looks blank');

  // Click a data cell → selection footer updates.
  const grid = await page.$('#grid');
  const box = await grid.boundingBox();
  await page.mouse.click(box.x + 120, box.y + 80);
  await page.waitForTimeout(50);
  const selText = await page.textContent('#sel');
  selText && selText !== '—' ? ok(`selection published: ${selText}`) : fail('selection did not publish');

  // Type a new value + Enter → overlay (edits) grows from 0 to 1.
  const editsBefore = await page.textContent('#edits');
  await page.keyboard.type('99.9');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  const editsAfter = await page.textContent('#edits');
  (editsBefore === '0' && editsAfter === '1')
    ? ok('edit committed to overlay (edits 0 → 1)')
    : fail(`edit not committed (edits ${editsBefore} → ${editsAfter})`);

  // ── keyboard navigation ──
  await page.evaluate(() => { window._loom.setSelection({ r0: 3, c0: 1, r1: 3, c1: 1 }); window._loom.focus(); });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(30);
  const nav = await page.evaluate(() => window._loom.getSelection());
  (nav.r0 === 4 && nav.c0 === 2 && nav.r1 === 4 && nav.c1 === 2)
    ? ok(`keyboard nav moved to r${nav.r0}:c${nav.c0}`)
    : fail(`nav failed: ${JSON.stringify(nav)}`);

  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(20);
  const ext = await page.evaluate(() => window._loom.getSelection());
  (ext.r0 === 4 && ext.c0 === 2 && ext.r1 === 5 && ext.c1 === 3)
    ? ok('shift-extend grew the selection to a 2×2 block')
    : fail(`shift-extend failed: ${JSON.stringify(ext)}`);

  await page.keyboard.press('Control+Home');
  await page.waitForTimeout(20);
  const home = await page.evaluate(() => window._loom.getSelection());
  (home.r0 === 0 && home.c0 === 0) ? ok('Ctrl+Home → top-left') : fail(`Ctrl+Home failed: ${JSON.stringify(home)}`);

  // ── range delete clears a whole rectangle ──
  await page.evaluate(() => { window._loom.setSelection({ r0: 10, c0: 1, r1: 11, c1: 2 }); window._loom.focus(); });
  const delBefore = Number(await page.textContent('#edits'));
  await page.keyboard.press('Delete');
  await page.waitForTimeout(40);
  const delAfter = Number(await page.textContent('#edits'));
  (delAfter === delBefore + 4)
    ? ok(`range delete wrote 4 cells (edits ${delBefore} → ${delAfter})`)
    : fail(`range delete wrote ${delAfter - delBefore} cells, expected 4`);

  // ── fill-down copies the top row into the rest of the selection ──
  await page.evaluate(() => { window._loom.setSelection({ r0: 20, c0: 1, r1: 23, c1: 1 }); window._loom.focus(); });
  const fillBefore = Number(await page.textContent('#edits'));
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(40);
  const fillAfter = Number(await page.textContent('#edits'));
  (fillAfter === fillBefore + 3)
    ? ok(`fill-down wrote 3 cells (edits ${fillBefore} → ${fillAfter})`)
    : fail(`fill-down wrote ${fillAfter - fillBefore} cells, expected 3`);

  // ── paste a 2×2 TSV block via a native paste event ──
  const paste = await page.evaluate(async () => {
    window._loom.setSelection({ r0: 30, c0: 1, r1: 30, c1: 1 });
    window._loom.focus();
    const before = window._loom.provider._overlay.size;
    const dt = new DataTransfer();
    dt.setData('text/plain', '1.5\t2.5\n3.5\t4.5');
    document.querySelector('#grid textarea')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const v = window._loom.provider.cellAt(31, 2); // bottom-right of the pasted block
    return { before, after: window._loom.provider._overlay.size, bottomRight: v && v.value };
  });
  (paste.after === paste.before + 4 && paste.bottomRight === 4.5)
    ? ok(`paste wrote a 2×2 block (overlay +4, cell[31,2]=${paste.bottomRight})`)
    : fail(`paste failed: ${JSON.stringify(paste)}`);

  // ── copy emits TSV onto the clipboard event (memory provider formats 2dp) ──
  const copied = await page.evaluate(() => {
    window._loom.setSelection({ r0: 30, c0: 1, r1: 31, c1: 2 });
    window._loom.focus();
    const dt = new DataTransfer();
    document.querySelector('#grid textarea')
      .dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  (copied === '1.50\t2.50\n3.50\t4.50')
    ? ok('copy produced the expected TSV')
    : fail(`copy produced: ${JSON.stringify(copied)}`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}

console.log(process.exitCode ? '\nLOOM SMOKE: FAIL' : '\nLOOM SMOKE: PASS');
