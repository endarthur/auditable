// Default styles, terrain color ramp, hillshade

export function defaultPointStyle() {
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: 6,
      fill: new ol.style.Fill({ color: 'rgba(200, 155, 60, 0.8)' }),
      stroke: new ol.style.Stroke({ color: '#c89b3c', width: 1.5 })
    })
  });
}

export function defaultLineStyle() {
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#c89b3c', width: 2 })
  });
}

export function defaultPolygonStyle() {
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#c89b3c', width: 2 }),
    fill: new ol.style.Fill({ color: 'rgba(200, 155, 60, 0.15)' })
  });
}

export function defaultStyle() {
  const pt = defaultPointStyle();
  const ln = defaultLineStyle();
  const pg = defaultPolygonStyle();
  return function(feature) {
    const geom = feature.getGeometry();
    if (!geom) return pg;
    const type = geom.getType();
    if (type === 'Point' || type === 'MultiPoint') return pt;
    if (type === 'LineString' || type === 'MultiLineString') return ln;
    return pg;
  };
}

// Terrain color ramp — returns [r, g, b] for normalized t in [0, 1]
const TERRAIN_STOPS = [
  [0,    34, 139, 34],     // forest green
  [0.15, 85, 153, 68],
  [0.3,  170, 160, 80],
  [0.5,  185, 152, 100],   // brown
  [0.7,  190, 170, 140],
  [0.85, 220, 220, 220],   // light gray
  [1.0,  255, 255, 255],   // white
];

export function terrainColor(t) {
  if (t <= 0) return [TERRAIN_STOPS[0][1], TERRAIN_STOPS[0][2], TERRAIN_STOPS[0][3]];
  if (t >= 1) { const s = TERRAIN_STOPS[TERRAIN_STOPS.length - 1]; return [s[1], s[2], s[3]]; }
  for (let i = 1; i < TERRAIN_STOPS.length; i++) {
    if (t <= TERRAIN_STOPS[i][0]) {
      const f = (t - TERRAIN_STOPS[i - 1][0]) / (TERRAIN_STOPS[i][0] - TERRAIN_STOPS[i - 1][0]);
      const a = TERRAIN_STOPS[i - 1], b = TERRAIN_STOPS[i];
      return [
        Math.round(a[1] + f * (b[1] - a[1])),
        Math.round(a[2] + f * (b[2] - a[2])),
        Math.round(a[3] + f * (b[3] - a[3]))
      ];
    }
  }
  return [255, 255, 255];
}

// Render DEM data to a canvas with terrain colors + simple hillshade
// Canvas is capped at MAX_RENDER pixels per side to avoid freezing the main thread.
const MAX_RENDER = 2048;

export function renderDEMCanvas(dem) {
  const { data, width, height, min, max, nodata } = dem;

  // Downsample if the DEM is larger than MAX_RENDER
  const scale = Math.min(1, MAX_RENDER / Math.max(width, height));
  const cw = Math.round(width * scale);
  const ch = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  const px = img.data;
  const range = max - min || 1;

  for (let r = 0; r < ch; r++) {
    // Map canvas row to DEM row
    const sr = Math.min(((r + 0.5) / ch * height) | 0, height - 1);
    for (let c = 0; c < cw; c++) {
      const sc = Math.min(((c + 0.5) / cw * width) | 0, width - 1);
      const si = sr * width + sc;
      const v = data[si];
      const idx = (r * cw + c) * 4;
      if (v === nodata) {
        px[idx + 3] = 0;
      } else {
        // Simple hillshade from neighbors in source grid
        let shade = 1;
        if (sc > 0 && sc < width - 1 && sr > 0 && sr < height - 1) {
          const dzdx = data[sr * width + sc + 1] - data[sr * width + sc - 1];
          const dzdy = data[(sr + 1) * width + sc] - data[(sr - 1) * width + sc];
          shade = 0.5 + 0.5 * (dzdy - dzdx) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 4);
        }
        const t = (v - min) / range;
        const [cr2, cg, cb] = terrainColor(t);
        px[idx]     = Math.min(255, Math.max(0, cr2 * shade));
        px[idx + 1] = Math.min(255, Math.max(0, cg * shade));
        px[idx + 2] = Math.min(255, Math.max(0, cb * shade));
        px[idx + 3] = 190;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}
