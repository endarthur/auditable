// moncad feature-export — the drawing→table data bridge (first slice). Converts
// WORLD-canonical @gcu/dxf features into a GeoJSON-shaped geometry, then a feature TABLE
// (a `wkt` geometry column + attribute columns) — the PostGIS/GeoPandas-friendly form the
// attributed-blocks model points at. Pure: no DOM. @gcu/wkt does the geometry serialization.
//
// Mappings: point/insert → POINT (a block instance is its insertion point + its attributes —
// the GIS point-symbology model); polyline → LineString (open) / Polygon (closed); circle →
// Polygon (a tessellated ring). Arcs/circles tessellate to a chord tolerance (the default
// curve option; densify / CIRCULARSTRING are follow options). text/attdef/face are skipped
// (annotation, not 2D feature data). SRID rides from the frame's CRS as EWKT.
//
// Pure / zero-import (the moncad convention): the @gcu/wkt `stringify` is dependency-injected
// (opts.stringify) so this stays node-testable; the host (app.js) passes the real one.

// sample an arc span (world endpoints + bulge) into points after p0
function arcSamples(p0, p1, bulge, eps) {
  if (!bulge) return [p1];
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], c = Math.hypot(dx, dy); if (!c) return [p1];
  const theta = 4 * Math.atan(bulge), r = c / 2 / Math.abs(Math.sin(theta / 2));
  const m = c / 2 / Math.tan(theta / 2), nx = -dy / c, ny = dx / c;
  const cx = p0[0] + dx / 2 + nx * m, cy = p0[1] + dy / 2 + ny * m, sa = Math.atan2(p0[1] - cy, p0[0] - cx);
  const step = r > eps ? 2 * Math.acos(Math.max(-1, 1 - eps / r)) : Math.PI / 8;
  const n = Math.max(1, Math.ceil(Math.abs(theta) / step));
  const out = []; for (let i = 1; i <= n; i++) { const t = sa + theta * (i / n); out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}
function tessPolyline(g, eps) {
  const v = g.vertices, n = v.length / 3; if (n < 1) return [];
  const pts = []; for (let k = 0; k < n; k++) pts.push([v[k * 3], v[k * 3 + 1]]);
  const coords = [pts[0]], spans = g.closed ? n : n - 1;   // closed → the last span wraps, closing the ring
  for (let i = 0; i < spans; i++) { const bul = g.bulges ? (g.bulges[i] || 0) : 0; for (const q of arcSamples(pts[i], pts[(i + 1) % n], bul, eps)) coords.push(q); }
  return coords;
}
function tessCircle(g, eps) {
  const cx = g.center[0], cy = g.center[1], r = g.radius;
  const step = r > eps ? 2 * Math.acos(Math.max(-1, 1 - eps / r)) : Math.PI / 8;
  const nseg = Math.max(12, Math.ceil(2 * Math.PI / step)), out = [];
  for (let i = 0; i <= nseg; i++) { const t = 2 * Math.PI * i / nseg; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;   // closed ring (first === last)
}

// One feature → a GeoJSON-shaped geometry (WORLD coords), or null if not exportable.
export function featureToGeometry(feature, opts = {}) {
  const g = feature.geometry; if (!g) return null;
  const eps = opts.eps || 0.05;
  if (g.kind === 'point') return { type: 'Point', coordinates: [g.position[0], g.position[1]] };
  if (g.kind === 'insert') return { type: 'Point', coordinates: [g.transform.position[0], g.transform.position[1]] };
  if (g.kind === 'circle') return { type: 'Polygon', coordinates: [tessCircle(g, eps)] };
  if (g.kind === 'polyline') {
    const coords = tessPolyline(g, eps); if (coords.length < 2) return null;
    return g.closed ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords };
  }
  return null;
}

// Features → a feature table: { columns:['wkt','kind',…tags], rows:[{wkt,kind,props}], tags }.
// A block instance contributes its attribute values as columns; `kind` is the block name
// (insert) or the feature type. opts.stringify = @gcu/wkt's stringify (injected); opts.srid
// (number) → EWKT.
export function featuresToTable(features, opts = {}) {
  const stringify = opts.stringify; if (!stringify) throw new Error('featuresToTable: opts.stringify (@gcu/wkt) required');
  const rows = [], tagSet = new Set();
  for (const f of features) {
    const geom = featureToGeometry(f, opts); if (!geom) continue;
    const props = {};
    for (const a of (f.properties && f.properties.attribs) || []) { props[a.tag] = a.value; tagSet.add(a.tag); }
    const kind = f.geometry.kind === 'insert' ? f.geometry.block : f.type;
    rows.push({ wkt: stringify(geom, opts.srid != null ? { srid: opts.srid } : {}), kind, props });
  }
  const tags = [...tagSet].sort();
  return { columns: ['wkt', 'kind', ...tags], rows, tags };
}

export function tableToCsv(table) {
  const esc = (s) => { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const out = [table.columns.map(esc).join(',')];
  for (const r of table.rows) out.push([esc(r.wkt), esc(r.kind), ...table.tags.map((t) => esc(r.props[t]))].join(','));
  return out.join('\n');
}

// EPSG SRID number from a frame CRS descriptor ('EPSG:31983' / {code} / …), or undefined.
export function sridFromCrs(crs) {
  if (!crs) return undefined;
  const s = typeof crs === 'string' ? crs : String(crs.id || crs.code || crs.srid || crs.name || '');
  const m = /EPSG[:/ ]?(\d{3,6})/i.exec(s) || /^(\d{3,6})$/.exec(s.trim());
  return m ? Number(m[1]) : undefined;
}
