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
    'from-csv': _fromCsv,
    'to-csv':   _toCsv,
    where:      _where,
    select:     _select,
    'first':    _first,
    'last':     _last,
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
  const text = ctx.stdin == null ? '' : String(ctx.stdin);
  return parseCSV(text);
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
