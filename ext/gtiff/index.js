// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/gtiff — Minimal WASM-free GeoTIFF reader — classic TIFF, strips+tiles, none/LZW/deflate/PackBits, predictors 2+3, overview pyramid, geo identity (scale+tiepoint+EPSG, never reprojection)

// ── src/lzw.js ──

// TIFF-variant LZW (Compression=5): MSB-first packed codes, Clear=256,
// EOI=257, code width grows 9→12 bits with the TIFF "early change" (the
// width bumps when the NEXT code would hit (1<<width)-1, one entry before
// the table is actually full — the historical off-by-one every writer ships).

function lzwDecode(src, dstLen) {
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

// ── src/codec.js ──

// Segment codecs shared by strips and tiles: PackBits, Deflate (native
// DecompressionStream — the reason this reader can stay WASM-free), and the
// two predictors. A "segment" is one strip or one tile: predictors run per
// SEGMENT row (width = the segment's row width, not the image's).


function packbitsDecode(src, dstLen) {
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
async function decodeSegment(compression, src, dstLen) {
  switch (compression) {
    // COPY (never a view into the file) — downstream undoes predictors and
    // swaps endianness IN PLACE, and segments may be decoded more than once
    case 1: { const o = new Uint8Array(dstLen); o.set(src.subarray(0, Math.min(dstLen, src.length))); return o; }
    case 5: return lzwDecode(src, dstLen);
    case 8: case 32946: return inflate(src, 'deflate');
    case 32773: return packbitsDecode(src, dstLen);
    default: throw new Error(`gtiff: unsupported compression ${compression} (have: none, LZW, deflate, PackBits)`);
  }
}

// Predictor 2 — horizontal differencing on SAMPLE values, per row.
function undoPredictor2(bytes, rowWidth, rows, bytesPerSample, samplesPerPixel, littleEndian) {
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
function undoPredictor3(bytes, rowWidth, rows, bytesPerSample, samplesPerPixel, littleEndian) {
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

// ── src/read.js ──

// @gcu/gtiff — a minimal, WASM-free GeoTIFF reader. Classic TIFF (little or
// big endian), strips AND tiles, compression none/LZW/deflate/PackBits,
// predictors 2 (horizontal) and 3 (floating point), sample formats
// uint/int/float at 8/16/32/64 bits. The IFD chain is exposed as
// images[0..n] — a COG's overview pyramid arrives for free (coarse level
// first = an instant full-extent surface; refinement can come later).
// Geo-referencing is IDENTITY ONLY (@gcu/frame's rule): pixel scale +
// tiepoint + EPSG code out, never a reprojection. Total-function ethos:
// structural failures throw with a plain message, ignorable oddities land
// in warnings.


const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const PLATFORM_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function readValues(view, bytes, off, type, count, le) {
  const size = TYPE_SIZE[type] || 1;
  const total = size * count;
  // values ≤ 4 bytes live inline in the entry, else the entry holds an offset
  const at = total <= 4 ? off : view.getUint32(off, le);
  if (type === 2) {                                        // ASCII (NUL-terminated)
    let s = '';
    for (let i = 0; i < count; i++) { const c = bytes[at + i]; if (c === 0) break; s += String.fromCharCode(c); }
    return s;
  }
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = at + i * size;
    switch (type) {
      case 1: case 7: out[i] = bytes[p]; break;
      case 3: out[i] = view.getUint16(p, le); break;
      case 4: out[i] = view.getUint32(p, le); break;
      case 5: out[i] = view.getUint32(p, le) / view.getUint32(p + 4, le); break;
      case 6: out[i] = view.getInt8(p); break;
      case 8: out[i] = view.getInt16(p, le); break;
      case 9: out[i] = view.getInt32(p, le); break;
      case 10: out[i] = view.getInt32(p, le) / view.getInt32(p + 4, le); break;
      case 11: out[i] = view.getFloat32(p, le); break;
      case 12: out[i] = view.getFloat64(p, le); break;
      default: out[i] = 0;
    }
  }
  return out;
}

function swapBytes(bytes, bytesPerSample) {
  if (bytesPerSample === 2) {
    for (let i = 0; i < bytes.length; i += 2) { const t = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = t; }
  } else if (bytesPerSample === 4) {
    for (let i = 0; i < bytes.length; i += 4) {
      let t = bytes[i]; bytes[i] = bytes[i + 3]; bytes[i + 3] = t;
      t = bytes[i + 1]; bytes[i + 1] = bytes[i + 2]; bytes[i + 2] = t;
    }
  } else if (bytesPerSample === 8) {
    for (let i = 0; i < bytes.length; i += 8) for (let b = 0; b < 4; b++) { const t = bytes[i + b]; bytes[i + b] = bytes[i + 7 - b]; bytes[i + 7 - b] = t; }
  }
}

function typedView(buffer, fmt, bps) {
  if (fmt === 3) return bps === 64 ? new Float64Array(buffer) : new Float32Array(buffer);
  if (fmt === 2) return bps === 8 ? new Int8Array(buffer) : bps === 16 ? new Int16Array(buffer) : new Int32Array(buffer);
  return bps === 8 ? new Uint8Array(buffer) : bps === 16 ? new Uint16Array(buffer) : new Uint32Array(buffer);
}

function parseGeo(tags, warnings) {
  const geo = { origin: null, scale: null, pixelIsPoint: false, crs: null, nodata: null };
  const scale = tags.get(33550);                           // ModelPixelScale
  const tie = tags.get(33922);                             // ModelTiepoint
  const xf = tags.get(34264);                              // ModelTransformation
  if (scale && tie) {
    geo.scale = [scale[0], scale[1]];
    // tiepoint maps raster (i,j) → model (X,Y); normalize to raster (0,0)
    geo.origin = [tie[3] - tie[0] * scale[0], tie[4] + tie[1] * scale[1]];
  } else if (xf) {
    if (xf[1] !== 0 || xf[4] !== 0) warnings.push('rotated ModelTransformation — axis-aligned reading only, geo dropped');
    else { geo.origin = [xf[3], xf[7]]; geo.scale = [xf[0], -xf[5]]; }
  }
  const dir = tags.get(34735);                             // GeoKeyDirectory
  if (dir && dir.length >= 4) {
    const n = dir[3];
    for (let k = 0; k < n; k++) {
      const id = dir[4 + k * 4], loc = dir[5 + k * 4], val = dir[7 + k * 4];
      if (loc !== 0) continue;                             // only inline short keys matter to us
      if (id === 1025 && val === 2) geo.pixelIsPoint = true;
      if (id === 3072 && val > 0 && val < 32767) geo.crs = `EPSG:${val}`;
      if (id === 2048 && !geo.crs && val > 0 && val < 32767) geo.crs = `EPSG:${val}`;
    }
  }
  const nd = tags.get(42113);                              // GDAL_NODATA (ascii)
  if (typeof nd === 'string') { const v = parseFloat(nd); if (Number.isFinite(v)) geo.nodata = v; }
  return geo;
}

async function readGTiff(input) {
  const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer())
    : input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) throw new Error('gtiff: not a TIFF (too short)');
  const bo = view.getUint16(0, false);
  const le = bo === 0x4949;                                // 'II'
  if (!le && bo !== 0x4d4d) throw new Error('gtiff: not a TIFF (bad byte-order mark)');
  const magic = view.getUint16(2, le);
  if (magic === 43) throw new Error('gtiff: BigTIFF not supported yet (classic TIFF only)');
  if (magic !== 42) throw new Error(`gtiff: not a TIFF (magic ${magic})`);

  const warnings = [];
  const ifds = [];
  let off = view.getUint32(4, le);
  while (off && ifds.length < 64) {
    const count = view.getUint16(off, le);
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      const tag = view.getUint16(e, le), type = view.getUint16(e + 2, le), n = view.getUint32(e + 4, le);
      if (!TYPE_SIZE[type]) continue;
      tags.set(tag, readValues(view, bytes, e + 8, type, n, le));
    }
    ifds.push(tags);
    off = view.getUint32(off + 2 + count * 12, le);
  }
  if (!ifds.length) throw new Error('gtiff: no IFDs');

  const mkImage = (tags) => {
    const one = (t, d) => { const v = tags.get(t); return v == null ? d : (typeof v === 'string' ? v : v[0]); };
    const width = one(256), height = one(257);
    if (!width || !height) return null;                    // not an image IFD
    const bps = one(258, 1), compression = one(259, 1), spp = one(277, 1);
    const fmt = one(339, 1), predictor = one(317, 1), planar = one(284, 1);
    const tileW = one(322, 0), tileH = one(323, 0);
    const img = {
      width, height, bitsPerSample: bps, sampleFormat: fmt, samplesPerPixel: spp,
      compression, predictor, tiled: tileW > 0,
      tileWidth: tileW || undefined, tileHeight: tileH || undefined,
      reduced: (one(254, 0) & 1) === 1,
      // the strip/tile segments overlapping a pixel window (all of them if no
      // window) — each { off, len, x0, y0, w, rows } in image pixel space
      segments(win) {
        const list = [];
        const hit = (x0, y0, w, rows) => !win || (x0 < win.x + win.width && x0 + w > win.x && y0 < win.y + win.height && y0 + rows > win.y);
        if (tileW > 0) {
          const offs = tags.get(324) || [], counts = tags.get(325) || [];
          const across = Math.ceil(width / tileW);
          for (let i = 0; i < offs.length; i++) {
            const x0 = (i % across) * tileW, y0 = Math.floor(i / across) * tileH;
            if (hit(x0, y0, tileW, tileH)) list.push({ off: offs[i], len: counts[i], x0, y0, w: tileW, rows: tileH });
          }
        } else {
          const offs = tags.get(273) || [], counts = tags.get(279) || [];
          const rps = one(278, height);
          for (let i = 0; i < offs.length; i++) {
            const y0 = i * rps, rows = Math.min(rps, height - y0);
            if (hit(0, y0, width, rows)) list.push({ off: offs[i], len: counts[i], x0: 0, y0, w: width, rows });
          }
        }
        return list;
      },
      // decode one segment → native-endian bytes, predictor undone
      async decodeSeg(s, bytesPer) {
        const raw = bytes.subarray(s.off, s.off + s.len);
        const seg = await decodeSegment(compression, raw, s.w * s.rows * spp * bytesPer);
        if (predictor === 2) undoPredictor2(seg, s.w, s.rows, bytesPer, spp, le);
        else if (predictor === 3) undoPredictor3(seg, s.w, s.rows, bytesPer, spp, le);
        else if (predictor !== 1) throw new Error(`gtiff: predictor ${predictor} not supported`);
        if (le !== PLATFORM_LE && bytesPer > 1) swapBytes(seg, bytesPer);
        return seg;
      },
      // assemble a pixel window [x,y,width,height] (default = the whole image)
      // by decoding ONLY the overlapping segments. Cheap random-access on a
      // tiled image / COG overview; strips still decode a whole strip-row.
      async readWindow(win, band = 0) {
        if (planar !== 1) throw new Error('gtiff: planar (band-separate) layout not supported');
        if (![8, 16, 32, 64].includes(bps)) throw new Error(`gtiff: ${bps}-bit samples not supported`);
        if (fmt === 3 && bps < 32) throw new Error('gtiff: half-float not supported');
        const bytesPer = bps / 8;
        const w = win ? { x: Math.max(0, win.x | 0), y: Math.max(0, win.y | 0) } : { x: 0, y: 0 };
        w.width = win ? Math.min((win.width | 0), width - w.x) : width;
        w.height = win ? Math.min((win.height | 0), height - w.y) : height;
        if (w.width <= 0 || w.height <= 0) throw new Error('gtiff: empty window');
        const out = new Uint8Array(w.width * w.height * spp * bytesPer);
        const rowOut = w.width * spp * bytesPer;
        const segs = this.segments(win ? w : null);
        if (!segs.length) throw new Error('gtiff: no strip/tile offsets');
        for (const s of segs) {
          const seg = await this.decodeSeg(s, bytesPer);
          const rowSeg = s.w * spp * bytesPer;
          const oc0 = Math.max(s.x0, w.x), oc1 = Math.min(s.x0 + s.w, Math.min(w.x + w.width, width));
          const or0 = Math.max(s.y0, w.y), or1 = Math.min(s.y0 + s.rows, Math.min(w.y + w.height, height));
          const copyW = (oc1 - oc0) * spp * bytesPer;
          if (copyW <= 0) continue;
          for (let r = or0; r < or1; r++) {
            const srcOff = (r - s.y0) * rowSeg + (oc0 - s.x0) * spp * bytesPer;
            out.set(seg.subarray(srcOff, srcOff + copyW), (r - w.y) * rowOut + (oc0 - w.x) * spp * bytesPer);
          }
        }
        let data = typedView(out.buffer, fmt, bps);
        if (spp > 1) {                                     // deinterleave the chosen band from chunky
          const bi = Math.max(0, Math.min(spp - 1, band | 0));
          const one = typedView(new ArrayBuffer(w.width * w.height * bytesPer), fmt, bps);
          for (let i = 0; i < w.width * w.height; i++) one[i] = data[i * spp + bi];
          data = one;
        }
        return { data, x: w.x, y: w.y, width: w.width, height: w.height };
      },
      async read(band = 0) { return (await this.readWindow(null, band)).data; },
      // decode the WHOLE image at 1/step resolution, one segment at a time —
      // bounded memory (one tile/strip + the coarse output), so ANY size TIFF
      // (overview or not, tiled or stripped) yields a display grid. Nodes are
      // taken on the step lattice (rows/cols ≡ 0 mod step); band 0 of chunky.
      async readDecimated(step, band = 0) {
        step = Math.max(1, step | 0);
        const bi = Math.max(0, Math.min(spp - 1, band | 0));
        if (step === 1) return { data: await this.read(bi), width, height, step: 1, dnx: width, dny: height };
        if (planar !== 1) throw new Error('gtiff: planar (band-separate) layout not supported');
        if (![8, 16, 32, 64].includes(bps)) throw new Error(`gtiff: ${bps}-bit samples not supported`);
        if (fmt === 3 && bps < 32) throw new Error('gtiff: half-float not supported');
        const bytesPer = bps / 8;
        const dnx = Math.ceil(width / step), dny = Math.ceil(height / step);
        const outBytes = new Uint8Array(dnx * dny * bytesPer);
        const outView = typedView(outBytes.buffer, fmt, bps);
        const segs = this.segments(null);
        if (!segs.length) throw new Error('gtiff: no strip/tile offsets');
        for (const s of segs) {
          const seg = await this.decodeSeg(s, bytesPer);
          const segView = typedView(seg.buffer, fmt, bps);   // native-endian samples
          const r0 = Math.ceil(s.y0 / step) * step, r1 = Math.min(s.y0 + s.rows, height);
          const c0 = Math.ceil(s.x0 / step) * step, c1 = Math.min(s.x0 + s.w, width);
          for (let r = r0; r < r1; r += step) {
            const segRow = (r - s.y0) * s.w * spp, outRow = (r / step) * dnx;
            for (let c = c0; c < c1; c += step) outView[outRow + c / step] = segView[segRow + (c - s.x0) * spp + bi];
          }
        }
        return { data: outView, width, height, step, dnx, dny };
      },
    };
    return img;
  };

  const images = ifds.map(mkImage).filter(Boolean);
  if (!images.length) throw new Error('gtiff: no image IFDs');
  return { images, geo: parseGeo(ifds[0], warnings), warnings, littleEndian: le };
}

