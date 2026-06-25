// @gcu/lamina — the record-offset scanner + read-time splitters. The crux of the
// windowed viewer: a chunk-fed scan must find record boundaries correctly
// (quote-aware, CRLF, across chunk edges) and a coarse block index must
// reconstruct any window. Pure, in `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecordScanner, scanRecords, splitRecords, parseFields } from '../ext/lamina/src/scan.js';

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
