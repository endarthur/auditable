// @gcu/parquet — vendored hyparquet(+writer) behind a WASM-free codec set.
// Round-trip a columnar table (snappy default + gzip), read the footer for
// discovery-without-decode (columns + per-row-group stats), read rows back,
// and confirm row-group sizing (the spatial-index granularity).
import { test } from 'node:test';
import assert from 'node:assert';
import { zstdCompressSync } from 'node:zlib';
import { writeParquet, readParquet, readParquetColumns, parquetInfo, parquetWriteBuffer, writeCompressors, streamParquetColumns, readParquetRange, readParquetRow } from '../ext/parquet/index.js';

// a little block-model-shaped table: XC,YC,ZC + FE + a LITO string
const N = 5000;
const XC = [], YC = [], ZC = [], FE = [], LITO = [];
for (let i = 0; i < N; i++) {
  XC.push(612000 + (i % 50) * 10);
  YC.push(7765000 + ((i / 50 | 0) % 50) * 10);
  ZC.push(650 + ((i / 2500) | 0) * 5);
  FE.push(30 + (i % 40));
  LITO.push(i % 3 === 0 ? 'HEMATITE' : i % 3 === 1 ? 'ITABIRITE' : 'WASTE');
}
const columnData = [
  { name: 'XC', data: XC }, { name: 'YC', data: YC }, { name: 'ZC', data: ZC },
  { name: 'FE', data: FE }, { name: 'LITO', data: LITO },
];

test('snappy round-trip (default codec) — columns + values', async () => {
  const buf = writeParquet({ columnData, rowGroupSize: 1024 });
  const rows = await readParquet(buf);
  assert.equal(rows.length, N);
  assert.equal(rows[0].XC, 612000);
  assert.equal(rows[123].FE, 30 + (123 % 40));
  assert.equal(rows[1].LITO, 'ITABIRITE');
});

test('parquetInfo: discovery from the footer, no data decode', () => {
  const buf = writeParquet({ columnData, rowGroupSize: 1024 });
  const info = parquetInfo(buf);
  assert.equal(info.rowCount, N);
  assert.deepEqual(info.columns.map((c) => c.name), ['XC', 'YC', 'ZC', 'FE', 'LITO']);
  assert.equal(info.codec, 'SNAPPY');
  // 5000 rows / 1024 → 5 row groups (the spatial-index granularity)
  assert.equal(info.rowGroups.length, 5);
  assert.equal(info.rowGroups[0].rowCount, 1024);
  // per-row-group column stats are present — the spatial-index substrate
  const xStats = info.rowGroups[0].columns.XC;
  assert.ok(xStats && xStats.min != null && xStats.max != null, `XC stats ${JSON.stringify(xStats)}`);
  assert.ok(Number(xStats.min) >= 612000 && Number(xStats.max) <= 612490);
});

test('gzip codec round-trips (fflate, sync)', async () => {
  const buf = writeParquet({ columnData, codec: 'GZIP', rowGroupSize: 2000 });
  assert.equal(parquetInfo(buf).codec, 'GZIP');
  const rows = await readParquet(buf);
  assert.equal(rows.length, N);
  assert.equal(rows[4999].LITO, 'ITABIRITE');   // 4999 % 3 === 1
  assert.equal(rows[2500].ZC, 655);
});

test('columnar read returns whole columns', async () => {
  const buf = writeParquet({ columnData, rowGroupSize: 2000 });
  const rows = await readParquetColumns(buf, { columns: ['XC', 'FE'] });
  assert.equal(rows.length, N);
  assert.equal(rows[10].XC, 612000 + (10 % 50) * 10);
  assert.equal(rows[10].FE, 30 + (10 % 40));
  assert.equal(rows[10].ZC, undefined);          // not requested
});

test('row / column subset reads', async () => {
  const buf = writeParquet({ columnData, rowGroupSize: 1000 });
  const rows = await readParquet(buf, { rowStart: 100, rowEnd: 110, columns: ['ZC'] });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].ZC, ZC[100]);
});

test('zstd read path (fzstd) decodes a real zstd file', async () => {
  // no pure-JS zstd ENCODER in fzstd, so encode the fixture with node's zstd
  // via the writer's compressor hook, then read it back through our fzstd map
  const buf = parquetWriteBuffer({
    columnData, rowGroupSize: 2000, codec: 'ZSTD', statistics: true,
    compressors: { ...writeCompressors, ZSTD: (bytes) => new Uint8Array(zstdCompressSync(bytes)) },
  });
  assert.equal(parquetInfo(buf).codec, 'ZSTD');
  const rows = await readParquet(buf);                    // ZSTD decode via fzstd
  assert.equal(rows.length, N);
  assert.equal(rows[777].FE, 30 + (777 % 40));
  assert.equal(rows[3333].LITO, 'HEMATITE');              // 3333 % 3 === 0
});

test('streamParquetColumns yields a row group at a time (nothing held)', async () => {
  const buf = writeParquet({ columnData, rowGroupSize: 1000 });   // 5000 rows → 5 groups
  const seen = [];
  let total = 0;
  for await (const { start, count, cols } of streamParquetColumns(buf, ['XC', 'FE'])) {
    seen.push([start, count]);
    assert.equal(cols.XC.length, count);
    assert.equal(cols.XC[0], XC[start]);            // first row of the group
    assert.equal(cols.FE[count - 1], FE[start + count - 1]);
    total += count;
  }
  assert.equal(total, N);
  assert.equal(seen.length, 5);
  assert.deepEqual(seen[0], [0, 1000]);
});

test('readParquetRange + readParquetRow are targeted (one group / one row)', async () => {
  const buf = writeParquet({ columnData, rowGroupSize: 1000 });
  const rng = await readParquetRange(buf, ['ZC', 'LITO'], 2500, 2510);
  assert.equal(rng.ZC.length, 10);
  assert.equal(rng.ZC[0], ZC[2500]);
  assert.equal(rng.LITO[3], LITO[2503]);
  const row = await readParquetRow(buf, 4321);
  assert.equal(row.XC, XC[4321]);
  assert.equal(row.LITO, LITO[4321]);
});

test('kvMetadata survives the round trip (a place to stamp micro geo/frame)', () => {
  const buf = writeParquet({ columnData: [{ name: 'A', data: [1, 2, 3] }], kvMetadata: [{ key: 'micro:frame', value: '{"origin":[612000,7765000,0]}' }] });
  const meta = parquetInfo(buf).meta;
  const kv = (meta.key_value_metadata || []).find((k) => k.key === 'micro:frame');
  assert.ok(kv && /612000/.test(kv.value), `kv ${JSON.stringify(kv)}`);
});
