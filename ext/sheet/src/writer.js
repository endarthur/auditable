import { zip } from './zip.js';
import { tag, escape } from './xml.js';
import { colLetter, cellRef, dateToSerial } from './util.js';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ── Shared strings ──

function buildSharedStrings(sheets) {
  const map = new Map(); // string → index
  const list = [];

  const intern = (s) => {
    if (map.has(s)) return map.get(s);
    const idx = list.length;
    map.set(s, idx);
    list.push(s);
    return idx;
  };

  for (const sheet of sheets) {
    const cols = sheet.columns;
    const colNames = Object.keys(cols);
    // intern header names
    for (const name of colNames) intern(name);
    // intern string values
    for (const name of colNames) {
      const col = cols[name];
      const values = Array.isArray(col) || ArrayBuffer.isView(col) ? col : col.values;
      if (!values) continue;
      for (const v of values) {
        if (typeof v === 'string') intern(v);
      }
    }
  }

  return { map, list };
}

function emitSharedStrings(list) {
  const items = list.map(s => tag('si', null, tag('t', null, escape(s)))).join('');
  return XML_HEADER + tag('sst', {
    xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    count: list.length, uniqueCount: list.length
  }, items);
}

// ── Styles ──

function buildStyles(sheets) {
  // collect unique format codes, assign numFmtId starting at 164
  const formatMap = new Map(); // formatCode → numFmtId
  let nextFmtId = 164;
  let hasDateValues = false;

  for (const sheet of sheets) {
    for (const name of Object.keys(sheet.columns)) {
      const col = sheet.columns[name];
      if (col && typeof col === 'object' && !Array.isArray(col) && !ArrayBuffer.isView(col)) {
        if (col.format) {
          if (!formatMap.has(col.format)) formatMap.set(col.format, nextFmtId++);
        }
      }
      // check for Date values (need default date style)
      const values = Array.isArray(col) || ArrayBuffer.isView(col) ? col : (col ? col.values : null);
      if (values) {
        for (const v of values) {
          if (v instanceof Date) { hasDateValues = true; break; }
        }
      }
    }
  }

  // default date format if Date values found but no explicit format
  const defaultDateFmt = 'yyyy-mm-dd';
  if (hasDateValues && !formatMap.has(defaultDateFmt)) {
    formatMap.set(defaultDateFmt, nextFmtId++);
  }

  // xf entries: index 0 = default, then one per unique format
  // returns { xml, colStyleIndex(col) }
  const fmtEntries = [...formatMap.entries()];

  return { formatMap, fmtEntries, hasDateValues, defaultDateFmt };
}

function emitStyles(styleInfo) {
  const { fmtEntries } = styleInfo;

  let numFmts = '';
  if (fmtEntries.length > 0) {
    const items = fmtEntries.map(([code, id]) =>
      tag('numFmt', { numFmtId: id, formatCode: code })
    ).join('');
    numFmts = tag('numFmts', { count: fmtEntries.length }, items);
  } else {
    numFmts = tag('numFmts', { count: 0 });
  }

  const fonts = tag('fonts', { count: 1 },
    tag('font', null, tag('sz', { val: 11 }), tag('name', { val: 'Calibri' }))
  );
  const fills = tag('fills', { count: 2 },
    tag('fill', null, tag('patternFill', { patternType: 'none' })),
    tag('fill', null, tag('patternFill', { patternType: 'gray125' }))
  );
  const borders = tag('borders', { count: 1 },
    tag('border', null, tag('left'), tag('right'), tag('top'), tag('bottom'), tag('diagonal'))
  );
  const cellStyleXfs = tag('cellStyleXfs', { count: 1 },
    tag('xf', { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 })
  );

  // cellXfs: index 0 = default, then one per format
  const xfItems = [tag('xf', { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0 })];
  for (const [, numFmtId] of fmtEntries) {
    xfItems.push(tag('xf', { numFmtId, fontId: 0, fillId: 0, borderId: 0, xfId: 0, applyNumberFormat: 1 }));
  }
  const cellXfs = tag('cellXfs', { count: xfItems.length }, ...xfItems);

  return XML_HEADER + tag('styleSheet', {
    xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  }, numFmts, fonts, fills, borders, cellStyleXfs, cellXfs);
}

// ── Worksheet ──

