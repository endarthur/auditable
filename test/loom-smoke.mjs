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

  // ── hover tooltip (provenance) ── cell (2,0) is edited from the test above
  await page.mouse.move(box.x + 120, box.y + 200);   // move away first
  await page.mouse.move(box.x + 120, box.y + 80);    // hover the edited cell
  await page.waitForTimeout(450);
  const tipText = await page.evaluate(() => { const t = document.querySelector('.loom-tooltip'); return t && t.style.display !== 'none' ? t.textContent : null; });
  (tipText && /was .* → now/.test(tipText)) ? ok(`hover tooltip shows provenance (${tipText})`) : fail(`tooltip: ${tipText}`);

  // ── right-click emits onContextMenu ──
  await page.evaluate(() => { window.__ctx = null; window._loom.onContextMenu((d) => { window.__ctx = d; }); });
  await page.mouse.click(box.x + 120, box.y + 80, { button: 'right' });
  await page.waitForTimeout(40);
  const ctx = await page.evaluate(() => window.__ctx);
  (ctx && Number.isInteger(ctx.row) && Number.isInteger(ctx.col))
    ? ok(`right-click emits onContextMenu (r${ctx.row}:c${ctx.col})`)
    : fail(`onContextMenu: ${JSON.stringify(ctx)}`);

  // ── right-click a column header → onHeaderContextMenu ──
  await page.evaluate(() => { window.__hctx = null; window._loom.onHeaderContextMenu((d) => { window.__hctx = d; }); });
  await page.mouse.click(box.x + 98, box.y + 12, { button: 'right' });   // header band, col 0
  await page.waitForTimeout(40);
  const hctx = await page.evaluate(() => window.__hctx);
  (hctx && Number.isInteger(hctx.col))
    ? ok(`right-click header emits onHeaderContextMenu (col ${hctx.col})`)
    : fail(`onHeaderContextMenu: ${JSON.stringify(hctx)}`);

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

  // ── undo / redo (Ctrl+Z / Ctrl+Y) ──
  await page.evaluate(() => { window._loom.setSelection({ r0: 40, c0: 1, r1: 40, c1: 1 }); window._loom.focus(); });
  const ovBefore = await page.evaluate(() => window._loom.provider._overlay.size);
  await page.keyboard.type('123');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(40);
  const ovEdit = await page.evaluate(() => window._loom.provider._overlay.size);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  const ovUndo = await page.evaluate(() => window._loom.provider._overlay.size);
  (ovEdit === ovBefore + 1 && ovUndo === ovBefore)
    ? ok(`undo reverts a single edit (overlay ${ovBefore}→${ovEdit}→${ovUndo})`)
    : fail(`undo failed: ${ovBefore} → ${ovEdit} → ${ovUndo}`);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(40);
  const ovRedo = await page.evaluate(() => window._loom.provider._overlay.size);
  ovRedo === ovBefore + 1 ? ok('redo (Ctrl+Y) restores the edit') : fail(`redo failed: ${ovRedo}`);

  // A batched paste undoes in ONE step.
  const batch = await page.evaluate(async () => {
    window._loom.setSelection({ r0: 45, c0: 1, r1: 45, c1: 1 });
    window._loom.focus();
    const before = window._loom.provider._overlay.size;
    const dt = new DataTransfer(); dt.setData('text/plain', '1\t2\n3\t4');
    document.querySelector('#grid textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    return { before, afterPaste: window._loom.provider._overlay.size };
  });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(40);
  const ovBatchUndo = await page.evaluate(() => window._loom.provider._overlay.size);
  (batch.afterPaste === batch.before + 4 && ovBatchUndo === batch.before)
    ? ok(`one undo reverts a whole 2×2 paste (overlay ${batch.before}→${batch.afterPaste}→${ovBatchUndo})`)
    : fail(`batch undo failed: ${JSON.stringify({ ...batch, ovBatchUndo })}`);

  // ── column resize: drag the col-0 right border (default width 100) ──
  const widthBefore = await page.evaluate(() => window._loom.getColWidths()[0] || 100);
  const border0 = await page.evaluate(() => {
    const r = document.querySelectorAll('#grid canvas')[0].getBoundingClientRect(); // colHdr
    return { x: r.left + 100, y: r.top + r.height / 2 }; // col0 right edge @ content-x 100, scrollLeft 0
  });
  await page.mouse.move(border0.x, border0.y);
  const cursor = await page.evaluate(() => document.querySelectorAll('#grid canvas')[0].style.cursor);
  cursor === 'col-resize' ? ok('hovering a border shows the col-resize cursor') : fail(`cursor was '${cursor}'`);
  await page.mouse.down();
  await page.mouse.move(border0.x + 60, border0.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(30);
  const widthAfter = await page.evaluate(() => window._loom.getColWidths()[0]);
  (widthAfter === widthBefore + 60)
    ? ok(`column resize: col 0 widened ${widthBefore} → ${widthAfter}px`)
    : fail(`resize failed: ${widthBefore} → ${widthAfter} (expected ${widthBefore + 60})`);

  // a resize drag must not also trigger click-to-sort (header click suppressed)
  // — col 0 has no sort UI in the demo, so just assert no errors crept in here.

  // ── autofit: double-click col 3's right border → fits the short category col ──
  const border3 = await page.evaluate(() => {
    const w = window._loom.getColWidths(); const cw = (c) => w[c] || 100;
    let x = 0; for (let i = 0; i < 4; i++) x += cw(i);           // right edge of col 3
    const r = document.querySelectorAll('#grid canvas')[0].getBoundingClientRect();
    return { x: r.left + x, y: r.top + r.height / 2 };
  });
  await page.mouse.dblclick(border3.x, border3.y);
  await page.waitForTimeout(40);
  const fit = await page.evaluate(() => window._loom.getColWidths()[3]);
  (typeof fit === 'number' && fit >= 30 && fit < 100)
    ? ok(`autofit shrank the 'domain' category column to ${fit}px`)
    : fail(`autofit produced ${fit} (expected a number in [30,100))`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}

console.log(process.exitCode ? '\nLOOM SMOKE: FAIL' : '\nLOOM SMOKE: PASS');
