// @gcu/lamina — the record-offset scanner + read-time splitters. The crux of the
// windowed viewer: a chunk-fed scan must find record boundaries correctly
// (quote-aware, CRLF, across chunk edges) and a coarse block index must
// reconstruct any window. Pure, in `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordScanner, scanRecords, scanFileToIndex, splitRecords, parseFields } from '../ext/lamina/src/scan.js';
import { detectKind } from '../ext/lamina/src/detect.js';
import { buildMemorySource, buildFileSource, buildStreamSource, buildSourceFromIndex, indexOf, fileKey } from '../ext/lamina/src/source.js';
import { createRecordViewSource, LOADING } from '../ext/lamina/src/viewsource.js';
import { parseFilter, scanFilter, createResultView } from '../ext/lamina/src/filter.js';
import { scanSortKeys } from '../ext/lamina/src/sort.js';
import { scanColumnStats } from '../ext/lamina/src/stats.js';
import { createLaminaProvider } from '../ext/lamina/src/provider.js';

const B = (s) => new TextEncoder().encode(s);
const D = (u) => new TextDecoder().decode(u);

// ── scanner: block index ──

test('scan: delimited, K=1 → per-record offsets + EOF', () => {
  const r = scanRecords(B('a,b\n1,2\n3,4\n'), { kind: 'delimited', blockSize: 1 });
  assert.equal(r.rowCount, 3);
  assert.equal(r.totalBytes, 12);
  assert.deepEqual([...r.blockOffsets], [0, 4, 8, 12]);
});

test('scan: trailing record with no final newline still counts', () => {
  const r = scanRecords(B('a\nb'), { kind: 'delimited', blockSize: 1 });
  assert.equal(r.rowCount, 2);
  assert.equal(r.totalBytes, 3);
  assert.deepEqual([...r.blockOffsets], [0, 2]);
});

test('scan: a \\n inside a quoted field is NOT a boundary (delimited)', () => {
  const bytes = B('a,"x\ny",b\n1\n');           // record 0 contains an embedded newline
  assert.equal(scanRecords(bytes, { kind: 'delimited', blockSize: 1 }).rowCount, 2);
  // …but in text mode the same bytes split on every \n
  assert.equal(scanRecords(bytes, { kind: 'text', blockSize: 1 }).rowCount, 3);
});

test('scan: CRLF — \\n is the boundary, \\r trimmed by splitRecords', () => {
  const bytes = B('a\r\nb\r\n');
  assert.equal(scanRecords(bytes, { kind: 'text', blockSize: 1 }).rowCount, 2);
  assert.deepEqual(splitRecords(bytes, { kind: 'text' }).map(D), ['a', 'b']);
});

test('scan: chunk-fed === one-shot (record + quote state cross chunk edges)', () => {
  const whole = scanRecords(B('a,b\n1,2\n3,4\n'), { kind: 'delimited', blockSize: 1 });
  const s = createRecordScanner({ kind: 'delimited', blockSize: 1 });
  s.push(B('a,b\n1,'));      // chunk boundary mid-record
  s.push(B('2\n3,4\n'));
  const chunked = s.end();
  assert.equal(chunked.rowCount, whole.rowCount);
  assert.deepEqual([...chunked.blockOffsets], [...whole.blockOffsets]);
});

test('scan: a quote spanning a chunk edge keeps in-quote state', () => {
  const s = createRecordScanner({ kind: 'delimited', blockSize: 1 });
  s.push(B('a,"x\n'));        // opens a quote, embedded \n, chunk ends mid-quote
  s.push(B('y",b\nz\n'));     // closes the quote later
  const r = s.end();
  assert.equal(r.rowCount, 2);   // the embedded \n did NOT split
});

test('scan: K=2 block index points at every 2nd record start', () => {
  const r = scanRecords(B('a\nb\nc\nd\ne\n'), { kind: 'text', blockSize: 2 });
  assert.equal(r.rowCount, 5);
  assert.deepEqual([...r.blockOffsets], [0, 4, 8]);  // rec0@0, rec2@4 ('c'), rec4@8 ('e')
});

test('scan: empty file', () => {
  const r = scanRecords(new Uint8Array(0), { kind: 'delimited', blockSize: 1 });
  assert.equal(r.rowCount, 0);
  assert.deepEqual([...r.blockOffsets], [0]);
});

// ── splitRecords / parseFields ──

