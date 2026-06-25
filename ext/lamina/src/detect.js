// @gcu/lamina — detect: sniff a file's KIND from a head sample, so the harness
// picks the right view (delimited→grid, text→lines, binary→hand to hex). recon's
// `sniff` is INJECTED for richer schema (types/units/roles); a solid builtin runs
// without it. Zero-dep.

const DELIMS = [',', '\t', ';', '|'];

// Binary = a NUL byte (text files don't have them) or a high ratio of control
// bytes (excluding \t \n \r). Cheap + reliable on a head sample.
function looksBinary(sample) {
  const n = Math.min(sample.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = sample[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.3;
}

function isNumeric(s) { return s !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()); }

// Pick the delimiter with a consistent, >0 column count across the sample lines.
function sniffDelimiter(lines) {
  let best = null, bestScore = 0;
  for (const d of DELIMS) {
    const counts = lines.map((l) => l.split(d).length - 1).filter((c, i) => lines[i] !== '');
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]; // median count
    if (mode < 1) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = mode * consistent;                  // more columns + more consistent = better
    if (score > bestScore) { bestScore = score; best = { delimiter: d, columns: mode + 1, consistent }; }
  }
  return best && best.consistent >= 0.6 ? best : null;
}

/**
 * @param {Uint8Array} sample  the file's head (e.g. first 64 KB)
 * @param {object} opts  { sniff?: @gcu/recon sniff }
 * @returns {{ kind:'delimited'|'text'|'binary', delimiter?, quote?, schema?, hasHeader? }}
 */
export function detectKind(sample, { sniff } = {}) {
  if (looksBinary(sample)) return { kind: 'binary' };

  const text = new TextDecoder().decode(sample);
  const lines = text.split('\n').slice(0, 50).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // recon enrichment (best-effort): if it finds a delimiter + fields, prefer it.
  if (typeof sniff === 'function') {
    try {
      const m = sniff(lines);
      if (m && m.delimiter && Array.isArray(m.fields) && m.fields.length > 1) {
        return {
          kind: 'delimited', delimiter: m.delimiter, quote: '"',
          hasHeader: m.hasHeader !== false,
          schema: m.fields.map((f) => ({ name: f.name, type: f.type || 'string', unit: f.unit, role: f.role })),
        };
      }
    } catch { /* fall through to builtin */ }
  }

  const d = sniffDelimiter(lines.filter((l) => l !== ''));
  if (!d) return { kind: 'text' };

  // Header guess: row 0 all non-numeric, and some later row has a numeric.
  const rows = lines.filter((l) => l !== '').map((l) => l.split(d.delimiter));
  const head = rows[0] || [];
  const headAllText = head.length > 0 && head.every((c) => !isNumeric(c));
  const laterHasNum = rows.slice(1, 20).some((r) => r.some(isNumeric));
  const hasHeader = headAllText && laterHasNum;

  const dataRows = rows.slice(hasHeader ? 1 : 0, hasHeader ? 21 : 20);
  const schema = [];
  for (let c = 0; c < d.columns; c++) {
    const name = hasHeader && head[c] != null ? head[c] : `col ${c + 1}`;
    const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== '');
    const type = vals.length && vals.every(isNumeric) ? 'number' : 'string';
    schema.push({ name, type });
  }
  return { kind: 'delimited', delimiter: d.delimiter, quote: '"', hasHeader, schema };
}
