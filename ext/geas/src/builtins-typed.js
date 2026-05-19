// Typed-pipe-aware built-ins. These produce or consume Typed table values
// instead of (or in addition to) text. The shell auto-registers them via
// defaultBuiltins(); third-party builtins from the GCU stack (e.g. a
// future sadpan-backed `read-csv`) can override.
//
// Demo surface for v0:
//
//   from-csv FILE | where 'COL > N' | select COL1 COL2 | to-csv
//
// `from-csv` produces a Typed table; `where` and `select` consume and
// produce Typed tables (passing through unchanged when their input is text
// — they parse the text as CSV on the fly); `to-csv` serialises back to
// text. Mix-and-match with text builtins works because Typed.toString()
// returns the canonical CSV text, so e.g. `from-csv f.csv | head -n 5`
// degrades gracefully (head reads the CSV text and slices the first 5
// lines, ignoring that columns are involved).

import { mkTyped, isTyped, parseCSV, serializeCSV, formatTable } from './typed.js';

export function defaultTypedBuiltins() {
  return {
    'from-csv':  _fromCsv,
    'to-csv':    _toCsv,
    'from-json': _fromJson,
    'to-json':   _toJson,
    where:       _where,
    select:      _select,
    'first':     _first,
    'last':      _last,
    display:     _display,
    plot:        _plot,
  };
}