test('splitRecords: quoted embedded newline stays in one record (delimited)', () => {
  const recs = splitRecords(B('a,"x\ny",b\n1,2\n'), { kind: 'delimited' });
  assert.deepEqual(recs.map(D), ['a,"x\ny",b', '1,2']);
});

test('parseFields: quoting + doubled-quote escape', () => {
  assert.deepEqual(parseFields(B('a,"b,c",d')), ['a', 'b,c', 'd']);
  assert.deepEqual(parseFields(B('1,"x""y",3')), ['1', 'x"y', '3']);
  assert.deepEqual(parseFields(B('p,q,r')), ['p', 'q', 'r']);
});

// ── window reconstruction from the block index (the read path, in-memory sim) ──

// Simulate window(from,count): find the covering blocks, slice their bytes (what
// readRange would fetch), splitRecords, then slice the records. Proves the coarse
// index → exact window mapping that the real RecordViewSource will do over readRange.
function windowSim(bytes, idx, from, count, opts) {
  const K = idx.blockSize;
  const b0 = Math.floor(from / K);
  const recs = [];
  let b = b0;
  const need = (from - b0 * K) + count;
  while (recs.length < need && b < idx.blockOffsets.length) {
    const s = idx.blockOffsets[b];
    const e = b + 1 < idx.blockOffsets.length ? idx.blockOffsets[b + 1] : idx.totalBytes;
    recs.push(...splitRecords(bytes.subarray(s, e), opts));
    b++;
  }
  const off = from - b0 * K;
  return recs.slice(off, off + count).map(D);
}

test('window: K=2 block index reconstructs arbitrary windows', () => {
  const bytes = B('a\nb\nc\nd\ne\n');
  const opts = { kind: 'text' };
  const idx = scanRecords(bytes, { ...opts, blockSize: 2 });
  assert.deepEqual(windowSim(bytes, idx, 0, 2, opts), ['a', 'b']);
  assert.deepEqual(windowSim(bytes, idx, 1, 1, opts), ['b']);
  assert.deepEqual(windowSim(bytes, idx, 3, 1, opts), ['d']);     // mid-block, forward-scan
  assert.deepEqual(windowSim(bytes, idx, 2, 3, opts), ['c', 'd', 'e']); // spans blocks + tail
  assert.deepEqual(windowSim(bytes, idx, 4, 1, opts), ['e']);     // last (partial) block
});

test('window: delimited rows reconstruct + parse into fields', () => {
  const bytes = B('x,y\n1,"a,b"\n2,c\n');
  const opts = { kind: 'delimited' };
  const idx = scanRecords(bytes, { ...opts, blockSize: 2 });
  const rows = windowSim(bytes, idx, 1, 2, opts).map((r) => parseFields(B(r)));
  assert.deepEqual(rows, [['1', 'a,b'], ['2', 'c']]);
});

// ── detect: kind / delimiter / schema ──

test('detect: comma CSV with header → delimited + schema + types', () => {
  const d = detectKind(B('id,grade,lito\n1,2.5,ox\n2,0.8,sulf\n'));
  assert.equal(d.kind, 'delimited');
  assert.equal(d.delimiter, ',');
  assert.equal(d.hasHeader, true);
  assert.deepEqual(d.schema.map((s) => s.name), ['id', 'grade', 'lito']);
  assert.equal(d.schema[1].type, 'number');   // grade
  assert.equal(d.schema[2].type, 'string');   // lito
});

test('detect: TSV', () => {
  const d = detectKind(B('a\tb\tc\n1\t2\t3\n'));
  assert.equal(d.kind, 'delimited');
  assert.equal(d.delimiter, '\t');
});

test('detect: plain text → text', () => {
  const d = detectKind(B('hello world\nthis is a log line\nno delimiters here at all\n'));
  assert.equal(d.kind, 'text');
});

test('detect: binary (NUL byte) → binary', () => {
  assert.equal(detectKind(new Uint8Array([1, 2, 0, 3, 4, 255, 7])).kind, 'binary');
});

test('detect: header-less CSV (all-numeric first row)', () => {
  const d = detectKind(B('1,2,3\n4,5,6\n7,8,9\n'));
  assert.equal(d.kind, 'delimited');
  assert.equal(d.hasHeader, false);
  assert.deepEqual(d.schema.map((s) => s.name), ['col 1', 'col 2', 'col 3']);
});

// ── viewsource: windowed read over the block index ──

