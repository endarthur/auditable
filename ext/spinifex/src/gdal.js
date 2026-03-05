// GDAL Wasm lazy loader, universal format fallthrough, DEM wrappers

import { loadGeoJSON, loadGeoTIFF } from './loaders.js';
import { SpxLayer, registerLayer } from './layers.js';

const GDAL_JS_URL = 'https://cdn.jsdelivr.net/npm/gdal3.js@2/dist/package/gdal3.js';
const GDAL_DATA_URL = 'https://cdn.jsdelivr.net/npm/gdal3.js@2/dist/package/gdal3WebAssembly.data';
const GDAL_WASM_URL = 'https://cdn.jsdelivr.net/npm/gdal3.js@2/dist/package/gdal3WebAssembly.wasm';

let _gdalInstance = null;
let _gdalLoading = null;

export async function loadGDAL() {
  if (_gdalInstance) return _gdalInstance;
  if (_gdalLoading) return _gdalLoading;

  _gdalLoading = (async () => {
    // Inject gdal3.js script
    await new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${GDAL_JS_URL}"]`)) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = GDAL_JS_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load gdal3.js'));
      document.head.appendChild(s);
    });

    // Initialize GDAL
    if (typeof initGdalJs !== 'function') {
      throw new Error('gdal3.js loaded but initGdalJs not found');
    }
    _gdalInstance = await initGdalJs({
      paths: {
        wasm: GDAL_WASM_URL,
        data: GDAL_DATA_URL
      }
    });
    return _gdalInstance;
  })();

  return _gdalLoading;
}

// Universal format fallthrough via GDAL
export async function loadViaGDAL(map, file) {
  const gdal = await loadGDAL();

  let fileObj;
  if (file instanceof File) {
    fileObj = file;
  } else if (typeof file === 'string') {
    const resp = await fetch(file);
    const blob = await resp.blob();
    const name = file.split('/').pop().split('?')[0] || 'data';
    fileObj = new File([blob], name);
  } else if (file instanceof ArrayBuffer || file instanceof Blob) {
    fileObj = new File([file], 'data');
  } else {
    throw new Error('GDAL input must be a File, URL, ArrayBuffer, or Blob');
  }

  const result = await gdal.open(fileObj);
  const ds = result.datasets[0];
  if (!ds) throw new Error('GDAL could not open the file');

  const info = await gdal.getInfo(ds);

  // Detect vector vs raster from info
  if (info.layers && info.layers.length > 0) {
    // Vector: convert to GeoJSON
    const output = await gdal.ogr2ogr(ds, ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326']);
    const bytes = await gdal.getFileBytes(output);
    const text = new TextDecoder().decode(bytes);
    const geojson = JSON.parse(text);
    await gdal.close(ds);
    return loadGeoJSON(map, geojson, { name: fileObj.name });
  } else {
    // Raster: convert to GeoTIFF
    const output = await gdal.gdal_translate(ds, ['-of', 'GTiff']);
    const bytes = await gdal.getFileBytes(output);
    await gdal.close(ds);
    return loadGeoTIFF(map, bytes.buffer, { name: fileObj.name });
  }
}

// Build a minimal GeoTIFF from DEM Float32Array for GDAL input
function demToGeoTIFF(dem) {
  // Create a simple binary GeoTIFF with minimal headers
  // This is used as input for GDAL DEM processing tools
  const { data, width, height, bbox } = dem;
  const [west, south, east, north] = bbox;

  // We'll create a simple TIFF file
  // For simplicity, use raw Float32 data with geo metadata
  // GDAL can read ENVI .hdr + .dat pairs more easily
  const pixelSizeX = (east - west) / width;
  const pixelSizeY = (north - south) / height;

  // Build TIFF with IFD
  const dataBytes = data.length * 4;
  const headerSize = 512; // generous header allocation

  const buf = new ArrayBuffer(headerSize + dataBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // TIFF header (little-endian)
  view.setUint16(0, 0x4949, true);  // II = little endian
  view.setUint16(2, 42, true);       // TIFF magic
  view.setUint32(4, 8, true);        // offset to first IFD

  // IFD at offset 8
  let ifdOffset = 8;
  const tags = [
    [256, 3, 1, width],              // ImageWidth
    [257, 3, 1, height],             // ImageLength
    [258, 3, 1, 32],                 // BitsPerSample
    [259, 3, 1, 1],                  // Compression = none
    [262, 3, 1, 1],                  // PhotometricInterpretation = MinIsBlack
    [273, 4, 1, headerSize],         // StripOffsets
    [277, 3, 1, 1],                  // SamplesPerPixel
    [278, 3, 1, height],             // RowsPerStrip
    [279, 4, 1, dataBytes],          // StripByteCounts
    [339, 3, 1, 3],                  // SampleFormat = floating point
  ];

  view.setUint16(ifdOffset, tags.length, true);
  ifdOffset += 2;

  for (const [tag, type, count, value] of tags) {
    view.setUint16(ifdOffset, tag, true);
    view.setUint16(ifdOffset + 2, type, true);
    view.setUint32(ifdOffset + 4, count, true);
    if (type === 3) view.setUint16(ifdOffset + 8, value, true);
    else view.setUint32(ifdOffset + 8, value, true);
    ifdOffset += 12;
  }

  // Next IFD offset = 0 (no more IFDs)
  view.setUint32(ifdOffset, 0, true);

  // Copy float data
  const floatView = new Float32Array(buf, headerSize, data.length);
  floatView.set(data);

  return new File([buf], 'dem.tif', { type: 'image/tiff' });
}

// High-level DEM wrappers using GDAL

export async function gdalContour(dem, opts = {}) {
  const gdal = await loadGDAL();
  const interval = opts.interval || 100;
  const tifFile = demToGeoTIFF(dem.data ? dem : dem);

  const result = await gdal.open(tifFile);
  const ds = result.datasets[0];

  const args = ['-i', String(interval), '-f', 'GeoJSON'];
  if (opts.attribute) args.push('-a', opts.attribute);
  else args.push('-a', 'elev');

  const output = await gdal.gdal_contour(ds, args);
  const bytes = await gdal.getFileBytes(output);
  const text = new TextDecoder().decode(bytes);
  const geojson = JSON.parse(text);
  await gdal.close(ds);

  return geojson;
}

export async function gdalSlope(dem) {
  const gdal = await loadGDAL();
  const tifFile = demToGeoTIFF(dem.data ? dem : dem);

  const result = await gdal.open(tifFile);
  const ds = result.datasets[0];

  const output = await gdal.gdaldem(ds, 'slope', []);
  const bytes = await gdal.getFileBytes(output);
  await gdal.close(ds);

  return bytes.buffer;
}

export async function gdalAspect(dem) {
  const gdal = await loadGDAL();
  const tifFile = demToGeoTIFF(dem.data ? dem : dem);

  const result = await gdal.open(tifFile);
  const ds = result.datasets[0];

  const output = await gdal.gdaldem(ds, 'aspect', []);
  const bytes = await gdal.getFileBytes(output);
  await gdal.close(ds);

  return bytes.buffer;
}

export async function gdalHillshade(dem, opts = {}) {
  const gdal = await loadGDAL();
  const azimuth = opts.azimuth || 315;
  const tifFile = demToGeoTIFF(dem.data ? dem : dem);

  const result = await gdal.open(tifFile);
  const ds = result.datasets[0];

  const output = await gdal.gdaldem(ds, 'hillshade', ['-az', String(azimuth)]);
  const bytes = await gdal.getFileBytes(output);
  await gdal.close(ds);

  return bytes.buffer;
}