// Read a CSV from file (or stdin) and emit a Typed table downstream.
async function _fromCsv(argv, ctx) {
  const path = argv[1];
  let text;
  try {
    if (path) {
      if (!ctx.vfs) {
        await ctx.stderr('from-csv: no VFS configured\n');
        return 1;
      }
      const abs = path.startsWith('/') ? path
        : (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + path;
      text = await ctx.vfs.readFile(abs, 'text');
    } else {
      // No path → read from stdin.
      text = ctx.stdin == null ? ''
        : typeof ctx.stdin === 'string' ? ctx.stdin
        : String(ctx.stdin);
    }
  } catch (e) {
    await ctx.stderr(`from-csv: ${e.message}\n`);
    return 1;
  }
  const table = parseCSV(text);
  await ctx.stdout(mkTyped('table', table, () => serializeCSV(table)));
  return 0;
}

// Convert Typed table → CSV text. Idempotent on text input.
async function _toCsv(_argv, ctx) {
  const v = ctx.stdin;
  if (isTyped(v) && v.kind === 'table') {
    await ctx.stdout(serializeCSV(v.value));
    return 0;
  }
  // Already text — pass through.
  await ctx.stdout(typeof v === 'string' ? v : String(v ?? ''));
  return 0;
}

// where 'COL OP VALUE' — filter table rows. Operators: == != > < >= <=
// VALUE may be a number (compared numerically) or a quoted-or-bare string.
// On text input, parses as CSV first; on Typed input, operates directly.
async function _where(argv, ctx) {
  const expr = argv[1];
  if (!expr) {
    await ctx.stderr('where: missing expression\n');
    return 2;
  }
  const pred = _compilePredicate(expr);
  if (!pred) {
    await ctx.stderr(`where: cannot parse expression "${expr}"\n`);
    return 2;
  }
  const table = await _consumeTable(ctx);
  const colIdx = table.columns.indexOf(pred.col);
  if (colIdx < 0) {
    await ctx.stderr(`where: no column "${pred.col}"\n`);
    return 2;
  }
  const filtered = {
    columns: table.columns,
    rows: table.rows.filter(r => pred.test(r[colIdx])),
  };
  await ctx.stdout(mkTyped('table', filtered, () => serializeCSV(filtered)));
  return 0;
}

// select COL1 COL2 ... — project columns by name. Unknown columns warned
// on stderr; the result drops them but doesn't fail.
async function _select(argv, ctx) {
  const names = argv.slice(1);
  if (names.length === 0) {
    await ctx.stderr('select: missing column names\n');
    return 2;
  }
  const table = await _consumeTable(ctx);
  const indices = names.map(n => {
    const i = table.columns.indexOf(n);
    if (i < 0) ctx.stderr(`select: warning: no column "${n}"\n`);
    return i;
  }).filter(i => i >= 0);
  const projected = {
    columns: indices.map(i => table.columns[i]),
    rows: table.rows.map(r => indices.map(i => r[i])),
  };
  await ctx.stdout(mkTyped('table', projected, () => serializeCSV(projected)));
  return 0;
}

// first [N] / last [N] — slice first/last N rows. Defaults to 5.
async function _first(argv, ctx) {
  const n = argv[1] ? Math.max(0, parseInt(argv[1], 10)) : 5;
  const table = await _consumeTable(ctx);
  const sliced = { columns: table.columns, rows: table.rows.slice(0, n) };
  await ctx.stdout(mkTyped('table', sliced, () => serializeCSV(sliced)));
  return 0;
}
async function _last(argv, ctx) {
  const n = argv[1] ? Math.max(0, parseInt(argv[1], 10)) : 5;
  const table = await _consumeTable(ctx);
  const sliced = { columns: table.columns, rows: table.rows.slice(-n) };
  await ctx.stdout(mkTyped('table', sliced, () => serializeCSV(sliced)));
  return 0;
}

// Common: pull a table out of ctx.stdin, parsing text if needed.
async function _consumeTable(ctx) {
  if (isTyped(ctx.stdin) && ctx.stdin.kind === 'table') {
    return ctx.stdin.value;
  }
  // JSON-array of flat objects → table (GCU-shape; sadpan-friendly).
  if (isTyped(ctx.stdin) && ctx.stdin.kind === 'array'
      && Array.isArray(ctx.stdin.value)
      && ctx.stdin.value.length > 0
      && typeof ctx.stdin.value[0] === 'object'
      && !Array.isArray(ctx.stdin.value[0])) {
    return _objectArrayToTable(ctx.stdin.value);
  }
  const text = ctx.stdin == null ? '' : String(ctx.stdin);
  return parseCSV(text);
}

// ── from-json / to-json ──
//
// from-json [FILE]: read JSON from FILE or stdin, emit a Typed value
// shaped to the JSON's structure:
//   - array of flat objects → kind='table' (where/select usable)
//   - array of primitives or mixed → kind='array'
//   - object → kind='object'
//   - scalar → text (no typing needed)
//
// to-json: consume any Typed value (or JSON text) and serialize to JSON
// text. `--pretty` (or `-p`) for indented output. Tables serialize as
// arrays of objects keyed by column name (the canonical JSON shape).
async function _fromJson(argv, ctx) {
  const path = argv[1];
  let text;
  try {
    if (path) {
      if (!ctx.vfs) {
        await ctx.stderr('from-json: no VFS configured\n');
        return 1;
      }
      const abs = path.startsWith('/') ? path
        : (ctx.cwd.endsWith('/') ? ctx.cwd : ctx.cwd + '/') + path;
      text = await ctx.vfs.readFile(abs, 'text');
    } else {
      text = ctx.stdin == null ? ''
        : typeof ctx.stdin === 'string' ? ctx.stdin
        : String(ctx.stdin);
    }
  } catch (e) {
    await ctx.stderr(`from-json: ${e.message}\n`);
    return 1;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    await ctx.stderr(`from-json: parse error: ${e.message}\n`);
    return 1;
  }
  // Shape-routing: array of homogeneous flat objects becomes a table.
  if (Array.isArray(parsed) && parsed.length > 0
      && parsed.every(r => r != null && typeof r === 'object' && !Array.isArray(r))) {
    const table = _objectArrayToTable(parsed);
    await ctx.stdout(mkTyped('table', table, () => JSON.stringify(parsed)));
    return 0;
  }
  if (Array.isArray(parsed)) {
    await ctx.stdout(mkTyped('array', parsed, () => JSON.stringify(parsed)));
    return 0;
  }
  if (parsed !== null && typeof parsed === 'object') {
    await ctx.stdout(mkTyped('object', parsed, () => JSON.stringify(parsed)));
    return 0;
  }
  // Scalars: just emit as text.
  await ctx.stdout(JSON.stringify(parsed) + '\n');
  return 0;
}

async function _toJson(argv, ctx) {
  const pretty = argv.slice(1).some(a => a === '--pretty' || a === '-p');
  const indent = pretty ? 2 : 0;
  const v = ctx.stdin;
  let obj;
  if (isTyped(v)) {
    if (v.kind === 'table') obj = _tableToObjectArray(v.value);
    else obj = v.value;
  } else if (typeof v === 'string') {
    // Best-effort: try to JSON-parse text input; otherwise emit as quoted string.
    try { obj = JSON.parse(v); }
    catch { obj = v; }
  } else if (v == null) {
    obj = null;
  } else {
    obj = v;
  }
  await ctx.stdout(JSON.stringify(obj, null, indent) + '\n');
  return 0;
}

// Convert an array of flat objects into a {columns, rows} table.
// Column order = first-seen order across all rows.
function _objectArrayToTable(arr) {
  const colSet = new Set();
  for (const r of arr) for (const k of Object.keys(r)) colSet.add(k);
  const columns = [...colSet];
  const rows = arr.map(r => columns.map(c => r[c] ?? ''));
  return { columns, rows };
}

function _tableToObjectArray(table) {
  const cols = table.columns || [];
  return (table.rows || []).map(row => {
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
    return obj;
  });
}

// ── display / plot ──
//
// display: render whatever's in the pipe as text. Tables get
// fixed-width column layout; arrays/objects get JSON; everything
// else passes through as text. Useful for forcing a human-readable
// rendering mid-pipeline or before saving.
//
// plot [--kind line|scatter|bar|hist] [--x COL] [--y COL]: emit a
// Typed 'plot' descriptor that an adapter capable of rich-block
// rendering can show as a chart. Fallback text rendering is an ASCII
// sparkline + summary (min/max/n), so degradation to terminal is
// graceful.
async function _display(_argv, ctx) {
  const v = ctx.stdin;
  if (v == null) return 0;
  if (isTyped(v)) {
    if (v.kind === 'table') {
      await ctx.stdout(formatTable(v.value));
      return 0;
    }
    if (v.kind === 'array' || v.kind === 'object') {
      await ctx.stdout(JSON.stringify(v.value, null, 2) + '\n');
      return 0;
    }
    // Unknown typed kind: fall back to its text rendering.
    await ctx.stdout(String(v));
    return 0;
  }
  await ctx.stdout(typeof v === 'string' ? v : String(v));
  return 0;
}

async function _plot(argv, ctx) {
  const opts = { kind: 'line', x: null, y: null };
  const cols = [];
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--x' && i + 1 < argv.length) { opts.x = argv[++i]; i++; continue; }
    if (a === '--y' && i + 1 < argv.length) { opts.y = argv[++i]; i++; continue; }
    if (a === '--kind' && i + 1 < argv.length) { opts.kind = argv[++i]; i++; continue; }
    if (a.startsWith('--')) { i++; continue; }
    cols.push(a);
    i++;
  }
  const table = await _consumeTable(ctx);
  // Resolve x/y. Default behaviour:
  //   1-positional COL → y=COL, x=row index
  //   2-positional X Y → x=X, y=Y
  //   --y / --x override
  let xCol = opts.x;
  let yCol = opts.y ?? cols[cols.length - 1] ?? table.columns[0];
  if (!opts.x && cols.length >= 2) xCol = cols[0];
  const yIdx = table.columns.indexOf(yCol);
  if (yIdx < 0) {
    await ctx.stderr(`plot: no column "${yCol}"\n`);
    return 2;
  }
  const xIdx = xCol ? table.columns.indexOf(xCol) : -1;
  if (xCol && xIdx < 0) {
    await ctx.stderr(`plot: no column "${xCol}"\n`);
    return 2;
  }
  const ys = table.rows.map(r => Number(r[yIdx])).filter(n => Number.isFinite(n));
  const xs = xIdx >= 0
    ? table.rows.map(r => Number(r[xIdx]))
    : ys.map((_, k) => k);
  const spec = { kind: opts.kind, xCol: xCol ?? '_index', yCol, xs, ys };
  await ctx.stdout(mkTyped('plot', spec, () => _plotAscii(spec)));
  return 0;
}

