// @gcu/build — text-splice emit (SPEC §6.4)
//
// Emit by copying the original source and overwriting the byte ranges of renamed
// identifiers and stripped import/export statements. Comments, whitespace, and
// string escapes survive byte-for-byte because the emitter is mostly a copy.
//
// Patches are { start, end, text } over the ORIGINAL source. They must be
// non-overlapping; we sort and validate before applying.

export function applyPatches(source, patches) {
  if (!patches || patches.length === 0) return source;
  const sorted = [...patches].sort((a, b) => a.start - b.start || a.end - b.end);
  let prevEnd = -1;
  for (const p of sorted) {
    if (p.start < prevEnd) {
      throw new Error(`gcu-build: internal: overlapping patches at ${p.start} (prev end ${prevEnd})`);
    }
    prevEnd = p.end;
  }
  let out = '';
  let cursor = 0;
  for (const p of sorted) {
    out += source.slice(cursor, p.start);
    out += p.text;
    cursor = p.end;
  }
  out += source.slice(cursor);
  return out;
}