test('viewsource: rowAt is LOADING then resolves; full parity; dataStart skips header', async () => {
  const csv = B('n,x\n1,a\n2,b\n3,c\n4,d\n5,e\n');             // header + 5 rows
  const src = buildMemorySource(csv, { kind: 'delimited', delimiter: ',', blockSize: 2 });
  const vs = createRecordViewSource(src, { schema: [{ name: 'n', type: 'number' }, { name: 'x', type: 'string' }], dataStart: 1 });
  assert.equal(vs.rowCount(), 5);                              // header skipped
  assert.equal(vs.rowAt(3), LOADING);
  assert.deepEqual(await vs.ensureRow(3), ['4', 'd']);
  assert.deepEqual(vs.rowAt(3), ['4', 'd']);                   // cached, sync
  assert.equal(vs.rowAt(99), null);                           // out of range
  for (let r = 0; r < 5; r++) assert.equal((await vs.ensureRow(r))[0], String(r + 1));
});

test('viewsource: onReady fires after a block loads', async () => {
  const vs = createRecordViewSource(buildMemorySource(B('1\n2\n3\n'), { kind: 'text', blockSize: 1 }), { schema: [{ name: 'line' }] });
  let fired = 0; vs.onReady(() => fired++);
  vs.rowAt(0);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(fired >= 1);
});

test('viewsource: LRU caps resident blocks (old block evicted)', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `r${i}`).join('\n') + '\n';
  const vs = createRecordViewSource(buildMemorySource(B(lines), { kind: 'text', blockSize: 1 }), { schema: [{ name: 'line' }], cacheBlocks: 3 });
  for (let r = 0; r < 20; r++) await vs.ensureRow(r);
  assert.equal(vs.rowAt(0), LOADING);                         // evicted; only the last few blocks resident
});

// ── provider: loom adapter (PENDING injected) ──

test('provider: maps LOADING → injected PENDING; cells + header + dims', async () => {
  const PEND = Symbol('test.pending');
  const src = buildMemorySource(B('id,g\n1,2.5\n3,4.5\n'), { kind: 'delimited', blockSize: 1 });
  const vs = createRecordViewSource(src, { schema: [{ name: 'id', type: 'number' }, { name: 'g', type: 'number' }], dataStart: 1 });
  const p = createLaminaProvider(vs, { PENDING: PEND });
  assert.deepEqual(p.dims(), { rows: 2, cols: 2 });
  assert.equal(p.cellAt(1, 0), PEND);                         // block not loaded → injected PENDING
  await vs.ensureRow(1);
  assert.deepEqual(p.cellAt(1, 0), { value: '3', state: 'raw', type: 'number', style: { text: '3' } });
  assert.equal(p.cellAt(99, 0), null);
  assert.deepEqual(p.header(0), { label: 'id', type: 'number' });
  assert.equal(p.rowHeader(1), 2);
});

// ── streaming source (File.stream — never resident) ──

test('buildFileSource: streaming scan === memory scan; readRange serves slices', async () => {
  let csv = 'id,x\n';
  for (let i = 0; i < 3000; i++) csv += `${i},v${i}\n`;
  const bytes = B(csv);
  const file = new File([bytes], 'big.csv');
  const mem = buildMemorySource(bytes, { kind: 'delimited', blockSize: 256 });
  const strm = await buildFileSource(file, { kind: 'delimited', blockSize: 256 });
  assert.equal(strm.rowCount, mem.rowCount);
  assert.equal(strm.totalBytes, mem.totalBytes);
  assert.deepEqual([...strm.blockOffsets], [...mem.blockOffsets]);
  const off = strm.blockOffsets[3];
  const r = await strm.readRange(off, 16);                      // lazy slice
  assert.deepEqual([...r], [...bytes.subarray(off, off + 16)]);
});

test('buildFileSource: a viewsource over a streamed File windows a deep row', async () => {
  let csv = 'n\n';
  for (let i = 0; i < 5000; i++) csv += `${i}\n`;
  const file = new File([B(csv)], 'col.csv');
  const src = await buildFileSource(file, { kind: 'text', blockSize: 512 });
  const vs = createRecordViewSource(src, { schema: [{ name: 'n', type: 'number' }], dataStart: 1 });
  assert.equal(vs.rowCount(), 5000);
  assert.equal(vs.rowAt(4321), LOADING);                        // deep, not loaded
  assert.deepEqual(await vs.ensureRow(4321), ['4321']);         // windowed via File.slice
});