function _plotAscii(spec) {
  if (spec.ys.length === 0) return '(no data)\n';
  if (spec.kind === 'hist') return _histAscii(spec);
  const min = Math.min(...spec.ys);
  const max = Math.max(...spec.ys);
  const range = max - min || 1;
  const blocks = '▁▂▃▄▅▆▇█';
  let bar = '';
  for (const v of spec.ys) {
    const t = (v - min) / range;
    const k = Math.min(blocks.length - 1, Math.max(0, Math.floor(t * blocks.length)));
    bar += blocks[k];
  }
  const head = `${spec.kind} ${spec.yCol}`;
  const footer = `min=${_fmtNum(min)} max=${_fmtNum(max)} n=${spec.ys.length}`;
  return `${head}\n${bar}\n${footer}\n`;
}

function _histAscii(spec) {
  const n = spec.ys.length;
  if (n === 0) return '(no data)\n';
  const min = Math.min(...spec.ys);
  const max = Math.max(...spec.ys);
  const bins = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(n))));
  const w = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of spec.ys) {
    let k = Math.floor((v - min) / w);
    if (k >= bins) k = bins - 1;
    if (k < 0) k = 0;
    counts[k]++;
  }
  const peak = Math.max(...counts);
  const blocks = '▁▂▃▄▅▆▇█';
  let bar = '';
  for (const c of counts) {
    const t = peak ? c / peak : 0;
    const i = Math.min(blocks.length - 1, Math.max(0, Math.floor(t * blocks.length)));
    bar += blocks[i];
  }
  return `hist ${spec.yCol}\n${bar}\nmin=${_fmtNum(min)} max=${_fmtNum(max)} bins=${bins} n=${n}\n`;
}

