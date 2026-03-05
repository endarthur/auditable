// Format loaders: CSV, GeoJSON, Shapefile, GeoTIFF

import { ensurePapa, ensureShp } from './deps.js';
import { SpxLayer, registerLayer } from './layers.js';
import { defaultStyle } from './render.js';

// -- CSV loader --

export const LON_PATTERNS = /^(lon|longitude|lng|x|easting|long|coordx)$/i;
export const LAT_PATTERNS = /^(lat|latitude|y|northing|coordy)$/i;

export function detectColumn(headers, pattern) {
  for (const h of headers) {
    if (pattern.test(h.trim())) return h;
  }
  return null;
}

export async function loadCSV(map, source, opts = {}) {

  await ensurePapa();

  // Parse CSV
  let text;
  if (typeof source === 'string') {
    // URL or raw CSV text
    if (source.startsWith('http')) {
      const resp = await fetch(source);
      text = await resp.text();
    } else {
      text = source;
    }
  } else if (source instanceof File || source instanceof Blob) {
    text = await source.text();
  } else {
    throw new Error('CSV source must be a string, URL, File, or Blob');
  }

  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rows = parsed.data;
  const headers = parsed.meta.fields;

  // Detect coordinate columns
  const lonCol = opts.lon || detectColumn(headers, LON_PATTERNS);
  const latCol = opts.lat || detectColumn(headers, LAT_PATTERNS);

  if (!lonCol || !latCol) {
    // Return data without spatial rendering
    const layer = new SpxLayer(new ol.layer.Vector({ source: new ol.source.Vector() }), {
      name: opts.name || 'CSV', type: 'csv', map, data: rows
    });
    registerLayer(map, layer);
    return layer;
  }

  // Create point features
  const features = [];
  for (const row of rows) {
    const lon = parseFloat(row[lonCol]);
    const lat = parseFloat(row[latCol]);
    if (isNaN(lon) || isNaN(lat)) continue;
    const feature = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
    });
    // Copy row properties to feature
    for (const key of headers) {
      if (key !== lonCol && key !== latCol) feature.set(key, row[key]);
    }
    feature.set('_lon', lon);
    feature.set('_lat', lat);
    features.push(feature);
  }

  const vectorSource = new ol.source.Vector({ features });
  const vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: defaultStyle()
  });

  map.ol.addLayer(vectorLayer);

  const layer = new SpxLayer(vectorLayer, {
    name: opts.name || 'CSV',
    type: 'csv',
    map,
    data: rows
  });
  registerLayer(map, layer);
  return layer;
}

// -- GeoJSON loader --

export async function loadGeoJSON(map, data, opts = {}) {


  const geojson = typeof data === 'string' ? JSON.parse(data) : data;
  const format = new ol.format.GeoJSON();
  const features = format.readFeatures(geojson, {
    featureProjection: map.ol.getView().getProjection(),
    dataProjection: opts.crs || 'EPSG:4326'
  });

  const vectorSource = new ol.source.Vector({ features });
  const vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: defaultStyle()
  });

  map.ol.addLayer(vectorLayer);

  const layer = new SpxLayer(vectorLayer, {
    name: opts.name || 'GeoJSON',
    type: 'geojson',
    map,
    data: geojson
  });
  registerLayer(map, layer);
  return layer;
}

// -- Shapefile loader --

export async function loadShapefile(map, source, opts = {}) {

  await ensureShp();

  let buffer;
  if (source instanceof ArrayBuffer) {
    buffer = source;
  } else if (source instanceof File || source instanceof Blob) {
    buffer = await source.arrayBuffer();
  } else if (typeof source === 'string') {
    const resp = await fetch(source);
    buffer = await resp.arrayBuffer();
  } else {
    throw new Error('Shapefile source must be an ArrayBuffer, File, Blob, or URL');
  }

  const geojson = await shp(buffer);
  // shpjs may return an array for multi-layer shapefiles
  const collection = Array.isArray(geojson) ? geojson[0] : geojson;

  const format = new ol.format.GeoJSON();
  const features = format.readFeatures(collection, {
    featureProjection: map.ol.getView().getProjection(),
    dataProjection: opts.crs || 'EPSG:4326'
  });

  const vectorSource = new ol.source.Vector({ features });
  const vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: defaultStyle()
  });

  map.ol.addLayer(vectorLayer);

  const layer = new SpxLayer(vectorLayer, {
    name: opts.name || 'Shapefile',
    type: 'shp',
    map,
    data: collection
  });
  registerLayer(map, layer);
  return layer;
}

// -- GeoTIFF loader --

export async function loadGeoTIFF(map, source, opts = {}) {


  let rasterLayer;

  if (typeof source === 'string') {
    // URL — use OL's native GeoTIFF source (supports COG streaming)
    const tifSource = new ol.source.GeoTIFF({
      sources: [{ url: source }],
      crossOrigin: 'anonymous'
    });
    rasterLayer = new ol.layer.WebGLTile({ source: tifSource });
  } else {
    // ArrayBuffer or File — parse and display as DataTile
    let buffer;
    if (source instanceof ArrayBuffer) {
      buffer = source;
    } else if (source instanceof File || source instanceof Blob) {
      buffer = await source.arrayBuffer();
    } else {
      throw new Error('GeoTIFF source must be a string URL, ArrayBuffer, File, or Blob');
    }

    // Use OL's GeoTIFF source with blob URL
    const blob = new Blob([buffer], { type: 'image/tiff' });
    const blobUrl = URL.createObjectURL(blob);
    const tifSource = new ol.source.GeoTIFF({
      sources: [{ url: blobUrl }]
    });
    rasterLayer = new ol.layer.WebGLTile({ source: tifSource });
  }

  map.ol.addLayer(rasterLayer);

  const layer = new SpxLayer(rasterLayer, {
    name: opts.name || 'GeoTIFF',
    type: 'tif',
    map
  });
  registerLayer(map, layer);
  return layer;
}

// -- Auto-detect loader --

export async function autoLoad(map, file) {
  let name, ext;
  if (typeof file === 'string') {
    name = file.split('/').pop().split('?')[0];
  } else if (file instanceof File) {
    name = file.name;
  } else {
    throw new Error('autoLoad expects a File, URL string, or use a specific loader');
  }

  ext = (name.split('.').pop() || '').toLowerCase();

  if (ext === 'csv' || ext === 'tsv') return loadCSV(map, file);
  if (ext === 'geojson' || ext === 'json') {
    const text = file instanceof File ? await file.text() : await (await fetch(file)).text();
    return loadGeoJSON(map, text);
  }
  if (ext === 'zip' || ext === 'shp') return loadShapefile(map, file);
  if (ext === 'tif' || ext === 'tiff') return loadGeoTIFF(map, file);

  // Unknown format — try GDAL fallthrough
  if (typeof loadViaGDAL === 'function') {
    return loadViaGDAL(map, file);
  }
  throw new Error(`Unknown format: .${ext}. Try spx.gdal() for GDAL-supported formats.`);
}
