// @gcu/strata — values: type coercion, the null vocabulary, display formatting.
//
// Shared by ingest (parsing source rows) and the provider (parsing edits) so a
// hand-typed value and an imported one travel the same path. Pure, zero-dep.

// Column types strata carries (a subset of @gcu/loom's CellType, by value — the
// provider hands these strings straight to loom). 'category' = a low-cardinality
// string (lithology, domain); 'string' = free text; 'number' = f64.
export const COL_TYPES = ['number', 'category', 'string'];

// The mining/geoscience null vocabulary — a light mirror of recon's
// NULL_SENTINELS (the full set lives there; this covers the common tokens so
// strata's built-in sniffer path handles them without a recon dependency).
export const NULL_TOKENS = new Set([
  '', 'na', 'n/a', 'nan', 'null', 'none', '-', '--',
  '-9999', '-99', '-1e32', '-1e+32', '1e32',
]);

// Coerce a raw string (from CSV or an edit) to a typed value, or null.
export function coerceValue(raw, type) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || NULL_TOKENS.has(s.toLowerCase())) return null;
  if (type === 'number') {
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  return s;
}

// Faithful display text for a typed value. Numbers print at full precision
// (a data table shows the real datum — column-level precision formatting is a
// later, additive nicety); null → empty.
export function fmtCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  return String(v);
}
