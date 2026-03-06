// Map creation, basemap management, controls

import { haversine } from './dem.js';

const BASEMAPS = {
  topo: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};

// Coordinate display overlay — dark monospace badge, bottom-left
function createCoordDisplay(mapEl) {
  const div = document.createElement('div');
  div.style.cssText = `
    position:absolute; bottom:8px; left:8px; z-index:10;
    background:rgba(0,0,0,0.7); color:#c89b3c; padding:2px 6px;
    font:11px monospace; border-radius:3px; pointer-events:none;
  `;
  mapEl.style.position = 'relative';
  mapEl.appendChild(div);
  return div;
}

export function createMap(target, opts = {}) {
  const center = opts.center || [0, 0]; // [lon, lat]
  const zoom = opts.zoom || 2;
  const basemap = opts.basemap || 'topo';

  // Resolve target element
  let el;
  if (!target) {
    el = document.createElement('div');
    el.style.width = '100%';
    el.style.height = '600px';
    // Append to current cell output if available
    if (opts._output) {
      opts._output.appendChild(el);
    } else {
      document.body.appendChild(el);
    }
  } else if (typeof target === 'string') {
    el = document.querySelector(target);
    if (!el) throw new Error(`Map target not found: ${target}`);
  } else {
    el = target;
  }

  // Basemap tile layer
  const tileUrl = BASEMAPS[basemap] || basemap;
  const baseLayer = new ol.layer.Tile({
    source: new ol.source.XYZ({ url: tileUrl, crossOrigin: 'anonymous' })
  });

  const view = new ol.View({
    center: ol.proj.fromLonLat(center),
    zoom: zoom
  });

  const controls = [];

  // Scale bar
  if (opts.scalebar !== false) {
    controls.push(new ol.control.ScaleLine({
      units: opts.scaleUnits || 'metric'
    }));
  }

  const map = new ol.Map({
    target: el,
    layers: [baseLayer],
    view: view,
    controls: ol.Map.prototype.getControls ? undefined : controls
  });

  // Add controls after construction (OL default controls may vary)
  for (const c of controls) map.addControl(c);

  // Coordinate display
  let coordDiv = null;
  if (opts.coordinates !== false) {
    coordDiv = createCoordDisplay(el);
    map.on('pointermove', (e) => {
      const [lon, lat] = ol.proj.toLonLat(e.coordinate);
      coordDiv.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    });
    map.getViewport().addEventListener('mouseout', () => {
      coordDiv.textContent = '';
    });
  }

  // Map wrapper object
  const wrapper = {
    ol: map,
    el: el,
    _layers: [],

    get bounds() {
      const ext = view.calculateExtent(map.getSize());
      const [w, s] = ol.proj.toLonLat([ext[0], ext[1]]);
      const [e, n] = ol.proj.toLonLat([ext[2], ext[3]]);
      return [w, s, e, n];
    },

    get center() {
      return ol.proj.toLonLat(view.getCenter());
    },

    set center(lonLat) {
      view.setCenter(ol.proj.fromLonLat(lonLat));
    },

    get zoom() {
      return view.getZoom();
    },

    set zoom(z) {
      view.setZoom(z);
    },

    fitBounds(bbox, padding = 50) {
      const ext = ol.proj.transformExtent(
        [bbox[0], bbox[1], bbox[2], bbox[3]],
        'EPSG:4326', view.getProjection()
      );
      view.fit(ext, { padding: [padding, padding, padding, padding], maxZoom: 18 });
    },

    setBasemap(name) {
      const url = BASEMAPS[name] || name;
      baseLayer.getSource().setUrl(url);
    },

    exportImage(type = 'image/png') {
      return new Promise((resolve) => {
        map.once('rendercomplete', () => {
          const canvas = document.createElement('canvas');
          const size = map.getSize();
          canvas.width = size[0];
          canvas.height = size[1];
          const ctx = canvas.getContext('2d');
          for (const c of map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer')) {
            if (c.width > 0) {
              ctx.globalAlpha = c.parentNode?.style?.opacity || c.style.opacity || 1;
              const transform = c.style.transform;
              const match = transform?.match(/matrix\(([^)]+)\)/);
              if (match) {
                const vals = match[1].split(',').map(Number);
                ctx.setTransform(vals[0], vals[1], vals[2], vals[3], vals[4], vals[5]);
              }
              ctx.drawImage(c, 0, 0);
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.globalAlpha = 1;
            }
          }
          resolve(canvas.toDataURL(type));
        });
        map.renderSync();
      });
    },

    async measure(type = 'distance') {
      const olType = type === 'area' ? 'Polygon' : 'LineString';
      const source = new ol.source.Vector();
      const layer = new ol.layer.Vector({
        source,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({ color: '#c89b3c', width: 2, lineDash: [6, 4] }),
          fill: new ol.style.Fill({ color: 'rgba(200, 155, 60, 0.1)' })
        })
      });
      map.addLayer(layer);
      const draw = new ol.interaction.Draw({ source, type: olType });
      map.addInteraction(draw);

      return new Promise((resolve) => {
        draw.on('drawend', (e) => {
          map.removeInteraction(draw);
          const geom = e.feature.getGeometry();

          if (type === 'area') {
            const coords = geom.getCoordinates()[0].map(c => ol.proj.toLonLat(c));
            // Shoelace on sphere via triangles from centroid (approximate for small polygons)
            const area = sphericalArea(coords);
            resolve({ area, unit: 'm\u00b2', coords, geometry: geom, layer });
          } else {
            const coords = geom.getCoordinates().map(c => ol.proj.toLonLat(c));
            let dist = 0;
            for (let i = 1; i < coords.length; i++) {
              dist += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
            }
            resolve({ distance: dist, unit: 'm', coords, geometry: geom, layer });
          }
        });
      });
    }
  };

  // Force map to recalculate size after DOM settles
  setTimeout(() => map.updateSize(), 100);

  return wrapper;
}

// Spherical polygon area via spherical excess (Girard's theorem)
function sphericalArea(coords) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const n = coords.length - 1; // last == first for closed ring
  if (n < 3) return 0;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % n];
    total += (lon2 - lon1) * rad * (2 + Math.sin(lat1 * rad) + Math.sin(lat2 * rad));
  }
  return Math.abs(total * R * R / 2);
}
