// moncad snap — a uniform-grid spatial index over snap targets (SPEC §6). Pure: no
// DOM/WebGL.
//
// The same index that makes the board feel alive (hover → snap to the nearest endpoint /
// midpoint / centre) is the one that does PICKING later. Targets are in LOCAL coords;
// query() takes a local point + a local tolerance (the caller converts a pixel tolerance
// via the viewport scale) and returns the best snap — nearest within tolerance, ties and
// near-ties broken by snap-type priority. Build once per scene; query per mousemove.

// Higher = preferred when two candidates are within tolerance.
const PRIORITY = { intersect: 5, end: 4, node: 4, center: 3, mid: 2, grid: 1 };

export class SnapIndex {
  constructor(snaps = [], opts = {}) {
    this.snaps = snaps;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const s of snaps) { const [x, y] = s.p; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    const ext = Math.max(maxx - minx, maxy - miny, 1);
    this.cell = opts.cell || Math.max(ext / 50, 1e-6);      // auto-sized; ~50 cells across the data
    this.grid = new Map();
    for (const s of snaps) this._put(s);
  }

  _key(x, y) { return Math.floor(x / this.cell) + ',' + Math.floor(y / this.cell); }
  _put(s) { const k = this._key(s.p[0], s.p[1]); const a = this.grid.get(k); if (a) a.push(s); else this.grid.set(k, [s]); }

  // Nearest snap to local point `p` within `tol` (local units), or null. When two are
  // within tolerance, the higher-priority type wins; among equal priority, the nearer.
  query(p, tol) {
    const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    const reach = Math.max(1, Math.ceil(tol / this.cell));
    let best = null, bestD = Infinity, bestPri = -1;
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iy = cy - reach; iy <= cy + reach; iy++) {
        const a = this.grid.get(ix + ',' + iy);
        if (!a) continue;
        for (const s of a) {
          const d = Math.hypot(s.p[0] - p[0], s.p[1] - p[1]);
          if (d > tol) continue;
          const pri = PRIORITY[s.type] || 0;
          if (pri > bestPri || (pri === bestPri && d < bestD)) { best = s; bestD = d; bestPri = pri; }
        }
      }
    }
    return best;
  }

  // ALL snaps within `tol`, sorted best-first (priority desc, then distance asc). The
  // snap-control layer needs the full candidate set, not just the winner, so it can filter
  // by the active type set and let Tab cycle the runners-up (SPEC §7). The index itself is
  // unchanged — this is just a second read over the same grid.
  queryAll(p, tol) {
    const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
    const reach = Math.max(1, Math.ceil(tol / this.cell));
    const out = [];
    for (let ix = cx - reach; ix <= cx + reach; ix++) {
      for (let iy = cy - reach; iy <= cy + reach; iy++) {
        const a = this.grid.get(ix + ',' + iy);
        if (!a) continue;
        for (const s of a) { const d = Math.hypot(s.p[0] - p[0], s.p[1] - p[1]); if (d <= tol) out.push({ snap: s, d }); }
      }
    }
    out.sort((a, b) => (PRIORITY[b.snap.type] || 0) - (PRIORITY[a.snap.type] || 0) || a.d - b.d);
    return out;
  }
}
