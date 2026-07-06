// Renders the docs page to micro-manual.pdf via Chromium's print-to-PDF (a
// cover page, per-section page breaks, and running page numbers in the footer —
// the @media print profile in index.html does the layout). Uses the SAME HTML +
// harness-generated screenshots, so the PDF tracks the build.
//   node tools/micro/docs/make-pdf.mjs
import { chromium } from 'playwright';
import http from 'http';
import { readFile } from 'fs/promises';
import { statSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');                 // tools/micro/docs → repo root
const OUT = join(HERE, 'micro-manual.pdf');
const MIME = { '.html': 'text/html', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try { const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); const d = await readFile(join(ROOT, p)); res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); res.end(d); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const b = await chromium.launch();
const page = await b.newPage();
await page.goto(`http://127.0.0.1:${PORT}/tools/micro/docs/index.html`, { waitUntil: 'networkidle' });
await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))));
await page.evaluate(() => document.fonts && document.fonts.ready);
await page.waitForTimeout(300);

await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font:8px \'Segoe UI\',sans-serif;color:#8a8a8a;padding:0 16mm;display:flex;justify-content:space-between;"><span>micro — user documentation · gentropic.org/micro</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  margin: { top: '14mm', bottom: '18mm', left: '16mm', right: '16mm' },
});
await b.close(); server.close();

const buf = await readFile(OUT);
const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`micro-manual.pdf — ${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB, ${pages} pages → ${OUT}`);
