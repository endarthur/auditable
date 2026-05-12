// @gcu/mimic-io — canonical serialization (spec §3.4)
//
// Signing a JSON file byte-for-byte requires a stable encoding both
// producer and verifier agree on. JSON has multiple semantically-
// equivalent serializations (key order, whitespace, integer-vs-decimal
// float text), so non-canonical JSON can round-trip identically through
// parse/stringify yet have different bytes — breaking any Ed25519
// signature over the bytes.
//
// Canonical form, per spec §3.4:
//   - UTF-8, no BOM
//   - LF line endings (no CRLF)
//   - Sorted object keys at every level (lexicographic byte order)
//   - 2-space indent for nested objects/arrays
//   - One element per line in arrays, except short arrays of pure
//     scalars (numbers, strings, booleans, null) which inline when they
//     fit in ≤ 80 columns including indent
//   - Integers: bare decimal, no leading zeros, no trailing `.0`
//   - Floats: shortest round-trippable decimal form (JS's default
//     Number.toString() is exactly this; Python's repr(float) too)
//   - NaN / Infinity / -Infinity: emitted as JSON `null`, with a
//     `metadata.nan_indices` entry recording positions (round-trip
//     preserves them, and signing covers them through the metadata)
//   - Trailing newline at end-of-file

const INDENT = '  ';
const INLINE_THRESHOLD = 80;

/**
 * Serialize a JSON-compatible value into canonical form. The return is
 * a string ready for hashing/signing.
 *
 * Caller is responsible for ensuring NaN / Infinity are pre-substituted
 * with null + recorded in metadata. canonicalize itself emits them as
 * null without complaint, on the theory that the producer's encode
 * step should handle this — but defensively, an opts.rejectNonFinite
 * flag exists to fail loudly.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {boolean} [opts.rejectNonFinite=false]
 * @returns {string}
 */
export function canonicalize(value, opts = {}) {
  const rejectNonFinite = !!opts.rejectNonFinite;
  const lines = [];
  _emit(value, 0, lines, rejectNonFinite, null);
  return lines.join('\n') + '\n';
}

function _emit(value, depth, lines, rejectNonFinite, _pathHint) {
  if (value === null) {
    _append(lines, depth, 'null');
    return;
  }
  if (typeof value === 'boolean') {
    _append(lines, depth, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    _append(lines, depth, _formatNumber(value, rejectNonFinite));
    return;
  }
  if (typeof value === 'string') {
    _append(lines, depth, _formatString(value));
    return;
  }
  if (Array.isArray(value)) {
    _emitArray(value, depth, lines, rejectNonFinite);
    return;
  }
  if (typeof value === 'object') {
    _emitObject(value, depth, lines, rejectNonFinite);
    return;
  }
  throw new Error(`canonicalize: unsupported value type ${typeof value}`);
}

function _emitArray(arr, depth, lines, rejectNonFinite) {
  if (arr.length === 0) {
    _append(lines, depth, '[]');
    return;
  }
  // Try inline form for short arrays of pure scalars.
  const inline = _maybeInlineArray(arr, depth, rejectNonFinite);
  if (inline !== null) {
    _append(lines, depth, inline);
    return;
  }
  // Block form: one element per line.
  _append(lines, depth, '[');
  for (let i = 0; i < arr.length; i++) {
    _emit(arr[i], depth + 1, lines, rejectNonFinite, `[${i}]`);
    const last = lines[lines.length - 1];
    if (i < arr.length - 1) lines[lines.length - 1] = last + ',';
  }
  _append(lines, depth, ']');
}

function _maybeInlineArray(arr, depth, rejectNonFinite) {
  // Only attempt inline if every element is a scalar.
  for (const v of arr) {
    if (v !== null && typeof v !== 'number' && typeof v !== 'string' &&
        typeof v !== 'boolean') return null;
  }
  const parts = arr.map(v => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return _formatNumber(v, rejectNonFinite);
    return _formatString(v);
  });
  const inline = '[' + parts.join(', ') + ']';
  const indented = INDENT.repeat(depth) + inline;
  if (indented.length <= INLINE_THRESHOLD) return inline;
  return null;
}

