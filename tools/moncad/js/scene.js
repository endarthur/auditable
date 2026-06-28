// moncad scene — bridges a parsed @gcu/dxf Document to the WebGL2 renderer. Pure: no
// DOM/WebGL.
//
// Adopts the document's recommended Frame as the working frame, converts WORLD geometry
// to small LOCAL coordinates (subtract the frame origin), tessellates arcs/circles to
// chords at a local tolerance, and packs the renderer's instance buffers. The canonical
// bulge arcs stay in the Document — this tessellation is a disposable view (SPEC §6 /
// the throughline rule). Explode the doc first if you want INSERTs rendered.
//
// Dependency-free on purpose: it transforms the Document's plain-object SHAPE, so it
// stays node-testable. The bulge math here mirrors @gcu/dxf's arcFromBulge (the render
// need is sample points, not the center/radius accessor).

const DEFAULT_GEO = [0.82, 0.82, 0.84, 1];   // bylayer/byblock → light (no layer-colour table yet)
const POINT_COL = [0.42, 0.63, 0.81, 1];
const SELECTED = [0.66, 0.45, 0.85, 1];      // violet = selected (SPEC §5 role mapping)
const ACI = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255] };

// Resolve an entity's RGBA. Explicit ACI/RGB wins; bylayer/byblock/absent falls to the
// entity's LAYER colour (the bylayer contract). Alpha carries the layer's opacity — the
// one GIS affordance borrowed into the data path (a dimmed reference layer).
function colorFor(props, layers) {
  const c = props && props.color;
  const L = layers && props && layers[props.layer];
  const op = L && L.opacity != null ? L.opacity : 1;
  const aci = (i) => (ACI[i] ? [ACI[i][0] / 255, ACI[i][1] / 255, ACI[i][2] / 255] : null);
  let rgb = null;
  if (c && c.mode === 'rgb') rgb = [c.r / 255, c.g / 255, c.b / 255];
  else if (c && c.mode === 'aci') rgb = aci(c.index);
  if (!rgb && L && L.color) { const lc = L.color; rgb = lc.mode === 'rgb' ? [lc.r / 255, lc.g / 255, lc.b / 255] : lc.mode === 'aci' ? aci(lc.index) : null; }
  if (!rgb) rgb = DEFAULT_GEO.slice(0, 3);
  return [rgb[0], rgb[1], rgb[2], op];
}

// Sample an arc span (local endpoints + bulge) into chord points after p0 (inclusive of
// the end). ε is the max chord-height error in local units.
function arcPoints(p0, p1, bulge, eps) {
  if (!bulge) return [p1];
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], c = Math.hypot(dx, dy);
  if (c === 0) return [p1];
  const theta = 4 * Math.atan(bulge), half = c / 2;
  const r = half / Math.abs(Math.sin(theta / 2));
  const m = half / Math.tan(theta / 2), nx = -dy / c, ny = dx / c;
  const cx = p0[0] + dx / 2 + nx * m, cy = p0[1] + dy / 2 + ny * m;
  const startAngle = Math.atan2(p0[1] - cy, p0[0] - cx);
  const step = r > eps ? 2 * Math.acos(Math.max(-1, 1 - eps / r)) : Math.PI / 4;
  const n = Math.max(1, Math.ceil(Math.abs(theta) / step));
  const out = [];
  for (let i = 1; i <= n; i++) { const t = startAngle + theta * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}

// Tessellate one WORLD geometry into LOCAL line segments [[a,b],…] (arcs/circles to
// chords at error ≤ eps). Shared by the renderer build and the edit-ghost preview, so a
// dragged selection is faceted identically to the committed result. Pure.
export function localSegments(geometry, origin, eps = 0.2) {
  const g = geometry, o = origin, toL = (p) => [p[0] - o[0], p[1] - o[1]], out = [];
  if (!g) return out;
  if (g.kind === 'polyline') {
    const v = g.vertices, n = v.length / 3; if (n < 2) return out;
    const lv = []; for (let k = 0; k < n; k++) lv.push(toL([v[k * 3], v[k * 3 + 1]]));
    const spans = g.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const a = lv[i], b = lv[(i + 1) % n], bul = g.bulges ? g.bulges[i] : 0;
      if (bul) { let from = a; for (const q of arcPoints(a, b, bul, eps)) { out.push([from, q]); from = q; } }
      else out.push([a, b]);
    }
  } else if (g.kind === 'circle') {
    const c = toL(g.center), r = g.radius;
    const step = r > eps ? 2 * Math.acos(Math.max(-1, 1 - eps / r)) : Math.PI / 8;
    const nseg = Math.max(8, Math.ceil(2 * Math.PI / step));
    let prev = [c[0] + r, c[1]];
    for (let i = 1; i <= nseg; i++) { const t = 2 * Math.PI * i / nseg; const q = [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; out.push([prev, q]); prev = q; }
  }
  return out;
}

export function sceneFromDxf(doc, opts = {}) {
  const frame = doc.frame, o = frame.origin;
  const eps = opts.eps != null ? opts.eps : 0.2;
  const selected = opts.selected;                        // Set<featureIndex> | undefined
  const layers = doc.layers || {};                       // bylayer colour + visibility + opacity
  const toL = (p) => [p[0] - o[0], p[1] - o[1]];          // world → local
  const L = [], P = [], S = [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const ext = (p) => { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; };
  const seg = (a, b, w, c) => { L.push(a[0], a[1], b[0], b[1], w, c[0], c[1], c[2], c[3]); ext(a); ext(b); };
  const pt = (p, s, c) => { P.push(p[0], p[1], s, c[0], c[1], c[2], c[3]); ext(p); };
  const snap = (p, type) => S.push({ p, type });   // snap target (local coords)

  for (let fi = 0; fi < doc.features.length; fi++) {
    const f = doc.features[fi];
    const g = f.geometry; if (!g) continue;
    const lay = layers[f.properties && f.properties.layer];
    if (lay && !lay.visible) continue;                   // hidden layer → off the board (and out of the snap index)
    const isSel = !!(selected && selected.has(fi));
    const col = isSel ? SELECTED : colorFor(f.properties, layers);
    const w = isSel ? 2 : 1.5;
    if (g.kind === 'polyline') {
      const v = g.vertices, n = v.length / 3;
      if (n < 2) continue;
      const lv = [];
      for (let k = 0; k < n; k++) { const p = toL([v[k * 3], v[k * 3 + 1]]); lv.push(p); snap(p, 'end'); }
      for (const [a, b] of localSegments(g, o, eps)) seg(a, b, w, col);
      const spans = g.closed ? n : n - 1;
      for (let i = 0; i < spans; i++) { const a = lv[i], b = lv[(i + 1) % n]; snap([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'mid'); }   // chord midpoint
    } else if (g.kind === 'circle') {
      for (const [a, b] of localSegments(g, o, eps)) seg(a, b, w, col);
      snap(toL(g.center), 'center');
    } else if (g.kind === 'point') {
      const p = toL(g.position); pt(p, 6, isSel ? SELECTED : POINT_COL); snap(p, 'node');
    }
    // 'face' deferred (3D-ish); 'insert' should be exploded before here.
  }
  const bounds = (minx === Infinity) ? { min: [-1, -1], max: [1, 1] } : { min: [minx, miny], max: [maxx, maxy] };
  return { frame, lines: new Float32Array(L), points: new Float32Array(P), bounds, snaps: S };
}
