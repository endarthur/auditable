// SRTM tile download, HGT parsing, mosaicing

import { DEM } from './dem.js';
import { SpxLayer, registerLayer } from './layers.js';
import { renderDEMCanvas } from './render.js';

const SRTM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
const TILE_SIZE = 3601; // SRTM GL1: 3601x3601 pixels per 1-degree tile
const MAX_TILES = 16;

// IndexedDB cache for gzipped SRTM tiles (~2.5 MB each)
const DB_NAME = 'spx-srtm';
const DB_VERSION = 1;

function openTileDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore('tiles', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tileGet(key) {
  const db = await openTileDB();
  return new Promise((resolve) => {
    const tx = db.transaction('tiles', 'readonly');
    const req = tx.objectStore('tiles').get(key);
    req.onsuccess = () => resolve(req.result?.data ?? null);
    req.onerror = () => resolve(null);
  });
}

async function tilePut(key, data) {
  const db = await openTileDB();
  const tx = db.transaction('tiles', 'readwrite');
  tx.objectStore('tiles').put({ key, data, ts: Date.now() });
}

function tileKey(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const latStr = String(Math.abs(lat)).padStart(2, '0');
  const lonStr = String(Math.abs(lon)).padStart(3, '0');
  return `${ns}${latStr}${ew}${lonStr}`;
}

function tileUrl(lat, lon) {
  const key = tileKey(lat, lon);
  const ns = lat >= 0 ? 'N' : 'S';
  const latStr = String(Math.abs(lat)).padStart(2, '0');
  const folder = `${ns}${latStr}`;
  return `${SRTM_BASE}/${folder}/${key}.hgt.gz`;
}

function tilesForBbox(bbox) {
  const [west, south, east, north] = bbox;
  const tiles = [];
  for (let lat = Math.floor(south); lat < Math.ceil(north); lat++) {
    for (let lon = Math.floor(west); lon < Math.ceil(east); lon++) {
      tiles.push({ lat, lon });
    }
  }
  return tiles;
}

async function fetchAndParseHGT(lat, lon) {
  const key = tileKey(lat, lon);

  // Check IDB cache first
  let gzBuf = await tileGet(key);
  if (!gzBuf) {
    const resp = await fetch(tileUrl(lat, lon));
    if (!resp.ok) return null; // ocean or void tile
    gzBuf = await resp.arrayBuffer();
    tilePut(key, gzBuf); // fire-and-forget
  }

  // Decompress gzip
  const ds = new DecompressionStream('gzip');
  const decompressed = new Blob([gzBuf]).stream().pipeThrough(ds);
  const reader = decompressed.getReader();
  const chunks = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }

  // Concatenate into single buffer
  const buffer = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  // Parse big-endian Int16 → Float32
  const expectedSize = TILE_SIZE * TILE_SIZE;
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const data = new Float32Array(expectedSize);
  for (let i = 0; i < expectedSize; i++) {
    const val = dv.getInt16(i * 2, false); // big-endian
    data[i] = val === -32768 ? -9999 : val; // nodata
  }
  return data;
}

