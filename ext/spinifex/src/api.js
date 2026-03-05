// Public API object

import { createMap } from './map.js';
import { loadCSV, loadGeoJSON, loadShapefile, loadGeoTIFF, autoLoad } from './loaders.js';
import { fetchSRTM, cacheList, cacheDelete, cacheClear, cacheSize } from './srtm.js';
import { drawOnMap } from './draw.js';
import { registerProj } from './proj.js';
import { loadGDAL, loadViaGDAL, gdalContour, gdalSlope, gdalAspect, gdalHillshade } from './gdal.js';

export const spx = {
  map: createMap,
  csv: loadCSV,
  shp: loadShapefile,
  tif: loadGeoTIFF,
  geojson: loadGeoJSON,
  srtm: fetchSRTM,
  draw: drawOnMap,
  proj: registerProj,
  load: autoLoad,
  gdal: loadGDAL,
  contour: gdalContour,
  slope: gdalSlope,
  aspect: gdalAspect,
  hillshade: gdalHillshade,
  cache: { list: cacheList, delete: cacheDelete, clear: cacheClear, size: cacheSize }
};