// Convenience: one IFD → a north-up grid. x0/y0 are the coordinates of
// SAMPLE (0,0)'s CENTER (PixelIsArea shifts half a cell in from the corner
// origin; PixelIsPoint means the origin IS the node); row r's centre is
// y0 − r·dy with dy POSITIVE. Overview levels inherit IFD0's geo, scaled.
async function gridFromGTiff(g, level = 0, band = 0) {
  const img = g.images[level];
  const data = await img.read(band);
  const f = g.images[0].width / img.width;                 // overview scale factor
  let x0 = null, y0 = null, dx = 1, dy = 1;
  if (g.geo.origin && g.geo.scale) {
    dx = g.geo.scale[0] * f; dy = g.geo.scale[1] * f;
    const half = g.geo.pixelIsPoint ? 0 : 0.5;
    x0 = g.geo.origin[0] + half * dx;
    y0 = g.geo.origin[1] - half * dy;
  }
  return { nx: img.width, ny: img.height, data, x0, y0, dx, dy, nodata: g.geo.nodata, crs: g.geo.crs, pixelIsPoint: g.geo.pixelIsPoint, bands: img.samplesPerPixel, band };
}

// geo of a level as functions (no pixel decode): world ↔ pixel, cell size
function levelGeo(g, level = 0) {
  const img = g.images[level];
  const f = g.images[0].width / img.width;
  const dx = (g.geo.scale ? g.geo.scale[0] : 1) * f, dy = (g.geo.scale ? g.geo.scale[1] : 1) * f;
  const half = g.geo.pixelIsPoint ? 0 : 0.5;
  const x0 = g.geo.origin ? g.geo.origin[0] + half * dx : half * dx;         // sample (0,0) CENTRE
  const y0 = g.geo.origin ? g.geo.origin[1] - half * dy : -half * dy;
  return { nx: img.width, ny: img.height, x0, y0, dx, dy };
}

