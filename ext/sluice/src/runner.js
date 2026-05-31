// @gcu/sluice — the cold-recipe scan runner.
//
// A Source is a thunk returning a FRESH stream each call (cold; never shared —
// sharing across consumers is the cache's job, not a live tee). A recipe is
// { source, ops } — ops are pure transforms over the row stream. scan() opens
// the source fresh, pipes the ops, pumps an accumulator, returns its result.
// Fusion is free: recipe(src, ...a.ops, ...b.ops) — adjacent ops run in one pass.
//
// Division of labour: sluice does the *mechanical* streaming + parse-given-config
// + accumulate. *Inferring* delimiter/types/geometry is the importer's job — it
// produces the config sluice consumes.

// The mining-software null vocabulary (harvested from BMA). Numeric fields
// matching these become NaN rather than a stolen real value.
export const NULL_SENTINELS = new Set([
  '', 'NA', 'NaN', 'na', 'nan', 'N/A', 'n/a', 'null', 'NULL', '*', '-',
  '-999', '-99', '#N/A', 'VOID', 'void', '-1.0e+32', '-1e+32', '1e+31', '-9999', '-99999',
]);

// ── Sources ───────────────────────────────────────────────────────────
export function source(thunk) {
  if (typeof thunk !== 'function') throw new Error('sluice: source(thunk) needs a function');
  return thunk;
}
export function fromText(str) {
  return () => new ReadableStream({ start(c) { c.enqueue(str); c.close(); } });
}
export function fromBytes(u8) {
  return () => new ReadableStream({ start(c) { c.enqueue(u8); c.close(); } });
}
export function fromBlob(blob) { return () => blob.stream(); }
export function fromFile(file) { return () => file.stream(); }

// ── Lines ─────────────────────────────────────────────────────────────
// Decode bytes incrementally with TextDecoder (portable; avoids TextDecoderStream).
// Strips trailing \r, skips comment lines. Yields every other line (blanks too;
// parseCsv skips blanks after the header).
export async function* lines(src, { comment = '#' } = {}) {
  const reader = src().getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += typeof value === 'string' ? value : dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const raw of parts) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (comment && line.startsWith(comment)) continue;
        yield line;
      }
    }
    buf += dec.decode();
    if (buf.length) {
      const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
      if (!(comment && line.startsWith(comment))) yield line;
    }
  } finally {
    if (reader.releaseLock) reader.releaseLock();
  }
}

// First n non-comment lines — feeds the importer's inference.
export async function sample(src, n, opts) {
  const out = [];
  for await (const line of lines(src, opts)) { out.push(line); if (out.length >= n) break; }
  return out;
}

// ── Ops (line/row transforms; each is iter -> iter) ──────────────────────
const unquote = (s) => s.replace(/^["']|["']$/g, '');

// parseCsv — text lines -> row objects, GIVEN config.
//   delimiter: field separator (default ',')
//   header: true (consume first line as names) | string[] (explicit names)
//   columns: [{ name, type }] — type 'numeric' coerces (NULL_SENTINELS -> NaN);
//            absent -> auto (number if it parses, else string), mirroring BMA.
export function parseCsv({ delimiter = ',', header = true, columns = null } = {}) {
  const typeOf = columns ? Object.fromEntries(columns.map((c) => [c.name, c.type])) : null;
  return async function* (lineIter) {
    let names = Array.isArray(header) ? header : null;
    for await (const line of lineIter) {
      if (line === '') continue;
      const fields = line.split(delimiter);
      if (names === null) { names = fields.map((h) => unquote(h.trim())); continue; }
      const row = {};
      for (let i = 0; i < names.length; i++) {
        const raw = unquote((fields[i] ?? '').trim());
        const t = typeOf ? typeOf[names[i]] : null;
        if (t === 'numeric') {
          row[names[i]] = NULL_SENTINELS.has(raw) ? NaN : Number(raw);
        } else if (t && t !== 'numeric') {
          row[names[i]] = raw;
        } else {
          row[names[i]] = NULL_SENTINELS.has(raw) ? NaN : (raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw);
        }
      }
      yield row;
    }
  };
}

export function filter(pred) {
  return async function* (it) { for await (const r of it) if (pred(r)) yield r; };
}
export function map(fn) {
  return async function* (it) { for await (const r of it) yield fn(r); };
}
export function select(cols) {
  return async function* (it) {
    for await (const r of it) { const o = {}; for (const c of cols) o[c] = r[c]; yield o; }
  };
}

// ── Recipe + scan ────────────────────────────────────────────────────
export function recipe(src, ...ops) { return { source: src, ops, comment: '#' }; }

// scanState — run the recipe, return the raw accumulator STATE (mergeable,
// transferable). This is what the parallel fan-out uses:
//   const states = await Promise.all(sources.map(s => scanState(recipe(s, ...ops), acc)));
//   const merged = states.reduce(acc.merge);
//   const out = acc.result(merged);
export async function scanState(rec, acc) {
  let iter = lines(rec.source, { comment: rec.comment });
  for (const op of (rec.ops || [])) iter = op(iter);
  const state = acc.create();
  for await (const item of iter) acc.push(state, item);
  return state;
}

// scan — run the recipe and finalize to the accumulator's result.
export async function scan(rec, acc) {
  return acc.result(await scanState(rec, acc));
}

// ── Boundary-aware chunking (sluice owns it — it has the line logic) ────
// Splits a sliceable Blob/File into n sub-sources at line boundaries, with the
// header stripped from all of them and returned separately, so every chunk
// parses identically: parseCsv({ header: result.header }). Enables parallel
// scan-then-merge (states are mergeable; the engine fans out to workers).
export async function chunks(file, n, { comment = '#' } = {}) {
  const size = file.size;
  if (!(size > 0) || !(n >= 1)) return { header: [], sources: [] };
  const dataStart = await findNewline(file, 0);          // after the header line
  const headerLine = await readLine(file, 0, dataStart);
  const header = headerLine.split(detectFieldSep(headerLine)).map((h) => unquote(h.trim()));

  const bounds = [dataStart];
  for (let k = 1; k < n; k++) {
    const nominal = dataStart + Math.floor((size - dataStart) * k / n);
    const b = await findNewline(file, nominal);
    if (b > bounds[bounds.length - 1] && b < size) bounds.push(b);
  }
  bounds.push(size);

  const sources = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end > start) sources.push(fromBlob(file.slice(start, end)));
  }
  void comment;
  return { header, sources };
}

async function findNewline(file, pos) {
  const WIN = 65536, size = file.size;
  let off = pos;
  while (off < size) {
    const buf = new Uint8Array(await file.slice(off, Math.min(off + WIN, size)).arrayBuffer());
    const i = buf.indexOf(10); // '\n'
    if (i >= 0) return off + i + 1;
    off += WIN;
  }
  return size;
}

async function readLine(file, start, end) {
  const buf = await file.slice(start, end).arrayBuffer();
  let s = new TextDecoder().decode(buf);
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s.endsWith('\r')) s = s.slice(0, -1);
  return s;
}

// Lightweight separator sniff for the header line only (delimiter inference
// proper lives in the importer; this just splits the header into names).
function detectFieldSep(line) {
  let best = ',', bestN = line.split(',').length;
  for (const d of ['\t', ';', '|']) {
    const c = line.split(d).length;
    if (c > bestN) { best = d; bestN = c; }
  }
  return best;
}
