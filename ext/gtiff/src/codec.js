// Segment codecs shared by strips and tiles: PackBits, Deflate (native
// DecompressionStream — the reason this reader can stay WASM-free), and the
// two predictors. A "segment" is one strip or one tile: predictors run per
// SEGMENT row (width = the segment's row width, not the image's).

import { lzwDecode } from './lzw.js';

export function packbitsDecode(src, dstLen) {
  const out = new Uint8Array(dstLen);
  let ip = 0, op = 0;
  while (ip < src.length && op < dstLen) {
    const n = (src[ip++] << 24) >> 24;                     // sign-extend
    if (n >= 0) { for (let i = 0; i <= n && ip < src.length; i++) out[op++] = src[ip++]; }
    else if (n !== -128) { const v = src[ip++]; for (let i = 0; i < 1 - n; i++) out[op++] = v; }
  }
  return out;
}

async function inflate(src, format) {
  const ds = new DecompressionStream(format);
  const stream = new Blob([src]).stream().pipeThrough(ds);
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let op = 0;
  for (const c of chunks) { out.set(c, op); op += c.length; }
  return out;
}

// COMPRESSION tag → decoder. 8 and 32946 are both zlib-wrapped deflate.
export async function decodeSegment(compression, src, dstLen) {
  switch (compression) {
    case 1: return src.length >= dstLen ? src.subarray(0, dstLen) : (() => { const o = new Uint8Array(dstLen); o.set(src); return o; })();
    case 5: return lzwDecode(src, dstLen);
    case 8: case 32946: return inflate(src, 'deflate');
    case 32773: return packbitsDecode(src, dstLen);
    default: throw new Error(`gtiff: unsupported compression ${compression} (have: none, LZW, deflate, PackBits)`);
  }
}

// Predictor 2 — horizontal differencing on SAMPLE values, per row.
export function undoPredictor2(bytes, rowWidth, rows, bytesPerSample, samplesPerPixel, littleEndian) {
  const spp = samplesPerPixel;
  if (bytesPerSample === 1) {
    for (let r = 0; r < rows; r++) {
      const off = r * rowWidth * spp;
      for (let i = spp; i < rowWidth * spp; i++) bytes[off + i] = (bytes[off + i] + bytes[off + i - spp]) & 0xff;
    }
  } else if (bytesPerSample === 2) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let r = 0; r < rows; r++) {
      const off = r * rowWidth * spp * 2;
      for (let i = spp; i < rowWidth * spp; i++) {
        const at = off + i * 2, prevAt = at - spp * 2;
        v.setUint16(at, (v.getUint16(at, littleEndian) + v.getUint16(prevAt, littleEndian)) & 0xffff, littleEndian);
      }
    }
  } else if (bytesPerSample === 4) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let r = 0; r < rows; r++) {
      const off = r * rowWidth * spp * 4;
      for (let i = spp; i < rowWidth * spp; i++) {
        const at = off + i * 4, prevAt = at - spp * 4;
        v.setUint32(at, (v.getUint32(at, littleEndian) + v.getUint32(prevAt, littleEndian)) >>> 0, littleEndian);
      }
    }
  } else throw new Error(`gtiff: predictor 2 with ${bytesPerSample}-byte samples`);
}

// Predictor 3 — floating-point: each row was byte-plane-shuffled (all MSBs,
// then next bytes…, big-endian planes) and horizontally byte-diffed. Undo =
// cumulative-sum the row bytes, then de-shuffle back to per-sample order.
export function undoPredictor3(bytes, rowWidth, rows, bytesPerSample, samplesPerPixel, littleEndian) {
  const w = rowWidth * samplesPerPixel;                    // samples per row
  const rowBytes = w * bytesPerSample;
  const tmp = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const off = r * rowBytes;
    for (let i = 1; i < rowBytes; i++) bytes[off + i] = (bytes[off + i] + bytes[off + i - 1]) & 0xff;
    tmp.set(bytes.subarray(off, off + rowBytes));
    for (let i = 0; i < w; i++) {
      for (let b = 0; b < bytesPerSample; b++) {
        // plane b holds byte b (big-endian significance) of every sample
        const src = tmp[b * w + i];
        bytes[off + i * bytesPerSample + (littleEndian ? bytesPerSample - 1 - b : b)] = src;
      }
    }
  }
}
