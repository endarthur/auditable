// soft — cell type handler: parseNames, findUses, execute

import { softParse } from './parse.js';
import { softEval, softString as softStringify } from './eval.js';

// ── parseNames: extract top-level variable defines ──
// Walks the AST for Set, Define, Capture, Use at top level.

export function softParseNames(code) {
  try {
    const ast = softParse(code);
    const defines = new Set();
    for (const node of ast.body) _collectDefines(node, defines);
    return defines;
  } catch {
    return _parseNamesRegex(code);
  }
}

function _collectDefines(node, defines) {
  switch (node.type) {
    case 'Set': defines.add(node.name); break;
    case 'Define': defines.add(node.name); break;
    case 'Capture': defines.add(node.name); break;
    case 'Use': defines.add(node.alias || node.path.split('.').pop()); break;
    case 'Load': if (node.name) defines.add(node.name); break;
    case 'PipeCalled': if (node.name) defines.add(node.name); _collectDefines(node.step, defines); break;
    case 'If':
      for (const s of node.body) _collectDefines(s, defines);
      if (node.elseBody) for (const s of node.elseBody) _collectDefines(s, defines);
      break;
    case 'ForEach': case 'While': case 'Repeat': case 'RangeLoop':
      for (const s of node.body) _collectDefines(s, defines);
      break;
    default: break;
  }
}

function _parseNamesRegex(code) {
  const defines = new Set();
  for (const line of code.split('\n')) {
    const t = line.trim();
    let m;
    m = t.match(/^set\s+(?:the\s+)?(\w+)\s+to\b/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/^put\s+.+\s+into\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/^define\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\binto\s+(\w+)\s*$/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\bas\s+(\w+)\s*$/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\bcalled\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
  }
  return defines;
}

// ── findUses: find references to other cells ──

export function softFindUses(code, allDefined) {
  const selfDefines = softParseNames(code);
  const uses = new Set();
  // strip comments and strings, then scan for identifiers
  const stripped = code.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const idRe = /\b([a-zA-Z_]\w*)\b/g;
  let m;
  while ((m = idRe.exec(stripped))) {
    if (allDefined.has(m[1]) && !selfDefines.has(m[1])) uses.add(m[1]);
  }
  return uses;
}

// ── execute: run a Soft cell ──

export async function softExecute(code, scopeIn, cell) {
  const globals = {};

  // inject Math, standard JS globals
  if (typeof Math !== 'undefined') globals.Math = Math;
  if (typeof JSON !== 'undefined') globals.JSON = JSON;

  // Text utilities
  globals.Text = {
    upper: (s) => String(s).toUpperCase(),
    lower: (s) => String(s).toLowerCase(),
    trim: (s) => String(s).trim(),
    split: (s, sep) => String(s).split(sep),
    replace: (s, a, b) => String(s).replace(a, b),
    starts: (s, prefix) => String(s).startsWith(prefix),
    ends: (s, suffix) => String(s).endsWith(suffix),
    slice: (s, a, b) => String(s).slice(a, b),
  };

  // List utilities
  globals.List = {
    range: (a, b, step) => {
      const arr = [];
      if (b === undefined) { b = a; a = 0; }
      step = step || 1;
      for (let i = a; step > 0 ? i < b : i > b; i += step) arr.push(i);
      return arr;
    },
    reverse: (arr) => [...arr].reverse(),
    flat: (arr) => arr.flat(),
    unique: (arr) => [...new Set(arr)],
    join: (arr, sep) => arr.join(sep ?? ', '),
    zip: (...arrs) => arrs[0].map((_, i) => arrs.map(a => a[i])),
  };

  // Date utilities
  globals.Date = {
    now: () => Date.now(),
    today: () => new Date().toISOString().slice(0, 10),
  };

  // host functions for file I/O, DOM, events
  const host = {};
  const hasCtx = !!cell?._ctx;

  // CSV parser
  const csvParse = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim());
      const row = {};
      headers.forEach((h, i) => {
        const v = vals[i];
        row[h] = v !== undefined && v !== '' && !isNaN(v) ? Number(v) : (v || '');
      });
      return row;
    });
  };
  const parseContent = (path, text) => {
    if (path.endsWith('.json')) return JSON.parse(text);
    if (path.endsWith('.csv')) return csvParse(text);
    return text;
  };

  // pre-read all files referenced in load statements (async, before sync evaluator)
  // parse the AST to find Load nodes — works regardless of locale
  const preloaded = {};
  const nbFs = hasCtx ? cell._ctx?.notebook?.fs : null;
  let loadPaths = [];
  try {
    const ast = softParse(code);
    for (const node of ast.body) {
      if (node.type === 'Load' && node.path?.type === 'Str') loadPaths.push(node.path.value);
    }
  } catch { /* parse error — no pre-loading */ }
  for (const path of loadPaths) {
    try {
      if (path.startsWith('http://') || path.startsWith('https://')) {
        preloaded[path] = await (await fetch(path)).text();
      } else if (nbFs) {
        preloaded[path] = await nbFs.read(path);
      }
    } catch { /* will error at eval time */ }
  }

  host.load = (path) => {
    if (preloaded[path] !== undefined) return parseContent(path, preloaded[path]);
    if (path in scopeIn) return scopeIn[path];
    throw new Error(`Cannot load "${path}": file not found`);
  };
  if (nbFs) {
    host.save = async (path, data) => {
      let content;
      if (typeof data === 'string') content = data;
      else if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        const keys = Object.keys(data[0]);
        content = keys.join(',') + '\n' + data.map(r => keys.map(k => r[k] ?? '').join(',')).join('\n');
      } else {
        content = JSON.stringify(data, null, 2);
      }
      await nbFs.write(path, content);
    };
  }

  // DOM helpers
  if (hasCtx) {
    const outputEl = cell._ctx.outputEl;
    // cleanup tracking for event listeners
    const cleanups = [];
    if (cell._ctx.invalidation) {
      cell._ctx.invalidation.then(() => { for (const fn of cleanups) fn(); });
    }

    host.make = (tag, parent) => {
      const el = document.createElement(tag);
      (parent || outputEl).appendChild(el);
      return el;
    };
    host.on = (event, target, handler) => {
      let el = target || outputEl;
      if (typeof el === 'string') el = document.getElementById(el);
      if (el && el.addEventListener) {
        el.addEventListener(event, handler);
        cleanups.push(() => el.removeEventListener(event, handler));
      }
    };
  }

  const result = softEval(code, {
    globals,
    scopeInit: scopeIn,
    host,
  });

  // extract defines
  const defines = {};
  const cellDefines = softParseNames(code);
  for (const name of cellDefines) {
    if (result.scope[name] !== undefined) {
      defines[name] = result.scope[name];
    }
  }

  // build output
  if (hasCtx) {
    // render output to DOM — use ui.table for arrays-of-objects, display for everything else
    for (const val of result.output) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        cell._ctx.ui.table(val);
      } else if (typeof val === 'string') {
        cell._ctx.display(val);
      } else {
        cell._ctx.display(val);
      }
    }
    // last expression value as cell reactive output
    if (result.scope.it !== null && result.scope.it !== undefined && result.output.length === 0) {
      if (Array.isArray(result.scope.it) && result.scope.it.length > 0 && typeof result.scope.it[0] === 'object') {
        cell._ctx.ui.table(result.scope.it);
      } else {
        cell._ctx.display(result.scope.it);
      }
    }
    return { defines };
  }

  // headless mode — stringify raw values
  return {
    defines,
    output: result.output.length > 0
      ? result.output.map(v => typeof v === 'string' ? v : softStringify(v)).join('\n')
      : undefined,
  };
}
