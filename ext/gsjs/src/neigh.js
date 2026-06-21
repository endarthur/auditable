// @gcu/gsjs — the search neighbourhood (M3a foundation: the moving ellipsoid).
//
// SPEC-neigh: the neighbourhood is a first-class, decoupled object — it SELECTS
// (and later tapers) the conditioning samples for a target; weighting stays the
// estimator's job. This is the Isatis-style split that lets one neighbourhood be
// reused across SK/OK/IK and compared apples-to-apples.
//
// Backend: a kd-tree (scitra's, inlined) built in TRANSFORMED coordinates — the
// `setrot` rotation+anisotropy is applied to every sample up front, so the
// anisotropic ellipsoid search collapses to a plain Euclidean sphere query. The
// tree is a prefilter only: select() recomputes the anisotropic distance via the
// ported `sqdist` and filters/sorts on THAT, so the result is bit-identical to a
// brute-force ellipsoid scan (the M3a validation gate) regardless of the tree's
// internal float order. Deterministic tie-break (original sample index) is a
// day-one invariant — the floor every later backend must reproduce.
//
// `ext/gslib` is frozen: setrot/sqdist are PORTED to JS here (faithfully, from
// gslib.atra) so gsjs owns the gather end-to-end in original sample order — no
// super-block permutation to thread. Spec: spec_inbox/SPEC-neigh.md §4.

import { KDTree } from '../../scitra/src/spatial/kdtree.js';
import { STATUS } from './realize.js';
import { sqdist, applyAnis, toRotmat, GSLIB_PI } from './orient.js';
// setrot/sqdist/orientation conventions live in orient.js (one-way dep); main.js
// exports orient.js's surface, so the package surface is unchanged.

// Apply R to a coordinate → its transformed-space position (Euclidean distance
// there == anisotropic sqdist here). Used to build the kd-tree.
function rotApply(R, x, y, z) {
  return [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
}

// Angular sector of an offset (dx,dy,dz) from the target, in the search's
// PURE-rotation frame (anisotropy removed, so sectors are true angular wedges
// aligned to the ellipsoid orientation, not stretched by anis). Horizontal
// azimuth → one of `n` wedges; with hemispheres, the dz sign doubles it to 2n.
function sectorOf(S, rotPure, dx, dy, dz) {
  const x = rotPure[0] * dx + rotPure[1] * dy + rotPure[2] * dz;
  const y = rotPure[3] * dx + rotPure[4] * dy + rotPure[5] * dz;
  let az = Math.atan2(y, x);
  if (az < 0) az += 2 * Math.PI;
  let w = Math.floor(az / (2 * Math.PI / S.n));
  if (w >= S.n) w = S.n - 1;
  if (S.hemispheres) {
    const z = rotPure[6] * dx + rotPure[7] * dy + rotPure[8] * dz;
    if (z < 0) w += S.n;
  }
  return w;
}

// createNeighborhood(opts) — the moving-ellipsoid neighbourhood. Orientation is
// convention-driven (see orient.js):
//   { radius, radiusMinor?, radiusVert?,           ranges: major / intermediate / minor
//     convention?, ndmin?, ndmax?, faithful?, sectors?, ...orientationParams }
//   convention 'gslib' (default): { azimuth | angle, dip | angle2, rake | angle3 }
//   convention 'leapfrog':        { dip, dipAzimuth, pitch }   (pitch from strike)
// radiusMinor/radiusVert default to radius (isotropic). `faithful:true` uses
// gslib's truncated π (oracle parity / wasm-kriging-fork consistency; gslib
// convention only). `sectors: { n, maxPer?, minPer?, minFilled?, hemispheres? }`
// turns on angular-sector declustering. The rotation matrix is built once here.
export function createNeighborhood(opts = {}) {
  if (!(opts.radius > 0)) throw new Error('gsjs.neigh: radius must be > 0');
  const radius = opts.radius;
  const radiusMinor = opts.radiusMinor != null ? opts.radiusMinor : radius;
  const radiusVert = opts.radiusVert != null ? opts.radiusVert : radius;
  const ndmin = opts.ndmin != null ? opts.ndmin : 1;
  const ndmax = opts.ndmax != null ? opts.ndmax : Infinity;
  if (!(ndmax >= ndmin) || !(ndmin >= 1)) throw new Error('gsjs.neigh: need ndmax ≥ ndmin ≥ 1');
  const faithful = !!opts.faithful;
  const pi = faithful ? GSLIB_PI : Math.PI;

  // orientation → pure (orthonormal) rotation; gslib accepts legacy angle/angle2/angle3.
  const convention = opts.convention || 'gslib';
  const orientParams = convention === 'gslib'
    ? { azimuth: opts.azimuth != null ? opts.azimuth : (opts.angle || 0), dip: opts.dip != null ? opts.dip : (opts.angle2 || 0), rake: opts.rake != null ? opts.rake : (opts.angle3 || 0) }
    : opts;
  const rotPure = toRotmat(convention, orientParams, pi);
  const rotmat = applyAnis(rotPure, radiusMinor / radius, radiusVert / radius);

  let sectors = null;
  if (opts.sectors) {
    const s = opts.sectors;
    const n = s.n != null ? s.n : 8;
    const maxPer = s.maxPer != null ? s.maxPer : Infinity;
    const minPer = s.minPer != null ? s.minPer : 1;
    const minFilled = s.minFilled != null ? s.minFilled : 1;
    const hemispheres = !!s.hemispheres;
    if (!(n >= 1)) throw new Error('gsjs.neigh: sectors.n must be ≥ 1');
    if (!(maxPer >= 1)) throw new Error('gsjs.neigh: sectors.maxPer must be ≥ 1');
    if (!(minPer >= 1) || minPer > maxPer) throw new Error('gsjs.neigh: need 1 ≤ sectors.minPer ≤ maxPer');
    if (!(minFilled >= 0)) throw new Error('gsjs.neigh: sectors.minFilled must be ≥ 0');
    sectors = { n, maxPer, minPer, minFilled, hemispheres, count: hemispheres ? 2 * n : n };
  }

  return {
    type: opts.type || 'moving',
    convention, faithful,
    radius, radiusMinor, radiusVert,
    rotmat, ndmin, ndmax, sectors,
    _rotPure: rotPure,   // pure orientation (anis removed) — used by sector binning
    _tree: null, _n: 0, _ox: null, _oy: null, _oz: null,
  };
}

// Bind the conditioning samples and build the kd-tree (once — samples are
// resident per §7). `samples` is an array of [x,y,z] (extra columns ignored), or
// the same row objects + a getter. Returns the neighbourhood (mutated) for chaining.
export function indexSamples(nbhd, samples, get) {
  const n = samples.length;
  const xform = new Float64Array(n * 3);
  const ox = new Float64Array(n), oy = new Float64Array(n), oz = new Float64Array(n);
  const R = nbhd.rotmat;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const x = get ? get(s, 0) : s[0], y = get ? get(s, 1) : s[1], z = get ? get(s, 2) : s[2];
    const t = rotApply(R, x, y, z);
    xform[i * 3] = t[0]; xform[i * 3 + 1] = t[1]; xform[i * 3 + 2] = t[2];
    ox[i] = x; oy[i] = y; oz[i] = z;
  }
  nbhd._tree = new KDTree({ data: xform, shape: [n, 3] });
  nbhd._n = n; nbhd._ox = ox; nbhd._oy = oy; nbhd._oz = oz;
  return nbhd;
}