// A re-openable byte stream (stands in for a decompression: the tape is
// compression-agnostic — it just needs fresh forward bytes from 0 each open).
function streamOf(bytes, chunkSize = 256) {
  let opens = 0;
  const fn = () => {
    opens++;
    let pos = 0;
    return new ReadableStream({
      pull(c) {
        if (pos >= bytes.length) { c.close(); return; }
        const end = Math.min(pos + chunkSize, bytes.length);
        c.enqueue(bytes.subarray(pos, end)); pos = end;
      },
    });
  };
  fn.opens = () => opens;
  return fn;
}

test('buildStreamSource: index == memory scan; tape serves forward + near-back, rewinds on far-back', async () => {
  let csv = 'id,x\n';
  for (let i = 0; i < 4000; i++) csv += `${i},v${i}\n`;
  const bytes = B(csv);
  const mem = buildMemorySource(bytes, { kind: 'delimited', blockSize: 128 });
  const os = streamOf(bytes);
  const src = await buildStreamSource({ openStream: os, kind: 'delimited', blockSize: 128, maxBuffer: 4096 });
  assert.equal(src.rowCount, mem.rowCount);
  assert.deepEqual([...src.blockOffsets], [...mem.blockOffsets]);
  const afterScan = os.opens();                                  // the index scan opened the stream once

  const a = await src.readRange(1000, 20);                        // first read → opens the tape
  assert.deepEqual([...a], [...bytes.subarray(1000, 1020)]);
  const afterFirst = os.opens();
  assert.equal(afterFirst, afterScan + 1);

  const b2 = await src.readRange(1005, 10);                       // near-back, inside the buffer → no reopen
  assert.deepEqual([...b2], [...bytes.subarray(1005, 1015)]);
  assert.equal(os.opens(), afterFirst);

  const c = await src.readRange(50000, 30);                       // far forward, same stream → no reopen
  assert.deepEqual([...c], [...bytes.subarray(50000, 50030)]);
  assert.equal(os.opens(), afterFirst);

  const before = os.opens();
  const d = await src.readRange(100, 20);                         // far back, past the buffer → REWIND
  assert.deepEqual([...d], [...bytes.subarray(100, 120)]);
  assert.equal(os.opens(), before + 1);
});

test('buildStreamSource: a viewsource over the tape resolves a deep row', async () => {
  let csv = 'n\n';
  for (let i = 0; i < 6000; i++) csv += `${i}\n`;
  const src = await buildStreamSource({ openStream: streamOf(B(csv)), kind: 'text', blockSize: 512, maxBuffer: 8192 });
  const vs = createRecordViewSource(src, { schema: [{ name: 'n' }], dataStart: 1 });
  assert.equal(vs.rowCount(), 6000);
  assert.deepEqual(await vs.ensureRow(5500), ['5500']);          // deep, windowed through the tape
  assert.deepEqual(await vs.ensureRow(10), ['10']);             // back near the top → rewind, still correct
});

test('scanFileToIndex == scanRecords (the worker-callable entry); quote BYTE in opts', async () => {
  const bytes = B('a,"x\ny",b\n1,2\n3,4\n');                     // an embedded-newline quoted field
  const file = new File([bytes], 'q.csv');
  const oneShot = scanRecords(bytes, { kind: 'delimited', blockSize: 1 });
  const streamed = await scanFileToIndex(file, { kind: 'delimited', quote: 34, blockSize: 1 });
  assert.equal(streamed.rowCount, oneShot.rowCount);
  assert.deepEqual([...streamed.blockOffsets], [...oneShot.blockOffsets]);
});

test('indexOf → buildSourceFromIndex round-trips (the cache path): no re-scan, same windows', async () => {
  let csv = 'id,x\n';
  for (let i = 0; i < 2000; i++) csv += `${i},v${i}\n`;
  const bytes = B(csv);
  const file = new File([bytes], 'c.csv');
  const fresh = await buildFileSource(file, { kind: 'delimited', blockSize: 64 });
  const idx = indexOf(fresh);                                    // what a host persists (no readRange closure)
  assert.equal(idx.readRange, undefined);
  assert.deepEqual(Object.keys(idx).sort(), ['blockOffsets', 'blockSize', 'delimiter', 'kind', 'quote', 'rowCount', 'totalBytes']);
  const rebuilt = buildSourceFromIndex(file, idx);              // reopen from cache — NO scan
  assert.equal(rebuilt.rowCount, fresh.rowCount);
  assert.deepEqual([...rebuilt.blockOffsets], [...fresh.blockOffsets]);
  const off = idx.blockOffsets[5];
  assert.deepEqual([...(await rebuilt.readRange(off, 10))], [...bytes.subarray(off, off + 10)]);  // readRange rebuilt over the File
  // and a viewsource over the rebuilt source resolves a deep row
  const vs = createRecordViewSource(rebuilt, { schema: [{ name: 'id' }, { name: 'x' }], dataStart: 1 });
  assert.deepEqual(await vs.ensureRow(1500), ['1500', 'v1500']);
});