function mosaicTiles(tiles, tileData) {
  if (tiles.length === 1 && tileData[0]) {
    const t = tiles[0];
    return {
      data: tileData[0],
      width: TILE_SIZE,
      height: TILE_SIZE,
      bbox: [t.lon, t.lat, t.lon + 1, t.lat + 1]
    };
  }

  // Calculate mosaic dimensions
  const lats = tiles.map(t => t.lat);
  const lons = tiles.map(t => t.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  const tilesX = maxLon - minLon + 1;
  const tilesY = maxLat - minLat + 1;
  // Tiles share border pixels, so mosaic size accounts for overlap
  const width = tilesX * (TILE_SIZE - 1) + 1;
  const height = tilesY * (TILE_SIZE - 1) + 1;

  const mosaic = new Float32Array(width * height).fill(-9999);

  for (let i = 0; i < tiles.length; i++) {
    const td = tileData[i];
    if (!td) continue;
    const t = tiles[i];

    const tileOffX = (t.lon - minLon) * (TILE_SIZE - 1);
    // SRTM tiles are stored north-to-south (row 0 = north edge)
    const tileOffY = (maxLat - t.lat) * (TILE_SIZE - 1);

    for (let row = 0; row < TILE_SIZE; row++) {
      for (let col = 0; col < TILE_SIZE; col++) {
        const val = td[row * TILE_SIZE + col];
        if (val !== -9999) {
          mosaic[(tileOffY + row) * width + (tileOffX + col)] = val;
        }
      }
    }
  }

  return {
    data: mosaic,
    width,
    height,
    bbox: [minLon, minLat, maxLon + 1, maxLat + 1]
  };
}

export async function cacheList() {
  const db = await openTileDB();
  return new Promise((resolve) => {
    const tx = db.transaction('tiles', 'readonly');
    const req = tx.objectStore('tiles').getAll();
    req.onsuccess = () => resolve(req.result.map(r => ({
      key: r.key, size: r.data.byteLength, ts: r.ts
    })));
    req.onerror = () => resolve([]);
  });
}

export async function cacheDelete(key) {
  const db = await openTileDB();
  const tx = db.transaction('tiles', 'readwrite');
  tx.objectStore('tiles').delete(key);
}

export async function cacheClear() {
  const db = await openTileDB();
  const tx = db.transaction('tiles', 'readwrite');
  tx.objectStore('tiles').clear();
}

export async function cacheSize() {
  const list = await cacheList();
  return { count: list.length, bytes: list.reduce((s, r) => s + r.size, 0) };
}

export async function fetchSRTM(map, boundsOrLayer, opts = {}) {

  // Determine bbox
  let bbox;
  if (!boundsOrLayer) {
    bbox = map.bounds;
  } else if (Array.isArray(boundsOrLayer)) {
    bbox = boundsOrLayer;
  } else if (boundsOrLayer.bounds) {
    bbox = boundsOrLayer.bounds;
  } else {
    bbox = map.bounds;
  }

  const tiles = tilesForBbox(bbox);
  if (tiles.length > MAX_TILES) {
    console.warn(`SRTM: ${tiles.length} tiles needed (max ${MAX_TILES}). Zoom in or narrow extent.`);
    throw new Error(`Too many SRTM tiles (${tiles.length}). Max is ${MAX_TILES}. Zoom in.`);
  }

  // Fetch all tiles
  const tileData = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (opts.onProgress) opts.onProgress(tileKey(t.lat, t.lon), i + 1, tiles.length);
    const data = await fetchAndParseHGT(t.lat, t.lon);
    tileData.push(data);
  }

  const mosaic = mosaicTiles(tiles, tileData);

  // Create DEM
  const dem = new DEM(mosaic.data, mosaic.width, mosaic.height, mosaic.bbox);

  // Render DEM to canvas and display as ImageStatic layer
  const canvas = renderDEMCanvas(dem);
  const extent = ol.proj.transformExtent(
    mosaic.bbox, 'EPSG:4326', map.ol.getView().getProjection()
  );

  const rasterLayer = new ol.layer.Image({
    source: new ol.source.ImageStatic({
      url: canvas.toDataURL(),
      imageExtent: extent
    })
  });

  map.ol.addLayer(rasterLayer);

  const layer = new SpxLayer(rasterLayer, {
    name: opts.name || 'SRTM',
    type: 'srtm',
    map,
    bounds: mosaic.bbox,
    data: dem
  });

  // Attach DEM methods to the layer for convenience
  layer.sample = (lat, lon) => dem.sample(lat, lon);
  layer.profile = (latA, lonA, latB, lonB, profileOpts) => dem.profile(latA, lonA, latB, lonB, profileOpts);
  layer.data = dem;
  layer.width = dem.width;
  layer.height = dem.height;
  layer.min = dem.min;
  layer.max = dem.max;
  layer.bbox = dem.bbox;

  registerLayer(map, layer);
  return layer;
}