// select(nbhd, target, opts?) — the neighbourhood for one target location.
//   target: [x, y, z]
//   returns { ranks: Int32Array, dists: Float64Array, status, n, filled? }
// `ranks` are ORIGINAL sample indices (into the array passed to indexSamples),
// distance-sorted then tie-broken by original index. Up to ndmax retained; with
// sectors, at most maxPer per sector (greedy in distance order). status is
// INSUFFICIENT_DATA when fewer than ndmin retained, or (sectors) fewer than
// minFilled sectors hold ≥ minPer. `filled` (sector count) is returned when
// sectors are active.
export function select(nbhd, target, opts = {}) {
  if (!nbhd._tree) throw new Error('gsjs.neigh.select: call indexSamples(nbhd, samples) first');
  const R = nbhd.rotmat;
  const tx = target[0], ty = target[1], tz = target[2];
  const [qx, qy, qz] = rotApply(R, tx, ty, tz);
  // Tree as PREFILTER: query slightly wide so transformed-coord float order can
  // never drop a boundary sample the authoritative sqdist would keep.
  const cand = nbhd._tree.query_ball_point([qx, qy, qz], nbhd.radius * (1 + 1e-9));
  const r2 = nbhd.radius * nbhd.radius;
  // Recompute the anisotropic distance authoritatively (same path as brute force)
  // and keep only those genuinely inside the ellipsoid.
  const inside = [];
  for (let k = 0; k < cand.length; k++) {
    const i = cand[k];
    const d2 = sqdist(tx, ty, tz, nbhd._ox[i], nbhd._oy[i], nbhd._oz[i], R);
    if (d2 <= r2) inside.push({ i, d2 });
  }
  inside.sort((a, b) => (a.d2 - b.d2) || (a.i - b.i));   // distance, then original index

  let keep, filled;
  const S = nbhd.sectors;
  if (S) {
    // greedy in distance order: keep a candidate if its sector isn't full and the
    // overall ndmax isn't reached — so sectors balance, distance still rules.
    const perSector = new Int32Array(S.count);
    keep = [];
    for (let k = 0; k < inside.length && keep.length < nbhd.ndmax; k++) {
      const c = inside[k];
      const sec = sectorOf(S, nbhd._rotPure, nbhd._ox[c.i] - tx, nbhd._oy[c.i] - ty, nbhd._oz[c.i] - tz);
      if (perSector[sec] >= S.maxPer) continue;
      perSector[sec]++;
      keep.push(c);
    }
    filled = 0;
    for (let s = 0; s < S.count; s++) if (perSector[s] >= S.minPer) filled++;
  } else {
    keep = inside.length > nbhd.ndmax ? inside.slice(0, nbhd.ndmax) : inside;
  }

  const ranks = new Int32Array(keep.length);
  const dists = new Float64Array(keep.length);
  for (let k = 0; k < keep.length; k++) { ranks[k] = keep[k].i; dists[k] = Math.sqrt(keep[k].d2); }
  const enough = keep.length >= nbhd.ndmin && (!S || filled >= S.minFilled);
  const out = { ranks, dists, n: keep.length, status: enough ? STATUS.OK : STATUS.INSUFFICIENT_DATA };
  if (S) out.filled = filled;
  return out;
}
