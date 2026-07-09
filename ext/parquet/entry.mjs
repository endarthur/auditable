// @gcu/parquet — vendored hyparquet (read) + hyparquet-writer (write) behind a
// micro-facing API, with a WASM-FREE codec set so Sealed builds keep their
// claim. SNAPPY + UNCOMPRESSED are native to hyparquet/-writer (pure JS); we
// add GZIP (fflate, sync) and ZSTD (fzstd, read-only). The decompress callback
// is SYNCHRONOUS — no DecompressionStream here (that's async), unlike gtiff.
import { parquetMetadata, parquetMetadataAsync, parquetReadObjects, parquetRead, parquetSchema, snappyUncompress, toJson } from 'hyparquet';
import { parquetWriteBuffer, ParquetWriter, ByteWriter, schemaFromColumnData } from 'hyparquet-writer';
import { gunzipSync, gzipSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';

// codec name → sync (input, outputLen?) => Uint8Array. Rare codecs (BROTLI,
// LZ4) fall through to hyparquet's "unsupported codec" error — honest, not a
// misread. Add them here if a real file needs one.
export const readCompressors = {
  GZIP: (input) => gunzipSync(input),
  ZSTD: (input) => zstdDecompress(input),
};
// writing: SNAPPY is hyparquet-writer's built-in default; GZIP via fflate. (No
// pure-JS ZSTD encoder in fzstd, so we WRITE snappy/gzip, READ snappy/gzip/zstd.)
export const writeCompressors = {
  GZIP: (bytes) => gzipSync(bytes),
};

// footer ONLY — schema, row count, and per-row-group column stats (min/max/
// nulls). No page decode: this is the free "discovery" + the spatial-index
// substrate. Returns typed columns + a row-group summary.
export function parquetInfo(input) {
  const ab = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input;
  return infoFromMeta(parquetMetadata(ab));
}
// like parquetInfo but RANGE-READS the footer from a File/Blob (or AsyncBuffer)
// — for a census without pulling the whole file into memory (drag-drop preview)
export async function parquetInfoAsync(input) {
  return infoFromMeta(await parquetMetadataAsync(toAsyncBuffer(input)));
}
function infoFromMeta(meta) {
  const rg0 = meta.row_groups && meta.row_groups[0];
  const colName = (c) => (c.meta_data && c.meta_data.path_in_schema || []).join('.');
  const columns = ((rg0 && rg0.columns) || []).map((c) => ({
    name: colName(c), type: c.meta_data && c.meta_data.type, codec: c.meta_data && c.meta_data.codec,
  }));
  const rowGroups = (meta.row_groups || []).map((rg) => ({
    rowCount: Number(rg.num_rows),
    columns: ((rg.columns || []).reduce((o, c) => {
      const m = c.meta_data, st = (m && m.statistics) || {};
      o[colName(c)] = { min: st.min_value, max: st.max_value, nulls: st.null_count != null ? Number(st.null_count) : undefined };
      return o;
    }, {})),
  }));
  return { rowCount: Number(meta.num_rows), columns, rowGroups, codec: columns[0] && columns[0].codec, meta };
}

// read rows as objects (all, or a column/row subset), bound to our codecs
export async function readParquet(input, opts = {}) {
  return parquetReadObjects({ file: toAsyncBuffer(input), compressors: readCompressors, ...opts });
}
// read as COLUMNS (columnar — what micro's pipeline wants): { name: array }
export async function readParquetColumns(input, opts = {}) {
  let out = null;
  await parquetRead({
    file: toAsyncBuffer(input), compressors: readCompressors, rowFormat: 'object', ...opts,
    onComplete: (rows) => { out = rows; },
  });
  return out;
}
// read named columns AS ARRAYS ({ name: array }) — memory-light vs. millions
// of row objects, and columnar is what micro's chunk builder wants. Each
// column decodes once; hyparquet skips the column chunks it isn't asked for.
export async function readParquetColumnMap(input, columns) {
  const info = parquetInfo(input);
  const names = columns || info.columns.map((c) => c.name);
  const out = {};
  for (const name of names) {
    const col = [];
    await parquetRead({ file: toAsyncBuffer(input), compressors: readCompressors, columns: [name], onComplete: (rows) => { for (const r of rows) col.push(r[0]); } });
    out[name] = col;
  }
  return out;
}
// named columns for a ROW RANGE (one row group) as arrays — the streaming
// primitive: hold nothing, decode a group at a time, only the columns asked for.
// `metadata` (parquetInfo(…).meta) skips the per-call footer parse — with a
// Blob/AsyncBuffer input that parse is real I/O, so PASS IT for hot paths.
export async function readParquetRange(input, columns, rowStart, rowEnd, metadata) {
  const out = {};
  for (const name of columns) {
    const col = [];
    await parquetRead({ file: toAsyncBuffer(input), compressors: readCompressors, metadata, columns: [name], rowStart, rowEnd, onComplete: (rows) => { for (const r of rows) col.push(r[0]); } });
    out[name] = col;
  }
  return out;
}
// stream the given columns row-group by row-group → { start, count, cols } —
// one group resident at a time. rowGroups (from parquetInfo) can be passed to
// skip re-parsing the footer each call; `metadata` skips it inside hyparquet too.
export async function* streamParquetColumns(input, columns, rowGroups, metadata) {
  const groups = rowGroups || (await parquetInfoAsync(input)).rowGroups;
  let start = 0;
  for (const rg of groups) {
    const count = rg.rowCount;
    yield { start, count, cols: await readParquetRange(input, columns, start, start + count, metadata) };
    start += count;
  }
}
// one row (all columns) as an object — the pick join; reads only its row group
export async function readParquetRow(input, index, metadata) {
  const rows = await readParquet(input, { rowStart: index, rowEnd: index + 1, metadata });
  return rows[0] || null;
}

// ── STREAMING writer: row groups appended incrementally, finished bytes drained
// to Blob parts after every group (ByteWriter.flush — the library calls it) —
// peak memory ≈ one encoded row group, whatever the file size. The write-side
// twin of streamParquetColumns; the big-model .dm → parquet conversion rides it.
//
// SCHEMA DISCIPLINE: the file schema is fixed at the FIRST write, and raw
// inference commits to whatever group 1 happens to hold (all-whole-numbers →
// INT, no-nulls → REQUIRED — then a later 8.15 or null THROWS; see the same
// trap in writeParquet). So columns are typed CONSERVATIVELY: explicit
// `columnTypes` ({ name → 'DOUBLE' | 'STRING' | … }) when the caller knows
// (a .dm DD does), else number→DOUBLE / string→STRING from the first batch;
// everything nullable (OPTIONAL — the library default).
export function createParquetBlobWriter({ schema = null, columnTypes = null, codec = 'SNAPPY', kvMetadata } = {}) {
  const parts = [];
  const bw = new ByteWriter();
  bw.flush = function () { if (this.index) { parts.push(this.getBuffer()); this.index = 0; } };
  let pw = null, sch = schema;
  const guessType = (data) => {
    for (const v of data) {
      if (v == null) continue;
      if (typeof v === 'number') return 'DOUBLE';
      if (typeof v === 'boolean') return 'BOOLEAN';
      if (typeof v === 'bigint') return 'INT64';
      return 'STRING';
    }
    return 'STRING';                                       // all-null first batch — strings hold anything
  };
  return {
    // columnData: [{ name, data }] — one call per row group (any size)
    write(columnData) {
      if (!pw) {
        if (!sch) {
          const cd = columnData.map((c) => ({ ...c, type: (columnTypes && columnTypes[c.name]) || c.type || guessType(c.data) }));
          sch = schemaFromColumnData({ columnData: cd });
        }
        pw = new ParquetWriter({ writer: bw, schema: sch, codec, compressors: writeCompressors, statistics: true, kvMetadata });
      }
      pw.write({ columnData, rowGroupSize: (columnData[0] && columnData[0].data.length) || 1 });
    },
    finish() {
      if (!pw) throw new Error('parquet blob writer: nothing written');
      pw.finish(); bw.flush();
      return new Blob(parts, { type: 'application/vnd.apache.parquet' });
    },
  };
}

// write columnar data → parquet bytes. columnData: [{ name, data:Array, type? }].
// rowGroupSize defaults to 1<<16 (micro's spatial-index granularity).
export function writeParquet({ columnData, rowGroupSize = 65536, codec = 'SNAPPY', kvMetadata } = {}) {
  // hyparquet-writer fixes a column's physical type from the FIRST row group.
  // A numeric column that happens to be all whole numbers there commits to INT,
  // then throws on a later fractional value ("expected integer value, got 8.15")
  // — e.g. a grade column that's 0 across an early band of waste blocks. Guard:
  // pre-scan the WHOLE column (not just row group 1); any finite non-integer
  // number in an untyped column → declare DOUBLE up front.
  const cd = columnData.map((c) => {
    if (c.type) return c;
    const d = c.data;
    for (let i = 0; i < d.length; i++) { const v = d[i]; if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) return { ...c, type: 'DOUBLE' }; }
    return c;
  });
  return parquetWriteBuffer({ columnData: cd, rowGroupSize, codec, compressors: writeCompressors, statistics: true, kvMetadata });
}

// hyparquet wants an AsyncBuffer ({ byteLength, slice }); a raw ArrayBuffer /
// Uint8Array is wrapped. (A future streaming source can implement slice() to
// range-read a File without loading it whole.)
function toAsyncBuffer(input) {
  if (input && typeof input.slice === 'function' && typeof input.byteLength === 'number' && !(input instanceof Uint8Array)) return input;   // already an AsyncBuffer
  if (typeof Blob !== 'undefined' && input instanceof Blob) {   // File / Blob → range-read via slice().arrayBuffer(), no full load
    return { byteLength: input.size, async slice(s, e) { return input.slice(s, e == null ? input.size : e).arrayBuffer(); } };
  }
  const ab = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input;
  return { byteLength: ab.byteLength, async slice(s, e) { return ab.slice(s, e); } };
}

export { parquetMetadata, parquetMetadataAsync, parquetReadObjects, parquetRead, parquetSchema, parquetWriteBuffer, snappyUncompress, toJson };

export { schemaFromColumnData };
