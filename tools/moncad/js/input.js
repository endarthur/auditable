// moncad precision input — parse a typed coordinate string into a LOCAL point (SPEC §3).
//
// The AutoLISP input family, the real soul of CAD typing:
//   x,y      absolute WORLD coordinate              → local = world − origin
//   @dx,dy   relative to the last point             → last + [dx,dy]
//   d<a      absolute polar (world), a degrees CCW from +X
//   @d<a     relative polar from the last point      → last + d·[cos a, sin a]
// Numbers take decimals and signs; comma OR whitespace separates x and y; a leading '@'
// means "relative to the last point". Returns
//   { ok:true, local:[x,y] }  |  { ok:false, error }.
//
// Absolute coordinates are WORLD (what the readout shows), so typed-in matches read-out —
// the no-silent-shift contract. Pure: no DOM. `last` is the previous LOCAL point (null at
// a tool's start); `frame` supplies the world↔local origin (offset inlined, the scene.js
// convention, so input.js stays dependency-free and node-testable).

const DEG = Math.PI / 180;

export function parsePoint(text, last, frame) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false, error: 'empty' };
  const rel = s[0] === '@';
  const body = (rel ? s.slice(1) : s).trim();
  const o = frame.origin;

  const lt = body.indexOf('<');
  if (lt >= 0) {                                       // polar — d<a
    const d = Number(body.slice(0, lt).trim());
    const a = Number(body.slice(lt + 1).trim());
    if (!Number.isFinite(d) || !Number.isFinite(a)) return { ok: false, error: 'bad polar (use d<a)' };
    const dx = d * Math.cos(a * DEG), dy = d * Math.sin(a * DEG);
    if (rel) {
      if (!last) return { ok: false, error: 'no previous point for @' };
      return { ok: true, local: [last[0] + dx, last[1] + dy] };
    }
    return { ok: true, local: [dx - o[0], dy - o[1]] };  // absolute polar = world point → local
  }

  const parts = body.split(/[,\s]+/).filter(Boolean);  // cartesian — x,y
  if (parts.length < 2) return { ok: false, error: 'need x,y' };
  const x = Number(parts[0]), y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'bad number' };
  if (rel) {
    if (!last) return { ok: false, error: 'no previous point for @' };
    return { ok: true, local: [last[0] + x, last[1] + y] };
  }
  return { ok: true, local: [x - o[0], y - o[1]] };      // absolute world → local
}