// the FINEST IFD level whose pixel count ≤ cap (fall back to the coarsest) —
// pick a display resolution within a decode budget. images[0] is full res;
// [1..n] are the overview pyramid (coarser as index grows), if present.
function pickOverviewForCap(g, cap) {
  let fin = -1;                                            // finest level whose pixels ≤ cap
  for (let i = 0; i < g.images.length; i++) {
    const px = g.images[i].width * g.images[i].height;
    if (px <= cap && (fin < 0 || g.images[i].width > g.images[fin].width)) fin = i;
  }
  // none fits → the coarsest (smallest) level, the best we can do within budget
  return fin >= 0 ? fin : g.images.reduce((c, im, i, a) => im.width * im.height < a[c].width * a[c].height ? i : c, 0);
}

// a WORLD bbox [minX, minY, maxX, maxY] → the level-`level` pixel window
// covering it (clamped), padded by `pad` cells for bilinear edges
function windowForWorldBbox(g, level, bbox, pad = 1) {
  const lg = levelGeo(g, level);
  const c0 = Math.floor((bbox[0] - lg.x0) / lg.dx) - pad;
  const c1 = Math.ceil((bbox[2] - lg.x0) / lg.dx) + pad;
  const r0 = Math.floor((lg.y0 - bbox[3]) / lg.dy) - pad;   // maxY → smallest row
  const r1 = Math.ceil((lg.y0 - bbox[1]) / lg.dy) + pad;
  const x = Math.max(0, c0), y = Math.max(0, r0);
  return { x, y, width: Math.min(lg.nx, c1 + 1) - x, height: Math.min(lg.ny, r1 + 1) - y };
}