function emitWorksheet(sheet, ssMap, styleInfo, tableRIds) {
  const cols = sheet.columns;
  const colNames = Object.keys(cols);
  if (colNames.length === 0) return XML_HEADER + tag('worksheet', {
    xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  }, tag('sheetData'));

  // determine row count
  let rowCount = 0;
  for (const name of colNames) {
    const col = cols[name];
    const values = Array.isArray(col) || ArrayBuffer.isView(col) ? col : (col ? col.values || [] : []);
    if (values.length > rowCount) rowCount = values.length;
  }

  const { formatMap, fmtEntries, defaultDateFmt } = styleInfo;

  // helper: get style index for a column
  const getStyleIdx = (col) => {
    if (col && typeof col === 'object' && !Array.isArray(col) && !ArrayBuffer.isView(col) && col.format) {
      const idx = fmtEntries.findIndex(([code]) => code === col.format);
      return idx >= 0 ? idx + 1 : 0;
    }
    return 0;
  };

  // helper: get date style index
  const dateStyleIdx = () => {
    const idx = fmtEntries.findIndex(([code]) => code === defaultDateFmt);
    return idx >= 0 ? idx + 1 : 0;
  };

  let sharedFormulaIdx = 0;
  const rows = [];

  // header row
  const headerCells = [];
  for (let ci = 0; ci < colNames.length; ci++) {
    const ref = cellRef(ci, 0);
    const ssIdx = ssMap.get(colNames[ci]);
    headerCells.push(tag('c', { r: ref, t: 's' }, tag('v', null, String(ssIdx))));
  }
  rows.push(tag('row', { r: 1 }, ...headerCells));

  // data rows
  for (let ri = 0; ri < rowCount; ri++) {
    const rowCells = [];
    const excelRow = ri + 2; // 1-indexed, after header

    for (let ci = 0; ci < colNames.length; ci++) {
      const ref = cellRef(ci, ri + 1);
      const col = cols[colNames[ci]];
      const values = Array.isArray(col) || ArrayBuffer.isView(col) ? col : (col ? col.values || [] : []);
      const formulas = (col && !Array.isArray(col) && !ArrayBuffer.isView(col)) ? col.formulas : null;
      const sharedFormula = (col && !Array.isArray(col) && !ArrayBuffer.isView(col)) ? col.sharedFormula : null;
      const value = ri < values.length ? values[ri] : null;

      if (value === null || value === undefined) continue;

      const attrs = { r: ref };
      let children = '';

      // handle shared formula
      if (sharedFormula && ri === 0) {
        const fText = sharedFormula.base.startsWith('=') ? sharedFormula.base.slice(1) : sharedFormula.base;
        children += tag('f', { t: 'shared', ref: sharedFormula.ref, si: sharedFormulaIdx }, escape(fText));
      } else if (sharedFormula && ri > 0) {
        children += tag('f', { t: 'shared', si: sharedFormulaIdx });
      }

      // per-cell formula
      if (!sharedFormula && formulas && ri < formulas.length && formulas[ri]) {
        const fText = formulas[ri].startsWith('=') ? formulas[ri].slice(1) : formulas[ri];
        children += tag('f', null, escape(fText));
      }

      // value
      if (value instanceof Date) {
        const serial = dateToSerial(value);
        attrs.s = dateStyleIdx();
        children += tag('v', null, String(serial));
      } else if (typeof value === 'boolean') {
        attrs.t = 'b';
        children += tag('v', null, value ? '1' : '0');
      } else if (typeof value === 'number') {
        const si = getStyleIdx(col);
        if (si > 0) attrs.s = si;
        children += tag('v', null, String(value));
      } else if (typeof value === 'string') {
        attrs.t = 's';
        const ssIdx = ssMap.get(value);
        children += tag('v', null, String(ssIdx));
      }

      rowCells.push(tag('c', attrs, children));
    }

    if (rowCells.length > 0) rows.push(tag('row', { r: excelRow }, ...rowCells));

    // increment shared formula index at end of column processing
    // (handled per-column below instead)
  }

  // count shared formulas used
  for (const name of colNames) {
    const col = cols[name];
    if (col && typeof col === 'object' && !Array.isArray(col) && !ArrayBuffer.isView(col) && col.sharedFormula) {
      sharedFormulaIdx++;
    }
  }

  let wsContent = tag('sheetData', null, ...rows);

  // table parts
  if (tableRIds && tableRIds.length > 0) {
    const parts = tableRIds.map(rId => tag('tablePart', { 'r:id': rId })).join('');
    wsContent += tag('tableParts', { count: tableRIds.length }, parts);
  }

  return XML_HEADER + tag('worksheet', {
    xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  }, wsContent);
}

// ── Tables ──

function emitTable(tableId, tableDef, colNames) {
  const style = tableDef.style || 'TableStyleMedium2';
  const tableCols = [];

  // parse ref to get column range
  const parts = tableDef.ref.split(':');
  const tl = { col: 0, row: 0 };
  const br = { col: colNames.length - 1, row: 0 };
  const refMatch1 = parts[0].match(/([A-Z]+)(\d+)/);
  const refMatch2 = parts[1].match(/([A-Z]+)(\d+)/);
  if (refMatch1 && refMatch2) {
    const startCol = colLetter(0); // we use all columns
  }

  for (let i = 0; i < colNames.length; i++) {
    tableCols.push(tag('tableColumn', { id: i + 1, name: colNames[i] }));
  }

  return XML_HEADER + tag('table', {
    xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    id: tableId, name: tableDef.name, displayName: tableDef.name,
    ref: tableDef.ref, totalsRowShown: 0
  },
    tag('autoFilter', { ref: tableDef.ref }),
    tag('tableColumns', { count: colNames.length }, ...tableCols),
    tag('tableStyleInfo', {
      name: style, showFirstColumn: 0, showLastColumn: 0,
      showRowStripes: 1, showColumnStripes: 0
    })
  );
}

