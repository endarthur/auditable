// @gcu/build — Source Map v3 generation (SPEC §11)
//
// Mappings fall out of the segment splice (§11.3): a copy segment is a verbatim
// run, so output positions track input positions 1:1 — one mapping at each copy
// segment's start and at each output-line start within it. Synth segments (header,
// section markers, namespace objects, export block, patch replacements) get no
// mapping. `names` is omitted — line/col is ~90% of debugging value (§11.1).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(n) {
  let v = n < 0 ? ((-n) << 1) | 1 : (n << 1);
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    out += B64[d];
  } while (v > 0);
  return out;
}

// Offsets of each line start in `source` (lineStarts[k] = index after the k-th '\n').
export function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function posOf(offset, lineStarts) {
  // binary search: largest line whose start <= offset
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, col: offset - lineStarts[lo] };
}

/**
 * Emit per-output-line mappings for one module body's segments, starting at
 * output line `startOutLine`. Pushes { outLine, outCol, srcIndex, srcLine, srcCol }
 * into `out`.
 */
export function moduleMappings(segments, source, srcIndex, lineStarts, startOutLine, out) {
  let outLine = startOutLine, outCol = 0;
  for (const seg of segments) {
    if (seg.text != null) {
      for (let i = 0; i < seg.text.length; i++) {
        if (seg.text[i] === '\n') { outLine++; outCol = 0; } else outCol++;
      }
      continue;
    }
    const [s, e] = seg.src;
    let { line: sl, col: sc } = posOf(s, lineStarts);
    out.push({ outLine, outCol, srcIndex, srcLine: sl, srcCol: sc });
    for (let i = s; i < e; i++) {
      if (source[i] === '\n') {
        outLine++; outCol = 0; sl++; sc = 0;
        if (i + 1 < e) out.push({ outLine, outCol, srcIndex, srcLine: sl, srcCol: sc });
      } else { outCol++; sc++; }
    }
  }
}

/**
 * @param {Array} mappings  flat { outLine, outCol, srcIndex, srcLine, srcCol }
 * @param {{ sources:string[], sourcesContent:string[], file:string }} opts
 */
export function buildSourceMap(mappings, opts) {
  const byLine = new Map();
  let maxLine = 0;
  for (const m of mappings) {
    let arr = byLine.get(m.outLine);
    if (!arr) byLine.set(m.outLine, (arr = []));
    arr.push(m);
    if (m.outLine > maxLine) maxLine = m.outLine;
  }
  let pSrc = 0, pSrcLine = 0, pSrcCol = 0;
  const lines = [];
  for (let line = 0; line <= maxLine; line++) {
    const segs = byLine.get(line);
    if (!segs) { lines.push(''); continue; }
    segs.sort((a, b) => a.outCol - b.outCol);
    let pCol = 0;
    const parts = [];
    for (const m of segs) {
      parts.push(vlq(m.outCol - pCol) + vlq(m.srcIndex - pSrc) + vlq(m.srcLine - pSrcLine) + vlq(m.srcCol - pSrcCol));
      pCol = m.outCol; pSrc = m.srcIndex; pSrcLine = m.srcLine; pSrcCol = m.srcCol;
    }
    lines.push(parts.join(','));
  }
  return {
    version: 3,
    file: opts.file,
    sources: opts.sources,
    sourcesContent: opts.sourcesContent,
    names: [],
    mappings: lines.join(';'),
  };
}
