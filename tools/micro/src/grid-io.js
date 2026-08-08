// micro — grid serialization: Surfer 6 (DSBB/DSAA) and ESRI ASCII read/write.
// Pure — takes/returns plain grid objects and blobs, no app state. The format
// dispatch (readAnyGrid) and the sniff (ascLooksLikeGrid) stay in the app: they
// reach the GeoTIFF reader and the display path. Grid convention throughout:
// { nx, ny, data, x0, y0, dx, dy, nodata, crs, form } — row 0 is the NORTH row,
// x0/y0 are SAMPLE CENTRES, dy positive (row r's centre = y0 − r·dy).

export const SURFER_BLANK = 1.70141e38;

// Surfer 6 binary (DSBB) writer — the compact, self-contained grid format we
// already read; 4 B/value + a 56 B header. Used for the display-cache sidecar.
export function writeSurferGrd(g) {
  const { nx, ny, x0, y0, dx, dy, data, nodata } = g;
  const isBad = (v) => Number.isNaN(v) || (nodata != null && (nodata >= 1.7e38 ? v >= 1.7014e38 : v === nodata));
  let zmin = Infinity, zmax = -Infinity;
  for (const v of data) { if (isBad(v)) continue; if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  if (!(zmin <= zmax)) { zmin = 0; zmax = 0; }
  const buf = new ArrayBuffer(56 + nx * ny * 4);
  const v = new DataView(buf);
  v.setUint8(0, 0x44); v.setUint8(1, 0x53); v.setUint8(2, 0x42); v.setUint8(3, 0x42);   // 'DSBB'
  v.setInt16(4, nx, true); v.setInt16(6, ny, true);
  v.setFloat64(8, x0, true); v.setFloat64(16, x0 + (nx - 1) * dx, true);                // xlo, xhi
  v.setFloat64(24, y0 - (ny - 1) * dy, true); v.setFloat64(32, y0, true);               // ylo, yhi
  v.setFloat64(40, zmin, true); v.setFloat64(48, zmax, true);
  let o = 56;                                                                            // Surfer is SOUTH-first
  for (let r = ny - 1; r >= 0; r--) for (let c = 0; c < nx; c++) { const val = data[r * nx + c]; v.setFloat32(o, isBad(val) ? SURFER_BLANK : val, true); o += 4; }
  return buf;
}

export async function readSurferGrd(blob) {
  const tag = new TextDecoder('latin1').decode(await blob.slice(0, 4).arrayBuffer());
  if (tag === 'DSRB') throw new Error('Surfer 7 .grd not supported yet — save as Surfer 6 grid');
  if (tag === 'DSBB') {
    const v = new DataView(await blob.arrayBuffer());
    const nx = v.getInt16(4, true), ny = v.getInt16(6, true);
    const xlo = v.getFloat64(8, true), xhi = v.getFloat64(16, true);
    const ylo = v.getFloat64(24, true), yhi = v.getFloat64(32, true);
    const data = new Float32Array(nx * ny);
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      // Surfer stores south-first — flip to north-first
      data[(ny - 1 - r) * nx + c] = v.getFloat32(56 + (r * nx + c) * 4, true);
    }
    return { nx, ny, data, x0: xlo, y0: yhi, dx: nx > 1 ? (xhi - xlo) / (nx - 1) : 1, dy: ny > 1 ? (yhi - ylo) / (ny - 1) : 1, nodata: SURFER_BLANK, crs: null, form: 'Surfer 6 binary' };
  }
  if (tag === 'DSAA') {
    const toks = (await blob.text()).trim().split(/\s+/);
    const nx = +toks[1], ny = +toks[2];
    const xlo = +toks[3], xhi = +toks[4], ylo = +toks[5], yhi = +toks[6];
    const data = new Float32Array(nx * ny);
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) data[(ny - 1 - r) * nx + c] = +toks[9 + r * nx + c];
    return { nx, ny, data, x0: xlo, y0: yhi, dx: nx > 1 ? (xhi - xlo) / (nx - 1) : 1, dy: ny > 1 ? (yhi - ylo) / (ny - 1) : 1, nodata: SURFER_BLANK, crs: null, form: 'Surfer 6 ascii' };
  }
  throw new Error('not a Surfer grid (no DSAA/DSBB magic)');
}

export async function readEsriAsc(blob) {
  const text = await blob.text();
  const toks = text.trim().split(/\s+/);
  let i = 0;
  const hdr = {};
  while (i < toks.length && /^[a-z_]/i.test(toks[i])) { hdr[toks[i].toLowerCase()] = +toks[i + 1]; i += 2; }
  const nx = hdr.ncols, ny = hdr.nrows, cs = hdr.cellsize;
  if (!nx || !ny || !cs) throw new Error('not an ESRI ASCII grid (missing ncols/nrows/cellsize)');
  const x0 = hdr.xllcenter != null ? hdr.xllcenter : hdr.xllcorner + cs / 2;
  const yll = hdr.yllcenter != null ? hdr.yllcenter : hdr.yllcorner + cs / 2;
  const data = new Float32Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) data[k] = +toks[i + k];   // already north-first
  return { nx, ny, data, x0, y0: yll + (ny - 1) * cs, dx: cs, dy: cs, nodata: hdr.nodata_value != null ? hdr.nodata_value : null, crs: null, form: 'ESRI ASCII' };
}

// a rasterized grid persists as (dogfoods readEsriAsc, projects reload it).
// north-first rows, square cells; a non-square grid exports at dx with a note.
export function writeEsriAsc(grid) {
  const { nx, ny, x0, y0, dx, dy, data } = grid;
  const nd = grid.nodata != null && grid.nodata < 1.7e38 ? grid.nodata : -9999;
  const isBad = (v) => Number.isNaN(v) || v === grid.nodata || (grid.nodata != null && grid.nodata >= 1.7e38 && v >= 1.7014e38);
  const out = [
    `ncols ${nx}`, `nrows ${ny}`,
    `xllcorner ${x0 - dx / 2}`, `yllcorner ${y0 - (ny - 1) * dy - dy / 2}`,
    `cellsize ${dx}`, `NODATA_value ${nd}`,
  ];
  const fmt = (v) => { const r = Math.round(v * 1000) / 1000; return Number.isInteger(r) ? String(r) : String(r); };
  for (let r = 0; r < ny; r++) {
    const row = new Array(nx);
    for (let c = 0; c < nx; c++) { const v = data[r * nx + c]; row[c] = isBad(v) ? nd : fmt(v); }
    out.push(row.join(' '));
  }
  return out.join('\n') + '\n';
}
