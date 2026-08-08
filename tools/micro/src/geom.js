// micro — pure structural-geometry helpers. Zero state, zero DOM: the first
// module carved out of the monolith, chosen precisely because it touches nothing
// but its arguments. World basis is X=east, Y=north, Z=up.

// small vector helpers
export const v3 = { dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; } };

// trend (azimuth, clockwise from north) + plunge (below horizontal) → unit vector
// in world (X=east, Y=north, Z=up)
export function dirTrendPlunge(trendDeg, plungeDeg) {
  const T = trendDeg * Math.PI / 180, P = plungeDeg * Math.PI / 180;
  return v3.norm([Math.cos(P) * Math.sin(T), Math.cos(P) * Math.cos(T), -Math.sin(P)]);
}

// dip-direction / dip / rake → an orthonormal TRIO [rakeLine, inPlanePerp, pole]
export function frameDipDirDipRake(ddDeg, dipDeg, rakeDeg) {
  const DD = ddDeg * Math.PI / 180, D = dipDeg * Math.PI / 180, R = rakeDeg * Math.PI / 180;
  const ddVec = [Math.cos(D) * Math.sin(DD), Math.cos(D) * Math.cos(DD), -Math.sin(D)];   // down-dip (steepest)
  const strike = [-Math.cos(DD), Math.sin(DD), 0];                                        // horizontal in-plane (trend DD−90)
  const rakeLine = v3.norm(v3.add(v3.scale(strike, Math.cos(R)), v3.scale(ddVec, Math.sin(R))));
  const inPlane = v3.norm(v3.add(v3.scale(strike, -Math.sin(R)), v3.scale(ddVec, Math.cos(R))));
  const pole = v3.norm(v3.cross(strike, ddVec));
  return [rakeLine, inPlane, pole];
}

export function swathDir(st) {
  if (st.mode === 'axes') return [[1, 0, 0], [0, 1, 0], [0, 0, 1]][st.axis];
  if (st.mode === 'oriented') return frameDipDirDipRake(st.dd, st.dip, st.rake)[st.axis];
  return dirTrendPlunge(st.trend, st.plunge);
}
