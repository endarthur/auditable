// @gcu/recon — bootstrap detection: delimiter, base column types, the sniff context.
// Zero-dep; NULL_SENTINELS mirrors @gcu/sluice's (recon stays standalone).

export const NULL_SENTINELS = new Set([
  '', 'NA', 'NaN', 'na', 'nan', 'N/A', 'n/a', 'null', 'NULL', '*', '-',
  '-999', '-99', '#N/A', 'VOID', 'void', '-1.0e+32', '-1e+32', '1e+31', '-9999', '-99999',
]);

const DELIMITERS = [',', '\t', ';', '|', ' '];

// Pick the delimiter that splits the sample into the most, most-consistent columns.
export function detectDelimiter(lines) {
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => l.split(d).length);
    if (counts.length === 0 || counts[0] < 2) continue;
    const allSame = counts.every((c) => c === counts[0]);
    const score = allSame ? counts[0] * 1000 + counts.length : counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

// Build the sniff context from raw sample lines.
export function buildContext(lines, { delimiter, comment = '#' } = {}) {
  const clean = lines.filter((l) => l !== '' && !(comment && l.startsWith(comment)));
  if (clean.length === 0) return { delimiter: delimiter || ',', header: [], sampleRows: [], columnCount: 0, baseTypes: [] };
  const delim = delimiter || detectDelimiter(clean.slice(0, 20));
  const header = clean[0].split(delim).map(unquote);
  const columnCount = header.length;
  const sampleRows = clean.slice(1).map((l) => l.split(delim).map(unquote));

  // Base type detection: numeric / categorical / id (BMA-style num vs non-num counts).
  const num = new Array(columnCount).fill(0);
  const nonNum = new Array(columnCount).fill(0);
  const distinct = Array.from({ length: columnCount }, () => new Set());
  for (const row of sampleRows) {
    for (let c = 0; c < columnCount; c++) {
      const v = row[c] ?? '';
      if (NULL_SENTINELS.has(v)) continue;
      distinct[c].add(v);
      if (!isNaN(Number(v))) num[c]++; else nonNum[c]++;
    }
  }
  const n = sampleRows.length;
  const baseTypes = header.map((_, c) => {
    const total = num[c] + nonNum[c];
    if (total === 0) return 'numeric';
    if (nonNum[c] === 0) {
      // all-numeric: an id if (near-)unique across the sample
      return (n >= 8 && distinct[c].size >= n * 0.98) ? 'id' : 'numeric';
    }
    if (num[c] === 0) return 'categorical';
    return num[c] / total > 0.8 ? 'numeric' : 'categorical';
  });

  return { delimiter: delim, header, sampleRows, columnCount, baseTypes, distinct: distinct.map((s) => s.size), rowSample: n };
}
