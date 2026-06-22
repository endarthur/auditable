// @gcu/gsjs — orientation conventions. The search ellipsoid / variogram anisotropy
// can be oriented in several mutually-incompatible parameterizations (GSLIB
// azimuth/dip/rake, Leapfrog dip/dip-azimuth/pitch, Isatis's nine, …). This module
// is the registry that maps each to ONE canonical form — the orthonormal 3×3
// rotation matrix whose ROWS are the ellipsoid axes in world coordinates:
//   row0 = major (Maximum range), row1 = semi-major (Intermediate), row2 = minor.
// World frame: X = East, Y = North, Z = up. `sqdist` / the kd-tree consume the
// matrix (after anisotropy scaling), so conversions go THROUGH the matrix — we
// never hand-derive cross-convention angle trig.
//
// Convention facts pinned by research (2026-06-21, see SPEC-neigh + memory):
//   GSLIB  — intrinsic Z·X·Y, major = North at zero, dip POSITIVE-UP (the quirk).
//            Our setrot port (validated f64 vs gslib wasm). 'gslib' producer.
//   Leapfrog — intrinsic Z·X·Z clockwise (dipAz·Z, dip·X, pitch·Z); pitch measured
//            FROM STRIKE (pitch 0 → major along strike, 90 → down-dip), per
//            Seequent's developer rotation schema. Built here by DIRECT geometric
//            construction of the axis vectors (no Euler sign ambiguity).
//   Isatis.neo — nine named conventions + a conversion tool; same matrix-canonical
//            idea. Future producers slot in here as data (axis order + signs).
//
// UNVERIFIED-vs-real-Leapfrog (single-line toggles, flagged): the strike SENSE
// (right-hand-rule, dipAz−90) and the pitch sign. Confirm against a real Leapfrog
// export when convenient; the geometry below is self-consistent with the docs.

// GSLIB's setrot.for uses a TRUNCATED pi literal (3.141592654) — a 1998 Fortran
// artifact. The 'gslib' producer defaults to Math.PI (modern) and takes GSLIB_PI
// for bit-identical oracle parity (atra's sin/cos are JS Math imports, so this
// literal is the only divergence). Leapfrog etc. always use Math.PI.
export const GSLIB_PI = 3.141592654;

// ── GSLIB setrot / sqdist (the validated baseline, ported from gslib.atra) ──

// Port of gslib.setrot (gslib.atra:196). GSLIB angle convention: ang1=azimuth
// (CW from N), ang2=dip, ang3=rake. Row-major 3×3; anisotropy ratios fold into
// rows 2,3 (anis1=minorRange/majorRange, anis2=vertRange/majorRange). `pi` picks
// accurate (Math.PI) vs faithful (GSLIB_PI).
export function setrot(ang1, ang2, ang3, anis1, anis2, pi = Math.PI) {
  const DEG = pi / 180;
  const alpha = (ang1 >= 0 && ang1 < 270 ? (90 - ang1) : (450 - ang1)) * DEG;
  const beta = -ang2 * DEG;
  const theta = ang3 * DEG;
  const sina = Math.sin(alpha), sinb = Math.sin(beta), sint = Math.sin(theta);
  const cosa = Math.cos(alpha), cosb = Math.cos(beta), cost = Math.cos(theta);
  const afac1 = 1 / Math.max(anis1, 1e-20);
  const afac2 = 1 / Math.max(anis2, 1e-20);
  return [
    cosb * cosa, cosb * sina, -sinb,
    afac1 * (-cost * sina + sint * sinb * cosa), afac1 * (cost * cosa + sint * sinb * sina), afac1 * (sint * cosb),
    afac2 * (sint * sina + cost * sinb * cosa), afac2 * (-sint * cosa + cost * sinb * sina), afac2 * (cost * cosb),
  ];
}

// Port of gslib.sqdist (gslib.atra:245) — squared anisotropic distance under R.
export function sqdist(x1, y1, z1, x2, y2, z2, R) {
  const dx = x1 - x2, dy = y1 - y2, dz = z1 - z2;
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const c = R[i * 3] * dx + R[i * 3 + 1] * dy + R[i * 3 + 2] * dz;
    s += c * c;
  }
  return s;
}

// Scale an orthonormal rotation R (rows = major/semi-major/minor axes) into the
// anisotropic distance matrix sqdist wants: rows 1,2 divided by the range ratios
// (so distance along a short axis counts more). Identical to setrot's afac folding.
export function applyAnis(R, anis1, anis2) {
  const a1 = 1 / Math.max(anis1, 1e-20), a2 = 1 / Math.max(anis2, 1e-20);
  return [
    R[0], R[1], R[2],
    a1 * R[3], a1 * R[4], a1 * R[5],
    a2 * R[6], a2 * R[7], a2 * R[8],
  ];
}

// ── vector helpers ──
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
// horizontal unit vector at azimuth (radians, CW from North): East=sin, North=cos
const unitH = (azRad) => [Math.sin(azRad), Math.cos(azRad), 0];

// ── Leapfrog producer (direct geometric construction) ──
//
// leapfrogToRotmat({ dip, dipAzimuth, pitch }) → orthonormal R (pure rotation).
// dip = angle below horizontal of the major-semimajor plane; dipAzimuth = compass
// direction of dip (CW from N); pitch = angle of the major axis IN the plane,
// measured from strike (0 → along strike, 90 → down-dip). Built straight from
// these meanings — pitch-from-strike falls out by construction, so there's no
// Euler-order/sign trap. Strike uses the right-hand rule (dip to the right →
// strike = dipAzimuth − 90°); see the UNVERIFIED note up top. This is the standard
// structural-geology convention (Leapfrog and others use it); the public name is
// 'structural' (leapfrogToRotmat is kept as a quiet alias).
export function structuralToRotmat({ dip = 0, dipAzimuth = 0, pitch = 0 } = {}) {
  const r = Math.PI / 180;
  const az = dipAzimuth * r, dp = dip * r, pt = pitch * r;
  const cd = Math.cos(dp), sd = Math.sin(dp);
  const strike = unitH(az - Math.PI / 2);                       // RHR strike
  const downdip = [Math.sin(az) * cd, Math.cos(az) * cd, -sd];  // toward dipAz, plunging down
  const cp = Math.cos(pt), sp = Math.sin(pt);
  const major = add(scale(strike, cp), scale(downdip, sp));     // pitch from strike
  const semimajor = add(scale(strike, -sp), scale(downdip, cp));// in-plane ⟂ to major
  const minor = cross(major, semimajor);                        // plane normal — right-handed (det +1)
  return [...major, ...semimajor, ...minor];
}
export { structuralToRotmat as leapfrogToRotmat };              // quiet alias

// ── convention dispatcher ──
//
// toRotmat(convention, params, pi?) → orthonormal R (rows = major/semi-major/minor).
//   'structural' { dip, dipAzimuth, pitch } — the geologist default (dip/dip-az/pitch)
//   'gslib'      { azimuth, dip, rake }      — the GSLIB baseline (pi-flag aware)
// ('leapfrog' is accepted as an alias of 'structural'.) Anisotropy is applied
// separately (applyAnis) so this stays pure orientation.
export function toRotmat(convention, params = {}, pi = Math.PI) {
  switch (convention) {
    case 'gslib':
      return setrot(params.azimuth || 0, params.dip || 0, params.rake || 0, 1, 1, pi);
    case 'structural':
    case 'leapfrog':
      return structuralToRotmat(params);
    default:
      throw new Error(`gsjs.orient: unknown convention '${convention}'`);
  }
}