function _fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

// ── predicate parser for `where` ──
//
// Grammar (v0):
//   COL OP RHS
//   COL  := identifier or quoted string
//   OP   := == | != | >= | <= | > | <
//   RHS  := number | "quoted string" | 'quoted string' | bare identifier
//
// Returns { col, op, test: (cellValue) => bool } or null on parse failure.
function _compilePredicate(expr) {
  const m = expr.match(/^\s*([A-Za-z_][A-Za-z0-9_]*|"[^"]*"|'[^']*')\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!m) return null;
  let col = m[1];
  const op = m[2];
  let rhs = m[3];
  if ((col.startsWith('"') && col.endsWith('"')) ||
      (col.startsWith("'") && col.endsWith("'"))) col = col.slice(1, -1);
  // Unquote RHS if it's a quoted string; otherwise try numeric.
  let rhsVal;
  if ((rhs.startsWith('"') && rhs.endsWith('"')) ||
      (rhs.startsWith("'") && rhs.endsWith("'"))) {
    rhsVal = rhs.slice(1, -1);
  } else if (/^-?\d+(?:\.\d+)?$/.test(rhs)) {
    rhsVal = Number(rhs);
  } else {
    rhsVal = rhs;
  }
  const numericCompare = typeof rhsVal === 'number';
  const test = (cell) => {
    let a = cell;
    let b = rhsVal;
    if (numericCompare) {
      a = Number(cell);
      if (Number.isNaN(a)) return false;
    } else {
      a = String(cell ?? '');
      b = String(b);
    }
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a >  b;
      case '<':  return a <  b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
    return false;
  };
  return { col, op, test };
}
