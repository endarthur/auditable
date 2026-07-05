// TIFF-variant LZW (Compression=5): MSB-first packed codes, Clear=256,
// EOI=257, code width grows 9→12 bits with the TIFF "early change" (the
// width bumps when the NEXT code would hit (1<<width)-1, one entry before
// the table is actually full — the historical off-by-one every writer ships).

export function lzwDecode(src, dstLen) {
  const out = new Uint8Array(dstLen);
  const CLEAR = 256, EOI = 257;
  // dictionary as (prefix code, appended byte) pairs — no byte-array churn
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let next = 258, width = 9;
  let bitBuf = 0, bitCnt = 0, ip = 0, op = 0;
  let prev = -1;

  const emit = (code) => {
    let sp = 0, c = code;
    while (c >= 256) { stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = c;
    const first = c;
    while (sp > 0 && op < dstLen) out[op++] = stack[--sp];
    return first;
  };

  while (ip < src.length && op < dstLen) {
    bitBuf = (bitBuf << 8) | src[ip++];
    bitCnt += 8;
    while (bitCnt >= width) {
      const code = (bitBuf >>> (bitCnt - width)) & ((1 << width) - 1);
      bitCnt -= width;
      if (code === EOI) return out;
      if (code === CLEAR) { next = 258; width = 9; prev = -1; continue; }
      let first;
      if (code < next) {
        first = emit(code);
      } else if (code === next && prev >= 0) {
        // the KwKwK case: entry being defined is prev + first byte of prev
        let c = prev;
        while (c >= 256) c = prefix[c];
        prefix[next] = prev; suffix[next] = c;
        first = emit(next);
        prev = code; next++;
        if (next === (1 << width) - 1 && width < 12) width++;   // early change: bump as entry 2^w-1 is defined (libtiff-verified)
        continue;
      } else {
        throw new Error(`gtiff: corrupt LZW stream (code ${code} ≥ table ${next})`);
      }
      if (prev >= 0 && next < 4096) { prefix[next] = prev; suffix[next] = first; next++; }
      prev = code;
      if (next === (1 << width) - 1 && width < 12) width++;   // early change: bump as entry 2^w-1 is defined (libtiff-verified)
    }
  }
  return out;
}
