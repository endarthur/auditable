// @gcu/parquet — vendored hyparquet (read) + hyparquet-writer (write) behind a
// micro-facing API, with a WASM-FREE codec set so Sealed builds keep their
// claim. SNAPPY + UNCOMPRESSED are native to hyparquet/-writer (pure JS); we
// add GZIP (fflate, sync) and ZSTD (fzstd, read-only). The decompress callback
// is SYNCHRONOUS — no DecompressionStream here (that's async), unlike gtiff.
import { parquetMetadata, parquetMetadataAsync, parquetReadObjects, parquetRead, parquetSchema, snappyUncompress, toJson } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
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
  const meta = parquetMetadata(input);
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
// write columnar data → parquet bytes. columnData: [{ name, data:Array, type? }].
// rowGroupSize defaults to 1<<16 (micro's spatial-index granularity).
export function writeParquet({ columnData, rowGroupSize = 65536, codec = 'SNAPPY', kvMetadata } = {}) {
  return parquetWriteBuffer({ columnData, rowGroupSize, codec, compressors: writeCompressors, statistics: true, kvMetadata });
}

// hyparquet wants an AsyncBuffer ({ byteLength, slice }); a raw ArrayBuffer /
// Uint8Array is wrapped. (A future streaming source can implement slice() to
// range-read a File without loading it whole.)
function toAsyncBuffer(input) {
  if (input && typeof input.slice === 'function' && typeof input.byteLength === 'number' && !(input instanceof Uint8Array)) return input;
  const ab = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input;
  return { byteLength: ab.byteLength, async slice(s, e) { return ab.slice(s, e); } };
}

export { parquetMetadata, parquetMetadataAsync, parquetReadObjects, parquetRead, parquetSchema, parquetWriteBuffer, snappyUncompress, toJson };