// ── Content Types & Relationships ──

function emitContentTypes(sheetCount, tableCount, hasSharedStrings) {
  const overrides = [];
  overrides.push(tag('Override', {
    PartName: '/xl/workbook.xml',
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  }));
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(tag('Override', {
      PartName: `/xl/worksheets/sheet${i}.xml`,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
    }));
  }
  if (hasSharedStrings) {
    overrides.push(tag('Override', {
      PartName: '/xl/sharedStrings.xml',
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'
    }));
  }
  overrides.push(tag('Override', {
    PartName: '/xl/styles.xml',
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
  }));
  for (let i = 1; i <= tableCount; i++) {
    overrides.push(tag('Override', {
      PartName: `/xl/tables/table${i}.xml`,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'
    }));
  }

  return XML_HEADER + tag('Types', {
    xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types'
  },
    tag('Default', { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' }),
    tag('Default', { Extension: 'xml', ContentType: 'application/xml' }),
    ...overrides
  );
}

function emitRootRels() {
  return XML_HEADER + tag('Relationships', {
    xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships'
  },
    tag('Relationship', {
      Id: 'rId1',
      Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
      Target: 'xl/workbook.xml'
    })
  );
}

function emitWorkbook(sheets, definedNames) {
  const sheetTags = sheets.map((s, i) =>
    tag('sheet', { name: s.name, sheetId: i + 1, 'r:id': `rId${i + 1}` })
  ).join('');

  let extra = '';
  if (definedNames && definedNames.length > 0) {
    const names = definedNames.map(d =>
      tag('definedName', { name: d.name }, escape(d.formula))
    ).join('');
    extra = tag('definedNames', null, names);
  }

  return XML_HEADER + tag('workbook', {
    xmlns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  }, tag('sheets', null, sheetTags), extra);
}

function emitWorkbookRels(sheetCount, hasSharedStrings) {
  const rels = [];
  for (let i = 1; i <= sheetCount; i++) {
    rels.push(tag('Relationship', {
      Id: `rId${i}`,
      Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
      Target: `worksheets/sheet${i}.xml`
    }));
  }
  let nextId = sheetCount + 1;
  if (hasSharedStrings) {
    rels.push(tag('Relationship', {
      Id: `rId${nextId++}`,
      Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
      Target: 'sharedStrings.xml'
    }));
  }
  rels.push(tag('Relationship', {
    Id: `rId${nextId}`,
    Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    Target: 'styles.xml'
  }));

  return XML_HEADER + tag('Relationships', {
    xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships'
  }, ...rels);
}

// ── Public API ──

export async function write(workbook) {
  const sheets = workbook.sheets || [];
  const encoder = new TextEncoder();
  const parts = new Map();

  // build shared strings
  const { map: ssMap, list: ssList } = buildSharedStrings(sheets);
  const hasSharedStrings = ssList.length > 0;

  // build styles
  const styleInfo = buildStyles(sheets);

  // count tables across all sheets
  let totalTables = 0;
  let tableId = 1;

  // emit worksheets
  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    const sheetTables = sheet.tables || [];
    const tableRIds = [];

    // emit tables for this sheet
    if (sheetTables.length > 0) {
      const colNames = Object.keys(sheet.columns);

      for (let ti = 0; ti < sheetTables.length; ti++) {
        const tDef = sheetTables[ti];
        const tXml = emitTable(tableId, tDef, colNames);
        parts.set(`xl/tables/table${tableId}.xml`, encoder.encode(tXml));
        tableRIds.push(`rId${ti + 1}`);
        tableId++;
        totalTables++;
      }

      // worksheet rels for tables
      const wsRels = sheetTables.map((_, ti) =>
        tag('Relationship', {
          Id: `rId${ti + 1}`,
          Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table',
          Target: `../tables/table${totalTables - sheetTables.length + ti + 1}.xml`
        })
      ).join('');
      parts.set(`xl/worksheets/_rels/sheet${si + 1}.xml.rels`,
        encoder.encode(XML_HEADER + tag('Relationships', {
          xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships'
        }, wsRels))
      );
    }

    const wsXml = emitWorksheet(sheet, ssMap, styleInfo, tableRIds);
    parts.set(`xl/worksheets/sheet${si + 1}.xml`, encoder.encode(wsXml));
  }

  // emit shared strings
  if (hasSharedStrings) {
    parts.set('xl/sharedStrings.xml', encoder.encode(emitSharedStrings(ssList)));
  }

  // emit styles
  parts.set('xl/styles.xml', encoder.encode(emitStyles(styleInfo)));

  // emit workbook
  parts.set('xl/workbook.xml', encoder.encode(emitWorkbook(sheets, workbook.definedNames)));
  parts.set('xl/_rels/workbook.xml.rels',
    encoder.encode(emitWorkbookRels(sheets.length, hasSharedStrings)));

  // emit root rels
  parts.set('_rels/.rels', encoder.encode(emitRootRels()));

  // emit content types
  parts.set('[Content_Types].xml',
    encoder.encode(emitContentTypes(sheets.length, totalTables, hasSharedStrings)));

  return zip(parts);
}
