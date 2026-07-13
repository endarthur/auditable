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
import { makeDM } from './dm-make.mjs';
import { sheet as xlsxSheet } from '../ext/sheet/index.js';   // build the .xlsx fixture, don't commit a binary

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
await page.setViewportSize({ width: 1280, height: 800 });   // a desktop size so panel-width / edge-flip math is exercised
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
    box.value = 'keep == "Y"'; box.dispatchEvent(new Event('input'));   // as if typed → × appears (text values are quoted)
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
    await window._lamina.applyFilter('grade >= 3 && lito == "ox"');       // i%5∈{3,4} and i even (&& + quoted text via @gcu/expr)
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

  // ── sort (via the column menu / toggleSort — not header-click): asc/desc; composes with filter ──
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

  // ── decimal-comma: a ;-delimited comma-decimal file → force decimal=',' ──
  const dec = await page.evaluate(async () => {
    let csv = 'id;grade\n';
    for (let i = 0; i < 200; i++) csv += `${i};${(i % 10) + ',5'}\n`;   // grades like "3,5"
    window._lamina.open('br.csv', new TextEncoder().encode(csv), { delimiter: ';' });
    const before = window._lamina.current.schema[1].type;               // 'string' (commas under point)
    window._lamina.reopen({ delimiter: ';', decimal: ',' });
    await new Promise((r) => setTimeout(r, 40));
    const after = window._lamina.current.schema[1].type;                // 'number' now
    await window._lamina.showColumnStats(1);
    await new Promise((r) => setTimeout(r, 40));
    const body = document.getElementById('helpBody').textContent;
    document.getElementById('helpClose').click();
    return { before, after, max: /max\s*9\.5/.test(body), hasMean: /mean/.test(body) };
  });
  (dec.before === 'string' && dec.after === 'number' && dec.max && dec.hasMean)
    ? ok(`decimal comma: "3,5" recognized → numeric (mean+max parsed; max 9.5)`)
    : fail(`decimal comma failed: ${JSON.stringify(dec)}`);

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

  // ── menubar + help overlay + Data→Interpretation opens the popover ──
  const menu = await page.evaluate(async () => {
    window._lamina.open('mm.csv', new TextEncoder().encode('a,b\n1,2\n3,4\n'));   // a file must be open
    document.getElementById('mFile').click();            // open the File menu
    const fileItems = [...document.querySelectorAll('.ctxmenu .item')].map((e) => e.textContent);
    document.getElementById('mData').click();            // open Data (calc / interpretation / clear filter+sort)
    const dataItems = [...document.querySelectorAll('.ctxmenu .item')].map((e) => e.textContent);
    document.getElementById('mView').click();            // open View (go-to-row / autofit / widths / show all)
    const viewItems = [...document.querySelectorAll('.ctxmenu .item')].map((e) => e.textContent);
    document.getElementById('mData').click();            // (re)open Data → click Interpretation
    [...document.querySelectorAll('.ctxmenu .item')].find((e) => e.textContent.startsWith('Interpretation')).click();
    await new Promise((r) => setTimeout(r, 20));
    const optsOpen = document.getElementById('opts').classList.contains('show');   // popover OPENS and STAYS open
    window._lamina.showHelp('start');                    // Help → Getting started
    const startGuide = document.getElementById('helpBody').textContent.includes('right-click');
    window._lamina.showHelp('filter');                   // Help → Filter syntax
    const helpShown = document.getElementById('help').classList.contains('show');
    const helpHasOps = document.getElementById('helpBody').textContent.includes('contains');
    document.getElementById('helpClose').click();
    return { fileItems, dataItems, viewItems, optsOpen, startGuide, helpShown, helpHasOps, helpClosed: !document.getElementById('help').classList.contains('show') };
  });
  (menu.fileItems.some((t) => t.startsWith('Open')) && menu.fileItems.includes('New window')
    && menu.dataItems.some((t) => t.startsWith('Calculated columns')) && menu.dataItems.includes('Clear sort')
    && menu.viewItems.includes('Show all columns') && menu.optsOpen && menu.startGuide && menu.helpShown && menu.helpHasOps && menu.helpClosed)
    ? ok(`menubar: File/Data/View populate · Data→Interpretation opens the popover · Help→filter overlay opens+closes`)
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
  (sclick.label === 'ox' && sclick.rows === 100 && /lito in "ox"/.test(sclick.filter))
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
  (multi.rows === 200 && /lito in "ox", "sulf"/.test(multi.filter) && multi.stillOpen && multi.selCount === 2)
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

  // ── Datamine .dm → the DIRECT record path (no decode-to-text): browse windows
  // via File.slice, and filter / sort / stats run over the record cursor exactly
  // like CSV. One path at any size — lastScan === 'dm'. ──
  const dmBuf = makeDM(
    [{ name: 'BHID', type: 'A', width: 8 }, { name: 'FROM', type: 'N' }, { name: 'TO', type: 'N' }, { name: 'AU', type: 'N' }],
    Array.from({ length: 250 }, (_, i) => ({ BHID: 'DDH' + String(i % 5).padStart(5, '0'), FROM: i, TO: i + 1, AU: (i % 10) * 0.1 })),
    { precision: 'sp' });
  const dmArr = Array.from(new Uint8Array(dmBuf));
  const dm = await page.evaluate(async (arr) => {
    await window._lamina.openFile(new File([new Uint8Array(arr)], 'model.dm'));
    const vs = window._laminaVS;
    const scan = window._lamina.lastScan;
    const first = await vs.ensureRow(0);
    const deep = await vs.ensureRow(240);                   // far record → windowed via File.slice
    const cols = vs.cols, rows = vs.rowCount(), h0 = window._lamina.grid.provider.header(0).label;
    const badge = document.querySelector('#kindBadge').textContent;
    await window._lamina.showColumnStats(1);               // stats over the cursor (no text round-trip)
    const statsText = document.querySelector('#helpBody').innerText;
    document.querySelector('#help').classList.remove('show');
    await window._lamina.applyFilter('AU > 0.5');          // filter via the record cursor
    const filtered = window._laminaVS.rowCount();
    await window._lamina.toggleSort(1);                    // sort FROM asc over the filtered matches
    const sortedTop = await window._laminaVS.ensureRow(0);
    return { scan, cols, rows, h0, first, deep, badge, filtered, statsText, sortedTop };
  }, dmArr);
  (dm.scan === 'dm' && dm.cols === 4 && dm.rows === 250 && dm.h0 === 'BHID' && dm.badge === 'dm'
    && dm.first[0] === 'DDH00000' && Number(dm.first[1]) === 0
    && dm.deep[0] === 'DDH00000' && Number(dm.deep[1]) === 240
    && /mean/i.test(dm.statsText) && dm.filtered > 0 && dm.filtered < 250 && Number(dm.sortedTop[1]) === 6)
    ? ok(`.dm direct (${dm.rows}×${dm.cols}, deep row 240 FROM=${dm.deep[1]} via File.slice); stats✓ filter AU>0.5 → ${dm.filtered}; sort+filter top FROM=${dm.sortedTop[1]}`)
    : fail(`.dm direct failed: ${JSON.stringify(dm)}`);

  // ── calculated columns (@gcu/expr) — a read-time derived column, filterable,
  //    chainable, removable; the value never materializes ──
  const calc = await page.evaluate(async () => {
    window._lamina.open('calc.csv', new TextEncoder().encode('a,b\n2,10\n3,20\n4,30\n'));
    document.getElementById('addCalc').click();               // toolbar button → the editor popover
    const editorOpen = document.getElementById('calcEditor').classList.contains('show');
    document.getElementById('ceCancel').click();
    window.__calcEditorOpened = editorOpen;
    await window._lamina.addCalc('ab', 'a * b');               // 20, 60, 120
    await window._lamina.addCalc('big', 'if(ab > 50, "Y", "N")'); // chains off ab: N, Y, Y
    const vs = window._laminaVS;
    const cols = vs.cols, h1 = window._lamina.grid.provider.header(cols - 2).label, h2 = window._lamina.grid.provider.header(cols - 1).label;
    const row1 = await vs.ensureRow(1);                        // a=3,b=20 → ab=60, big=Y
    await window._lamina.applyFilter('ab > 50');               // filter ON the calc → 2 rows
    const filtered = window._laminaVS.rowCount();
    // the manager lists both, marks them ƒ, and removes from the list
    window._lamina.openCalcManager();
    const mgrShown = document.getElementById('calcManager').classList.contains('show');
    const listed = [...document.querySelectorAll('#cmList .cm-name')].map((e) => e.textContent);
    const headerCalc = window._lamina.grid.provider.header(2).calc === true;   // 'ab' header flagged calc → ƒ glyph
    [...document.querySelectorAll('#cmList .cm-acts button')].find((b) => b.textContent === 'Remove').click();   // remove first via the manager
    const listedAfter = [...document.querySelectorAll('#cmList .cm-name')].map((e) => e.textContent);
    document.getElementById('cmClose').click();
    window._lamina.removeCalc(0);                               // remove the remaining → back to base
    const afterCols = window._laminaVS.cols, afterCalcs = window._lamina.calcs.length;
    return { cols, h1, h2, ab1: row1[cols - 2], big1: row1[cols - 1], filtered, afterCols, afterCalcs, editorOpen: window.__calcEditorOpened, mgrShown, listed, headerCalc, listedAfter };
  });
  (calc.cols === 4 && calc.h1 === 'ab' && calc.h2 === 'big' && calc.ab1 === '60' && calc.big1 === 'Y'
    && calc.filtered === 2 && calc.afterCols === 2 && calc.afterCalcs === 0 && calc.editorOpen
    && calc.mgrShown && calc.headerCalc && calc.listed.join(',') === 'ab,big' && calc.listedAfter.join(',') === 'big')
    ? ok(`calc columns: ƒ+ col opens editor; header marked ƒ; manager lists [${calc.listed}] → remove → [${calc.listedAfter}]; filter ab>50 → ${calc.filtered}; remove all → ${calc.afterCols} cols`)
    : fail(`calc columns failed: ${JSON.stringify(calc)}`);

  // ── column distribution gutter: numeric → histogram, categorical → top-N bar,
  //    sampled (≈), fed to loom's header gutter ──
  await page.evaluate(() => {
    let csv = 'grade,lito\n';
    for (let i = 0; i < 500; i++) csv += `${((i % 50) * 0.1).toFixed(1)},${['ox', 'sulf', 'trans'][i % 3]}\n`;
    window._lamina.open('g.csv', new TextEncoder().encode(csv));
  });
  await page.waitForTimeout(150);   // refreshGutter is an async sample scan
  const gut = await page.evaluate(() => {
    const g = window._lamina.gutter, prov = window._lamina.grid.provider;
    return {
      n: g && g.length, gradeKind: g && g[0] && g[0].kind, litoKind: g && g[1] && g[1].kind,
      gradeBins: g && g[0] && g[0].bins && g[0].bins.length, litoSegs: g && g[1] && g[1].segments && g[1].segments.length,
      litoColors: g && g[1] && g[1].colors, approx: !!(g && g[0] && g[0].approx), provKind: prov.headerGutter(0) && prov.headerGutter(0).kind,
    };
  });
  const distinctColors = gut.litoColors && gut.litoColors.length === gut.litoSegs && new Set(gut.litoColors).size === gut.litoSegs;
  (gut.n === 2 && gut.gradeKind === 'hist' && gut.litoKind === 'cat' && gut.gradeBins > 0 && gut.litoSegs === 3 && gut.approx && gut.provKind === 'hist' && distinctColors)
    ? ok(`gutter: grade→histogram (${gut.gradeBins} bins, ≈) · lito→top-${gut.litoSegs} bar w/ distinct colors · provider feeds loom`)
    : fail(`gutter failed: ${JSON.stringify(gut)}`);

  // ── autocomplete (expr.complete) + smart-validate: values from the gutter sample,
  //    column suggestions, and the "quote it as text" footgun hint ──
  await page.evaluate(() => {
    let csv = 'grade,lito\n';
    for (let i = 0; i < 300; i++) csv += `${(i * 0.1).toFixed(1)},${['OXIDE', 'SULF', 'TRANS'][i % 3]}\n`;
    window._lamina.open('ac.csv', new TextEncoder().encode(csv));
  });
  await page.waitForTimeout(150);   // gutter sample (the value list) must be ready
  const ac = await page.evaluate(async () => {
    const inp = document.getElementById('filter');
    const fire = (val) => { inp.value = val; inp.setSelectionRange(val.length, val.length); inp.dispatchEvent(new Event('input')); };
    fire('lito = ');                                     // value position → the column's sampled values, quoted
    const valShown = document.getElementById('acPopup').classList.contains('show');
    const valOpts = [...document.querySelectorAll('#acPopup .ac-item .ac-val')].map((e) => e.textContent);
    fire('gr');                                          // operand prefix → columns
    const colOpts = [...document.querySelectorAll('#acPopup .ac-item .ac-val')].map((e) => e.textContent);
    fire('');                                            // clear the box back
    await window._lamina.applyFilter('lito = ox');       // bare ox = unknown column → footgun hint
    return { valShown, valOpts, colOpts, errMeta: document.getElementById('meta').textContent };
  });
  (ac.valShown && ac.valOpts.includes('"OXIDE"') && ac.colOpts.includes('grade') && /quote it as "ox"/.test(ac.errMeta))
    ? ok(`autocomplete: lito= → values [${ac.valOpts.join(', ')}]; "gr" → ${ac.colOpts.join(', ')}; smart-validate hints "quote it as text"`)
    : fail(`autocomplete/smart-validate failed: ${JSON.stringify(ac)}`);

  // ── syntax highlighting: the overlay (expr.tokenize) colours the filter text ──
  const hl = await page.evaluate(() => {
    const inp = document.getElementById('filter');
    inp.value = 'grade > 1 and lito = "OXIDE"'; inp.setSelectionRange(0, 0); inp.dispatchEvent(new Event('input'));
    const hlEl = document.getElementById('filterHL');
    const by = (cls) => [...hlEl.querySelectorAll('.' + cls)].map((e) => e.textContent);
    const transparent = getComputedStyle(inp).color === 'rgba(0, 0, 0, 0)';   // text drawn by the overlay, not the input
    const out = { col: by('hl-column'), str: by('hl-string'), kw: by('hl-keyword'), num: by('hl-number'), transparent };
    inp.value = ''; inp.dispatchEvent(new Event('input'));        // clean up AFTER reading the spans
    return out;
  });
  (hl.transparent && hl.col.join() === 'grade,lito' && hl.str.join() === '"OXIDE"' && hl.kw.join() === 'and' && hl.num.join() === '1')
    ? ok(`highlight: overlay colours columns [${hl.col}], string ${hl.str}, keyword ${hl.kw}, number ${hl.num} (no CM6)`)
    : fail(`highlight failed: ${JSON.stringify(hl)}`);

  // ── gutter brush → filter (ac.csv still open: 300 rows, grade 0..29.9 numeric).
  //    A numeric range brush writes `grade between A and B`; apply vs stage by mode. ──
  const brush = await page.evaluate(async () => {
    window._lamina.setBrushMode('apply');
    await window._lamina.applyFilter('');                 // clean slate
    await window._lamina.brushFilter(0, 0.0, 0.5);        // grade col, lower half of the range (apply → await the scan)
    const box = document.getElementById('filter').value, rows = window._laminaVS.rowCount();
    window._lamina.setBrushMode('stage');
    window._lamina.applyFilter('');
    window._lamina.brushFilter(0, 0.0, 0.5);             // stage: fills the box, does NOT apply
    const stagedBox = document.getElementById('filter').value, stagedRows = window._laminaVS.rowCount();
    window._lamina.setBrushMode('auto'); window._lamina.applyFilter('');
    return { box, rows, stagedBox, stagedRows };
  });
  (/^grade between [\d.]+ and [\d.]+$/.test(brush.box) && brush.rows > 0 && brush.rows < 300
    && /^grade between/.test(brush.stagedBox) && brush.stagedRows === 300)
    ? ok(`brush: drag → "${brush.box}" applied (${brush.rows}/300); stage mode fills box but holds (${brush.stagedRows}/300, press Enter)`)
    : fail(`brush failed: ${JSON.stringify(brush)}`);

  // ── gutter brush tooltip: live range readout while dragging (ac.csv, grade 0..~30) ──
  const tip = await page.evaluate(async () => {
    const L = window._lamina;
    L.showBrushTip(0, 0.0, 0.5, 200, 100);                 // mid-drag on the grade col, lower half
    const el = document.querySelector('.brush-tip');
    const shown = !!el && el.style.display === 'block' && /\d.*–.*\d/.test(el.textContent);
    const text = el && el.textContent;
    L.showBrushTip(0, null, null);                          // drag end → hide
    const hidden = el && el.style.display === 'none';
    return { shown, text, hidden };
  });
  (tip.shown && tip.hidden)
    ? ok(`brush tooltip: live range "${tip.text}" while dragging, hides on release`)
    : fail(`brush tooltip failed: ${JSON.stringify(tip)}`);

  // ── gutter hover tooltip + categorical click/drag filtering ──
  const catGut = await page.evaluate(async () => {
    const L = window._lamina;
    let csv = 'grade,lito\n';
    for (let i = 0; i < 300; i++) csv += `${(i % 30) * 0.5},${['OXIDE', 'SULF', 'TRANS'][i % 3]}\n`;
    L.open('cg.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 150));
    const tip = document.querySelector('.brush-tip');
    // hover the categorical glyph (col 1) near the left → first category, with a %
    L.showGutterTip(1, 0.05, 300, 50);
    const catHover = tip && tip.style.display === 'block' && /OXIDE|SULF|TRANS/.test(tip.textContent) && /%/.test(tip.textContent);
    const catHoverText = tip && tip.textContent;
    // hover the numeric glyph (col 0) → a ≈ value
    L.showGutterTip(0, 0.5, 300, 50);
    const numHover = tip && /≈/.test(tip.textContent);
    L.showGutterTip(null);                                  // leave → hide
    const hidden = tip && tip.style.display === 'none';
    // tap the categorical glyph near the left → (debounced) filter to that category
    document.getElementById('filter').value = '';
    L.gutterClick(1, 0.05);
    await new Promise((r) => setTimeout(r, 300));            // > the 220ms tap debounce
    const box1 = document.getElementById('filter').value;
    const oneCat = /^lito == "(OXIDE|SULF|TRANS)"$/.test(box1);
    await L.applyFilter('');
    // double-click cancels the pending tap-filter and opens stats instead
    document.getElementById('filter').value = ''; document.getElementById('help').classList.remove('show');
    L.gutterClick(1, 0.05); L.gutterDblClick(1);
    await new Promise((r) => setTimeout(r, 300));
    const dblOpensStats = document.getElementById('help').classList.contains('show') && document.getElementById('filter').value === '';
    document.getElementById('help').classList.remove('show');
    // numeric tap → filter to the hovered bin's range (a `between`)
    L.gutterClick(0, 0.5);
    await new Promise((r) => setTimeout(r, 300));
    const box3 = document.getElementById('filter').value;
    const numBin = /^grade between [\d.]+ and [\d.]+$/.test(box3);
    await L.applyFilter('');
    // drag across the whole categorical glyph → in (…) of the covered categories
    L.gutterBrush(1, 0.0, 1.0);
    await new Promise((r) => setTimeout(r, 80));
    const box2 = document.getElementById('filter').value;
    const manyCat = /^lito in \(.*OXIDE.*\)$/.test(box2) && (box2.match(/"/g) || []).length >= 4;
    await L.applyFilter('');
    return { catHover, catHoverText, numHover, hidden, oneCat, box1, dblOpensStats, numBin, box3, manyCat, box2 };
  });
  (catGut.catHover && catGut.numHover && catGut.hidden && catGut.oneCat && catGut.dblOpensStats && catGut.numBin && catGut.manyCat)
    ? ok(`gutter: hover tip (cat "${catGut.catHoverText}" + num ≈) · tap→filter (${catGut.box1} / ${catGut.box3}) · dbl-click→stats · cat drag→in(…)`)
    : fail(`cat gutter interaction failed: ${JSON.stringify(catGut)}`);

  // ── filter-reactive gutters: an active filter overlays the matched-rows
  //    distribution (numeric/hist) on the global one ──
  const react = await page.evaluate(async () => {
    window._lamina.setBrushMode('apply');
    await window._lamina.applyFilter('grade < 5');        // a sub-range → a distinct filtered shape
    await new Promise((r) => setTimeout(r, 120));         // refreshGutterFiltered is async
    const prov = window._lamina.grid.provider;
    const g0 = prov.headerGutter(0);                      // grade column (numeric)
    const hasFiltered = !!(g0 && g0.filtered && g0.filtered.bins && g0.filtered.bins.length);
    await window._lamina.applyFilter('');                 // clear → overlay gone
    await new Promise((r) => setTimeout(r, 60));
    const cleared = !window._lamina.grid.provider.headerGutter(0).filtered;
    return { hasFiltered, cleared };
  });
  (react.hasFiltered && react.cleared)
    ? ok('filter-reactive gutter: matched-rows histogram overlays the global; clears with the filter')
    : fail(`filter-reactive gutter failed: ${JSON.stringify(react)}`);

  // ── responsive: a phone-width viewport → the toolbar wraps to two rows, the
  //    grid drops below it, nothing overflows horizontally ──
  await page.setViewportSize({ width: 360, height: 720 });
  await page.evaluate(() => window._lamina.open('r.csv', new TextEncoder().encode('a,b\n1,2\n3,4\n')));
  await page.waitForTimeout(80);   // let the ResizeObserver sync --tb to the wrapped toolbar height
  const resp = await page.evaluate(() => {
    const tb = document.getElementById('toolbar'), grid = document.getElementById('grid');
    const tbH = tb.offsetHeight, gridTop = grid.getBoundingClientRect().top;
    return {
      tbH, gridTop,
      tbFits: tb.scrollWidth <= tb.clientWidth + 1,                                  // wrapped, not clipped
      titleHidden: getComputedStyle(document.querySelector('#toolbar .title')).display === 'none',
      filterOnRow2: document.getElementById('filterWrap').getBoundingClientRect().top > document.getElementById('mFile').getBoundingClientRect().top + 4,
    };
  });
  (resp.tbH >= 70 && Math.abs(resp.gridTop - resp.tbH) < 3 && resp.tbFits && resp.titleHidden && resp.filterOnRow2)
    ? ok(`responsive: toolbar wraps to ${resp.tbH}px (title hidden · filter on row 2) · grid below it · no overflow`)
    : fail(`responsive failed: ${JSON.stringify(resp)}`);

  // ── streaming export: serialize the current view (filtered + sorted + calc +
  //    chosen columns) to CSV/TSV. Tests the serializer via the string sink. ──
  const exp = await page.evaluate(async () => {
    window._lamina.open('ex.csv', new TextEncoder().encode('id,name,grade\n1,"a,b",2.5\n2,c,9\n3,d,0.1\n'));
    await new Promise((r) => setTimeout(r, 30));
    const all = await window._lamina.exportToString({ delimiter: ',', header: true });   // whole table, CSV
    await window._lamina.applyFilter('grade > 1');                                        // → rows 1 & 2
    const filtered = await window._lamina.exportToString({ delimiter: '\t', header: true });  // current view, TSV
    const cols = await window._lamina.exportToString({ delimiter: ',', header: false, colIdx: [2], allRows: true });  // grade only, no header, ALL rows (ignores the active filter)
    await window._lamina.applyFilter('');
    return { all, filtered, cols };
  });
  (exp.all === 'id,name,grade\n1,"a,b",2.5\n2,c,9\n3,d,0.1\n'           // CSV quoting of "a,b" preserved
    && exp.filtered === 'id\tname\tgrade\n1\ta,b\t2.5\n2\tc\t9\n'        // TSV, filtered to grade>1, tab needs no quote for "a,b"
    && exp.cols === '2.5\n9\n0.1\n')                                     // single column, no header, all rows
    ? ok('export: CSV quoting + TSV + filtered view + column subset all serialize correctly')
    : fail(`export failed: ${JSON.stringify(exp)}`);

  // ── theme: View → Theme flips the chrome (CSS vars) + re-skins the grid ──
  const th = await page.evaluate(() => {
    const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    window._lamina.setTheme('light');
    const lightBg = bg(), lightAttr = document.documentElement.dataset.theme, lightCanvases = document.querySelectorAll('#grid canvas').length;
    window._lamina.setTheme('dark');
    const darkBg = bg(), darkAttr = document.documentElement.dataset.theme;
    window._lamina.setTheme('auto');
    return { lightBg, lightAttr, darkBg, darkAttr, lightCanvases };
  });
  (th.lightAttr === 'light' && th.darkAttr === 'dark' && th.lightBg && th.lightBg !== th.darkBg && th.lightCanvases === 3)
    ? ok(`theme: light/dark/auto flips chrome (--bg ${th.lightBg} ≠ ${th.darkBg}) + re-skins the grid`)
    : fail(`theme failed: ${JSON.stringify(th)}`);

  // ── cell color-scale (heatmap): toggle on a numeric column → cells get a viridis
  //    bg + readable fg, low vs high distinct ──
  const heat = await page.evaluate(async () => {
    window._lamina.open('heat.csv', new TextEncoder().encode('id,grade\n' + Array.from({ length: 50 }, (_, i) => `${i},${(i * 0.2).toFixed(1)}`).join('\n') + '\n'));
    await new Promise((r) => setTimeout(r, 120));         // gutter (min/max) ready
    window._lamina.toggleColorScale(1);                   // grade column
    const prov = window._lamina.grid.provider;
    await window._laminaVS.ensureRow(0); await window._laminaVS.ensureRow(49);
    const lo = prov.cellAt(0, 1), hi = prov.cellAt(49, 1);   // low grade vs high grade
    await window._laminaVS.ensureRow(25);
    const linMid = prov.cellAt(25, 1).style.bg;           // mid cell, linear viridis
    await window._lamina.setColScaleOpt(1, { scale: 'log' });
    const logMid = prov.cellAt(25, 1).style.bg;           // log remaps the mid
    await window._lamina.setColScaleOpt(1, { scale: 'linear', palette: 'magma' });
    const magMid = prov.cellAt(25, 1).style.bg;           // different palette
    window._lamina.toggleColorScale(1);
    const off = prov.cellAt(49, 1);
    return { loBg: lo && lo.style && lo.style.bg, hiBg: hi && hi.style && hi.style.bg, hasFg: !!(hi && hi.style && hi.style.fg), offBg: off && off.style && off.style.bg, linMid, logMid, magMid };
  });
  (heat.loBg && heat.hiBg && heat.loBg !== heat.hiBg && heat.hasFg && !heat.offBg
    && heat.logMid !== heat.linMid && heat.magMid !== heat.linMid)
    ? ok(`color scale: viridis low ${heat.loBg} ≠ high ${heat.hiBg}; log + palette remap the mid; readable fg; toggles off`)
    : fail(`color scale failed: ${JSON.stringify(heat)}`);

  // ── lens: build a view config, re-open the file fresh, apply the lens back ──
  const lensRT = await page.evaluate(async (text) => {
    const L = window._lamina;
    L.open('block.csv', new TextEncoder().encode(text));        // a fresh view
    await new Promise((r) => setTimeout(r, 40));
    await L.addCalc('gx', 'grade * 2');
    document.getElementById('filter').value = 'grade > 10 and lito = "ox"';   // the box is the expr's source of truth
    await L.applyFilter('grade > 10 and lito = "ox"');
    L.toggleSort(1);                                            // grade ↑
    await new Promise((r) => setTimeout(r, 40));
    const lens = L.buildLens();
    L.open('block.csv', new TextEncoder().encode(text));        // re-open fresh → resets calc/filter/sort
    await new Promise((r) => setTimeout(r, 40));
    const beforeRows = window._laminaVS.rowCount();
    await L.applyLens(lens);                                    // …then re-apply the lens
    await new Promise((r) => setTimeout(r, 120));
    const c = L.current;
    return {
      kind: lens.kind, filter: lens.filter, lensHasCalc: !!(lens.calcs && lens.calcs.length), lensSort: lens.sort && lens.sort[0] && lens.sort[0].col,
      beforeRows, appliedFilter: document.getElementById('filter').value,
      appliedCalc: !!(c.calcs && c.calcs.find((x) => x.name === 'gx')), appliedSort: !!(c.sort && c.sort.length),
      afterRows: window._laminaVS.rowCount(),
    };
  }, csv);
  (lensRT.kind === 'lamina-lens' && lensRT.lensHasCalc && lensRT.lensSort === 'grade'
    && lensRT.appliedFilter === lensRT.filter && lensRT.appliedCalc && lensRT.appliedSort
    && lensRT.beforeRows === N && lensRT.afterRows < N)
    ? ok(`lens: round-trips filter + sort + calc by name (${lensRT.afterRows} of ${N} rows after apply)`)
    : fail(`lens round-trip failed: ${JSON.stringify(lensRT)}`);

  // ── record card: a row → name:value fields, follows selection, click-to-filter ──
  const rec = await page.evaluate(async (text) => {
    const L = window._lamina;
    L.open('block.csv', new TextEncoder().encode(text));  // fresh (clear prior filter/calc/sort)
    await new Promise((r) => setTimeout(r, 40));
    L.toggleRecordPanel(true);
    await L.renderRecordCard(3);                          // inspect row #3 (0-based)
    await new Promise((r) => setTimeout(r, 40));
    const fields = [...document.querySelectorAll('#recordPanel .rp-field')].map((f) => ({
      k: f.querySelector('.rp-k') && f.querySelector('.rp-k').textContent,
      v: f.querySelector('.rp-v') && f.querySelector('.rp-v').textContent,
    })).filter((x) => x.k);
    const rownum = document.getElementById('rpRow').textContent;
    const grade = fields.find((x) => x.k === 'grade');
    L.toggleRecordPanel(false);
    return { count: fields.length, cols: L.current.schema.length, rownum, grade };
  }, csv);
  (rec.count === rec.cols && /row 4 of/.test(rec.rownum) && rec.grade && rec.grade.v === '0.03')
    ? ok(`record card: ${rec.count} fields for ${rec.rownum} (grade=${rec.grade.v})`)
    : fail(`record card failed: ${JSON.stringify(rec)}`);

  // ── selection stats: select a numeric range → count · sum · mean · min · max ──
  const ss = await page.evaluate(async (text) => {
    const L = window._lamina;
    L.open('block.csv', new TextEncoder().encode(text));   // fresh: display col 1 = grade
    await new Promise((r) => setTimeout(r, 40));
    await L.updateSelStats({ r0: 0, c0: 1, r1: 9, c1: 1 }); // grade, rows 0..9 (0.00..0.09)
    return document.getElementById('selStats').textContent;
  }, csv);
  (/sel 10\b/.test(ss) && /Σ 0\.45/.test(ss) && /x̄ 0\.045/.test(ss) && /max 0\.09/.test(ss))
    ? ok(`selection stats: ${ss}`)
    : fail(`selection stats failed: ${JSON.stringify(ss)}`);

  // ── column pin/freeze: pins to the front, drives loom's frozen band, round-trips ──
  const pinT = await page.evaluate(async () => {
    const L = window._lamina; L.showAllColumns(); L.current.pinned = null; L.current.colOrder = null;
    await new Promise((r) => setTimeout(r, 20));
    L.togglePin(2);                                          // pin underlying col #2
    await new Promise((r) => setTimeout(r, 40));
    const c = L.current;
    const frontIsPinned = c._vis[0] === 2 && c._pinnedCount === 1;
    const loomPinned = L.grid.getPinnedCols();
    const lens = L.buildLens();
    c.pinned = null; await new Promise((r) => setTimeout(r, 10));
    await L.applyLens(lens); await new Promise((r) => setTimeout(r, 60));
    const restored = !!(L.current.pinned && L.current.pinned.has(2)) && L.current._vis[0] === 2;
    return { frontIsPinned, loomPinned, lensPinned: lens.pinned, restored };
  });
  (pinT.frontIsPinned && pinT.loomPinned === 1 && Array.isArray(pinT.lensPinned) && pinT.restored)
    ? ok(`pin/freeze: hoists to front + drives loom's frozen band + round-trips (pinned ${JSON.stringify(pinT.lensPinned)})`)
    : fail(`pin/freeze failed: ${JSON.stringify(pinT)}`);

  // ── column-profile popup: the stats popup shows a histogram + a log toggle ──
  const prof = await page.evaluate(async () => {
    await window._lamina.showColumnStats(1);              // grade (numeric) on the open file
    const canvas = document.getElementById('profHist'), logBtn = document.getElementById('profLog');
    const drew = !!(canvas && canvas.width > 0);          // a real (DPR-sized) canvas was drawn onto
    const hasMedian = document.getElementById('helpBody').textContent.includes('median');
    document.getElementById('help').classList.remove('show');
    return { hasCanvas: !!canvas, drew, hasLog: !!logBtn, hasMedian };
  });
  (prof.hasCanvas && prof.drew && prof.hasLog && prof.hasMedian)
    ? ok('column-profile: stats popup renders a histogram canvas + log toggle + quantiles')
    : fail(`column-profile failed: ${JSON.stringify(prof)}`);

  // ── copy-stats + resident indicator ──
  const extras = await page.evaluate(async () => {
    const L = window._lamina;
    await L.showColumnStats(1);                           // grade
    const hasCopy = !!document.getElementById('statsCopy');
    const tsv = L.statsToTSV({ kind: 'number', count: 10, n: 10, nulls: 0, min: 0, max: 9, mean: 4.5, std: 3, sum: 45, quantiles: { p5: 0, p25: 2, p50: 4.5, p75: 7, p95: 9 } }, 'grade');
    document.getElementById('help').classList.remove('show');
    const residMem = L.residentEstimate(L.current);      // memory source → null (no badge)
    const residSynth = L.residentEstimate({ totalBytes: 14e9, bytes: null, source: { blockOffsets: { length: 850000 }, blockSize: 4096, rowCount: 3.5e9 } });
    return { hasCopy, tsvOk: /^column\tgrade\n/.test(tsv) && tsv.includes('median\t4.5'), residMem, residSynthMB: residSynth ? Math.round(residSynth / 1e6) : null };
  });
  (extras.hasCopy && extras.tsvOk && extras.residMem === null && extras.residSynthMB < 200)
    ? ok(`copy-stats button + TSV; resident est: memory→null, 14 GB file → ~${extras.residSynthMB} MB resident`)
    : fail(`extras failed: ${JSON.stringify(extras)}`);

  // ── type override round-trips through a lens (treat-as) ──
  const tov = await page.evaluate(async (text) => {
    const L = window._lamina;
    L.open('block.csv', new TextEncoder().encode(text));
    await new Promise((r) => setTimeout(r, 40));
    L.setColType(1, 'string');                            // treat grade as text
    await new Promise((r) => setTimeout(r, 20));
    const lens = L.buildLens();
    L.open('block.csv', new TextEncoder().encode(text));  // fresh (grade back to number)
    await new Promise((r) => setTimeout(r, 40));
    const before = L.current.schema[1].type;
    await L.applyLens(lens);
    await new Promise((r) => setTimeout(r, 60));
    return { lensType: lens.columns && lens.columns.grade && lens.columns.grade.type, before, after: L.current.schema[1].type };
  }, csv);
  (tov.lensType === 'string' && tov.before === 'number' && tov.after === 'string')
    ? ok(`type override: treat-as round-trips through a lens (grade ${tov.before}→${tov.after})`)
    : fail(`type override failed: ${JSON.stringify(tov)}`);

  // ── go-to-column: scroll the grid to a column (panel name click) ──
  const gtc = await page.evaluate(async (text) => {
    const L = window._lamina;
    L.open('block.csv', new TextEncoder().encode(text));
    await new Promise((r) => setTimeout(r, 40));
    L.scrollToColumn(2);                                  // lito (underlying 2) → display col 2 (no reorder/hidden)
    await new Promise((r) => setTimeout(r, 20));
    const sel = L.grid.getSelection();
    return { c0: sel && sel.c0, uc: L.current._vis[sel ? sel.c0 : 0] };
  }, csv);
  (gtc.uc === 2) ? ok(`go-to-column: selects the target column (display col ${gtc.c0} → underlying ${gtc.uc})`)
    : fail(`go-to-column failed: ${JSON.stringify(gtc)}`);

  // ── in-grid find (Ctrl+F): locate-and-jump, substring + regex + whole-cell + count ──
  const fnd = await page.evaluate(async (text) => {
    const L = window._lamina;
    L.open('find.csv', new TextEncoder().encode(text));   // id,grade,lito (5000 rows)
    await new Promise((r) => setTimeout(r, 40));
    document.getElementById('findInput').value = 'sulf';   // lito ∈ ox/sulf/trans; sulf at i%3===1 → rows 1,4,7,…
    L.openFind();
    await new Promise((r) => setTimeout(r, 20));
    await L.findNext(1);                                    // from -1 → first match at display row 1
    const after1 = L.grid.getSelection();
    await L.findNext(1);                                    // next → row 4
    const after2 = L.grid.getSelection();
    await L.findCountAll();                                 // total sulf rows ≈ 1666
    const countMsg = document.getElementById('findStatus').textContent;
    L.closeFind();
    return { r1: after1 && after1.r0, r2: after2 && after2.r0, countMsg };
  }, csv);
  (fnd.r1 === 1 && fnd.r2 === 4 && /1,66\d rows? match/.test(fnd.countMsg))
    ? ok(`in-grid find: jumps to matches (rows ${fnd.r1}, ${fnd.r2}) + counts (${fnd.countMsg})`)
    : fail(`find failed: ${JSON.stringify(fnd)}`);

  // ── encoding: Latin-1 file → mojibake hint on UTF-8, decodes right + hint clears ──
  const encT = await page.evaluate(async (text) => {
    const L = window._lamina;
    const asc = (s) => [...s].map((c) => c.charCodeAt(0));
    const b = asc('id,note\n');                               // 0xE9 = é in Latin-1, invalid as a lone UTF-8 byte
    for (let i = 0; i < 30; i++) b.push(...asc(i + ',caf'), 0xE9, 0x0A);   // numeric id → header detects; rows to spare
    L.open('latin.csv', new Uint8Array(b));                   // default UTF-8 → mojibake
    await new Promise((r) => setTimeout(r, 50));
    const hintShown = getComputedStyle(document.getElementById('encHint')).display !== 'none';
    const utf8note = (await window._laminaVS.ensureRow(0))[1];
    L.reopen({ encoding: 'iso-8859-1' });                     // re-decode as Latin-1
    await new Promise((r) => setTimeout(r, 60));
    const hintAfter = getComputedStyle(document.getElementById('encHint')).display !== 'none';
    const latinNote = (await window._laminaVS.ensureRow(0))[1];
    L.open('block.csv', new TextEncoder().encode(text));      // restore (don't pollute downstream tests)
    await new Promise((r) => setTimeout(r, 30));
    return { hintShown, hintAfter, utf8note, latinNote };
  }, csv);
  (encT.hintShown && !encT.hintAfter && encT.utf8note.includes('�') && encT.latinNote === 'café')
    ? ok(`encoding: UTF-8 mojibake hint → Latin-1 decodes "café", hint clears`)
    : fail(`encoding failed: ${JSON.stringify(encT)}`);

  // ── recents: local, remembers a file, shows a chip, clears (FSAA reopen needs a real handle) ──
  const rc = await page.evaluate(async () => {
    const L = window._lamina;
    await L.clearRecents();
    await L.addRecent({ name: 'assays_q2.csv', size: 12345, lastModified: 0 }, null);
    await new Promise((r) => setTimeout(r, 30));
    const inList = L.recents.some((e) => e.name === 'assays_q2.csv');
    const chip = document.querySelector('#emptyRecents .er-chip');
    const chipText = chip && chip.textContent;
    await L.clearRecents();
    await new Promise((r) => setTimeout(r, 20));
    return { inList, chipText, cleared: L.recents.length === 0, chipGone: !document.querySelector('#emptyRecents .er-chip') };
  });
  (rc.inList && rc.chipText === 'assays_q2.csv' && rc.cleared && rc.chipGone)
    ? ok(`recents: remembers a file → chip, clears (${rc.chipText})`)
    : fail(`recents failed: ${JSON.stringify(rc)}`);

  // ── security wing link: banner link is clickable + footer build-stamp links out ──
  const sec = await page.evaluate(() => {
    const a = document.querySelector('#empty .empty-sec a'), b = document.getElementById('build');
    return {
      bannerHref: a && a.href, bannerClickable: a && getComputedStyle(a).pointerEvents === 'auto',
      footerTag: b && b.tagName, footerHref: b && b.getAttribute('href'),
    };
  });
  (/gentropic\.org\/security$/.test(sec.bannerHref || '') && sec.bannerClickable
    && sec.footerTag === 'A' && /gentropic\.org\/security$/.test(sec.footerHref || ''))
    ? ok('security wing: empty-state link clickable + footer build-stamp links to /security')
    : fail(`security link failed: ${JSON.stringify(sec)}`);

  // ── columns panel: lists columns, toggles visibility, searches, bulk hide ──
  const cp = await page.evaluate(async () => {
    const L = window._lamina;
    L.showAllColumns();
    L.toggleColPanel(true);
    await new Promise((r) => setTimeout(r, 30));
    const rows = document.querySelectorAll('#cpList .cp-row').length;
    const total = L.current.schema.length;
    const cb = document.querySelector('#cpList .cp-row input');      // toggle the first column off
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 40));
    const hiddenAfter = L.current.hidden.size;
    const search = document.getElementById('cpSearch');             // search filters the list
    search.value = 'zzz_nomatch'; search.dispatchEvent(new Event('input'));
    const rowsFiltered = document.querySelectorAll('#cpList .cp-row').length;
    search.value = ''; search.dispatchEvent(new Event('input'));
    document.querySelector('#colPanel .cp-bulk button[data-cp="none"]').click();   // bulk hide all
    await new Promise((r) => setTimeout(r, 40));
    const allHidden = L.current.hidden.size === total;
    L.showAllColumns(); L.toggleColPanel(false);
    return { rows, total, hiddenAfter, rowsFiltered, allHidden };
  });
  (cp.rows === cp.total && cp.hiddenAfter === 1 && cp.rowsFiltered === 0 && cp.allHidden)
    ? ok(`columns panel: lists ${cp.rows} cols · toggle + search + bulk-hide work`)
    : fail(`columns panel failed: ${JSON.stringify(cp)}`);

  // ── column reorder: moves display order + round-trips through a lens ──
  const ro = await page.evaluate(async () => {
    const L = window._lamina; L.current.pinned = null; L.current.colOrder = null; L.showAllColumns();   // reset, then rerender
    await new Promise((r) => setTimeout(r, 20));
    const before = L.current._vis.map((uc) => L.current.schema[uc].name);
    L.reorderCol(2, 0);                                   // move col #2 to the front
    await new Promise((r) => setTimeout(r, 30));
    const after = L.current._vis.map((uc) => L.current.schema[uc].name);
    const lens = L.buildLens();                           // order captured by name?
    L.current.colOrder = null; await new Promise((r) => setTimeout(r, 10));   // reset
    await L.applyLens(lens); await new Promise((r) => setTimeout(r, 60));     // re-apply
    const restored = L.current._vis.map((uc) => L.current.schema[uc].name);
    return { before, after, lensOrder: lens.order, restored };
  });
  (ro.after[0] === ro.before[2] && JSON.stringify(ro.after) !== JSON.stringify(ro.before)
    && Array.isArray(ro.lensOrder) && JSON.stringify(ro.restored) === JSON.stringify(ro.after))
    ? ok(`column reorder: moves display order + round-trips through a lens (${ro.after.join(',')})`)
    : fail(`column reorder failed: ${JSON.stringify(ro)}`);

  // ── non-numeric examples in stats (the diagnostic) + gutter spread sampling ──
  const diag = await page.evaluate(async (text) => {
    const L = window._lamina;
    // a mostly-numeric column with a couple non-numeric values → detected numeric, bad surfaced
    let csv = 'id,grade\n';
    for (let i = 0; i < 60; i++) csv += `${i},${(i * 0.1).toFixed(2)}\n`;
    csv += '60,BDL\n61,1.2.3\n';                          // BDL (below detection) + a double-dot
    L.open('mix.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 40));
    await L.showColumnStats(1);                           // grade
    await new Promise((r) => setTimeout(r, 30));
    const body = document.getElementById('helpBody').textContent;
    document.getElementById('help').classList.remove('show');
    // gutter spread: small file → null (limit); synthetic large → a spread ascending list
    const small = L.gutterSampleRows({ rowCount: 5000 }, 1);
    const big = L.gutterSampleRows({ rowCount: 2_000_000 }, 0);
    const ascending = big && big.every((v, i) => i === 0 || v >= big[i - 1]);
    const spread = big && (big[big.length - 1] - big[0]) > 1_000_000;   // covers the whole file, not the first rows
    return { hasEg: /e\.g\./.test(body) && body.includes('BDL'), small, bigLen: big && big.length, ascending, spread };
  }, csv);
  (diag.hasEg && diag.small === null && diag.ascending && diag.spread)
    ? ok(`non-numeric examples shown (BDL…) + gutter sweep spreads across the file (${diag.bigLen} rows sampled)`)
    : fail(`diag failed: ${JSON.stringify(diag)}`);

  // ── stats: CV / skewness / zeros + a cancellable scan (pre-aborted signal throws) ──
  const moreStats = await page.evaluate(async () => {
    const L = window._lamina;
    L.open('s.csv', new TextEncoder().encode('g\n0\n0\n1\n2\n9\n'));   // 2 zeros, right-skewed
    await new Promise((r) => setTimeout(r, 40));
    const S = L.scanColumnStats, src = L.current.source, ds = L.current.dataStart;
    const st = await S(src, { col: 0, dataStart: ds });
    let aborted = false;
    try { const ac = new AbortController(); ac.abort(); await S(src, { col: 0, dataStart: ds, signal: ac.signal }); }
    catch (e) { aborted = e && e.name === 'AbortError'; }
    return { zeros: st.zeros, cv: st.cv, skew: st.skew, n: st.n, aborted };
  });
  (moreStats.zeros === 2 && moreStats.cv > 0 && Number.isFinite(moreStats.skew) && moreStats.skew > 0 && moreStats.aborted)
    ? ok(`stats: zeros=${moreStats.zeros} · CV=${moreStats.cv.toFixed(2)} · skew=${moreStats.skew.toFixed(2)} · pre-aborted scan throws AbortError`)
    : fail(`stats extras/cancel failed: ${JSON.stringify(moreStats)}`);

  // ── exclude-zeros / exclude-negatives re-scan (grade-data stats) ──
  const exTest = await page.evaluate(async () => {
    const L = window._lamina;
    // grades: zeros (waste), a negative sentinel, and real grades
    const csv = 'id,g\n1,0\n2,0\n3,-99\n4,1.0\n5,3.0\n6,5.0\n';
    L.open('grades.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 40));
    const S = L.scanColumnStats;
    const src = L.current.source, ds = L.current.dataStart;
    const all = await S(src, { col: 1, dataStart: ds });
    const noZero = await S(src, { col: 1, dataStart: ds, excludeZero: true });
    const noNeg = await S(src, { col: 1, dataStart: ds, excludeNeg: true });
    const pos = await S(src, { col: 1, dataStart: ds, excludeZero: true, excludeNeg: true });
    return {
      all: { n: all.n, min: all.min, excluded: all.excluded || 0 },
      noZero: { n: noZero.n, excluded: noZero.excluded },     // drops 2 zeros → n 4
      noNeg: { min: noNeg.min, excluded: noNeg.excluded },    // drops -99 → min 0
      pos: { n: pos.n, min: pos.min, excluded: pos.excluded },// only 1,3,5 → n 3, min 1
    };
  });
  (exTest.all.n === 6 && exTest.all.min === -99 && exTest.all.excluded === 0
    && exTest.noZero.n === 4 && exTest.noZero.excluded === 2
    && exTest.noNeg.min === 0 && exTest.noNeg.excluded === 1
    && exTest.pos.n === 3 && exTest.pos.min === 1 && exTest.pos.excluded === 3)
    ? ok('stats exclude zeros/negatives re-scan (n + min + excluded count track)')
    : fail(`exclude test failed: ${JSON.stringify(exTest)}`);

  // ── exclude toggles STAGE — a tick doesn't re-scan; apply does ──
  const stageTest = await page.evaluate(async () => {
    const L = window._lamina;
    let csv = 'id,g\n';
    for (let i = 0; i < 20; i++) csv += `${i},${i % 3 === 0 ? 0 : i}\n`;   // ~7 zeros
    L.open('stage.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 60));
    await L.showColumnStats(1);
    await new Promise((r) => setTimeout(r, 40));
    const oz = document.getElementById('optNoZero'), ap = document.getElementById('optApply');
    const applyDisabledBefore = ap.disabled;
    oz.checked = true; oz.dispatchEvent(new Event('change'));
    const applyEnabledAfterTick = !ap.disabled;
    const noScanOnTick = !/excluded/.test(document.getElementById('helpBody').textContent);   // staged, not applied
    ap.click();
    await new Promise((r) => setTimeout(r, 60));
    const appliedAfterClick = /excluded/.test(document.getElementById('helpBody').textContent);
    document.getElementById('help').classList.remove('show');
    return { applyDisabledBefore, applyEnabledAfterTick, noScanOnTick, appliedAfterClick };
  });
  (stageTest.applyDisabledBefore && stageTest.applyEnabledAfterTick && stageTest.noScanOnTick && stageTest.appliedAfterClick)
    ? ok('exclude toggles stage until apply (no scan on tick)')
    : fail(`stage test failed: ${JSON.stringify(stageTest)}`);

  // ── log-normal gutter detection + per-column toggle ──
  const logTest = await page.evaluate(async () => {
    const L = window._lamina;
    // grade: ~60% ZEROS (waste blocks) + a skewed positive tail (uniform-in-log →
    // symmetric in log) — the real block-model shape; must still be log-detected.
    let csv = 'id,grade,flat\n';
    for (let i = 0; i < 3000; i++) { const v = (i % 5 < 3) ? 0 : Math.exp(((i * 7) % 100) / 18); csv += `${i},${v.toFixed(4)},${(i % 50)}\n`; }
    L.open('logn.csv', new TextEncoder().encode(csv));
    for (let t = 0; t < 60 && !(L.current && L.current.gutter && L.current.gutter[1]); t++) await new Promise((r) => setTimeout(r, 50));
    const g = L.current.gutter && L.current.gutter[1];          // grade — skewed → log
    const flat = L.current.gutter && L.current.gutter[2];        // a flat 0..49 column → NOT log
    const detected = !!(g && g.log && g.logBins && g.logSuggested);
    L.setGutterLog(1, false); const afterOff = L.current.gutter[1].log;
    L.setGutterLog(1, true); const afterOn = L.current.gutter[1].log;
    return { detected, flatNotLog: !(flat && flat.log), afterOff, afterOn };
  });
  (logTest.detected && logTest.flatNotLog && logTest.afterOff === false && logTest.afterOn === true)
    ? ok('log-normal gutter auto-detected (flat column stays linear) + per-column toggle')
    : fail(`log gutter test failed: ${JSON.stringify(logTest)}`);

  // ── horizontal scroll survives a filter (grid rebuild) ──
  const scrollTest = await page.evaluate(async () => {
    const L = window._lamina;
    let header = 'r'; for (let j = 1; j < 30; j++) header += `,c${j}`;
    let csv = header + '\n';
    for (let i = 0; i < 500; i++) { let row = `${i}`; for (let j = 1; j < 30; j++) row += `,${i * j}`; csv += row + '\n'; }
    L.open('wide.csv', new TextEncoder().encode(csv));
    for (let t = 0; t < 40 && !L.grid; t++) await new Promise((r) => setTimeout(r, 25));
    L.grid.setScroll({ left: 600 });
    const before = L.grid.getScroll().left;
    await L.applyFilter('r > 100');
    await new Promise((r) => setTimeout(r, 60));
    const after = L.grid.getScroll().left;
    await L.applyFilter('');
    return { before, after };
  });
  (scrollTest.before > 100 && Math.abs(scrollTest.after - scrollTest.before) < 2)
    ? ok(`horizontal scroll preserved across filter (${scrollTest.after}px)`)
    : fail(`scroll restore failed: ${JSON.stringify(scrollTest)}`);

  // ── color scale: picking a palette while off enables it (no toggle-then-reopen) ──
  const csTest = await page.evaluate(async () => {
    const L = window._lamina;
    L.open('cs.csv', new TextEncoder().encode('a\n1\n2\n3\n4\n'));
    await new Promise((r) => setTimeout(r, 60));
    const offBefore = !(L.current.colScale && L.current.colScale.get(0));
    await L.setColScaleOpt(0, { palette: 'turbo' });
    const cs = L.current.colScale && L.current.colScale.get(0);
    return { offBefore, on: !!cs, palette: cs && cs.palette };
  });
  (csTest.offBefore && csTest.on && csTest.palette === 'turbo')
    ? ok('color scale: picking a palette while off enables it (turbo)')
    : fail(`color scale opt failed: ${JSON.stringify(csTest)}`);

  // ── context submenus flip/clamp to stay in the viewport near the right edge ──
  const submenuFit = await page.evaluate(async () => {
    const L = window._lamina;
    let header = 'r'; for (let j = 1; j < 30; j++) header += `,c${j}`;
    let csv = header + '\n3'; for (let j = 1; j < 30; j++) csv += `,${j}`; csv += '\n6'; for (let j = 1; j < 30; j++) csv += `,${j * 2}`; csv += '\n';
    L.open('wide2.csv', new TextEncoder().encode(csv));
    for (let t = 0; t < 40 && !L.grid; t++) await new Promise((r) => setTimeout(r, 25));
    const hdr = [...document.querySelectorAll('#grid canvas')].find((cv) => cv.style.zIndex === '2');
    const cy = hdr.getBoundingClientRect().top + 6, cx = window.innerWidth - 24;   // right-click a header near the right edge
    hdr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: cx, clientY: cy }));
    await new Promise((r) => setTimeout(r, 30));
    const fits = (el) => el && el.getBoundingClientRect().right <= window.innerWidth + 1 && el.getBoundingClientRect().left >= -1;
    const root = document.querySelector('.ctxmenu');
    const rootOk = fits(root);
    const hover = (menu, re) => { const it = menu && [...menu.querySelectorAll('.item')].find((e) => re.test(e.textContent)); if (it) it.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); return it; };
    const hasCs = !!hover(root, /Color scale/);
    await new Promise((r) => setTimeout(r, 30));
    const sub = [...document.querySelectorAll('.ctxmenu')][1];
    const subOk = fits(sub);
    hover(sub, /Palette/);
    await new Promise((r) => setTimeout(r, 30));
    const palOk = fits([...document.querySelectorAll('.ctxmenu')][2]);
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return { rootOk, hasCs, subOk, palOk };
  });
  (submenuFit.rootOk && submenuFit.hasCs && submenuFit.subOk && submenuFit.palOk)
    ? ok('context submenu + sub-submenu flip to stay in the viewport near the right edge')
    : fail(`submenu fit failed: ${JSON.stringify(submenuFit)}`);

  // ── dock panels: mutually exclusive, never extend the page horizontally ──
  const panels = await page.evaluate(async () => {
    const L = window._lamina;
    let h = 'r'; for (let j = 1; j < 40; j++) h += `,c${j}`;
    let csv = h + '\n'; for (let i = 0; i < 50; i++) { let row = `${i}`; for (let j = 1; j < 40; j++) row += `,${i * j}`; csv += row + '\n'; }
    L.open('panels.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 120));
    const vis = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return b.right > 2 && b.left < window.innerWidth - 2; };
    const overflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;
    const snap = () => ({ col: vis('colPanel'), rec: vis('recordPanel'), of: overflow() });
    const seq = [];
    L.toggleColPanel(); await new Promise((r) => setTimeout(r, 200)); seq.push(snap());          // col only
    L.toggleRecordPanel(); await new Promise((r) => setTimeout(r, 200)); seq.push(snap());        // rec replaces col
    L.toggleColPanel(); await new Promise((r) => setTimeout(r, 200)); seq.push(snap());           // col replaces rec
    L.toggleColPanel(); await new Promise((r) => setTimeout(r, 200)); seq.push(snap());           // both closed
    return seq;
  });
  const exclusive = panels.every((s) => !(s.col && s.rec) && !s.of);
  const expected = panels[0].col && !panels[0].rec && panels[1].rec && !panels[1].col && panels[2].col && !panels[2].rec && !panels[3].col && !panels[3].rec;
  (exclusive && expected)
    ? ok('dock panels are mutually exclusive + never cause horizontal overflow')
    : fail(`panel exclusivity failed: ${JSON.stringify(panels)}`);

  // ── axis-locked scrolling: a 2D wheel (deltaX+deltaY) moves only the dominant axis ──
  const axis = await page.evaluate(async () => {
    const L = window._lamina;
    let h = 'r'; for (let j = 1; j < 60; j++) h += `,c${j}`;
    let csv = h + '\n'; for (let i = 0; i < 400; i++) { let row = `${i}`; for (let j = 1; j < 60; j++) row += `,${i * j}`; csv += row + '\n'; }
    L.open('scroll.csv', new TextEncoder().encode(csv));
    for (let t = 0; t < 40 && !L.grid; t++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 120));
    const sc = [...document.querySelectorAll('#grid *')].find((e) => e.scrollHeight > e.clientHeight + 10 && e.scrollWidth > e.clientWidth + 10);
    if (!sc) return { err: 'no scroll viewport' };
    const fire = (dx, dy) => sc.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
    sc.scrollTop = 0; sc.scrollLeft = 0;
    fire(25, 140);                                          // mostly-vertical with sideways jitter → only down
    const afterY = { top: sc.scrollTop, left: sc.scrollLeft };
    await new Promise((r) => setTimeout(r, 220));           // let the per-gesture lock expire
    fire(140, 25);                                          // mostly-horizontal → only across
    const afterX = { top: sc.scrollTop, left: sc.scrollLeft };
    return { afterY, afterX };
  });
  (axis.afterY && axis.afterY.top > 0 && axis.afterY.left === 0 && axis.afterX.left > 0 && axis.afterX.top === axis.afterY.top)
    ? ok(`axis-locked scroll: vertical gesture drops x-jitter (top ${axis.afterY.top}), then horizontal gesture moves only x (left ${axis.afterX.left})`)
    : fail(`axis-lock failed: ${JSON.stringify(axis)}`);

  // ── record panel: nav + pin-to-compare (side-by-side diff) ──
  const recPanel = await page.evaluate(async () => {
    const L = window._lamina;
    L.open('rec.csv', new TextEncoder().encode('id,g\n1,10\n2,20\n3,30\n'));
    await new Promise((r) => setTimeout(r, 60));
    L.toggleRecordPanel(true);
    await new Promise((r) => setTimeout(r, 40));
    L.renderRecordCard(0); await new Promise((r) => setTimeout(r, 30));
    const row1 = document.getElementById('rpRow').textContent;
    document.getElementById('rpPin').click(); await new Promise((r) => setTimeout(r, 40));   // pin row 1
    const pinned = document.getElementById('rpPin').classList.contains('on');
    document.getElementById('rpNext').click(); await new Promise((r) => setTimeout(r, 40));   // → row 2, compare
    const cmpRows = document.querySelectorAll('#rpList .rp-field.cmp').length;
    const diffRows = document.querySelectorAll('#rpList .rp-field.diff').length;     // id & g both differ
    const header = document.getElementById('rpRow').textContent;                     // "row 1 ⇄ 2"
    document.getElementById('rpPin').click(); await new Promise((r) => setTimeout(r, 40));    // unpin
    const backToSingle = document.querySelectorAll('#rpList .rp-field.cmp').length === 0;
    L.toggleRecordPanel(false);
    return { row1, pinned, cmpRows, diffRows, header, backToSingle };
  });
  (/row 1 of 3/.test(recPanel.row1) && recPanel.pinned && recPanel.cmpRows === 2 && recPanel.diffRows === 2 && /⇄/.test(recPanel.header) && recPanel.backToSingle)
    ? ok(`record panel: pin row 1, next→2 shows side-by-side diff (${recPanel.diffRows} changed), unpin restores`)
    : fail(`record panel failed: ${JSON.stringify(recPanel)}`);

  // ── dock panel resize: dragging the grip changes width + the grid inset, persisted ──
  await page.setViewportSize({ width: 1280, height: 800 });   // an earlier test shrank to 360; need room to widen
  const resize = await page.evaluate(async () => {
    const L = window._lamina;
    L.open('rs.csv', new TextEncoder().encode('a,b\n1,2\n3,4\n'));
    await new Promise((r) => setTimeout(r, 50));
    L.toggleColPanel(true); await new Promise((r) => setTimeout(r, 40));
    const grip = document.getElementById('cpGrip'), panel = document.getElementById('colPanel');
    const w0 = panel.getBoundingClientRect().width;
    const targetX = window.innerWidth - 420;             // drag the left edge to make it ~420px wide
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: window.innerWidth - w0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: targetX }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const w1 = panel.getBoundingClientRect().width;
    const cp = getComputedStyle(document.documentElement).getPropertyValue('--cp').trim();
    const persisted = localStorage.getItem('lamina.colPanelW');
    L.toggleColPanel(false);
    return { w0: Math.round(w0), w1: Math.round(w1), cp, persisted };
  });
  (resize.w1 > resize.w0 + 50 && resize.cp === resize.w1 + 'px' && Number(resize.persisted) === resize.w1)
    ? ok(`panel resize: drag widened ${resize.w0}→${resize.w1}px, grid inset + width persisted`)
    : fail(`panel resize failed: ${JSON.stringify(resize)}`);

  // ── precompute stats (BMA-style 2-pass) fills the cache; exact-on-demand upgrade ──
  const prec = await page.evaluate(async () => {
    const L = window._lamina;
    const vals = [0, 0, 1, 2, 2, 3, 5, 8, 13, 21];
    let csv = 'id,g,lito\n';
    for (let i = 0; i < vals.length; i++) csv += `${i},${vals[i]},${['OX', 'SU', 'OX'][i % 3]}\n`;
    L.open('pc.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 60));
    const exact = await L.scanColumnStats(L.current.source, { col: 1, dataStart: L.current.dataStart });   // baseline
    await L.precomputeStats();
    const cache = L.current._statsCache, g = cache && cache.get('1|0|0'), lito = cache && cache.get('2|0|0');
    const out = {
      cached: !!g, precomputed: g && g.precomputed === true, approx: g && g.quantilesApprox === true,
      meanMatch: g && Math.abs(g.mean - exact.mean) < 1e-9, skewMatch: g && Math.abs((g.skew || 0) - (exact.skew || 0)) < 1e-9,
      zerosMatch: g && g.zeros === exact.zeros, hist: !!(g && g.histogram),
      medianClose: g && Math.abs(g.quantiles.p50 - exact.quantiles.p50) < 3,
      litoKind: lito && lito.kind, litoTop: lito && lito.top && lito.top.length,
    };
    // open the precomputed numeric column → exact button present → upgrade to exact
    await L.showColumnStats(1); await new Promise((r) => setTimeout(r, 40));
    out.exactBtn = !!document.getElementById('statsExact');
    if (out.exactBtn) document.getElementById('statsExact').click();
    await new Promise((r) => setTimeout(r, 100));
    const up = L.current._statsCache.get('1|0|0');
    out.upgraded = up && !up.precomputed && !up.quantilesApprox;
    document.getElementById('help').classList.remove('show');
    return out;
  });
  (prec.cached && prec.precomputed && prec.approx && prec.meanMatch && prec.skewMatch && prec.zerosMatch && prec.hist && prec.medianClose && prec.litoKind === 'string' && prec.litoTop >= 2 && prec.exactBtn && prec.upgraded)
    ? ok('precompute: all columns cached (exact moments + hist, ≈ quantiles); "compute exact" upgrades one column')
    : fail(`precompute failed: ${JSON.stringify(prec)}`);

  // ── column summary table: precompute → all-columns table, click-to-sort, row→detail ──
  const summary = await page.evaluate(async () => {
    const L = window._lamina;
    let csv = 'a,b,lito\n';
    for (let i = 0; i < 30; i++) csv += `${i},${(i % 7) * (i % 7)},${['OX', 'SU'][i % 2]}\n`;
    L.open('sum.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 60));
    await L.precomputeStats({ show: true });
    await new Promise((r) => setTimeout(r, 40));
    const wide = document.querySelector('.help-box').classList.contains('wide');
    const bodyRows = document.querySelectorAll('.sum-tbl tbody tr').length;
    // sort by CV descending (click the CV header)
    [...document.querySelectorAll('.sum-tbl th')].find((t) => t.getAttribute('data-k') === 'cv').click();
    await new Promise((r) => setTimeout(r, 20));           // paintSummary rebuilds the table → re-query
    const firstName = document.querySelector('.sum-tbl tbody tr td').textContent;   // top row after sort
    const sorted = !![...document.querySelectorAll('.sum-tbl th')].find((t) => t.getAttribute('data-k') === 'cv' && t.classList.contains('sorted'));
    // click a row → opens that column's Statistics popup (overlay no longer wide)
    document.querySelector('.sum-tbl tbody tr').click(); await new Promise((r) => setTimeout(r, 60));
    const wentToDetail = !document.querySelector('.help-box').classList.contains('wide') && /Statistics —/.test(document.getElementById('helpTitle').textContent);
    document.getElementById('help').classList.remove('show');
    return { wide, bodyRows, sorted, firstName, wentToDetail };
  });
  (summary.wide && summary.bodyRows === 3 && summary.sorted && summary.wentToDetail)
    ? ok(`column summary: ${summary.bodyRows}-column table, sort by CV (top "${summary.firstName.trim()}"), row→detail`)
    : fail(`column summary failed: ${JSON.stringify(summary)}`);

  // ── group by: engine (multi-var + weighted) + UI (config, compute, click→filter) ──
  const grp = await page.evaluate(async () => {
    const L = window._lamina;
    // lito OX/SU; cu grade; wt weight. OX rows: cu 2,4 wt 1,3 → wmean=(2*1+4*3)/(1+3)=3.5, mean=3
    let csv = 'lito,cu,wt\nOX,2,1\nOX,4,3\nSU,10,1\nSU,10,1\n';
    L.open('gb.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 60));
    // engine directly
    const res = await L.scanGroupBy(L.current.source, { groupCol: 0, valueCols: [1], weightCol: 2, dataStart: L.current.dataStart });
    const ox = res.groups.find((g) => g.key === 'OX'), su = res.groups.find((g) => g.key === 'SU');
    const eng = {
      groups: res.groups.length, weighted: res.weighted,
      oxN: ox.count, oxMean: ox.vars[0].mean, oxWmean: ox.vars[0].wmean, oxSum: ox.vars[0].sum,
      suMean: su.vars[0].mean, totalN: res.total.count, totalMean: res.total.vars[0].mean,
    };
    // UI: open, add a 2nd variable, set weight, compute
    L.openGroupBy(); await new Promise((r) => setTimeout(r, 30));
    document.getElementById('gbGroup').value = '0'; document.getElementById('gbGroup').dispatchEvent(new Event('change'));
    document.querySelector('.gb-value').value = '1'; document.querySelector('.gb-value').dispatchEvent(new Event('change'));
    document.getElementById('gbWeight').value = '2'; document.getElementById('gbWeight').dispatchEvent(new Event('change'));
    await L.computeGroupBy(); await new Promise((r) => setTimeout(r, 40));
    const headers = [...document.querySelectorAll('.sum-tbl th')].map((t) => t.textContent.trim());
    const hasWmean = headers.some((x) => /wmean/.test(x));
    const bodyRows = document.querySelectorAll('.sum-tbl tbody tr:not(.gb-total)').length;
    const hasTotal = !!document.querySelector('.sum-tbl tr.gb-total');
    // click the OX group row → filters the grid to lito == "OX"
    const oxRow = [...document.querySelectorAll('.sum-tbl tbody tr:not(.gb-total)')].find((tr) => tr.getAttribute('data-key') === 'OX');
    oxRow.click(); await new Promise((r) => setTimeout(r, 80));
    const box = document.getElementById('filter').value;
    await L.applyFilter('');
    return { eng, hasWmean, bodyRows, hasTotal, box };
  });
  (grp.eng.groups === 2 && grp.eng.weighted && grp.eng.oxN === 2 && Math.abs(grp.eng.oxMean - 3) < 1e-9 && Math.abs(grp.eng.oxWmean - 3.5) < 1e-9 && grp.eng.totalN === 4
    && grp.hasWmean && grp.bodyRows === 2 && grp.hasTotal && /^lito == "OX"$/.test(grp.box))
    ? ok(`group by: OX mean 3 vs wmean 3.5 (weighted) · 2 groups + total · click group → ${grp.box}`)
    : fail(`group by failed: ${JSON.stringify(grp)}`);

  // ── group-by numeric bins via expr bin() calc column + numeric key sort ──
  const binGb = await page.evaluate(async () => {
    const L = window._lamina;
    let csv = 'id,au\n'; [0.1, 0.6, 1.2, 2.1, 10.3, 0.4, 1.8].forEach((v, i) => csv += `${i},${v}\n`);
    L.open('bin.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 60));
    await L.addCalc('aubin', 'bin(au, 0.5)');             // the new expr bin() helper
    await new Promise((r) => setTimeout(r, 60));
    const binCol = L.current.schema.findIndex((s) => s.name === 'aubin');
    L.openGroupBy(); await new Promise((r) => setTimeout(r, 20));
    document.getElementById('gbGroup').value = String(binCol); document.getElementById('gbGroup').dispatchEvent(new Event('change'));
    await L.computeGroupBy(); await new Promise((r) => setTimeout(r, 40));
    [...document.querySelectorAll('.sum-tbl th')].find((t) => t.getAttribute('data-k') === 'key').click();   // sort by key asc
    await new Promise((r) => setTimeout(r, 20));
    const keys = [...document.querySelectorAll('.sum-tbl tbody tr:not(.gb-total) td:first-child')].map((td) => td.textContent.trim());
    await L.applyFilter('');
    return { keys };
  });
  const bn = binGb.keys.map(Number);
  (bn.length >= 5 && bn.every((v, i) => i === 0 || v >= bn[i - 1]) && bn.indexOf(10) === bn.length - 1)
    ? ok(`bin() group-by: numeric bins [${binGb.keys.join(', ')}] sort numerically (10 last, not after 1)`)
    : fail(`bin group-by failed: ${JSON.stringify(binGb)}`);

  // ── data quality: leading-zeros / non-numeric / sentinel / all-blank detectors ──
  const dq = await page.evaluate(async () => {
    const L = window._lamina;
    // code: 00N (leading zeros, numeric-detected) · au: numeric w/ ONE BLK (sparse junk, stays numeric) · snt: -999 sentinel · empty: all blank
    let csv = 'code,au,snt,empty\n';
    for (let i = 0; i < 12; i++) {
      const code = String(i + 1).padStart(3, '0');
      const au = i === 5 ? 'BLK' : (1 + i * 0.3).toFixed(1);
      const snt = i % 4 === 0 ? '-999' : String(5 + i);
      csv += `${code},${au},${snt},\n`;
    }
    L.open('dq.csv', new TextEncoder().encode(csv));
    await new Promise((r) => setTimeout(r, 60));
    L.setColType(1, 'number');                              // au: numeric column with sparse BLK (the Isatis case)
    await new Promise((r) => setTimeout(r, 40));
    await L.showDataQuality(); await new Promise((r) => setTimeout(r, 60));
    const rows = [...document.querySelectorAll('.sum-tbl tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(1, 3).map((td) => td.textContent.trim()));
    document.getElementById('help').classList.remove('show');
    const has = (col, issue) => rows.some((r) => r[0] === col && r[1] === issue);
    const out = { rows, lead: has('code', 'leading zeros lost'), nonnum: has('au', 'non-numeric values'), sentinel: has('snt', 'possible sentinel'), blank: has('empty', 'all blank') };
    // one-click fix: the leading-zeros flag → "treat as text" → re-scan, flag gone, column now text
    const fixBtn = document.querySelector('.dq-fix');
    out.hadFix = !!fixBtn;
    fixBtn.click(); await new Promise((r) => setTimeout(r, 80));
    const rows2 = [...document.querySelectorAll('.sum-tbl tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(1, 3).map((td) => td.textContent.trim()));
    out.leadGone = !rows2.some((r) => r[0] === 'code' && r[1] === 'leading zeros lost');
    out.codeNowText = L.current.schema[0].type === 'string';
    document.getElementById('help').classList.remove('show');
    return out;
  });
  (dq.lead && dq.nonnum && dq.sentinel && dq.blank && dq.hadFix && dq.leadGone && dq.codeNowText)
    ? ok(`data quality: leading-zeros/non-numeric/sentinel/all-blank flags · "fix: treat as text" clears the leading-zeros flag`)
    : fail(`data quality failed: ${JSON.stringify(dq)}`);

  // ── help is current: the new Analysis & quality topic covers the session's features ──
  const help = await page.evaluate(() => {
    const L = window._lamina;
    L.showHelp('analysis');
    const t = document.getElementById('helpTitle').textContent, b = document.getElementById('helpBody').textContent;
    const covers = ['Σ stats', 'Group by', 'Data quality', 'weight', 'leading zeros'].filter((s) => b.includes(s));
    L.showHelp('filter'); const fb = document.getElementById('helpBody').textContent;
    document.getElementById('help').classList.remove('show');
    return { title: t, covers, binDoc: /bin\(grade/.test(fb) };
  });
  (help.title === 'Analysis & quality' && help.covers.length === 5 && help.binDoc)
    ? ok(`help current: Analysis & quality topic covers ${help.covers.length}/5 features + bin() documented in filter syntax`)
    : fail(`help check failed: ${JSON.stringify(help)}`);

  // ── jump-to-column: a column name in the summary table scrolls/selects it in the grid ──
  const jump = await page.evaluate(async () => {
    const L = window._lamina;
    let header = 'r'; for (let j = 1; j < 30; j++) header += `,c${j}`;
    let csv = header + '\n'; for (let i = 0; i < 40; i++) { let row = `${i}`; for (let j = 1; j < 30; j++) row += `,${i * j}`; csv += row + '\n'; }
    L.open('jump.csv', new TextEncoder().encode(csv));
    for (let t = 0; t < 40 && !L.grid; t++) await new Promise((r) => setTimeout(r, 25));
    await L.precomputeStats({ show: true }); await new Promise((r) => setTimeout(r, 50));
    // click the name of a far-right column (c27, underlying index 27)
    const target = [...document.querySelectorAll('.sum-tbl tbody tr')].find((tr) => +tr.getAttribute('data-uc') === 27);
    const before = L.grid.getScroll().left;
    target.querySelector('.col-jump').click();
    await new Promise((r) => setTimeout(r, 60));
    const sel = L.grid.getSelection();
    const overlayClosed = !document.getElementById('help').classList.contains('show');
    const scrolled = L.grid.getScroll().left > before;
    return { overlayClosed, scrolled, selCol: sel && sel.c0, vis27: (L.current._vis || []).indexOf(27) };
  });
  (jump.overlayClosed && jump.scrolled && jump.selCol === jump.vis27)
    ? ok(`jump-to-column: name click closes overlay + scrolls/selects the column (display col ${jump.selCol})`)
    : fail(`jump-to-column failed: ${JSON.stringify(jump)}`);

  if (errors.length) fail('console errors: ' + errors.join(' | '));
  else ok('no console errors');
  // ── §: an EXCEL workbook is a zip, and a person dragging one in wants their DATA ──
  // Before this, .xlsx fell into the archive branch and offered a picker full of
  // `xl/worksheets/sheet1.xml`. Now it offers SHEETS, typed straight from Excel.
  {
    const bytes = await xlsxSheet.write({
      sheets: [
        { name: 'Assays', columns: { HOLE: ['DH1', 'DH1', 'DH2', 'DH2'], FROM: [0, 1.5, 0, 2], AU: [0.42, 1.10, 0.05, 2.30], LITHO: ['OXIDE', 'OXIDE', 'FRESH', 'FRESH'] } },
        { name: 'General', columns: { parameter: ['cutoff', 'density'], value: [0.3, 2.7] } },
      ],
    });
    const b64 = Buffer.from(bytes).toString('base64');

    const picked = await page.evaluate(async (b) => {
      const raw = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      await window._lamina.openFile(new File([raw], 'assays.xlsx'));
      await new Promise((r) => setTimeout(r, 400));
      const items = [...document.querySelectorAll('#pickerList .pk-item')].map((i) => ({
        name: i.querySelector('.pk-name').textContent, meta: i.querySelector('.pk-size').textContent }));
      return { shown: document.getElementById('picker').classList.contains('show'), items };
    }, b64);
    if (picked.shown && picked.items.length === 2 && picked.items.some((i) => i.name === 'Assays') && /rows/.test(picked.items[0].meta))
      ok(`xlsx: a workbook offers its SHEETS, measured in rows (${picked.items.map((i) => i.name).join(', ')})`);
    else fail(`xlsx: expected a 2-sheet picker, got ${JSON.stringify(picked)}`);

    const mounted = await page.evaluate(async () => {
      [...document.querySelectorAll('#pickerList .pk-item')].find((i) => i.querySelector('.pk-name').textContent === 'Assays').click();
      await new Promise((r) => setTimeout(r, 500));
      const vs = window._laminaVS;
      return {
        rows: vs.rowCount(),
        schema: Array.from({ length: vs.cols }, (_, i) => `${vs.header(i).label}:${vs.colType(i)}`),
        badge: document.getElementById('kindBadge').textContent,
      };
    });
    // AU is a number because EXCEL says so (a Float64Array), not because a string parsed
    if (mounted.rows === 4 && mounted.schema.includes('AU:number') && mounted.schema.includes('HOLE:string') && /xlsx/.test(mounted.badge))
      ok(`xlsx: the sheet mounts TYPED — ${mounted.schema.join(' · ')} (badge "${mounted.badge}")`);
    else fail(`xlsx: expected a typed 4-row mount, got ${JSON.stringify(mounted)}`);

    const filtered = await page.evaluate(async () => {
      await window._lamina.applyFilter('AU > 1');
      await new Promise((r) => setTimeout(r, 400));
      return document.getElementById('meta').textContent;
    });
    if (/2 of 4/.test(filtered)) ok(`xlsx: the whole toolkit runs on it — "AU > 1" → ${filtered.split('·')[0].trim()}`);
    else fail(`xlsx: filter on an Excel column gave "${filtered}"`);
  }

  // ── §: a CORRUPT archive must fail with a NAME, not hang ──
  // listZip() threw out of openFile uncaught, so the status sat on "decompressing…"
  // forever and the console carried "invalid zip data". A .docx did this too.
  {
    const stuck = await page.evaluate(async () => {
      const junk = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);   // zip magic, then garbage
      await window._lamina.openFile(new File([junk], 'report.docx'));
      await new Promise((r) => setTimeout(r, 600));
      return document.getElementById('meta').textContent;
    });
    if (!/decompressing/i.test(stuck) && stuck.trim())
      ok(`corrupt archive: fails with a name, not a hang — "${stuck}"`);
    else fail(`corrupt archive: stuck on "${stuck}"`);
  }

  // ── §: the filter tells a stranger the truth ──
  {
    const msgs = await page.evaluate(async () => {
      const csv = 'ID,FE,SIO2\n' + Array.from({ length: 20 }, (_, i) => `${i},${30 + i},5`).join('\n');
      window._lamina.open('grades.csv', new TextEncoder().encode(csv));
      await new Promise((r) => setTimeout(r, 300));
      const out = {};
      for (const e of ['SELECT * WHERE FE > 40', 'FEE > 40']) {
        await window._lamina.applyFilter(e);
        await new Promise((r) => setTimeout(r, 300));
        out[e] = document.getElementById('meta').textContent;
      }
      return out;
    });
    // a SQL person's first instinct — hand them the working expression
    if (/WHERE clause/.test(msgs['SELECT * WHERE FE > 40']) && /just: FE > 40/.test(msgs['SELECT * WHERE FE > 40']))
      ok(`filter: SQL-brain gets the answer — "${msgs['SELECT * WHERE FE > 40'].replace('filter: ', '')}"`);
    else fail(`filter: SQL hint missing — "${msgs['SELECT * WHERE FE > 40']}"`);
    // @gcu/expr suggests, and lamina must NOT suggest again ("did you mean FE? — did you mean FE?")
    const dm = (msgs['FEE > 40'].match(/did you mean/g) || []).length;
    if (dm === 1) ok(`filter: the column suggestion is offered ONCE — "${msgs['FEE > 40'].replace('filter: ', '')}"`);
    else fail(`filter: suggestion appears ${dm}× — "${msgs['FEE > 40']}"`);
  }

} catch (e) {
  fail('smoke threw: ' + e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(process.exitCode ? '\nLAMINA SMOKE: FAIL' : '\nLAMINA SMOKE: PASS');
