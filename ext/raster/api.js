// raster high-level API — appended to binary dist by build.js.
// Runtime helpers (alloc, writeF32, readF32, growMemory, instantiate)
// are in module scope from the binary dist.

const DEG2RAD = Math.PI / 180;
const NODATA_DEFAULT = -9999;

function _parseCellSize(cellSize) {
  if (Array.isArray(cellSize)) return [cellSize[0], cellSize[1]];
  return [cellSize, cellSize];
}

function _allocMem(nArrays, n) {
  const pages = Math.ceil(nArrays * n * 4 / 65536) + 2;
  return new WebAssembly.Memory({ initial: pages });
}

export function slope(data, w, h, cellSize, opts) {
  const [cx, cy] = _parseCellSize(cellSize);
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(2, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.slope(pDem, pOut, w, h, cx, cy, nodata);
  return readF32(mem, pOut, n);
}

export function aspect(data, w, h, cellSize, opts) {
  const [cx, cy] = _parseCellSize(cellSize);
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(2, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.aspect(pDem, pOut, w, h, cx, cy, nodata);
  return readF32(mem, pOut, n);
}

export function hillshade(data, w, h, cellSize, opts) {
  const [cx, cy] = _parseCellSize(cellSize);
  const o = opts || {};
  const nodata = o.nodata != null ? o.nodata : NODATA_DEFAULT;
  const azimuth = o.azimuth != null ? o.azimuth : 315;
  const altitude = o.altitude != null ? o.altitude : 45;
  const zFactor = o.zFactor != null ? o.zFactor : 1;
  const azRad = (360 - azimuth + 90) * DEG2RAD;
  const zenRad = (90 - altitude) * DEG2RAD;
  const n = w * h;
  const mem = _allocMem(2, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.hillshade(pDem, pOut, w, h, cx, cy, nodata, azRad, zenRad, zFactor);
  return readF32(mem, pOut, n);
}

export function terrain(data, w, h, cellSize, opts) {
  const [cx, cy] = _parseCellSize(cellSize);
  const o = opts || {};
  const nodata = o.nodata != null ? o.nodata : NODATA_DEFAULT;
  const azimuth = o.azimuth != null ? o.azimuth : 315;
  const altitude = o.altitude != null ? o.altitude : 45;
  const zFactor = o.zFactor != null ? o.zFactor : 1;
  const azRad = (360 - azimuth + 90) * DEG2RAD;
  const zenRad = (90 - altitude) * DEG2RAD;
  const n = w * h;
  const mem = _allocMem(4, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pS = alloc(st, 0, n);
  const pA = alloc(st, 0, n);
  const pH = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.terrain(pDem, pS, pA, pH, w, h, cx, cy, nodata, azRad, zenRad, zFactor);
  return {
    slope: readF32(mem, pS, n),
    aspect: readF32(mem, pA, n),
    hillshade: readF32(mem, pH, n),
  };
}

export function curvature(data, w, h, cellSize, opts) {
  const [cx, cy] = _parseCellSize(cellSize);
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(4, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pProf = alloc(st, 0, n);
  const pPlan = alloc(st, 0, n);
  const pMean = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.curvature(pDem, pProf, pPlan, pMean, w, h, cx, cy, nodata);
  return {
    profile: readF32(mem, pProf, n),
    plan: readF32(mem, pPlan, n),
    mean: readF32(mem, pMean, n),
  };
}

export function tri(data, w, h, opts) {
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(2, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.tri(pDem, pOut, w, h, nodata);
  return readF32(mem, pOut, n);
}

export function tpi(data, w, h, opts) {
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(2, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.tpi(pDem, pOut, w, h, nodata);
  return readF32(mem, pOut, n);
}

export function roughness(data, w, h, opts) {
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(2, n);
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.roughness(pDem, pOut, w, h, nodata);
  return readF32(mem, pOut, n);
}

// ── D8 flow direction lookup tables ──────────────────────────────────

// D8 encoding: bit 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
const _D8_DR = [0, 1, 1, 1, 0, -1, -1, -1];
const _D8_DC = [1, 1, 0, -1, -1, -1, 0, 1];
const _D8_BIT = new Uint8Array(129);
for (let b = 0; b < 8; b++) _D8_BIT[1 << b] = b;

// ── flowDirection — D8 via atra kernel ──────────────────────────────

export function flowDirection(data, w, h, cellSize, opts) {
  const [cx, cy] = _parseCellSize(cellSize);
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const mem = _allocMem(3, n); // dem(f32) + out(i32)
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };
  const pDem = alloc(st, 0, n);
  const pOut = alloc(st, 0, n);
  growMemory(mem, st.off);
  writeF32(mem, pDem, data);
  lib.raster.flowDir(pDem, pOut, w, h, cx, cy, nodata);
  return Uint8Array.from(readI32(mem, pOut, n));
}

// ── fillSinks — priority-flood with epsilon (Barnes et al. 2014) ────

class _MinHeap {
  constructor(capacity) {
    this._keys = new Float32Array(capacity);
    this._vals = new Int32Array(capacity);
    this._size = 0;
  }
  get size() { return this._size; }
  push(key, val) {
    let i = this._size++;
    this._keys[i] = key;
    this._vals[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._keys[p] <= this._keys[i]) break;
      this._swap(i, p);
      i = p;
    }
  }
  pop() {
    const key = this._keys[0];
    const val = this._vals[0];
    const last = --this._size;
    if (last > 0) {
      this._keys[0] = this._keys[last];
      this._vals[0] = this._vals[last];
      this._siftDown(0);
    }
    return [key, val];
  }
  _swap(a, b) {
    let t = this._keys[a]; this._keys[a] = this._keys[b]; this._keys[b] = t;
    let u = this._vals[a]; this._vals[a] = this._vals[b]; this._vals[b] = u;
  }
  _siftDown(i) {
    const n = this._size;
    while (true) {
      let min = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._keys[l] < this._keys[min]) min = l;
      if (r < n && this._keys[r] < this._keys[min]) min = r;
      if (min === i) break;
      this._swap(i, min);
      i = min;
    }
  }
}

export function fillSinks(data, w, h, opts) {
  const nodata = (opts && opts.nodata != null) ? opts.nodata : NODATA_DEFAULT;
  const n = w * h;
  const EPS = 1e-5;
  const out = new Float32Array(n);
  out.set(data);
  const visited = new Uint8Array(n);
  const heap = new _MinHeap(n);

  // seed edges
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (r === 0 || r === h - 1 || c === 0 || c === w - 1) {
        const idx = r * w + c;
        visited[idx] = 1;
        if (out[idx] === nodata) continue;
        heap.push(out[idx], idx);
      }
    }
  }

  // mark nodata as visited (barriers)
  for (let i = 0; i < n; i++) {
    if (out[i] === nodata) visited[i] = 1;
  }

  while (heap.size > 0) {
    const [elev, idx] = heap.pop();
    const r = (idx / w) | 0, c = idx % w;
    for (let d = 0; d < 8; d++) {
      const nr = r + _D8_DR[d], nc = c + _D8_DC[d];
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      const ni = nr * w + nc;
      if (visited[ni]) continue;
      visited[ni] = 1;
      if (out[ni] < elev + EPS) out[ni] = elev + EPS;
      heap.push(out[ni], ni);
    }
  }

  return out;
}

// ── flowAccumulation — topological sort BFS ─────────────────────────

export function flowAccumulation(fdir, w, h) {
  const n = w * h;
  const indeg = new Uint8Array(n);
  const acc = new Float32Array(n);
  acc.fill(1);

  // compute in-degrees
  for (let i = 0; i < n; i++) {
    const code = fdir[i];
    if (code === 0) continue;
    const b = _D8_BIT[code];
    const r = (i / w) | 0, c = i % w;
    const nr = r + _D8_DR[b], nc = c + _D8_DC[b];
    if (nr >= 0 && nr < h && nc >= 0 && nc < w) {
      indeg[nr * w + nc]++;
    }
  }

  // seed queue with in-degree-0 cells
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (indeg[i] === 0) queue[tail++] = i;
  }

  // BFS
  while (head < tail) {
    const i = queue[head++];
    const code = fdir[i];
    if (code === 0) continue;
    const b = _D8_BIT[code];
    const r = (i / w) | 0, c = i % w;
    const nr = r + _D8_DR[b], nc = c + _D8_DC[b];
    if (nr >= 0 && nr < h && nc >= 0 && nc < w) {
      const ni = nr * w + nc;
      acc[ni] += acc[i];
      if (--indeg[ni] === 0) queue[tail++] = ni;
    }
  }

  return acc;
}

// ── watershed — upstream BFS from seed points ───────────────────────

export function watershed(fdir, w, h, seeds) {
  const n = w * h;
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  // seed labels
  for (let s = 0; s < seeds.length; s++) {
    const [sc, sr] = seeds[s];
    if (sr >= 0 && sr < h && sc >= 0 && sc < w) {
      const idx = sr * w + sc;
      labels[idx] = s + 1;
      queue[tail++] = idx;
    }
  }

  // BFS upstream
  while (head < tail) {
    const idx = queue[head++];
    const r = (idx / w) | 0, c = idx % w;
    const lbl = labels[idx];
    for (let d = 0; d < 8; d++) {
      const nr = r + _D8_DR[d], nc = c + _D8_DC[d];
      if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
      const ni = nr * w + nc;
      if (labels[ni] !== 0) continue;
      // check if neighbor's flow direction points TO this cell
      // neighbor at direction d flows toward us if its code = reverse direction
      // reverse of d is (d+4)%8, and the code is 1 << ((d+4)%8)
      const reverseCode = 1 << ((d + 4) % 8);
      if (fdir[ni] === reverseCode) {
        labels[ni] = lbl;
        queue[tail++] = ni;
      }
    }
  }

  return labels;
}

// ── contour — marching squares → GeoJSON ────────────────────────────

export function contour(data, w, h, bbox, opts) {
  const o = opts || {};
  const interval = o.interval || 100;
  const base = o.base || 0;
  const attr = o.attribute || 'elev';
  const nodata = o.nodata != null ? o.nodata : NODATA_DEFAULT;

  const [west, south, east, north] = bbox;
  const dx = (east - west) / (w - 1);
  const dy = (north - south) / (h - 1);

  // find elevation range (excluding nodata)
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === nodata || !isFinite(v)) continue;
    if (v < zMin) zMin = v;
    if (v > zMax) zMax = v;
  }
  if (!isFinite(zMin)) return { type: 'FeatureCollection', features: [] };

  // enumerate contour levels
  const levels = [];
  let lv = Math.ceil((zMin - base) / interval) * interval + base;
  while (lv <= zMax) {
    if (lv >= zMin) levels.push(lv);
    lv += interval;
  }

  const features = [];

  for (const level of levels) {
    // marching squares on cell grid (w-1 x h-1 cells)
    // each cell has 4 corners: (r,c), (r,c+1), (r+1,c), (r+1,c+1)
    const segments = [];

    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const v0 = data[r * w + c];         // top-left
        const v1 = data[r * w + c + 1];     // top-right
        const v2 = data[(r + 1) * w + c + 1]; // bottom-right
        const v3 = data[(r + 1) * w + c];   // bottom-left

        if (v0 === nodata || v1 === nodata || v2 === nodata || v3 === nodata) continue;
        if (!isFinite(v0) || !isFinite(v1) || !isFinite(v2) || !isFinite(v3)) continue;

        const b0 = v0 >= level ? 1 : 0;
        const b1 = v1 >= level ? 1 : 0;
        const b2 = v2 >= level ? 1 : 0;
        const b3 = v3 >= level ? 1 : 0;
        const code = b0 | (b1 << 1) | (b2 << 2) | (b3 << 3);

        if (code === 0 || code === 15) continue;

        // interpolation helpers — pixel coordinates (col, row as fractional)
        const t01 = v0 !== v1 ? (level - v0) / (v1 - v0) : 0.5;
        const t12 = v1 !== v2 ? (level - v1) / (v2 - v1) : 0.5;
        const t23 = v2 !== v3 ? (level - v2) / (v3 - v2) : 0.5; // right to left: v3 is left
        const t30 = v3 !== v0 ? (level - v3) / (v0 - v3) : 0.5;

        // edge midpoints in pixel coords
        const top    = [c + t01, r];
        const right  = [c + 1, r + t12];
        const bottom = [c + 1 - t23, r + 1];
        const left   = [c, r + 1 - t30];

        const cellSegs = [];
        switch (code) {
          case 1: cellSegs.push([left, top]); break;
          case 2: cellSegs.push([top, right]); break;
          case 3: cellSegs.push([left, right]); break;
          case 4: cellSegs.push([right, bottom]); break;
          case 5: // saddle
            cellSegs.push([left, top]);
            cellSegs.push([right, bottom]);
            break;
          case 6: cellSegs.push([top, bottom]); break;
          case 7: cellSegs.push([left, bottom]); break;
          case 8: cellSegs.push([bottom, left]); break;
          case 9: cellSegs.push([bottom, top]); break;
          case 10: // saddle
            cellSegs.push([top, right]);
            cellSegs.push([bottom, left]);
            break;
          case 11: cellSegs.push([bottom, right]); break;
          case 12: cellSegs.push([right, left]); break;
          case 13: cellSegs.push([right, top]); break;
          case 14: cellSegs.push([top, left]); break;
        }
        for (const seg of cellSegs) segments.push(seg);
      }
    }

    // stitch segments into polylines
    const lines = _stitchSegments(segments);

    for (const line of lines) {
      // convert pixel coords to geographic
      const coords = line.map(([px, py]) => [
        west + px * dx,
        north - py * dy,
      ]);
      features.push({
        type: 'Feature',
        properties: { [attr]: level },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

function _stitchSegments(segments) {
  if (segments.length === 0) return [];
  const EPS = 1e-9;
  const eq = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

  const lines = [];
  const used = new Uint8Array(segments.length);

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segments[i][0], segments[i][1]];

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const s = segments[j];
        if (eq(s[0], line[line.length - 1])) {
          line.push(s[1]);
          used[j] = 1;
          changed = true;
        } else if (eq(s[1], line[line.length - 1])) {
          line.push(s[0]);
          used[j] = 1;
          changed = true;
        } else if (eq(s[1], line[0])) {
          line.unshift(s[0]);
          used[j] = 1;
          changed = true;
        } else if (eq(s[0], line[0])) {
          line.unshift(s[1]);
          used[j] = 1;
          changed = true;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}
