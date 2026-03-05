// DEM data access, bilinear sampling, profile extraction

export class DEM {
  constructor(data, width, height, bbox) {
    this.data = data;       // Float32Array
    this.width = width;
    this.height = height;
    this.bbox = bbox;       // [west, south, east, north]
    this.nodata = -9999;

    // Compute min/max (excluding nodata)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v !== this.nodata) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    this.min = min === Infinity ? 0 : min;
    this.max = max === -Infinity ? 0 : max;
  }

  // Bilinear interpolation at (lat, lon)
  sample(lat, lon) {
    const [west, south, east, north] = this.bbox;
    if (lon < west || lon > east || lat < south || lat > north) return null;

    // Convert to pixel coordinates
    // Row 0 = north edge, row (height-1) = south edge
    const px = (lon - west) / (east - west) * (this.width - 1);
    const py = (north - lat) / (north - south) * (this.height - 1);

    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, this.width - 1);
    const y1 = Math.min(y0 + 1, this.height - 1);

    const fx = px - x0;
    const fy = py - y0;

    const v00 = this.data[y0 * this.width + x0];
    const v10 = this.data[y0 * this.width + x1];
    const v01 = this.data[y1 * this.width + x0];
    const v11 = this.data[y1 * this.width + x1];

    // Skip nodata pixels
    if (v00 === this.nodata || v10 === this.nodata ||
        v01 === this.nodata || v11 === this.nodata) {
      // Fallback: nearest neighbor among valid values
      const candidates = [v00, v10, v01, v11].filter(v => v !== this.nodata);
      return candidates.length > 0 ? candidates[0] : null;
    }

    // Bilinear interpolation
    const top = v00 * (1 - fx) + v10 * fx;
    const bot = v01 * (1 - fx) + v11 * fx;
    return top * (1 - fy) + bot * fy;
  }

  // Extract elevation profile between two points
  profile(latA, lonA, latB, lonB, opts = {}) {
    const samples = opts.samples || 500;

    const dist = new Float64Array(samples);
    const elev = new Float32Array(samples);
    const lat = new Float64Array(samples);
    const lon = new Float64Array(samples);

    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      lat[i] = latA + t * (latB - latA);
      lon[i] = lonA + t * (lonB - lonA);
      elev[i] = this.sample(lat[i], lon[i]) ?? this.nodata;
      dist[i] = i === 0 ? 0 : dist[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    }

    return { dist, elev, lat, lon };
  }
}

// Haversine distance in meters
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