test('fileKey is stable + changes with size/mtime', () => {
  const k = fileKey({ name: 'a.csv', size: 100, lastModified: 5 });
  assert.equal(k, fileKey({ name: 'a.csv', size: 100, lastModified: 5 }));   // same triple → same key
  assert.notEqual(k, fileKey({ name: 'a.csv', size: 101, lastModified: 5 })); // size differs
  assert.notEqual(k, fileKey({ name: 'a.csv', size: 100, lastModified: 6 })); // mtime differs
  assert.equal(fileKey({ name: 'a.csv', size: 100 }), 'a.csv:100:0');         // missing mtime → 0
});

test('buildFileSource: injected `scan` dispatcher (the off-thread seam) is used; readRange stays local', async () => {
  let csv = 'k,v\n';
  for (let i = 0; i < 1200; i++) csv += `${i},${i * 2}\n`;
  const bytes = B(csv);
  const file = new File([bytes], 'inj.csv');
  let called = 0;
  // Stand-in for the @gcu/proc worker: a function that returns the index off-band.
  const scan = async (f, opts) => { called++; return scanFileToIndex(f, opts); };
  const src = await buildFileSource(file, { kind: 'delimited', blockSize: 128, scan });
  assert.equal(called, 1);                                       // the seam ran, not the inline path
  const mem = buildMemorySource(bytes, { kind: 'delimited', blockSize: 128 });
  assert.deepEqual([...src.blockOffsets], [...mem.blockOffsets]);
  const off = src.blockOffsets[2];
  assert.deepEqual([...(await src.readRange(off, 12))], [...bytes.subarray(off, off + 12)]);  // readRange = File.slice, local
});

// ── filter (predicate scan + remap view) ──

test('parseFilter: numeric, string, contains, AND, unknown column', () => {
  const cols = [{ name: 'id' }, { name: 'grade' }, { name: 'lito' }];
  assert.equal(parseFilter('grade > 2', cols)(['1', '2.5', 'ox']), true);
  assert.equal(parseFilter('grade > 2', cols)(['1', '0.5', 'ox']), false);
  assert.equal(parseFilter('lito == ox', cols)(['1', '2', 'ox']), true);
  assert.equal(parseFilter('lito == "ox"', cols)(['1', '2', 'sulf']), false);
  assert.equal(parseFilter('lito ~ XID', cols)(['1', '2', 'OXIDE']), true);     // contains, case-insensitive
  assert.equal(parseFilter('grade >= 2 && lito == ox', cols)(['1', '2', 'ox']), true);
  assert.equal(parseFilter('grade >= 2 && lito == ox', cols)(['1', '2', 'sulf']), false);
  assert.equal(parseFilter('GRADE > 2', cols)(['1', '3', 'ox']), true);          // case-insensitive column
  assert.equal(parseFilter('', cols), null);
  assert.throws(() => parseFilter('nope > 1', cols), /unknown column/);
});

test('scanFilter + createResultView: per-row result read by byte offset', async () => {
  let csv = 'id,grade,lito\n';
  for (let i = 0; i < 1000; i++) csv += `${i},${(i % 5)},${['ox', 'sulf'][i % 2]}\n`;
  const src = buildMemorySource(B(csv), { kind: 'delimited', delimiter: ',', blockSize: 64 });
  const schema = [{ name: 'id' }, { name: 'grade', type: 'number' }, { name: 'lito' }];

  const pred = parseFilter('grade >= 3 && lito == ox', schema);
  const result = await scanFilter(src, { predicate: pred, dataStart: 1 });
  // rows where grade(i%5)>=3 AND lito(i%2)=='ox' (i even): i%5∈{3,4} and i even → among 0..999
  let expect = 0;
  for (let i = 0; i < 1000; i++) if ((i % 5) >= 3 && (i % 2) === 0) expect++;
  assert.equal(result.nums.length, expect);
  assert.equal(result.offsets.length, expect);
  assert.equal(result.lengths.length, expect);

  const fv = createResultView(src, result, schema);
  assert.equal(fv.rowCount(), expect);
  const first = await fv.ensureRow(0);
  assert.equal(Number(first[1]) >= 3, true);
  assert.equal(first[2], 'ox');
  assert.equal(fv.rowHeaderAt(0), result.nums[0] + 1);            // original row number, not 1
  assert.equal(fv.cols, 3);
  assert.deepEqual(fv.header(1), { label: 'grade', type: 'number' });
  // a DEEP result row reads correctly (the offset path, not a block remap)
  const last = await fv.ensureRow(expect - 1);
  assert.equal(Number(last[1]) >= 3, true);
  assert.equal(last[2], 'ox');
});

