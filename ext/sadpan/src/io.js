// io.js — CSV parse/serialize

import { Table } from './table.js';

function csv(text, opts = {}) {
  const sep = opts.sep || ',';
  const lines = text.trim().split('\n');
  if (lines.length === 0) return new Table({}, []);
  const header = opts.header !== false;
  const names = header
    ? lines[0].split(sep).map(s => s.trim().replace(/^"|"$/g, ''))
    : lines[0].split(sep).map((_, i) => `col${i}`);
  const start = header ? 1 : 0;
  const cols = {};
  for (const n of names) cols[n] = [];

  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(sep);
    for (let j = 0; j < names.length; j++) {
      let v = (vals[j] || '').trim().replace(/^"|"$/g, '');
      const num = Number(v);
      cols[names[j]].push(v === '' ? null : isNaN(num) ? v : num);
    }
  }
  return new Table(cols, names);
}

function toCSV(table, opts = {}) {
  return table.toCSV(opts);
}

export { csv, toCSV };
