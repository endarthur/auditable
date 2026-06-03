// @gcu/strata — ingest: source adapters into the working model (strata-spec §6).
//
// v1: CSV/TSV → a typed StrataTable. Schema detection is recon-injectable: pass
// @gcu/recon's `sniff` for the rich path (roles, units, analytes — so an
// `Au_gpt` column arrives typed number with unit g/t and analyte Au), or omit it
// and strata uses a minimal built-in sniffer (delimiter + numeric/string only),
// so it ingests CSV standalone without a recon dependency. recon is *injected*,
// not imported — keeps strata zero-dep and lets a Works surface pass
// `(await load('@gcu/recon')).sniff`.
//
// Pure, zero-dep (beyond ./values, ./table).

import { coerceValue } from './values.js';
import { createTable } from './table.js';

// recon type → strata type. Generous matching (recon may say numeric/integer/
// float/categorical/text); unknown → string.
function mapReconType(t) {
  if (!t) return 'string';
  if (/num|int|float|real|double/i.test(t)) return 'number';
  if (/cat/i.test(t)) return 'category';
  return 'string';
}

// Normalize to \n, split, drop trailing blank lines.
function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

// Pick the delimiter by counting candidates in the header line.
export function detectDelimiter(headerLine) {
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestN = -1;
  for (const d of cands) {
    const n = headerLine.split(d).length - 1;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

// Minimal schema sniffer (the recon-less fallback): delimiter + per-column
// number-vs-string inference over a sample.
export function builtinSniff(lines) {
  const delimiter = detectDelimiter(lines[0] || '');
  const header = (lines[0] || '').split(delimiter);
  const sample = lines.slice(1, 51);
  const columns = header.map((name, c) => {
    let numeric = true, saw = false;
    for (const ln of sample) {
      const v = ln.split(delimiter)[c];
      if (v == null || v.trim() === '') continue;
      saw = true;
      if (Number.isNaN(Number(v.trim()))) { numeric = false; break; }
    }
    return { name: name.trim(), type: saw && numeric ? 'number' : 'string' };
  });
  return { delimiter, columns };
}

/**
 * Parse CSV/TSV text into a StrataTable.
 * @param {string} text
 * @param {object} [opts]
 * @param {function} [opts.sniff]  @gcu/recon sniff(lines) → manifest. If given,
 *   used for delimiter + rich schema; else the built-in sniffer is used.
 * @param {number} [opts.sampleSize=200]  lines fed to the sniffer.
 */
export function tableFromCsv(text, opts = {}) {
  const lines = splitLines(text);
  if (lines.length === 0) return createTable({ schema: [], columns: [], nrows: 0 });

  let delimiter, schema;
  if (typeof opts.sniff === 'function') {
    const sample = lines.slice(0, (opts.sampleSize || 200) + 1);
    const m = opts.sniff(sample);
    delimiter = m.delimiter || detectDelimiter(lines[0]);
    schema = m.columns.map((col) => ({
      name: col.name,
      type: mapReconType(col.type),
      ...(col.unit ? { unit: col.unit } : {}),
      ...(col.role ? { role: col.role } : {}),
      ...(col.analyte ? { analyte: col.analyte } : {}),
    }));
  } else {
    const s = builtinSniff(lines);
    delimiter = s.delimiter;
    schema = s.columns.map((col) => ({ name: col.name, type: col.type }));
  }

  const ncols = schema.length;
  const columns = Array.from({ length: ncols }, () => []);
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter);
    for (let c = 0; c < ncols; c++) columns[c].push(coerceValue(cells[c], schema[c].type));
  }
  return createTable({ schema, columns, nrows: lines.length - 1 });
}