test('scanFilter: max cap throws on a runaway match set', async () => {
  let csv = 'n\n'; for (let i = 0; i < 500; i++) csv += `${i}\n`;
  const src = buildMemorySource(B(csv), { kind: 'text', blockSize: 64 });
  await assert.rejects(
    scanFilter(src, { predicate: () => true, dataStart: 1, max: 10 }),
    /too many matches/);
});

// ── sort (key scan → ordered result; nums = display rows in sorted order) ──

test('scanSortKeys: numeric asc/desc, nulls last; result view reads sorted rows', async () => {
  const csv = 'id,grade\n0,3\n1,1\n2,\n3,2\n4,9\n';     // row 2 has empty grade → NaN → last
  const src = buildMemorySource(B(csv), { kind: 'delimited', delimiter: ',', blockSize: 2 });
  const schema = [{ name: 'id' }, { name: 'grade', type: 'number' }];

  const asc = await scanSortKeys(src, { col: 1, dir: 'asc', dataStart: 1, numeric: true });
  // grades: row0=3,row1=1,row2=NaN,row3=2,row4=9 → asc by grade: 1(r1),2(r3),3(r0),9(r4),NaN(r2)
  assert.deepEqual([...asc.nums], [1, 3, 0, 4, 2]);
  const v = createResultView(src, asc, schema);
  assert.equal(v.rowCount(), 5);
  assert.deepEqual(await v.ensureRow(0), ['1', '1']);    // smallest grade first
  assert.equal(v.rowHeaderAt(0), 2);                     // original row # (1-based: data row 1 → 2)

  const desc = await scanSortKeys(src, { col: 1, dir: 'desc', dataStart: 1, numeric: true });
  assert.deepEqual([...desc.nums], [4, 0, 3, 1, 2]);     // 9,3,2,1 then NaN last (both dirs)
});

test('scanSortKeys: string sort + subset (filter→sort composition)', async () => {
  let csv = 'k,v\n';
  for (let i = 0; i < 10; i++) csv += `${i},${['c', 'a', 'b'][i % 3]}\n`;
  const src = buildMemorySource(B(csv), { kind: 'delimited', blockSize: 4 });
  // sort only the even rows (a subset, ascending) by column v (string)
  const subset = Float64Array.from([0, 2, 4, 6, 8]);
  const order = await scanSortKeys(src, { col: 1, dir: 'asc', dataStart: 1, numeric: false, rows: subset });
  assert.equal(order.nums.length, 5);                     // only the subset
  for (const r of order.nums) assert.equal(subset.includes(r), true);
  // v of even rows (['c','a','b'][i%3]): r0=c,r2=b,r4=a,r6=c,r8=b → asc: a(4),b(2),b(8),c(0),c(6)
  assert.deepEqual([...order.nums], [4, 2, 8, 0, 6]);
});

test('scanSortKeys: max cap throws', async () => {
  let csv = 'n\n'; for (let i = 0; i < 200; i++) csv += `${i}\n`;
  const src = buildMemorySource(B(csv), { kind: 'text', blockSize: 32 });
  await assert.rejects(scanSortKeys(src, { col: 0, dataStart: 1, numeric: true, max: 10 }), /too many rows/);
});

// ── detect: force overrides + BOM ──

test('detect: force delimiter/kind/header overrides', () => {
  const semi = B('a;b;c\n1;2;3\n4;5;6\n');
  // a semicolon file where the comma-sniffer might pick text/wrong — force ';'
  const forced = detectKind(semi, { force: { delimiter: ';' } });
  assert.equal(forced.kind, 'delimited');
  assert.equal(forced.delimiter, ';');
  assert.deepEqual(forced.schema.map((s) => s.name), ['a', 'b', 'c']);

  // force header off on a file detect would call header-having
  const noHdr = detectKind(B('id,name\n1,x\n2,y\n'), { force: { hasHeader: false } });
  assert.equal(noHdr.hasHeader, false);
  assert.deepEqual(noHdr.schema.map((s) => s.name), ['col 1', 'col 2']);

  // force header ON for an all-numeric file detect would call headerless
  const hdrOn = detectKind(B('1,2,3\n4,5,6\n7,8,9\n'), { force: { hasHeader: true } });
  assert.equal(hdrOn.hasHeader, true);
  assert.deepEqual(hdrOn.schema.map((s) => s.name), ['1', '2', '3']);

  // force a delimited file to be viewed as plain text
  assert.equal(detectKind(B('a,b\n1,2\n'), { force: { kind: 'text' } }).kind, 'text');
});

