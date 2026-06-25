// lamina harness smoke — boots tools/lamina in headless Chromium over loopback
// HTTP, opens a CSV / a text file / binary, and asserts the windowed read-only
// loop: detect → grid renders → a DEEP row resolves through the block index → the
// line view + binary handoff work. Not in `npm test` (needs a browser):
//   node test/lamina-smoke.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, gzipSync } from '../ext/archive/vendor/fflate.module.mjs';
import { writeTar } from '../ext/archive/src/tar.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(repo, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(repo) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✔ ' + m);

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/tools/lamina/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window._lamina, null, { timeout: 8000 });
  ok('lamina booted');

  // ── a 5000-row CSV (with a header) ──
  const N = 5000;
  let csv = 'id,grade,lito\n';
  for (let i = 0; i < N; i++) csv += `${i},${(i * 0.01).toFixed(2)},${['ox', 'sulf', 'trans'][i % 3]}\n`;
  const opened = await page.evaluate((text) => {
    window._lamina.open('block.csv', new TextEncoder().encode(text));
    const vs = window._laminaVS;
    return { rows: vs.rowCount(), cols: vs.cols, hasGrid: !!window._lamina.grid, footer: document.getElementById('meta').textContent };
  }, csv);
  (opened.rows === N && opened.cols === 3 && opened.hasGrid)
    ? ok(`opened CSV → ${opened.rows} rows × ${opened.cols} cols (footer: ${opened.footer})`)
    : fail(`CSV open failed: ${JSON.stringify(opened)}`);

  // 3 canvases, painted
  const canvasOk = await page.evaluate(() => {
    const cs = document.querySelectorAll('#grid canvas');
    return cs.length === 3 && [...cs].every((c) => c.width > 0 && c.height > 0);
  });
  canvasOk ? ok('grid rendered (3 canvases sized)') : fail('grid canvases missing');

  // A DEEP row resolves through the block index (windowed read, not a full load).
  const deep = await page.evaluate(async () => {
    const vs = window._laminaVS;
    const R = 4500;                                      // block 1 (blockSize 4096) — not loaded by the initial paint
    const before = vs.rowAt(R);                          // not loaded yet → LOADING
    const row = await vs.ensureRow(R);                   // fetch its block
    return { wasPending: typeof before === 'symbol', id: row[0], lito: row[2] };
  });
  (deep.wasPending && deep.id === '4500' && deep.lito === ['ox', 'sulf', 'trans'][4500 % 3])
    ? ok(`deep row 4500 resolved through the block index (id=${deep.id}, lito=${deep.lito})`)
    : fail(`deep row failed: ${JSON.stringify(deep)}`);

  // ── a text file → line view (one column) ──
  const txt = Array.from({ length: 300 }, (_, i) => `log line ${i}: nothing tabular here`).join('\n') + '\n';
  const textOpen = await page.evaluate((t) => {
    window._lamina.open('app.log', new TextEncoder().encode(t));
    const vs = window._laminaVS;
    return { rows: vs.rowCount(), cols: vs.cols, kind: vs.kind, badge: document.getElementById('kindBadge').textContent };
  }, txt);
  (textOpen.rows === 300 && textOpen.cols === 1 && textOpen.kind === 'text')
    ? ok(`opened text → line view (${textOpen.rows} lines, 1 col, badge "${textOpen.badge}")`)
    : fail(`text open failed: ${JSON.stringify(textOpen)}`);

  // ── binary → hex handoff message ──
  const bin = await page.evaluate(() => {
    window._lamina.open('blob.bin', new Uint8Array([1, 2, 0, 3, 255, 7, 0, 9]));
    return { binaryShown: getComputedStyle(document.getElementById('binary')).display !== 'none' };
  });
  bin.binaryShown ? ok('binary file → hex-handoff message shown') : fail('binary not handled');

  // ── a streamed File (never-resident path) → block index + deep windowed row ──
  const stream = await page.evaluate(async () => {
    let csv = 'n,v\n';
    for (let i = 0; i < 6000; i++) csv += `${i},x${i}\n`;
    const file = new File([new TextEncoder().encode(csv)], 'stream.csv');
    await window._lamina.openFile(file);                 // streams file.stream() → block index
    const vs = window._laminaVS;
    const R = 5000;                                      // a deep, unloaded block
    const before = vs.rowAt(R);                          // LOADING
    const row = await vs.ensureRow(R);                   // windowed via File.slice (lazy)
    return { rows: vs.rowCount(), wasPending: typeof before === 'symbol', n: row[0], v: row[1], scan: window._lamina.lastScan };
  });
  (stream.rows === 6000 && stream.wasPending && stream.n === '5000' && stream.v === 'x5000')
    ? ok(`streamed File → ${stream.rows} rows; deep row 5000 windowed via File.slice (n=${stream.n})`)
    : fail(`streaming open failed: ${JSON.stringify(stream)}`);
  // over http the index scan must run in a @gcu/proc worker (off the main thread), not the inline fallback
  stream.scan === 'worker'
    ? ok('index scan ran off-thread (@gcu/proc worker)')
    : fail(`expected worker scan, got "${stream.scan}" (worker path fell back to inline)`);

  // ── index cache: reopen the SAME file → hit (no re-scan), identical view ──
  const cache = await page.evaluate(async () => {
    await window._lamina.cache.clear();
    let csv = 'a,b\n';
    for (let i = 0; i < 4000; i++) csv += `${i},y${i}\n`;
    const file = new File([new TextEncoder().encode(csv)], 'cached.csv');   // one object → stable fileKey
    await window._lamina.openFile(file);
    const first = { scan: window._lamina.lastScan, rows: window._laminaVS.rowCount() };
    await window._lamina.openFile(file);                                    // reopen → should hit the sidecar
    const row = await window._laminaVS.ensureRow(3700);
    return { first, secondScan: window._lamina.lastScan, secondRows: window._laminaVS.rowCount(), b: row[1] };
  });
  (cache.first.scan === 'worker' && cache.secondScan === 'cache' && cache.secondRows === cache.first.rows && cache.b === 'y3700')
    ? ok(`index cache: first open scanned (${cache.first.scan}), reopen hit the cache (${cache.first.rows} rows, deep row intact)`)
    : fail(`index cache failed: ${JSON.stringify(cache)}`);

  // ── archive (resident tier): a CSV inside a zip → grid; a single entry auto-opens ──
  const enc = new TextEncoder();
  let zcsv = 'p,q\n'; for (let i = 0; i < 800; i++) zcsv += `${i},z${i}\n`;
  const zipBytes = zipSync({ 'inner.csv': enc.encode(zcsv) });
  const zipArr = Array.from(zipBytes);
  const zipRes = await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], 'bundle.zip');
    await window._lamina.openFile(file);
    const vs = window._laminaVS;
    return { rows: vs.rowCount(), cols: vs.cols, scan: window._lamina.lastScan, name: document.getElementById('fileName').textContent };
  }, zipArr);
  (zipRes.rows === 800 && zipRes.cols === 2 && zipRes.scan === 'resident' && zipRes.name.includes('inner.csv'))
    ? ok(`zip → single CSV entry auto-opened (${zipRes.rows} rows, label "${zipRes.name}")`)
    : fail(`zip open failed: ${JSON.stringify(zipRes)}`);

  // multi-entry zip → picker lists both; clicking one renders it
  const zip2 = Array.from(zipSync({ 'a.csv': enc.encode('x\n1\n2\n3\n'), 'b.csv': enc.encode('y,z\n4,5\n6,7\n') }));
  const pick = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'two.zip'));
    const items = [...document.querySelectorAll('#picker.show .pk-item .pk-name')].map((n) => n.textContent);
    document.querySelectorAll('#picker .pk-item')[1].click();     // pick b.csv
    await new Promise((r) => setTimeout(r, 100));
    return { items, cols: window._laminaVS.cols, rows: window._laminaVS.rowCount() };
  }, zip2);
  (pick.items.length === 2 && pick.items.includes('a.csv') && pick.items.includes('b.csv') && pick.cols === 2 && pick.rows === 2)
    ? ok(`multi-entry zip → picker (${pick.items.join(', ')}), chose b.csv → ${pick.rows}×${pick.cols}`)
    : fail(`zip picker failed: ${JSON.stringify(pick)}`);

  // a .gz stream → decompress + render
  const gzArr = Array.from(gzipSync(enc.encode('m\n' + Array.from({ length: 200 }, (_, i) => i).join('\n') + '\n')));
  const gz = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'log.txt.gz'));
    return { rows: window._laminaVS.rowCount(), name: document.getElementById('fileName').textContent };
  }, gzArr);
  (gz.rows === 201 && gz.name.includes('log.txt'))
    ? ok(`.gz → decompressed + rendered (${gz.rows} rows, label "${gz.name}")`)
    : fail(`gz open failed: ${JSON.stringify(gz)}`);

  // ── tape: window a zip entry WITHOUT unpacking (forces the streaming path by
  // dropping the resident threshold to 0) — deep row resolves; reopen hits cache ──
  let bcsv = 'id,v\n'; for (let i = 0; i < 5000; i++) bcsv += `${i},w${i}\n`;
  const bigZip = Array.from(zipSync({ 'big.csv': enc.encode(bcsv) }, { level: 6 }));
  const tape = await page.evaluate(async (arr) => {
    window.__LAMINA_RESIDENT_LIMIT__ = 0;                                  // force the tape, even for a tiny zip
    await window._lamina.cache.clear();
    const file = new File([new Uint8Array(arr)], 'huge.zip');
    await window._lamina.openFile(file);                                   // stream-enumerate → 1 entry → tape
    const first = { scan: window._lamina.lastScan, rows: window._laminaVS.rowCount(), name: document.getElementById('fileName').textContent };
    const deep = await window._laminaVS.ensureRow(4200);                   // forward-windowed through the tape
    const back = await window._laminaVS.ensureRow(15);                     // far back → rewind, still correct
    await window._lamina.openFile(file);                                   // reopen → cached stream index
    const second = window._lamina.lastScan;
    window.__LAMINA_RESIDENT_LIMIT__ = undefined;
    return { ...first, deep, back, second };
  }, bigZip);
  (tape.scan === 'stream' && tape.rows === 5000 && tape.deep[0] === '4200' && tape.back[0] === '15'
    && tape.name.includes('big.csv') && tape.second === 'cache')
    ? ok(`zip entry windowed via tape (no unpack): ${tape.rows} rows, deep=${tape.deep[0]}, rewind-back=${tape.back[0]}, reopen=${tape.second}`)
    : fail(`tape zip failed: ${JSON.stringify(tape)}`);

  // ── scattered filter reads deep result rows by offset (no block thrash) + × clears ──
  const scat = await page.evaluate(async () => {
    let csv = 'id,keep\n';
    for (let i = 0; i < 20000; i++) csv += `${i},${i % 50 === 0 ? 'Y' : 'N'}\n`;   // 1-in-50 matches → scattered
    window._lamina.open('scatter.csv', new TextEncoder().encode(csv));
    const box = document.getElementById('filter');
    box.value = 'keep == Y'; box.dispatchEvent(new Event('input'));   // as if typed → × appears
    await window._lamina.applyFilter(box.value);
    const vs = window._laminaVS;
    const rows = vs.rowCount();
    const deep = await vs.ensureRow(rows - 1);            // last matching row, read by offset
    const clearShown = document.getElementById('filterWrap').classList.contains('has');
    document.getElementById('filterClear').click();       // the × button
    const afterClear = window._laminaVS.rowCount();
    return { rows, deepId: deep[0], deepKeep: deep[1], clearShown, afterClear };
  });
  (scat.rows === 400 && scat.deepKeep === 'Y' && scat.deepId === '19950' && scat.clearShown && scat.afterClear === 20000)
    ? ok(`scattered filter: ${scat.rows} rows read by offset (deep id=${scat.deepId}); × clears → ${scat.afterClear}`)
    : fail(`scattered filter failed: ${JSON.stringify(scat)}`);

  // ── filter: scan a CSV → matching rows; row header shows the original row # ──
  const flt = await page.evaluate(async () => {
    let csv = 'id,grade,lito\n';
    for (let i = 0; i < 3000; i++) csv += `${i},${i % 5},${['ox', 'sulf'][i % 2]}\n`;
    window._lamina.open('grades.csv', new TextEncoder().encode(csv));
    const base = window._laminaVS.rowCount();
    await window._lamina.applyFilter('grade >= 3 && lito == ox');         // i%5∈{3,4} and i even
    let expect = 0; for (let i = 0; i < 3000; i++) if ((i % 5) >= 3 && (i % 2) === 0) expect++;
    const vs = window._laminaVS;
    const first = await vs.ensureRow(0);
    const origRow = vs.rowHeaderAt(0);                                    // original row #, not 1
    await window._lamina.applyFilter('');                                 // clear → back to base
    return { base, expect, shown: vs.rowCount(), firstGrade: Number(first[1]), firstLito: first[2], origRow, cleared: window._laminaVS.rowCount() };
  });
  (flt.shown === flt.expect && flt.firstGrade >= 3 && flt.firstLito === 'ox' && flt.origRow > 1 && flt.cleared === flt.base)
    ? ok(`filter: ${flt.shown}/${flt.base} rows match (grade≥3 ∧ ox); orig row #${flt.origRow}; clear restores ${flt.cleared}`)
    : fail(`filter failed: ${JSON.stringify(flt)}`);

  // a bad column marks the box red and doesn't crash
  const bad = await page.evaluate(async () => {
    await window._lamina.applyFilter('nope > 1');
    return { err: document.getElementById('filter').classList.contains('err'), meta: document.getElementById('meta').textContent };
  });
  (bad.err && /unknown column/.test(bad.meta))
    ? ok('filter: unknown column → box marked red, no crash')
    : fail(`filter error-handling failed: ${JSON.stringify(bad)}`);

  // ── sort: header-click cycles asc/desc; composes with filter ──
  const srt = await page.evaluate(async () => {
    let csv = 'id,grade\n';
    const grades = [];
    for (let i = 0; i < 2000; i++) { const g = (i * 7) % 100; grades.push(g); csv += `${i},${g}\n`; }
    window._lamina.open('g.csv', new TextEncoder().encode(csv));
    await window._lamina.toggleSort(1);                  // grade asc
    const a0 = Number((await window._laminaVS.ensureRow(0))[1]);
    const a1 = Number((await window._laminaVS.ensureRow(1))[1]);
    await window._lamina.toggleSort(1);                  // grade desc
    const dTop = Number((await window._laminaVS.ensureRow(0))[1]);
    // filter then sort: keep grade<50, sorted desc → top should be the max under 50
    await window._lamina.applyFilter('grade < 50');
    const fRows = window._laminaVS.rowCount();
    const fTop = Number((await window._laminaVS.ensureRow(0))[1]);   // sort (desc) still active over the filtered set
    return { a0, a1, dTop, fRows, fTop, expectMax: Math.max(...grades), expectFiltered: grades.filter((g) => g < 50).length, expectFTop: Math.max(...grades.filter((g) => g < 50)) };
  });
  (srt.a0 <= srt.a1 && srt.dTop === srt.expectMax && srt.fRows === srt.expectFiltered && srt.fTop === srt.expectFTop)
    ? ok(`sort: asc (${srt.a0}≤${srt.a1}), desc top=${srt.dTop}; filter+sort → ${srt.fRows} rows, top=${srt.fTop}`)
    : fail(`sort failed: ${JSON.stringify(srt)}`);

  // ── tar (multi-entry) + .tar.gz (decompress → tar picker) ──
  const tarBytes = writeTar({ 'a.csv': enc.encode('x,y\n1,2\n3,4\n'), 'b.csv': enc.encode('p\nq\nr\n') });
  const tarArr = Array.from(tarBytes);
  const tar = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'bundle.tar'));
    const items = [...document.querySelectorAll('#picker.show .pk-item .pk-name')].map((n) => n.textContent);
    document.querySelectorAll('#picker .pk-item')[0].click();
    await new Promise((r) => setTimeout(r, 60));
    return { items, cols: window._laminaVS.cols };
  }, tarArr);
  (tar.items.length === 2 && tar.items.includes('a.csv') && tar.cols === 2)
    ? ok(`tar → picker (${tar.items.join(', ')}), entry → ${tar.cols} cols`)
    : fail(`tar failed: ${JSON.stringify(tar)}`);

  const targzArr = Array.from(gzipSync(writeTar({ 'inner.csv': enc.encode('m,n\n9,8\n') })));
  const targz = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'data.tar.gz'));   // 1-entry tar → auto-opens
    return { cols: window._laminaVS.cols, name: document.getElementById('fileName').textContent };
  }, targzArr);
  (targz.cols === 2 && targz.name.includes('inner.csv'))
    ? ok(`.tar.gz → decompress → tar entry auto-opened (${targz.name})`)
    : fail(`.tar.gz failed: ${JSON.stringify(targz)}`);

  // ── #-comment preamble (the block-model export norm) → real header skipped to ──
  const pre = await page.evaluate(async () => {
    let csv = '';
    for (let i = 0; i < 12; i++) csv += `# meta line ${i}\n`;        // preamble
    csv += 'Id,X,Y,grade\n';                                          // real header
    for (let i = 0; i < 500; i++) csv += `${i},${612105 + i * 10},9291005,${(i * 0.01).toFixed(2)}\n`;
    window._lamina.open('blockmodel.csv', new TextEncoder().encode(csv));
    const vs = window._laminaVS;
    return { cols: vs.cols, rows: vs.rowCount(), header: window._lamina.grid.provider.header(0).label, first: await vs.ensureRow(0), footer: document.getElementById('meta').textContent };
  });
  (pre.cols === 4 && pre.rows === 500 && pre.header === 'Id' && pre.first[0] === '0' && pre.first[1] === '612105' && /12 .*comment lines skipped/.test(pre.footer))
    ? ok(`#-preamble: skipped 12 comments → header "${pre.header}", ${pre.rows} rows; footer notes the skip`)
    : fail(`preamble failed: ${JSON.stringify(pre)}`);

  // ── interpretation override: a semicolon file forced to ';' + header off ──
  const ovr = await page.evaluate(async () => {
    const bytes = new TextEncoder().encode('a;b;c\n1;2;3\n4;5;6\n');
    window._lamina.open('semi.csv', bytes);              // auto: likely 1 "text" column
    const autoCols = window._laminaVS.cols;
    window._lamina.reopen({ delimiter: ';' });           // force semicolon
    await new Promise((r) => setTimeout(r, 30));
    const forcedCols = window._laminaVS.cols;
    window._lamina.reopen({ delimiter: ';', hasHeader: false });
    await new Promise((r) => setTimeout(r, 30));
    const rows = window._laminaVS.rowCount();            // header off → 3 data rows
    return { autoCols, forcedCols, rows };
  });
  (ovr.forcedCols === 3 && ovr.rows === 3)
    ? ok(`override: forced ';' → ${ovr.forcedCols} cols (auto saw ${ovr.autoCols}); header off → ${ovr.rows} rows`)
    : fail(`override failed: ${JSON.stringify(ovr)}`);

  // ── whitespace-delimited + Geo-EAS ──
  const ws = await page.evaluate(async () => {
    let csv = 'id      x         grade\n';
    for (let i = 0; i < 400; i++) csv += `${i}\t${612105 + i * 10}    ${(i * 0.01).toFixed(2)}\n`;
    window._lamina.open('gslib.dat', new TextEncoder().encode(csv));
    const vs = window._laminaVS;
    return { cols: vs.cols, rows: vs.rowCount(), header: window._lamina.grid.provider.header(2).label, first: await vs.ensureRow(0) };
  });
  (ws.cols === 3 && ws.rows === 400 && ws.header === 'grade' && ws.first[0] === '0')
    ? ok(`whitespace-delimited → ${ws.cols} cols, header "${ws.header}", ${ws.rows} rows`)
    : fail(`whitespace failed: ${JSON.stringify(ws)}`);

  const geo = await page.evaluate(async () => {
    let csv = 'Block model export\n3\nID\nGrade\nLito\n';   // Geo-EAS: title, count, names
    for (let i = 0; i < 300; i++) csv += `${i} ${(i * 0.02).toFixed(2)} ox\n`;
    window._lamina.open('model.geoeas', new TextEncoder().encode(csv));
    const vs = window._laminaVS;
    return { cols: vs.cols, rows: vs.rowCount(), h0: window._lamina.grid.provider.header(0).label, h1: window._lamina.grid.provider.header(1).label, first: await vs.ensureRow(0) };
  });
  (geo.cols === 3 && geo.rows === 300 && geo.h0 === 'ID' && geo.h1 === 'Grade' && geo.first[2] === 'ox')
    ? ok(`Geo-EAS → ${geo.cols} cols (${geo.h0}, ${geo.h1}, …), ${geo.rows} data rows`)
    : fail(`Geo-EAS failed: ${JSON.stringify(geo)}`);

  // ── go-to-row scrolls a deep row into selection ──
  const go = await page.evaluate(async () => {
    let csv = 'id\n'; for (let i = 0; i < 5000; i++) csv += `${i}\n`;
    window._lamina.open('rows.csv', new TextEncoder().encode(csv));
    window._lamina.gotoRow(4000);
    const sel = window._lamina.grid.getSelection();
    return { r0: sel && sel.r0 };
  });
  (go.r0 === 3999)
    ? ok(`go-to-row: row 4000 selected (r0=${go.r0})`)
    : fail(`go-to-row failed: ${JSON.stringify(go)}`);

  // ── column hide / show (remaps display columns past hidden ones) ──
  const col = await page.evaluate(async () => {
    window._lamina.open('c.csv', new TextEncoder().encode('a,b,c,d\n1,2,3,4\n5,6,7,8\n'));
    const all = window._laminaVS.cols;
    const h0 = window._lamina.grid.provider.header(0).label;
    window._lamina.hideColumn(1);                        // hide 'b'
    await window._laminaVS.ensureRow(0);                 // load the block so cellAt is ready
    const afterHide = { cols: window._lamina.grid.provider.dims().cols, c1: window._lamina.grid.provider.header(1).label, cell1: window._lamina.grid.provider.cellAt(0, 1).value };
    window._lamina.showAllColumns();
    const restored = window._lamina.grid.provider.dims().cols;
    return { all, h0, afterHide, restored };
  });
  (col.all === 4 && col.afterHide.cols === 3 && col.afterHide.c1 === 'c' && col.afterHide.cell1 === '3' && col.restored === 4)
    ? ok(`columns: hide 'b' → ${col.afterHide.cols} cols (display col 1 now '${col.afterHide.c1}'); show all → ${col.restored}`)
    : fail(`column hide/show failed: ${JSON.stringify(col)}`);

  // ── menubar + help overlay + View→Interpretation opens the popover ──
  const menu = await page.evaluate(async () => {
    window._lamina.open('mm.csv', new TextEncoder().encode('a,b\n1,2\n3,4\n'));   // a file must be open
    document.getElementById('mFile').click();            // open the File menu
    const fileItems = [...document.querySelectorAll('.ctxmenu .item')].map((e) => e.textContent);
    document.getElementById('mView').click();            // (re)open View
    const viewItems = [...document.querySelectorAll('.ctxmenu .item')].map((e) => e.textContent);
    // click "Interpretation…" and confirm the popover OPENS and STAYS open (the bug)
    [...document.querySelectorAll('.ctxmenu .item')].find((e) => e.textContent.startsWith('Interpretation')).click();
    await new Promise((r) => setTimeout(r, 20));
    const optsOpen = document.getElementById('opts').classList.contains('show');
    window._lamina.showHelp('filter');                   // Help → Filter syntax
    const helpShown = document.getElementById('help').classList.contains('show');
    const helpHasOps = document.getElementById('helpBody').textContent.includes('contains');
    document.getElementById('helpClose').click();
    return { fileItems, viewItems, optsOpen, helpShown, helpHasOps, helpClosed: !document.getElementById('help').classList.contains('show') };
  });
  (menu.fileItems.some((t) => t.startsWith('Open')) && menu.fileItems.includes('New window') && menu.viewItems.includes('Clear sort') && menu.optsOpen && menu.helpShown && menu.helpHasOps && menu.helpClosed)
    ? ok(`menubar: File/View populate · View→Interpretation opens the popover · Help→filter overlay opens+closes`)
    : fail(`menubar failed: ${JSON.stringify(menu)}`);

  // ── column statistics (numeric + categorical, respecting the filter) ──
  const stats = await page.evaluate(async () => {
    let csv = 'id,grade,lito\n';
    for (let i = 0; i <= 200; i++) csv += `${i},${i % 11},${['ox', 'sulf'][i % 2]}\n`;
    window._lamina.open('s2.csv', new TextEncoder().encode(csv));
    await window._lamina.showColumnStats(1);             // numeric column 'grade'
    await new Promise((r) => setTimeout(r, 40));
    const numBody = document.getElementById('helpBody').textContent;
    const numTitle = document.getElementById('helpTitle').textContent;
    await window._lamina.showColumnStats(2);             // categorical 'lito'
    await new Promise((r) => setTimeout(r, 40));
    const catBody = document.getElementById('helpBody').textContent;
    document.getElementById('helpClose').click();
    return { numTitle, numHasMean: /mean/.test(numBody), numHasMedian: /median/.test(numBody), catHasDistinct: /distinct/.test(catBody), catHasOx: /ox/.test(catBody) };
  });
  (stats.numTitle.includes('grade') && stats.numHasMean && stats.numHasMedian && stats.catHasDistinct && stats.catHasOx)
    ? ok(`column stats: numeric (mean+median) + categorical (distinct + top values)`)
    : fail(`stats failed: ${JSON.stringify(stats)}`);

  // ── click a categorical top-value in the stats panel → filter ──
  const sclick = await page.evaluate(async () => {
    let csv = 'id,lito\n';
    for (let i = 0; i < 300; i++) csv += `${i},${['ox', 'sulf', 'trans'][i % 3]}\n`;
    window._lamina.open('sc.csv', new TextEncoder().encode(csv));
    await window._lamina.showColumnStats(1);             // categorical 'lito'
    await new Promise((r) => setTimeout(r, 40));
    const sf = document.querySelector('#helpBody .sfilter');
    const label = sf && sf.textContent;
    sf.click();                                          // → filter by that value, close overlay
    await new Promise((r) => setTimeout(r, 40));
    return { label, hidden: !document.getElementById('help').classList.contains('show'), rows: window._laminaVS.rowCount(), filter: document.getElementById('filter').value };
  });
  (sclick.label === 'ox' && sclick.rows === 100 && /lito in ox/.test(sclick.filter))
    ? ok(`stats → click "${sclick.label}" filters to it (${sclick.rows} rows, "${sclick.filter}")`)
    : fail(`stat click-filter failed: ${JSON.stringify(sclick)}`);

  // ── multi-select in the stats panel → `col in a, b` (OR) ──
  const multi = await page.evaluate(async () => {
    let csv = 'id,lito\n';
    for (let i = 0; i < 300; i++) csv += `${i},${['ox', 'sulf', 'trans'][i % 3]}\n`;
    window._lamina.open('sm.csv', new TextEncoder().encode(csv));
    await window._lamina.showColumnStats(1);
    await new Promise((r) => setTimeout(r, 40));
    const spans = [...document.querySelectorAll('#helpBody .sfilter')];
    spans.find((s) => s.textContent === 'ox').click();      // select ox
    await new Promise((r) => setTimeout(r, 20));
    spans.find((s) => s.textContent === 'sulf').click();    // + sulf (panel stays open)
    await new Promise((r) => setTimeout(r, 30));
    const rows = window._laminaVS.rowCount();
    const filter = document.getElementById('filter').value;
    const stillOpen = document.getElementById('help').classList.contains('show');
    const selCount = document.querySelectorAll('#helpBody .sfilter.sel').length;
    return { rows, filter, stillOpen, selCount };
  });
  (multi.rows === 200 && /lito in ox, sulf/.test(multi.filter) && multi.stillOpen && multi.selCount === 2)
    ? ok(`stats multi-select: ox + sulf → "${multi.filter}" (${multi.rows} rows, panel stays open)`)
    : fail(`multi-select failed: ${JSON.stringify(multi)}`);

  // ── cell context menu + copy variants + footer flash ──
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const cm = await page.evaluate(async () => {
    window._lamina.open('cm.csv', new TextEncoder().encode('id,grade,lito\n0,1.2,ox\n1,0.8,sulf\n2,3.4,ox\n'));
    await window._laminaVS.ensureRow(0);
    // copy a 2×2 range with header + row # (the cell-menu actions); read clipboard + footer flash
    await window._lamina.copySelection({ r0: 0, c0: 0, r1: 1, c1: 1 }, { header: true, rowNum: true });
    await new Promise((r) => setTimeout(r, 40));
    const text = await navigator.clipboard.readText().catch(() => '');
    const footer = document.getElementById('meta').textContent;
    // and the cell menu's "Filter <col> = <value>" action
    window._lamina.filterByValue(2, 'ox');                              // lito == ox
    await new Promise((r) => setTimeout(r, 40));
    return { text, footer, filtered: window._laminaVS.rowCount() };
  });
  const lines = (cm.text || '').split(/\r?\n/);                          // Windows clipboard uses CRLF
  (lines[0] === 'row\tid\tgrade' && lines[1] === '1\t0\t1.2' && /✓ copied 2×2 \+header \+row#/.test(cm.footer) && cm.filtered === 2)
    ? ok(`cell copy+header+row# → "${lines[0]}" / "${lines[1]}"; footer "${cm.footer}"; filter-by-value → ${cm.filtered} rows`)
    : fail(`cell menu/copy failed: ${JSON.stringify({ lines: lines.slice(0, 2), footer: cm.footer, filtered: cm.filtered })}`);

  // ── per-column number format (display only; value unchanged) ──
  const fmt = await page.evaluate(async () => {
    window._lamina.open('nf.csv', new TextEncoder().encode('id,grade\n0,1.23456\n1,2.7\n'));
    await window._laminaVS.ensureRow(0);
    const raw = window._lamina.grid.provider.cellAt(0, 1).style.text;     // 'grade' col, auto
    window._lamina.setColFormat(1, { mode: 'fixed', digits: 2 });
    const fixed = window._lamina.grid.provider.cellAt(0, 1).style.text;   // 2 decimals
    window._lamina.setColFormat(1, { mode: 'sci', digits: 3 });
    const sci = window._lamina.grid.provider.cellAt(0, 1).style.text;
    window._lamina.setColFormat(1, null);
    const auto = window._lamina.grid.provider.cellAt(0, 1).style.text;
    return { raw, fixed, sci, auto };
  });
  (fmt.raw === '1.23456' && fmt.fixed === '1.23' && /^1\.235e/.test(fmt.sci) && fmt.auto === '1.23456')
    ? ok(`number format: 2-decimals (${fmt.fixed}), scientific (${fmt.sci}), auto restores (${fmt.auto})`)
    : fail(`number format failed: ${JSON.stringify(fmt)}`);

  // ── force column type (number ↔ text) changes sort + stats ──
  const ftype = await page.evaluate(async () => {
    // a column that looks numeric but should be text (codes); x keeps it a real table
    window._lamina.open('ft.csv', new TextEncoder().encode('code,x\n10,a\n2,b\n30,c\n'));
    const before = window._lamina.current.schema[0].type;     // detected 'number'
    window._lamina.setColType(0, 'string');                   // force text
    const after = window._lamina.current.schema[0].type;
    // stats now treat it as categorical (distinct), not numeric
    await window._lamina.showColumnStats(0);
    await new Promise((r) => setTimeout(r, 40));
    const body = document.getElementById('helpBody').textContent;
    document.getElementById('helpClose').click();
    return { before, after, statsCategorical: /distinct/.test(body) };
  });
  (ftype.before === 'number' && ftype.after === 'string' && ftype.statsCategorical)
    ? ok(`force column type: number→text (stats become categorical)`)
    : fail(`force type failed: ${JSON.stringify(ftype)}`);

  // ── column widths persist across a re-render (autofit then sort) ──
  const persist = await page.evaluate(async () => {
    window._lamina.open('p2.csv', new TextEncoder().encode('a,b\n1,2\n3,4\n5,6\n'));
    await window._laminaVS.ensureRow(0);
    window._lamina.autofitAll();
    const before = window._lamina.grid.getColWidths();
    const w0 = before[0];
    await window._lamina.toggleSort(0);                  // re-mounts the grid
    const after = window._lamina.grid.getColWidths();
    return { w0, kept: after[0], same: after[0] === w0 };
  });
  (persist.w0 > 0 && persist.same)
    ? ok(`column widths persist across re-render (autofit ${persist.w0}px survived a sort)`)
    : fail(`width persistence failed: ${JSON.stringify(persist)}`);

  // ── autofit all columns / reset widths ──
  const fit = await page.evaluate(async () => {
    window._lamina.open('w.csv', new TextEncoder().encode('short,a_very_long_header_name_here\nx,y\n1,2\n'));
    await window._laminaVS.ensureRow(0);
    const before = Object.keys(window._lamina.grid.getColWidths()).length;   // no custom widths yet
    window._lamina.autofitAll();
    const after = window._lamina.grid.getColWidths();
    window._lamina.resetColWidths();
    const reset = Object.keys(window._lamina.grid.getColWidths()).length;
    return { before, fitCount: Object.keys(after).length, w1: after[1], reset };
  });
  (fit.before === 0 && fit.fitCount === 2 && fit.w1 > 0 && fit.reset === 0)
    ? ok(`autofit: all ${fit.fitCount} columns sized (long header → ${fit.w1}px), reset clears widths`)
    : fail(`autofit failed: ${JSON.stringify(fit)}`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nLAMINA SMOKE: FAIL' : '\nLAMINA SMOKE: PASS');
