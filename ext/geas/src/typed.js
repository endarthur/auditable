// Typed pipe protocol — the GCU-distinctive feature.
//
// Pipes carry one of two payload shapes:
//
//   string       — POSIX-shape text (default)
//   Typed object — { __geas_typed: true, kind, value, toString }
//
// When the previous stage's stdout is a Typed value, the next stage's ctx.stdin
// is that Typed object. Stages that recognise its `kind` can read `.value`
// directly without re-parsing. Stages that don't (cat, grep, head, etc.)
// fall back to `String(stdin)` — the Typed object's `toString()` returns
// its text rendering, so the pipe degrades gracefully to POSIX semantics.
//
// Capability negotiation is implicit: producers always emit Typed; consumers
// inspect `__geas_typed`. No explicit handshake. The terminal adapter does
// a separate negotiation via `caps()` for inline rich-block rendering of
// the final pipe stage's typed output.

// ── factory ──

// Construct a Typed value. `text` is the canonical text rendering used by
// downstream non-typed consumers and by terminal adapters without rich-block
// support. Can be a string OR a function () => string for lazy rendering.
export function mkTyped(kind, value, text) {
  const tv = {
    __geas_typed: true,
    kind,
    value,
    toString() { return typeof text === 'function' ? text() : text; },
  };
  // Make sure `'' + tv` / template literals invoke toString correctly.
  // (Object stringification falls back to toString automatically.)
  return tv;
}

export function isTyped(v) {
  return v != null && typeof v === 'object' && v.__geas_typed === true;
}

// Convert any pipe payload to text. Used by builtins that don't understand
// the Typed kind — they read input through here and get a string.
export function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (isTyped(v)) return v.toString();
  return String(v);
}

// ── CSV helpers (minimal) ──
//
// v0 ships a compact CSV parser/serialiser inline so the typed-pipe demo
// works without dragging in sadpan. The format is small but POSIX-friendly:
//
//   parseCSV(text, opts)   → { columns: string[], rows: any[][] }
//   serializeCSV(table)    → string (with trailing newline if rows > 0)
//
// Quoting: double-quote-wrapped fields with ""-doubled embedded quotes.
// Delimiter: comma by default; opts.delim overrides.

export function parseCSV(text, opts = {}) {
  const delim = opts.delim || ',';
  if (!text || text.length === 0) return { columns: [], rows: [] };
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const records = _parseCSVRecords(trimmed, delim);
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0];
  const rows = records.slice(1);
  return { columns, rows };
}

function _parseCSVRecords(text, delim) {
  const out = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  // Last field / row.
  row.push(field);
  if (row.length > 1 || row[0] !== '') out.push(row);
  return out;
}

export function serializeCSV(table, opts = {}) {
  const delim = opts.delim || ',';
  const escape = (v) => {
    const s = String(v ?? '');
    if (s.includes(delim) || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [];
  if (table.columns && table.columns.length > 0) {
    lines.push(table.columns.map(escape).join(delim));
  }
  for (const row of table.rows || []) {
    lines.push(row.map(escape).join(delim));
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

// Pretty-format a table as a fixed-width text block, for tty fallback.
// Used by Typed-table.toString() in the absence of structured rendering.
export function formatTable(table, opts = {}) {
  const max = opts.maxRows ?? 50;
  const cols = table.columns || [];
  const rows = (table.rows || []).slice(0, max);
  const widths = cols.map((c, i) => {
    let w = String(c).length;
    for (const r of rows) w = Math.max(w, String(r[i] ?? '').length);
    return w;
  });
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const lines = [];
  if (cols.length > 0) {
    lines.push(cols.map((c, i) => pad(c, widths[i])).join('  '));
    lines.push(widths.map(w => '─'.repeat(w)).join('  '));
  }
  for (const r of rows) lines.push(r.map((v, i) => pad(v, widths[i])).join('  '));
  if ((table.rows?.length ?? 0) > max) {
    lines.push(`… (${table.rows.length - max} more rows)`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
