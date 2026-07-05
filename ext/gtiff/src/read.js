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

import { decodeSegment, undoPredictor2, undoPredictor3 } from './codec.js';

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

export async function readGTiff(input) {
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
      async readWindow(win) {
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
        if (spp > 1) {                                     // band 0 of chunky interleave
          warnings.push(`multi-band image (${spp} samples/pixel) — reading band 0`);
          const band = typedView(new ArrayBuffer(w.width * w.height * bytesPer), fmt, bps);
          for (let i = 0; i < w.width * w.height; i++) band[i] = data[i * spp];
          data = band;
        }
        return { data, x: w.x, y: w.y, width: w.width, height: w.height };
      },
      async read() { return (await this.readWindow(null)).data; },
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
export async function gridFromGTiff(g, level = 0) {
  const img = g.images[level];
  const data = await img.read();
  const f = g.images[0].width / img.width;                 // overview scale factor
  let x0 = null, y0 = null, dx = 1, dy = 1;
  if (g.geo.origin && g.geo.scale) {
    dx = g.geo.scale[0] * f; dy = g.geo.scale[1] * f;
    const half = g.geo.pixelIsPoint ? 0 : 0.5;
    x0 = g.geo.origin[0] + half * dx;
    y0 = g.geo.origin[1] - half * dy;
  }
  return { nx: img.width, ny: img.height, data, x0, y0, dx, dy, nodata: g.geo.nodata, crs: g.geo.crs, pixelIsPoint: g.geo.pixelIsPoint };
}

// geo of a level as functions (no pixel decode): world ↔ pixel, cell size
export function levelGeo(g, level = 0) {
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
export function pickOverviewForCap(g, cap) {
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
export function windowForWorldBbox(g, level, bbox, pad = 1) {
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
export async function gridWindowFromGTiff(g, level, win) {
  const img = g.images[level];
  const r = await img.readWindow(win);
  const lg = levelGeo(g, level);
  return { nx: r.width, ny: r.height, data: r.data, x0: lg.x0 + r.x * lg.dx, y0: lg.y0 - r.y * lg.dy, dx: lg.dx, dy: lg.dy, nodata: g.geo.nodata, crs: g.geo.crs, pixelIsPoint: g.geo.pixelIsPoint };
}
