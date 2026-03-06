// OpenLayers + proj4 tree-shaken bundle for spinifex
// Builds the `ol` namespace object matching the OL global API

import OlMap from 'ol/Map.js';
import OlView from 'ol/View.js';
import OlFeature from 'ol/Feature.js';

import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import ImageLayer from 'ol/layer/Image.js';

import XYZSource from 'ol/source/XYZ.js';
import VectorSource from 'ol/source/Vector.js';
import ImageStaticSource from 'ol/source/ImageStatic.js';

import GeoJSONFormat from 'ol/format/GeoJSON.js';

import OlStyle from 'ol/style/Style.js';
import OlCircle from 'ol/style/Circle.js';
import OlFill from 'ol/style/Fill.js';
import OlStroke from 'ol/style/Stroke.js';

import OlPoint from 'ol/geom/Point.js';

import OlDraw, { createBox } from 'ol/interaction/Draw.js';

import ScaleLine from 'ol/control/ScaleLine.js';

import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import { register as registerProj4 } from 'ol/proj/proj4.js';

import proj4 from 'proj4';

// Register proj4 with OL
registerProj4(proj4);

// Attach createBox as static method (matches OL global API)
OlDraw.createBox = createBox;

// Reconstruct the ol.* namespace used by spinifex code
const ol = {
  Map: OlMap,
  View: OlView,
  Feature: OlFeature,
  layer: {
    Tile: TileLayer,
    Vector: VectorLayer,
    Image: ImageLayer,
  },
  source: {
    XYZ: XYZSource,
    Vector: VectorSource,
    ImageStatic: ImageStaticSource,
  },
  format: {
    GeoJSON: GeoJSONFormat,
  },
  style: {
    Style: OlStyle,
    Circle: OlCircle,
    Fill: OlFill,
    Stroke: OlStroke,
  },
  geom: {
    Point: OlPoint,
  },
  interaction: {
    Draw: OlDraw,
  },
  control: {
    ScaleLine,
  },
  proj: {
    fromLonLat,
    toLonLat,
    transformExtent,
    proj4: { register: registerProj4 },
  },
};

export { ol, proj4 };
