// @gcu/facet — plane fitting by principal component analysis of vertex POSITIONS.
//
// This is a total-least-squares fit: the plane that minimizes the sum of squared
// perpendicular distances to a set of points. It is NOT an average of face
// normals, and the difference matters — averaging normals weights by however the
// mesh happens to be triangulated, while the position fit weights by where the
// rock actually is.
//
//     T = (1/n) Σ (xᵢ - x̄)(xᵢ - x̄)ᵀ        the covariance, mean-centered
//     [values, vectors] = symmetricEigen3(T)   descending
//     normal = vectors[2]                      the SMALLEST eigenvalue's axis
//
// The eigenvalues are the dispersion measure, and they come out in squared
// length units: e0 and e1 span the patch, e2 is the variance perpendicular to
// the fitted plane, so `sqrt(e2)` is the RMS distance from the plane. A patch
// that is genuinely planar has e2 ≈ 0, and the ratio e2/e1 is the quality
// number to filter on.
//
// ── The mean-centering is load-bearing, twice ──
//
// Mathematically: @gcu/bearing already has an `orientationTensor(dcos)` which
// does NOT mean-center, because it is built for unit direction cosines where the
// origin is meaningful. Feed positions to that one and the leading eigenvector
// comes back pointing at the centroid rather than along the plane — a fit that is
// wrong and looks entirely plausible. Hence the deliberately different name here.
//
// Numerically: outcrop coordinates are UTM, so x ≈ 5e5 and x² ≈ 2.5e11. Float64
// carries ~16 significant digits, so accumulating raw squares would spend six of
// them representing an offset we are about to subtract. Both passes below work
// in coordinates shifted to the first point, which keeps every accumulated
// quantity the size of the patch rather than the size of the projection.

import { symmetricEigen3, conversions, statistics } from '@gcu/bearing';

/**
 * The one place a normal vector becomes a geological attitude.
 *
 * CAPIVARAS rolled this conversion by hand in four places out of a Y-up
 * spherical helper, plus a fifth that disagreed with the other four — the single
 * biggest source of silent wrongness in the original. There is exactly one copy
 * here, it delegates to @gcu/bearing, and it is round-trip tested.
 *
 * The input basis is **x = East, y = North, z = Up**, which is what micro's world
 * coordinates and bearing's direction cosines both already use, so the basis
 * change is the identity — stated once and verified, rather than assumed
 * everywhere. Either sign of the normal gives the same answer: `dcosToPlane`
 * folds the vector into the lower hemisphere itself.
 *
 * @param {ArrayLike<number>} normal  a plane normal (need not be unit length)
 * @returns {{dipDirection: number, dip: number}} degrees; dip ∈ [0, 90],
 *          dipDirection ∈ [0, 360). A horizontal plane has no meaningful dip
 *          direction — the value returned for one is arbitrary, not wrong.
 */
export function attitude(normal) {
  const [dd, dip] = conversions.dcosToPlane(unit(normal));
  return { dipDirection: dd, dip };
}

/**
 * The inverse of `attitude` — the downward pole of a plane at this attitude.
 * Present so the round trip can be tested, and so a synthetic plane can be built
 * from an attitude a geologist wrote down.
 */
export function normalOf(dipDirection, dip) {
  return conversions.planeToDcos(dipDirection, dip);
}

/**
 * The mean-centered covariance of a set of points.
 *
 * @param {ArrayLike<number>} positions  flat xyz, length 3·nv
 * @param {ArrayLike<number>} [indices]  which vertices to include; all if omitted
 * @returns {{tensor: Float64Array, centroid: number[], n: number}}
 *          `tensor` is row-major 3×3 (symmetric), ready for `symmetricEigen3`.
 */
export function fitTensor(positions, indices) {
  const n = indices ? indices.length : Math.floor(positions.length / 3);
  const centroid = [0, 0, 0];
  const tensor = new Float64Array(9);
  if (n <= 0) return { tensor, centroid, n: 0 };

  const at = (k) => (indices ? indices[k] : k) * 3;

  // pass 1 — the centroid, accumulated relative to the first point so that the
  // sum stays patch-sized even when the coordinates are UTM
  const o = at(0);
  const ox = positions[o], oy = positions[o + 1], oz = positions[o + 2];
  let sx = 0, sy = 0, sz = 0;
  for (let k = 0; k < n; k++) {
    const i = at(k);
    sx += positions[i] - ox;
    sy += positions[i + 1] - oy;
    sz += positions[i + 2] - oz;
  }
  centroid[0] = ox + sx / n;
  centroid[1] = oy + sy / n;
  centroid[2] = oz + sz / n;

  // pass 2 — the covariance of the centered points
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let k = 0; k < n; k++) {
    const i = at(k);
    const dx = positions[i] - centroid[0];
    const dy = positions[i + 1] - centroid[1];
    const dz = positions[i + 2] - centroid[2];
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const inv = 1 / n;
  tensor[0] = xx * inv; tensor[1] = xy * inv; tensor[2] = xz * inv;
  tensor[3] = xy * inv; tensor[4] = yy * inv; tensor[5] = yz * inv;
  tensor[6] = xz * inv; tensor[7] = yz * inv; tensor[8] = zz * inv;
  return { tensor, centroid, n };
}

