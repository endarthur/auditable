// @gcu/gsjs — the LAG-SUPPORT SURFACE L(û): for every direction on the hemisphere, the
// reasonable lag spacing, derived purely from where the data PAIRS sit (point positions
// only — no grades). It's a data-support map: fine along the holes (~composite length),
// coarse across the drill pattern (~drill spacing), and directions with no close pairs are
// directions you're structurally blind in. Its job is to DRIVE per-direction lag selection
// in the sweep — "fine resolution is wherever close pairs are," derived, not assumed (no
// hardcoded "vertical", so inclined / fanned / mixed surveys work the same).
//
// Method: golden-spiral (Fibonacci) nodes on the hemisphere for even direction coverage;
// each pair is assigned to its nearest node and contributes its separation; per node, L is a
// low quantile of those separations. Pair enumeration is KDTree-bounded to maxSep (the
// buildLagVolume pattern — O(N·k), not O(N²)). Memory is bounded by the node count, not N.
//
// Exact low-quantile per node for now; the t-digest seam (see variogram.js §lag-vector volume
// + SPEC-variography §10) is open — swap a @gcu/sluice t-digest of separations into each node
// for the streaming / mergeable / proc-parallel version at scale.

import { KDTree } from '../../scitra/src/spatial/kdtree.js';   // inlined by build.js (the neigh.js pattern)

// azimuth (CW from North) + plunge (down from horizontal) → unit vector (East=sin, North=cos; down = −z).
// (Math.PI/180 inlined — no top-level D2R const, which would collide when a host concatenates the bundle bare.)
function dirVec(az, plunge) { const t = az * Math.PI / 180, p = plunge * Math.PI / 180, cp = Math.cos(p); return [Math.sin(t) * cp, Math.cos(t) * cp, -Math.sin(p)]; }

// golden-spiral nodes on the LOWER hemisphere (variogram is undirected → fold to z ≤ 0)
function fibNodes(n) {
  const ga = Math.PI * (3 - Math.sqrt(5)), out = new Array(n);
  for (let i = 0; i < n; i++) { const z = -(i + 0.5) / n, r = Math.sqrt(1 - z * z), th = ga * i; out[i] = [Math.cos(th) * r, Math.sin(th) * r, z]; }
  return out;
}

// lagSupport(data, opts) → { nodes, L, nNodes, maxSep, q }
//   data: [[x,y,z,(v?)], …] (z optional → treated as 2-D); only positions are read.
//   opts: { nNodes=256, maxSep=0.3·extent, q=0.06, minPairs=12 }
//   nodes[k] = a lower-hemisphere unit direction; L[k] = its reasonable lag (or null if too sparse).
export function lagSupport(data, opts = {}) {
  const nd = data.length, is3d = data[0] && data[0].length > 3;
  const X = new Float64Array(nd), Y = new Float64Array(nd), Z = new Float64Array(nd);
  let xmn = Infinity, xmx = -Infinity, ymn = Infinity, ymx = -Infinity, zmn = Infinity, zmx = -Infinity;
  for (let i = 0; i < nd; i++) {
    const d = data[i], x = d[0], y = d[1], z = is3d ? d[2] : 0;
    X[i] = x; Y[i] = y; Z[i] = z;
    if (x < xmn) xmn = x; if (x > xmx) xmx = x; if (y < ymn) ymn = y; if (y > ymx) ymx = y; if (z < zmn) zmn = z; if (z > zmx) zmx = z;
  }
  const extent = Math.max(xmx - xmn, ymx - ymn, zmx - zmn) || 1;
  const nNodes = opts.nNodes ?? 256, q = opts.q ?? 0.06, minPairs = opts.minPairs ?? 12;
  const maxSep = opts.maxSep ?? 0.3 * extent;
  const nodes = fibNodes(nNodes), seps = Array.from({ length: nNodes }, () => []);

  const flat = new Float64Array(nd * 3);
  for (let i = 0; i < nd; i++) { flat[i * 3] = X[i]; flat[i * 3 + 1] = Y[i]; flat[i * 3 + 2] = Z[i]; }
  const tree = new KDTree({ data: flat, shape: [nd, 3] }), r = maxSep * (1 + 1e-9);

  for (let i = 0; i < nd; i++) {
    const nb = tree.query_ball_point([X[i], Y[i], Z[i]], r);
    for (let qi = 0; qi < nb.length; qi++) {
      const j = nb[qi]; if (j <= i) continue;                 // each pair once (also skips self)
      const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i], s = Math.hypot(dx, dy, dz);
      if (s <= 0 || s > maxSep) continue;
      let ux = dx / s, uy = dy / s, uz = dz / s; if (uz > 0) { ux = -ux; uy = -uy; uz = -uz; }   // fold to lower hemisphere
      let best = 0, bd = -2;
      for (let k = 0; k < nNodes; k++) { const n = nodes[k], dot = ux * n[0] + uy * n[1] + uz * n[2]; if (dot > bd) { bd = dot; best = k; } }
      seps[best].push(s);
    }
  }
  const L = seps.map((arr) => { if (arr.length < minPairs) return null; arr.sort((a, b) => a - b); return arr[Math.floor(q * arr.length)]; });
  return { nodes, L, nNodes, maxSep, q };
}

// lagSupportAt(surface, az, plunge) → the reasonable lag in that direction (nearest node;
// null if that node is too sparse). az = azimuth CW from North, plunge = dip below horizontal.
export function lagSupportAt(surface, az, plunge) {
  const d = dirVec(az, plunge), nodes = surface.nodes;
  let best = 0, bd = -2;
  for (let k = 0; k < nodes.length; k++) { const n = nodes[k], v = Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]); if (v > bd) { bd = v; best = k; } }
  return surface.L[best];
}