// decode a pixel window of a level → a north-up grid (origin shifted to the
// window's sample (0,0) CENTRE). Only the overlapping tiles are decoded.
async function gridWindowFromGTiff(g, level, win, band = 0) {
  const img = g.images[level];
  const r = await img.readWindow(win, band);
  const lg = levelGeo(g, level);
  return { nx: r.width, ny: r.height, data: r.data, x0: lg.x0 + r.x * lg.dx, y0: lg.y0 - r.y * lg.dy, dx: lg.dx, dy: lg.dy, nodata: g.geo.nodata, crs: g.geo.crs, pixelIsPoint: g.geo.pixelIsPoint };
}

// the decimation step so a level fits a pixel cap (bounded-memory display of a
// huge non-overview raster). 1 if it already fits.
function stepForCap(g, level, cap) {
  const img = g.images[level];
  return Math.max(1, Math.ceil(Math.sqrt((img.width * img.height) / Math.max(1, cap))));
}

// decode a WHOLE level at 1/step resolution → a north-up grid (cell size ×
// step, origin unchanged — sample (0,0) is on the step lattice). One segment
// resident at a time; the display path for any-size TIFFs.
async function gridDecimatedFromGTiff(g, level, step, band = 0) {
  const img = g.images[level];
  const r = await img.readDecimated(step, band);
  const lg = levelGeo(g, level);
  return { nx: r.dnx, ny: r.dny, data: r.data, x0: lg.x0, y0: lg.y0, dx: lg.dx * r.step, dy: lg.dy * r.step, nodata: g.geo.nodata, crs: g.geo.crs, pixelIsPoint: g.geo.pixelIsPoint };
}

// ── src/main.js ──

// @gcu/gtiff — module manifest (build concat order).

export {
  lzwDecode,
  packbitsDecode,
  decodeSegment,
  undoPredictor2,
  undoPredictor3,
  readGTiff,
  gridFromGTiff,
  levelGeo,
  pickOverviewForCap,
  windowForWorldBbox,
  gridWindowFromGTiff,
  stepForCap,
  gridDecimatedFromGTiff,
};
