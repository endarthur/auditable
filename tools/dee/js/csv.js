// dee tool — CSV parser for block models and drillholes

function detectSeparator(text) {
  const first = text.slice(0, text.indexOf('\n') || 200);
  const counts = { ',': 0, '\t': 0, ';': 0 };
  for (const ch of first) if (ch in counts) counts[ch]++;
  return counts['\t'] > counts[','] ? '\t' : counts[';'] > counts[','] ? ';' : ',';
}

function parseCSV(text) {
  const sep = detectSeparator(text);
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(sep);
    if (parts.length < headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const v = parts[j]?.trim().replace(/^["']|["']$/g, '');
      row[headers[j]] = v;
    }
    rows.push(row);
  }
  return { headers, rows };
}

function findColumn(headers, ...candidates) {
  const lower = headers.map(h => h.toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return headers[idx];
  }
  return null;
}

function inferGridDef(xs, ys, zs) {
  // sort unique values per axis, find spacing
  const unique = arr => [...new Set(arr)].sort((a, b) => a - b);
  const ux = unique(xs), uy = unique(ys), uz = unique(zs);
  const spacing = arr => {
    if (arr.length < 2) return 1;
    const diffs = [];
    for (let i = 1; i < arr.length; i++) diffs.push(arr[i] - arr[i - 1]);
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)]; // median spacing
  };
  const sx = spacing(ux), sy = spacing(uy), sz = spacing(uz);
  const nx = ux.length, ny = uy.length, nz = uz.length;
  // origin = centroid of first block
  return {
    origin: [ux[0], uy[0], uz[0]],
    size: [sx, sy, sz],
    count: [nx, ny, nz],
  };
}

function parseBlockCSV(text) {
  const { headers, rows } = parseCSV(text);
  const xCol = findColumn(headers, 'x', 'east', 'easting', 'centroid_x', 'xc');
  const yCol = findColumn(headers, 'y', 'north', 'northing', 'centroid_y', 'yc');
  const zCol = findColumn(headers, 'z', 'elev', 'elevation', 'rl', 'centroid_z', 'zc');
  if (!xCol || !yCol || !zCol) throw new Error(`Cannot find x/y/z columns in: ${headers.join(', ')}`);

  const xs = rows.map(r => parseFloat(r[xCol]));
  const ys = rows.map(r => parseFloat(r[yCol]));
  const zs = rows.map(r => parseFloat(r[zCol]));

  const gridDef = inferGridDef(xs, ys, zs);
  const n = _grid.nBlocks(gridDef);

  // numeric columns (excluding x/y/z)
  const skip = new Set([xCol, yCol, zCol]);
  const columnNames = headers.filter(h => !skip.has(h) && rows.some(r => !isNaN(parseFloat(r[h]))));

  const columns = {};
  for (const col of columnNames) {
    const indices = [], values = [];
    for (let i = 0; i < rows.length; i++) {
      const v = parseFloat(rows[i][col]);
      if (isNaN(v)) continue;
      const idx = _grid.locate(gridDef, xs[i], ys[i], zs[i]);
      if (idx >= 0) { indices.push(idx); values.push(v); }
    }
    columns[col] = { values: new Float64Array(values), indices: new Int32Array(indices) };
  }

  return { gridDef, columns, columnNames };
}

function parseDrillholeCSV(collarText, intervalText) {
  const collar = parseCSV(collarText);
  const intervals = parseCSV(intervalText);

  const idCol = findColumn(collar.headers, 'hole_id', 'holeid', 'id', 'bhid', 'dhid');
  const eCol = findColumn(collar.headers, 'east', 'easting', 'x', 'collar_x');
  const nCol = findColumn(collar.headers, 'north', 'northing', 'y', 'collar_y');
  const zCol = findColumn(collar.headers, 'elev', 'elevation', 'z', 'collar_z', 'rl');
  if (!idCol || !eCol || !nCol || !zCol) throw new Error('Cannot find collar columns');

  const iIdCol = findColumn(intervals.headers, 'hole_id', 'holeid', 'id', 'bhid', 'dhid');
  const fromCol = findColumn(intervals.headers, 'from', 'from_m', 'depth_from');
  const toCol = findColumn(intervals.headers, 'to', 'to_m', 'depth_to');
  if (!iIdCol || !fromCol || !toCol) throw new Error('Cannot find interval columns');

  // find grade columns (numeric, not from/to)
  const skip = new Set([iIdCol, fromCol, toCol]);
  const gradeCol = intervals.headers.find(h => !skip.has(h) && intervals.rows.some(r => !isNaN(parseFloat(r[h]))));

  const collarMap = {};
  for (const r of collar.rows) {
    collarMap[r[idCol]] = {
      id: r[idCol],
      collar: [parseFloat(r[eCol]), parseFloat(r[nCol]), parseFloat(r[zCol])],
      surveys: [{ depth: 0, azimuth: 0, dip: -90 }],
      intervals: [],
    };
  }

  for (const r of intervals.rows) {
    const hole = collarMap[r[iIdCol]];
    if (!hole) continue;
    const iv = { from: parseFloat(r[fromCol]), to: parseFloat(r[toCol]) };
    if (gradeCol) iv.value = parseFloat(r[gradeCol]);
    hole.intervals.push(iv);
  }

  return { holes: Object.values(collarMap).filter(h => h.intervals.length > 0) };
}
