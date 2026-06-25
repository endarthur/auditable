// @gcu/lamina — detect: sniff a file's KIND from a head sample, so the harness
// picks the right view (delimited→grid, text→lines, binary→hand to hex). recon's
// `sniff` is INJECTED for richer schema (types/units/roles); a solid builtin runs
// without it. Zero-dep.

const DELIMS = [',', '\t', ';', '|', ' '];   // ' ' = whitespace-run mode (GSLIB / scientific dumps)

// Split a line by a delimiter; ' ' means split on whitespace runs (trimmed).
function splitBy(line, delim) {
  if (delim === ' ') { const t = line.trim(); return t === '' ? [] : t.split(/\s+/); }
  return line.split(delim);
}

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
    const counts = lines.map((l) => splitBy(l, d).length - 1).filter((c, i) => lines[i] !== '');
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)]; // median count
    if (mode < 1) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    // Whitespace is the fallback delimiter and would also "split" prose, so gate
    // it on the data being NUMERIC (geology/scientific whitespace dumps are) — and
    // discount it so a real punctuation delimiter on the same data wins.
    if (d === ' ') {
      const toks = lines.flatMap((l) => splitBy(l, d));
      const numFrac = toks.length ? toks.filter(isNumeric).length / toks.length : 0;
      if (numFrac < 0.5) continue;                    // prose / non-numeric → not whitespace-delimited
    }
    const score = mode * consistent * (d === ' ' ? 0.9 : 1);
    if (score > bestScore) { bestScore = score; best = { delimiter: d, columns: mode + 1, consistent }; }
  }
  return best;   // best candidate (may be low-consistency); the caller gates it
}

// Build a delimited result (schema + header guess) for a known delimiter. Header:
// forced (true/false) or guessed (row 0 all-text + a later numeric). Column count
// = the median row length (robust to a stray ragged row). Shared by auto + forced.
function buildDelimited(lines, delimiter, forceHeader) {
  const rows = lines.filter((l) => l !== '').map((l) => splitBy(l, delimiter));
  const lens = rows.map((r) => r.length).sort((a, b) => a - b);
  const columns = Math.max(1, lens[Math.floor(lens.length / 2)] || 1);
  const head = rows[0] || [];
  let hasHeader;
  if (forceHeader === true || forceHeader === false) hasHeader = forceHeader;
  else hasHeader = head.length > 0 && head.every((c) => !isNumeric(c)) && rows.slice(1, 20).some((r) => r.some(isNumeric));
  const dataRows = rows.slice(hasHeader ? 1 : 0, hasHeader ? 21 : 20);
  const schema = [];
  for (let c = 0; c < columns; c++) {
    const name = hasHeader && head[c] != null && head[c] !== '' ? head[c] : `col ${c + 1}`;
    const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== '');
    schema.push({ name, type: vals.length && vals.every(isNumeric) ? 'number' : 'string' });
  }
  return { kind: 'delimited', delimiter, quote: '"', hasHeader, schema };
}

// How many leading lines to skip as a comment/preamble (the geology-export norm:
// a block of `# …` metadata before the real header). Auto: a `comment` prefix
// (forced, or `#` when line 0 starts with it) → skip leading lines that match.
function leadingSkip(lines, f) {
  if (f.skip != null) return { skip: f.skip | 0, comment: f.comment || null };
  const comment = f.comment != null ? f.comment : (lines[0] && lines[0].startsWith('#') ? '#' : null);
  if (!comment) return { skip: 0, comment: null };
  let skip = 0;
  while (skip < lines.length && lines[skip].startsWith(comment)) skip++;
  return { skip, comment };
}

