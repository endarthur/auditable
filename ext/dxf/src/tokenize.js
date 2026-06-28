// DXF group-code pair reader/writer — the bulletproof spine of the parser.
//
// A DXF file is a flat stream of (integer code, value) pairs, one per two lines: the
// group code on one line, its value on the next. The value's TYPE is dictated by the
// code's numeric range, not by how the value looks — a whole-numbered coordinate is
// still a double (the same code-driven-type rule as the AutoLISP entity model). The
// reader is a TOTAL function: malformed input never throws, it resyncs by skipping a
// bad code line. "Bulletproof" starts here.

// Value kind by group-code range — the fixed DXF code→type table, common ranges.
function valueKind(code) {
  if (code >= 10 && code <= 59) return 'num';      // primary doubles (coordinates / reals)
  if (code >= 60 && code <= 79) return 'int';      // int16 (incl. 62 = ACI colour, 70 = flags)
  if (code >= 90 && code <= 99) return 'int';      // int32
  if (code >= 140 && code <= 149) return 'num';    // doubles
  if (code >= 160 && code <= 179) return 'int';    // int64 / int16
  if (code >= 210 && code <= 239) return 'num';    // extrusion / OCS doubles
  if (code >= 270 && code <= 289) return 'int';
  if (code >= 290 && code <= 299) return 'bool';
  if (code >= 370 && code <= 389) return 'int';    // lineweight / flags
  if (code >= 400 && code <= 409) return 'int';
  if (code === 420 || code === 440) return 'int';  // 24-bit true colour / transparency
  if (code >= 1010 && code <= 1059) return 'num';  // XDATA doubles (points / reals)
  if (code >= 1060 && code <= 1071) return 'int';  // XDATA ints
  return 'str';                                    // 0-9, 100/102/105, 300-369, 430, 1000-1009, names, handles
}

function coerce(code, raw) {
  const kind = valueKind(code);
  if (kind === 'num') { const n = parseFloat(raw); return Number.isNaN(n) ? 0 : n; }
  if (kind === 'int') { const n = parseInt(raw, 10); return Number.isNaN(n) ? 0 : n; }
  if (kind === 'bool') return raw.trim() !== '0';
  return raw;                                       // string: keep verbatim (trailing \r already stripped)
}

// Parse DXF text into an array of { code, value } pairs. Handles LF and CRLF, blank
// lines, and a desynced stream (a non-integer where a code is expected → skip one line
// and retry, rather than throw).
export function parsePairs(text) {
  const lines = String(text).split('\n');
  const pairs = [];
  for (let i = 0; i < lines.length; ) {
    const head = lines[i].trim();
    if (head === '') { i++; continue; }
    const code = Number(head);
    if (!Number.isInteger(code)) { i++; continue; }               // desync guard
    const raw = i + 1 < lines.length ? lines[i + 1].replace(/\r$/, '') : '';
    pairs.push({ code, value: coerce(code, raw) });
    i += 2;
  }
  return pairs;
}

// Decimal formatting that avoids exponential notation across the coordinate ranges DXF
// readers expect (UTM magnitudes round-trip via String; only tiny/huge values fall back
// to a fixed expansion).
function fmtNum(n) {
  if (!Number.isFinite(n)) return '0.0';
  if (n === 0) return '0.0';
  const s = String(n);
  return (s.includes('e') || s.includes('E')) ? n.toFixed(12).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0') : s;
}

function fmtValue(code, value) {
  const kind = valueKind(code);
  if (kind === 'num') return fmtNum(value);
  if (kind === 'int') return String(Math.trunc(value));
  if (kind === 'bool') return value ? '1' : '0';
  return String(value);
}

// Serialize { code, value } pairs back to DXF text (CRLF, as is traditional — readers
// accept LF too, but CRLF is the safe default). Round-trips with parsePairs.
export function serializePairs(pairs) {
  const out = [];
  for (const { code, value } of pairs) out.push(String(code), fmtValue(code, value));
  return out.join('\r\n') + '\r\n';
}

// Exposed for the reader/entity layer (code-driven type decisions, e.g. XDATA walking).
export { valueKind };