test('detect + parseFields: a UTF-8 BOM is stripped from the first column', () => {
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...B('id,grade\n1,2.5\n')]);
  const d = detectKind(bom);
  assert.equal(d.kind, 'delimited');
  assert.equal(d.schema[0].name, 'id');                       // not "﻿id"
  // and a record whose bytes start with the BOM decodes clean
  assert.deepEqual(parseFields(new Uint8Array([0xEF, 0xBB, 0xBF, ...B('a,b,c')])), ['a', 'b', 'c']);
});

// ── detect: comment/preamble skip (the geology-export norm) ──

test('detect: a #-comment preamble is skipped → real header + dataStart', () => {
  const csv = B('# exported from FooMine\n# encoding: UTF-8\n# block size: 10\nId,X,Y,grade\n0,612105,9291005,1.2\n1,612115,9291005,0.8\n');
  const d = detectKind(csv);
  assert.equal(d.kind, 'delimited');
  assert.equal(d.skip, 3);                                   // three '# …' lines
  assert.equal(d.comment, '#');
  assert.equal(d.hasHeader, true);
  assert.equal(d.dataStart, 4);                              // 3 preamble + 1 header → first data is record 4
  assert.deepEqual(d.schema.map((s) => s.name), ['Id', 'X', 'Y', 'grade']);
  assert.equal(d.schema[3].type, 'number');
});

test('detect: force skip + force comment override', () => {
  // a preamble with no comment char — force skip
  const csv = B('junk line one\njunk two\nId,X\n0,1\n2,3\n');
  const d = detectKind(csv, { force: { skip: 2 } });
  assert.equal(d.skip, 2);
  assert.equal(d.dataStart, 3);
  assert.deepEqual(d.schema.map((s) => s.name), ['Id', 'X']);

  // a ';'-comment preamble
  const semi = B('; note\n; note 2\na,b\n1,2\n');
  const d2 = detectKind(semi, { force: { comment: ';' } });
  assert.equal(d2.skip, 2);
  assert.deepEqual(d2.schema.map((s) => s.name), ['a', 'b']);
});

test('detect: a viewsource over a preamble file shows data rows, not comments', async () => {
  const csv = B('# a\n# b\nId,v\n10,x\n20,y\n30,z\n');
  const src = buildMemorySource(csv, { kind: 'delimited', delimiter: ',', blockSize: 2 });
  const d = detectKind(csv);
  const vs = createRecordViewSource(src, { schema: d.schema, dataStart: d.dataStart });
  assert.equal(vs.rowCount(), 3);                            // 3 data rows (comments + header skipped)
  assert.deepEqual(await vs.ensureRow(0), ['10', 'x']);     // first data row, not a comment
});

// ── whitespace-delimited + Geo-EAS ──

test('detect + parse: whitespace-delimited (runs of spaces)', () => {
  const ws = B('id    x       grade\n0     612105  1.20\n1     612115  0.85\n');
  const d = detectKind(ws);
  assert.equal(d.kind, 'delimited');
  assert.equal(d.delimiter, ' ');
  assert.deepEqual(d.schema.map((s) => s.name), ['id', 'x', 'grade']);
  assert.deepEqual(parseFields(B('0     612105  1.20'), { delimiter: ' ' }), ['0', '612105', '1.20']);
});

test('detect: GSLIB / Geo-EAS (count + one name per line + whitespace data)', () => {
  const geo = B('Some block model\n3\nID\nGrade\nLito\n0 1.2 ox\n1 0.8 sulf\n2 2.1 ox\n');
  const d = detectKind(geo);
  assert.equal(d.kind, 'delimited');
  assert.equal(d.geoeas, true);
  assert.equal(d.delimiter, ' ');
  assert.equal(d.dataStart, 5);                          // title + count + 3 names
  assert.equal(d.hasHeader, false);
  assert.deepEqual(d.schema.map((s) => s.name), ['ID', 'Grade', 'Lito']);
  assert.equal(d.schema[1].type, 'number');             // Grade
});

