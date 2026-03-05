// Map creation and basemap management

const BASEMAPS = {
  topo: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};

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

  const map = new ol.Map({
    target: el,
    layers: [baseLayer],
    view: view
  });

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
    }
  };

  // Force map to recalculate size after DOM settles
  setTimeout(() => map.updateSize(), 100);

  return wrapper;
}