// GSLIB / Geo-EAS: line 0 = title, line 1 = an integer N (column count), lines
// 2..N+1 = one column NAME per line, then N-column (usually whitespace) data.
// Column names come from the preamble, not a header row → schema + dataStart=N+2.
function detectGeoEAS(lines) {
  if (lines.length < 4) return null;
  const n = Number((lines[1] || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000 || lines.length < n + 3) return null;
  const names = lines.slice(2, 2 + n).map((l) => l.trim());
  if (names.some((nm) => nm === '')) return null;
  const first = lines[2 + n] || '';
  for (const delim of [' ', ',', '\t']) {              // data delimiter (whitespace is the norm)
    const tok = splitBy(first, delim);
    if (tok.length === n && tok.some(isNumeric)) {
      const dataRows = lines.slice(2 + n, 2 + n + 20).map((l) => splitBy(l, delim));
      const schema = names.map((nm, c) => {
        const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== '');
        return { name: nm, type: vals.length && vals.every(isNumeric) ? 'number' : 'string' };
      });
      return { kind: 'delimited', delimiter: delim, quote: '"', hasHeader: false, schema, dataStart: 2 + n, geoeas: true, skip: 0, comment: null };
    }
  }
  return null;
}

/**
 * @param {Uint8Array} sample  the file's head (e.g. first 64 KB)
 * @param {object} opts  { sniff?, force? }
 *   force overrides auto-detection (when the user corrects a wrong guess):
 *   { kind?: 'delimited'|'text'|'binary', delimiter?, hasHeader?, skip?, comment? }
 *   name = the filename (a .csv/.tsv/.tab extension biases an ambiguous file to a table).
 * @returns {{ kind, delimiter?, quote?, schema?, hasHeader?, skip?, comment?, dataStart? }}
 *   dataStart = records to skip before the first DATA row (preamble + header).
 */
export function detectKind(sample, { sniff, force, name } = {}) {
  const f = force || {};
  if (f.kind === 'binary') return { kind: 'binary' };
  if (!f.kind && !f.delimiter && looksBinary(sample)) return { kind: 'binary' };

  const text = new TextDecoder().decode(sample);   // default decoder strips a leading BOM
  const all = text.split('\n').slice(0, 200).map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // GSLIB / Geo-EAS structured preamble (only when nothing is forced).
  if (!f.kind && !f.delimiter && f.skip == null) { const g = detectGeoEAS(all); if (g) return g; }

  const { skip, comment } = leadingSkip(all, f);
  const lines = all.slice(skip);                    // the body, past the preamble

  if (f.kind === 'text') return { kind: 'text', skip, comment, dataStart: skip };

  const finish = (r) => ({ ...r, skip, comment, dataStart: skip + (r.hasHeader ? 1 : 0) });
  if (f.delimiter) return finish(buildDelimited(lines, f.delimiter, f.hasHeader));

  // recon enrichment (best-effort): if it finds a delimiter + fields, prefer it.
  if (typeof sniff === 'function') {
    try {
      const m = sniff(lines);
      if (m && m.delimiter && Array.isArray(m.fields) && m.fields.length > 1) {
        return finish({
          kind: 'delimited', delimiter: m.delimiter, quote: '"',
          hasHeader: f.hasHeader != null ? f.hasHeader : m.hasHeader !== false,
          schema: m.fields.map((fl) => ({ name: fl.name, type: fl.type || 'string', unit: fl.unit, role: fl.role })),
        });
      }
    } catch { /* fall through to builtin */ }
  }

  const d = sniffDelimiter(lines.filter((l) => l !== ''));
  // A .csv/.tsv/.tab extension is a strong "this is a table" signal — accept the
  // best delimiter even when column counts are inconsistent (ragged/quoted rows),
  // where a generic sniff would bail to text. Otherwise require ≥0.6 consistency.
  const csvHint = /\.(csv|tsv|tab|lam|lamina)$/i.test(name || '');   // .lam/.lamina = lamina's marker ext (delimited data)
  if (d && (d.consistent >= 0.6 || (csvHint && d.columns >= 2))) return finish(buildDelimited(lines, d.delimiter, f.hasHeader));
  return { kind: 'text', skip, comment, dataStart: skip };
}