/**
 * Fit a plane to a set of mesh vertices.
 *
 * @param {ArrayLike<number>} positions  flat xyz, length 3·nv
 * @param {ArrayLike<number>} [indices]  which vertices; all if omitted
 * @param {object} [opts]
 * @param {ArrayLike<number>} [opts.normals]  flat per-vertex normals, same
 *        indexing as `positions`. When given, two things change: the fitted
 *        normal is oriented to agree with the patch's mean surface normal (so it
 *        points out of the outcrop rather than at an arbitrary hemisphere), and
 *        Fisher statistics over the vertex normals are returned.
 * @param {number} [opts.collinearTol=1e-9]  e1/e0 below this means the points are
 *        collinear and the plane is not determined.
 * @returns {null | {
 *   normal: number[], centroid: number[], eig: number[], axes: number[][],
 *   n: number, radius: number, rms: number, eigRatio21: number, eigRatio20: number,
 *   dipDirection: number, dip: number, degenerate: null|'collinear',
 *   fisher?: {n,R,Rbar,mean,kappa,alpha95}
 * }}  `null` when fewer than 3 points are given — three is the minimum that
 *     determines a plane, and returning a confident-looking answer for two would
 *     be exactly the kind of plausible wrongness this package exists to avoid.
 */
export function fitPlane(positions, indices, opts = {}) {
  const { normals, collinearTol = 1e-9 } = opts;
  const { tensor, centroid, n } = fitTensor(positions, indices);
  if (n < 3) return null;

  const { values, vectors } = symmetricEigen3(tensor);
  let normal = unit(vectors[2]);                    // smallest eigenvalue → the pole

  // Orient it. With surface normals available the fit should agree with the rock
  // face; without them, fall back to bearing's convention of a downward pole.
  // Neither choice can change the attitude — `dcosToPlane` folds hemispheres —
  // but it does decide which way the reported vector points.
  let fisher;
  if (normals) {
    const mean = meanNormal(normals, indices, n);
    if (mean) {
      if (dot(normal, mean) < 0) normal = [-normal[0], -normal[1], -normal[2]];
      fisher = fisherOf(normals, indices, n, normal);
    }
  }
  if (!normals && normal[2] > 0) normal = [-normal[0], -normal[1], -normal[2]];

  // radius: how far the patch reaches from its center. Reported by CAPIVARAS and
  // worth keeping — it is the honest scale of the measurement, and a 4 cm plane
  // and a 4 m plane are not the same observation even at identical eigenvalues.
  let far = 0;
  const at = (k) => (indices ? indices[k] : k) * 3;
  for (let k = 0; k < n; k++) {
    const i = at(k);
    const dx = positions[i] - centroid[0];
    const dy = positions[i + 1] - centroid[1];
    const dz = positions[i + 2] - centroid[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > far) far = d2;
  }

  const [e0, e1, e2] = values;
  const { dipDirection, dip } = attitude(normal);
  return {
    normal,
    centroid,
    eig: [e0, e1, e2],
    axes: [unit(vectors[0]), unit(vectors[1]), normal],
    n,
    radius: Math.sqrt(far),
    rms: Math.sqrt(Math.max(0, e2)),               // RMS distance to the plane
    eigRatio21: e1 > 0 ? e2 / e1 : 0,              // the quality number to filter on
    eigRatio20: e0 > 0 ? e2 / e0 : 0,
    dipDirection,
    dip,
    degenerate: e0 > 0 && e1 / e0 < collinearTol ? 'collinear' : null,
    ...(fisher ? { fisher } : {}),
  };
}

// ── internals ──

function unit(v) {
  const L = Math.hypot(v[0], v[1], v[2]);
  return L > 0 ? [v[0] / L, v[1] / L, v[2] / L] : [0, 0, -1];
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function meanNormal(normals, indices, n) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < n; k++) {
    const i = (indices ? indices[k] : k) * 3;
    x += normals[i]; y += normals[i + 1]; z += normals[i + 2];
  }
  return Math.hypot(x, y, z) > 1e-12 ? [x, y, z] : null;
}

// Fisher statistics over the vertex normals, which is the ingredient CAPIVARAS
// exported (‖R̄‖) but never turned into a concentration. bearing finishes it.
//
// The normals are hemisphere-aligned to the fitted pole first. Mesh normals of a
// single patch normally agree already, but a patch spanning a sharp edge or a
// two-sided sheet would otherwise cancel to R̄ ≈ 0 and report a fictitious
// dispersion — an artifact of the sign convention, not of the rock.
function fisherOf(normals, indices, n, pole) {
  const dcos = new Array(n);
  for (let k = 0; k < n; k++) {
    const i = (indices ? indices[k] : k) * 3;
    const v = unit([normals[i], normals[i + 1], normals[i + 2]]);
    dcos[k] = dot(v, pole) < 0 ? [-v[0], -v[1], -v[2]] : v;
  }
  return statistics.fisherStats(dcos);
}