function _emitObject(obj, depth, lines, rejectNonFinite) {
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) {
    _append(lines, depth, '{}');
    return;
  }
  _append(lines, depth, '{');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = obj[k];
    const keyStr = _formatString(k) + ': ';
    // For scalar values we keep the key + value on one line; for nested
    // we put the key on its own line.
    if (_isScalar(v)) {
      const scalar = (v === null) ? 'null'
        : typeof v === 'boolean' ? (v ? 'true' : 'false')
        : typeof v === 'number' ? _formatNumber(v, rejectNonFinite)
        : _formatString(v);
      const trailing = i < keys.length - 1 ? ',' : '';
      _append(lines, depth + 1, keyStr + scalar + trailing);
    } else if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
      // Try inline for short scalar arrays / empty containers.
      if (Array.isArray(v) && v.length === 0) {
        const trailing = i < keys.length - 1 ? ',' : '';
        _append(lines, depth + 1, keyStr + '[]' + trailing);
        continue;
      }
      if (!Array.isArray(v) && Object.keys(v).length === 0) {
        const trailing = i < keys.length - 1 ? ',' : '';
        _append(lines, depth + 1, keyStr + '{}' + trailing);
        continue;
      }
      if (Array.isArray(v)) {
        const inline = _maybeInlineArray(v, depth + 1, rejectNonFinite);
        if (inline !== null) {
          const trailing = i < keys.length - 1 ? ',' : '';
          _append(lines, depth + 1, keyStr + inline + trailing);
          continue;
        }
      }
      _append(lines, depth + 1, keyStr.trimEnd());
      _emit(v, depth + 1, lines, rejectNonFinite, k);
      // Append the value to the previous "key:" line: object_open or array_open
      // is on its own line; merge "key:" with the opening token. We do this by
      // popping the last two lines and rejoining.
      // Simpler approach: emit the opener inline with the key.
      // -- the current implementation produces:
      //    "key:"
      //    "{"
      //    ...
      // which is also valid canonical form; pretty-printers vary. To match
      // common conventions, post-process: if the line after key-line starts
      // with `{` or `[` at the same indent, merge them.
      const lastIdx = lines.length - 1;
      const keyLineIdx = _findKeyLine(lines, lastIdx, keyStr.trimEnd());
      _mergeKeyAndOpener(lines, keyLineIdx);
      if (i < keys.length - 1) {
        lines[lines.length - 1] = lines[lines.length - 1] + ',';
      }
    }
  }
  _append(lines, depth, '}');
}

function _isScalar(v) {
  return v === null || typeof v === 'boolean' || typeof v === 'number'
    || typeof v === 'string';
}

function _formatNumber(n, rejectNonFinite) {
  if (!Number.isFinite(n)) {
    if (rejectNonFinite) {
      throw new Error(
        `canonicalize: non-finite number ${n}; pre-substitute with null + ` +
        `metadata.nan_indices, or pass opts.rejectNonFinite=false to emit null`,
      );
    }
    return 'null';
  }
  // Integer fast path — emit without trailing .0
  if (Number.isInteger(n)) return n.toString();
  // JS's default Number.toString() is the shortest round-trippable form
  // for finite floats (per ECMA-262 §7.1.17). That's what we want.
  return n.toString();
}

function _formatString(s) {
  // JSON escape — minimum required. JS's JSON.stringify(s) handles this
  // correctly and produces canonical escapes for control chars.
  return JSON.stringify(s);
}

function _append(lines, depth, content) {
  lines.push(INDENT.repeat(depth) + content);
}

function _findKeyLine(lines, fromIdx, keyPrefix) {
  for (let i = fromIdx; i >= 0; i--) {
    if (lines[i].trimStart().startsWith(keyPrefix)) return i;
  }
  return -1;
}

function _mergeKeyAndOpener(lines, keyLineIdx) {
  if (keyLineIdx < 0 || keyLineIdx + 1 >= lines.length) return;
  const keyLine = lines[keyLineIdx];
  const nextLine = lines[keyLineIdx + 1];
  // The opener line is either at indent (depth) `{` or `[` exactly; merge.
  const nextTrimmed = nextLine.trimStart();
  if (nextTrimmed === '{' || nextTrimmed === '[') {
    lines[keyLineIdx] = keyLine + ' ' + nextTrimmed;
    lines.splice(keyLineIdx + 1, 1);
  }
}
