// Drawing interactions returning promises

export async function drawOnMap(map, type, opts = {}) {

  const olType = {
    point: 'Point',
    polyline: 'LineString',
    polygon: 'Polygon',
    rectangle: 'Circle' // uses createBox geometry function
  }[type];

  if (!olType) throw new Error(`Unknown draw type: ${type}. Use point, polyline, polygon, or rectangle.`);

  const drawOpts = { type: olType };

  // Rectangle uses createBox geometry function
  if (type === 'rectangle') {
    drawOpts.geometryFunction = ol.interaction.Draw.createBox();
  }

  if (opts.maxPoints && type !== 'point' && type !== 'rectangle') {
    drawOpts.maxPoints = opts.maxPoints;
  }

  const source = new ol.source.Vector();
  const drawLayer = new ol.layer.Vector({ source });
  map.ol.addLayer(drawLayer);

  const draw = new ol.interaction.Draw({ source, ...drawOpts });
  map.ol.addInteraction(draw);

  return new Promise((resolve) => {
    draw.on('drawend', (e) => {
      map.ol.removeInteraction(draw);

      const geom = e.feature.getGeometry();
      let result;

      if (type === 'point') {
        const coord = ol.proj.toLonLat(geom.getCoordinates());
        result = { coord, geometry: geom };
      } else if (type === 'rectangle') {
        const ext = geom.getExtent();
        const [w, s] = ol.proj.toLonLat([ext[0], ext[1]]);
        const [e, n] = ol.proj.toLonLat([ext[2], ext[3]]);
        result = { extent: [w, s, e, n], geometry: geom };
      } else {
        const coords = geom.getCoordinates();
        // Convert to lon/lat
        const llCoords = type === 'polygon'
          ? coords[0].map(c => ol.proj.toLonLat(c))
          : coords.map(c => ol.proj.toLonLat(c));
        result = { coords: llCoords, geometry: geom };
      }

      // Remove draw layer after a short delay to show the drawn feature
      setTimeout(() => map.ol.removeLayer(drawLayer), 100);

      resolve(result);
    });
  });
}