test('detect: a viewsource over a Geo-EAS file shows the data rows', async () => {
  const geo = B('title\n2\nX\nY\n10 20\n30 40\n50 60\n');
  const src = buildMemorySource(geo, { kind: 'delimited', delimiter: ' ', blockSize: 2 });
  const d = detectKind(geo);
  const vs = createRecordViewSource(src, { schema: d.schema, dataStart: d.dataStart });
  assert.equal(vs.rowCount(), 3);
  assert.deepEqual(await vs.ensureRow(0), ['10', '20']);
});

// ── detect: .csv extension biases an ambiguous file to a table ──

test('detect: ragged .csv (low consistency) → table via the name hint, text without', () => {
  // rows with varying column counts → consistency < 0.6 → would be text generically
  const ragged = B('a,b,c\n1,2\n3,4,5,6\n7\n8,9,10\n');
  assert.equal(detectKind(ragged).kind, 'text');                       // no name → bails to text
  const d = detectKind(ragged, { name: 'blockmodel.csv' });            // .csv → trust it's a table
  assert.equal(d.kind, 'delimited');
  assert.equal(d.delimiter, ',');
});

// ── column statistics ──

test('scanColumnStats: numeric summary + quantiles', async () => {
  let csv = 'id,grade\n';
  for (let i = 0; i <= 100; i++) csv += `${i},${i}\n`;                  // grade 0..100
  const src = buildMemorySource(B(csv), { kind: 'delimited', blockSize: 16 });
  const st = await scanColumnStats(src, { col: 1, dataStart: 1, numeric: true });
  assert.equal(st.kind, 'number');
  assert.equal(st.count, 101);
  assert.equal(st.n, 101);
  assert.equal(st.min, 0);
  assert.equal(st.max, 100);
  assert.equal(st.mean, 50);
  assert.equal(st.quantiles.p50, 50);
  assert.equal(st.sum, 5050);
});

test('scanColumnStats: categorical top-N + distinct; respects the rows subset', async () => {
  let csv = 'lito\n';
  const lits = ['ox', 'ox', 'ox', 'sulf', 'sulf', 'trans'];
  for (let i = 0; i < 600; i++) csv += `${lits[i % 6]}\n`;
  const src = buildMemorySource(B(csv), { kind: 'text', blockSize: 64 });
  const st = await scanColumnStats(src, { col: 0, dataStart: 1, numeric: false });
  assert.equal(st.kind, 'string');
  assert.equal(st.count, 600);
  assert.equal(st.distinct, 3);
  assert.equal(st.top[0].value, 'ox');
  assert.equal(st.top[0].n, 300);

  // restrict to a subset (e.g. a filter's matches) — first 60 display rows
  const subset = Float64Array.from(Array.from({ length: 60 }, (_, i) => i));
  const st2 = await scanColumnStats(src, { col: 0, dataStart: 1, numeric: false, rows: subset });
  assert.equal(st2.count, 60);
});

test('scanColumnStats: numeric column counts nulls vs non-numeric (bad) separately', async () => {
  // grade column: numbers, one empty, two non-numeric tokens
  const csv = 'id,grade\n0,1\n1,\n2,2\n3,oops\n4,3\n5,NA\n';
  const src = buildMemorySource(B(csv), { kind: 'delimited', blockSize: 2 });
  const st = await scanColumnStats(src, { col: 1, dataStart: 1, numeric: true });
  assert.equal(st.count, 6);
  assert.equal(st.n, 3);            // 1, 2, 3 parsed
  assert.equal(st.nulls, 1);        // the empty cell
  assert.equal(st.bad, 2);          // "oops" + "NA"
  assert.equal(st.max, 3);
});

test('parseFilter: `in` set membership (OR for multiple categorical values)', () => {
  const cols = [{ name: 'lito' }];
  const p = parseFilter('lito in ox, sulf', cols);
  assert.equal(p(['ox']), true);
  assert.equal(p(['sulf']), true);
  assert.equal(p(['trans']), false);
  // quoted values + a single-value set
  assert.equal(parseFilter('lito in "Main Zone"', cols)(['Main Zone']), true);
  // composes with && on another column
  const p2 = parseFilter('lito in ox,sulf && grade > 1', [{ name: 'lito' }, { name: 'grade' }]);
  assert.equal(p2(['ox', '2']), true);
  assert.equal(p2(['ox', '0.5']), false);
  assert.equal(p2(['trans', '2']), false);
});
