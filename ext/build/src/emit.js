// @gcu/build — text-splice emit (SPEC §6.4)
//
// Emit by copying the original source and overwriting the byte ranges of renamed
// identifiers and stripped import/export statements. Comments, whitespace, and
// string escapes survive byte-for-byte because the emitter is mostly a copy.
//
// The splice is modeled as a SEGMENT list so source maps fall out of it (§11.3):
//   { src: [start, end] }  — a verbatim copy run from the original source
//   { text: '…' }          — synthesized text (patch replacement / synth code),
//                            which carries no source mapping.
// Patches are { start, end, text } over the original source; non-overlapping.

// Splice patches into a segment list (sorted, validated non-overlapping).
export function spliceSegments(source, patches) {
  const sorted = patches ? [...patches].sort((a, b) => a.start - b.start || a.end - b.end) : [];
  let prevEnd = -1;
  for (const p of sorted) {
    if (p.start < prevEnd) throw new Error(`gcu-build: internal: overlapping patches at ${p.start} (prev end ${prevEnd})`);
    prevEnd = p.end;
  }
  const segs = [];
  let cursor = 0;
  for (const p of sorted) {
    if (p.start > cursor) segs.push({ src: [cursor, p.start] });
    if (p.text) segs.push({ text: p.text });
    cursor = p.end;
  }
  if (cursor < source.length) segs.push({ src: [cursor, source.length] });
  return segs;
}

export function codeOfSegments(segments, source) {
  let out = '';
  for (const s of segments) out += s.text != null ? s.text : source.slice(s.src[0], s.src[1]);
  return out;
}

// Mirror of `.replace(/^\n+/, '').replace(/\n+$/, '')` over the segment list.
export function trimNewlineSegments(segments, source) {
  const segs = segments.map((s) => ({ ...s }));
  // leading
  while (segs.length) {
    const s = segs[0];
    if (s.text != null) {
      const t = s.text.replace(/^\n+/, '');
      if (t === '') { segs.shift(); continue; }
      s.text = t; break;
    } else {
      let [a, b] = s.src;
      while (a < b && source[a] === '\n') a++;
      if (a >= b) { segs.shift(); continue; }
      s.src = [a, b]; break;
    }
  }
  // trailing
  while (segs.length) {
    const s = segs[segs.length - 1];
    if (s.text != null) {
      const t = s.text.replace(/\n+$/, '');
      if (t === '') { segs.pop(); continue; }
      s.text = t; break;
    } else {
      let [a, b] = s.src;
      while (b > a && source[b - 1] === '\n') b--;
      if (b <= a) { segs.pop(); continue; }
      s.src = [a, b]; break;
    }
  }
  return segs;
}

export function applyPatches(source, patches) {
  if (!patches || patches.length === 0) return source;
  return codeOfSegments(spliceSegments(source, patches), source);
}
