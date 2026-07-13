// Public API — assembles the sheet object from all modules

import { crc32, zip, unzip } from './zip.js';
import { tag, escape, parseXml, find, findAll } from './xml.js';
import { colLetter, colIndex, cellRef, parseRef, dateToSerial, serialToDate } from './util.js';
import { read } from './reader.js';
import { write } from './writer.js';
import { census, openSheet } from './table.js';

export const sheet = {
  read, write, census, openSheet,
  colLetter, colIndex, cellRef, parseRef,
  dateToSerial, serialToDate,
  // internals for testing
  _crc32: crc32, _zip: zip, _unzip: unzip,
  _tag: tag, _escape: escape, _parseXml: parseXml, _find: find, _findAll: findAll,
};
