import { unzip } from './zip.js';
import { parseXml, find, findAll } from './xml.js';
import { colLetter, colIndex, parseRef } from './util.js';

// ── Shared strings ──

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = parseXml(xml);
  const strings = [];
  for (const si of findAll(doc, 'si')) {
    // simple text: <si><t>text</t></si>
    const t = find(si, 't');
    if (t && si.children.length === 1) {
      strings.push(t.text);
      continue;
    }
    // rich text: <si><r><rPr>...</rPr><t>part</t></r>...</si>
    let text = '';
    for (const r of findAll(si, 'r')) {
      const rt = find(r, 't');
      if (rt) text += rt.text;
    }
    strings.push(text || (t ? t.text : ''));
  }
  return strings;
}

// ── Styles / date detection ──

// built-in date format IDs (14-22)
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22]);

function parseDateFormats(xml) {
  if (!xml) return new Set();
  const doc = parseXml(xml);
  const dateIds = new Set(BUILTIN_DATE_IDS);

  // custom number formats
  for (const fmt of findAll(doc, 'numFmt')) {
    const id = parseInt(fmt.attrs.numFmtId);
    const code = (fmt.attrs.formatCode || '').toLowerCase();
    // date/time tokens: y, m, d, h, s (but not in # patterns like #,##0)
    if (/[ydhsap]/i.test(code) && !/[#0]/.test(code)) {
      dateIds.add(id);
    } else if (/(?:^|[^#0])m(?:[^#0]|$)/.test(code) && /[ydhs]/i.test(code)) {
      dateIds.add(id);
    }
  }

  // build map: style index → numFmtId
  const styleNumFmts = [];
  const cellXfs = find(doc, 'cellXfs');
  if (cellXfs) {
    for (const xf of findAll(cellXfs, 'xf')) {
      styleNumFmts.push(parseInt(xf.attrs.numFmtId || '0'));
    }
  }

  return { dateIds, styleNumFmts };
}

// ── Workbook / relationships ──

function parseWorkbook(wbXml, relsXml) {
  const wb = parseXml(wbXml);
  const rels = parseXml(relsXml);
  const sheets = [];

  // build relationship map: rId → target path
  const relMap = {};
  for (const rel of findAll(rels, 'Relationship')) {
    relMap[rel.attrs.Id] = rel.attrs.Target;
  }

  for (const sheet of findAll(wb, 'sheet')) {
    const name = sheet.attrs.name;
    const rId = sheet.attrs.id;
    const target = relMap[rId];
    if (target) sheets.push({ name, path: 'xl/' + target });
  }

  return sheets;
}

// ── Worksheet parsing ──

function parseWorksheet(xml, sharedStrings, styles, options) {
  const doc = parseXml(xml);
  const sheetData = find(doc, 'sheetData');
  if (!sheetData) return { columns: {}, headers: [], rows: 0 };

  const { dateIds, styleNumFmts } = styles || { dateIds: new Set(), styleNumFmts: [] };
  const headerRow = (options && options.headerRow) || 1;

  // parse range filter if specified
  let rangeFilter = null;
  if (options && options.range) {
    const parts = options.range.split(':');
    const tl = parseRef(parts[0]);
    const br = parseRef(parts[1]);
    if (tl && br) rangeFilter = { minCol: tl.col, maxCol: br.col, minRow: tl.row, maxRow: br.row };
  }

  // collect raw cells: { col, row, value, type }
  // type: 'n' | 's' | 'b' | 'd' (date numeric)
  const rawCells = [];
  let maxCol = -1;
  let maxRow = -1;

  for (const rowNode of findAll(sheetData, 'row')) {
    for (const c of findAll(rowNode, 'c')) {
      const ref = c.attrs.r;
      if (!ref) continue;
      const parsed = parseRef(ref);
      if (!parsed) continue;
      const { col, row } = parsed;

      // apply range filter
      if (rangeFilter) {
        if (col < rangeFilter.minCol || col > rangeFilter.maxCol) continue;
        if (row < rangeFilter.minRow || row > rangeFilter.maxRow) continue;
      }

      const t = c.attrs.t || '';
      const s = parseInt(c.attrs.s || '0');
      const vNode = find(c, 'v');
      const vText = vNode ? vNode.text : '';

      let value, type;

      if (t === 's') {
        // shared string
        const idx = parseInt(vText);
        value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        type = 's';
      } else if (t === 'str' || t === 'inlineStr') {
        // inline string
        if (t === 'inlineStr') {
          const is = find(c, 'is');
          const tNode = is ? find(is, 't') : null;
          value = tNode ? tNode.text : '';
        } else {
          value = vText;
        }
        type = 's';
      } else if (t === 'b') {
        value = vText === '1';
        type = 'b';
      } else if (t === 'e') {
        value = vText; // error string like "#REF!"
        type = 's';
      } else {
        // number (or date)
        if (!vText && vText !== '0') continue; // blank cell
        value = parseFloat(vText);
        if (isNaN(value)) continue;
        // check if date format
        const numFmtId = styleNumFmts[s] || 0;
        type = dateIds.has(numFmtId) ? 'd' : 'n';
      }

      rawCells.push({ col, row, value, type });
      if (col > maxCol) maxCol = col;
      if (row > maxRow) maxRow = row;
    }
  }

  if (rawCells.length === 0) return { columns: {}, headers: [], rows: 0 };

  // determine headers
  const headerCells = rawCells.filter(c => c.row === headerRow - 1);
  const allHeadersAreStrings = headerCells.length > 0 &&
    headerCells.every(c => c.type === 's');

  const headers = [];
  const headerMap = {};
  if (allHeadersAreStrings) {
    for (const c of headerCells) {
      headerMap[c.col] = c.value;
    }
  }

  // determine columns present
  const colSet = new Set(rawCells.map(c => c.col));
  const colList = [...colSet].sort((a, b) => a - b);

  for (const col of colList) {
    const name = headerMap[col] || colLetter(col);
    headers.push(name);
  }

  // determine data rows (exclude header row)
  const dataCells = allHeadersAreStrings
    ? rawCells.filter(c => c.row !== headerRow - 1)
    : rawCells;

  // determine row range
  const dataRows = dataCells.map(c => c.row);
  const minDataRow = dataRows.length > 0 ? Math.min(...dataRows) : 0;
  const maxDataRow = dataRows.length > 0 ? Math.max(...dataRows) : 0;
  const rowCount = maxDataRow - minDataRow + 1;

  // group cells by column, determine types
  const colCells = {};
  for (const col of colList) colCells[col] = [];
  for (const c of dataCells) colCells[c.col].push(c);

  const columns = {};
  for (let ci = 0; ci < colList.length; ci++) {
    const col = colList[ci];
    const name = headers[ci];
    const cells = colCells[col];

    // count types
    const typeCounts = { n: 0, s: 0, b: 0, d: 0 };
    for (const c of cells) typeCounts[c.type]++;

    const total = cells.length;
    let colType;
    if (total === 0) {
      colType = 's'; // empty column defaults to string
    } else if (typeCounts.n === total) {
      colType = 'n';
    } else if (typeCounts.d === total) {
      colType = 'd';
    } else if (typeCounts.b === total) {
      colType = 'b';
    } else if (typeCounts.s === total) {
      colType = 's';
    } else {
      colType = 's'; // mixed → string
    }

    // build typed array
    if (colType === 'n' || colType === 'd') {
      const arr = new Float64Array(rowCount);
      arr.fill(NaN);
      for (const c of cells) arr[c.row - minDataRow] = c.value;
      columns[name] = arr;
    } else if (colType === 'b') {
      const arr = new Uint8Array(rowCount);
      for (const c of cells) arr[c.row - minDataRow] = c.value ? 1 : 0;
      columns[name] = arr;
    } else {
      const arr = new Array(rowCount).fill('');
      for (const c of cells) arr[c.row - minDataRow] = String(c.value);
      columns[name] = arr;
    }
  }

  return { columns, headers, rows: rowCount };
}

// ── Public API ──

export async function read(source, options) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const files = await unzip(bytes);

  const decode = (path) => {
    const data = files.get(path);
    return data ? new TextDecoder().decode(data) : null;
  };

  const sharedStrings = parseSharedStrings(decode('xl/sharedStrings.xml'));
  const styles = parseDateFormats(decode('xl/styles.xml'));

  const wbXml = decode('xl/workbook.xml');
  const relsXml = decode('xl/_rels/workbook.xml.rels');
  if (!wbXml || !relsXml) throw new Error('invalid xlsx: missing workbook');

  const sheetDefs = parseWorkbook(wbXml, relsXml);
  const filterSheet = options && options.sheet;

  const sheets = [];
  for (const def of sheetDefs) {
    if (filterSheet && def.name !== filterSheet) continue;
    const wsXml = decode(def.path);
    if (!wsXml) continue;
    const result = parseWorksheet(wsXml, sharedStrings, styles, options);
    sheets.push({ name: def.name, ...result });
  }

  return { sheets };
}
