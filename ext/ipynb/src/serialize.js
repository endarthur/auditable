// Auditable cells → .ipynb JSON.
//
// Inverse of parse.js. Python (adder) cells become ipynb code cells with
// imports rewritten back to their numpy/pandas/etc. originals so a
// colleague opening the file in Jupyter sees idiomatic code. Non-Python
// auditable cell types (JS code, html, css) become markdown cells
// containing the source verbatim in a fenced block, with a note that
// they need to be re-executed in Auditable. This is the "honest framing"
// version: the Python parts of your work, intact; everything else
// preserved as text for reference.
//
// Returns a JS object you can JSON.stringify (or pass through directly
// to a file writer). Caller is responsible for serializing.

import { SUBSTITUTIONS } from './substitutions.js';

// Inverse of the substitution table. Built lazily at first use.
let _inverseSubs = null;
function inverseSubs() {
  if (_inverseSubs) return _inverseSubs;
  _inverseSubs = {};
  for (const [py, gcu] of Object.entries(SUBSTITUTIONS)) {
    _inverseSubs[gcu] = py;
  }
  return _inverseSubs;
}

// Same rewriter shape as substitutions.rewriteImports, but using the
// inverse table. Could be unified, but the asymmetry (forward maps
// `numpy.linalg` via prefix; inverse needs to map `natra.linalg` via
// prefix too) is cleanest as a separate dedicated pass.
export function rewriteImportsBack(source) {
  const inv = inverseSubs();
  const lines = source.split('\n');
  const out = [];
  for (const line of lines) {
    out.push(rewriteImportLineBack(line, inv));
  }
  return out.join('\n');
}

function rewriteImportLineBack(line, inv) {
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const body = line.slice(indent.length);
  let code = body;
  let comment = '';
  const hashAt = body.indexOf('#');
  if (hashAt >= 0) {
    code = body.slice(0, hashAt).trimEnd();
    comment = body.slice(hashAt);
    if (comment) comment = ' ' + comment;
  }

  let m = code.match(/^from\s+([\w.]+)\s+import\s+(.+?)\s*$/);
  if (m) {
    const pkg = m[1];
    const rest = m[2];
    const replacement = invSub(pkg, inv);
    if (replacement === null) return line;
    return `${indent}from ${replacement} import ${rest}${comment}`;
  }

  m = code.match(/^import\s+(.+?)\s*$/);
  if (m) {
    const segments = m[1].split(',').map(x => x.trim()).filter(Boolean);
    const newSegs = [];
    let anyChange = false;
    for (const seg of segments) {
      const segMatch = seg.match(/^([\w.]+)(\s+as\s+\w+)?$/);
      if (!segMatch) { newSegs.push(seg); continue; }
      const pkg = segMatch[1];
      const asPart = segMatch[2] || '';
      const replacement = invSub(pkg, inv);
      if (replacement === null) {
        newSegs.push(seg);
        continue;
      }
      newSegs.push(`${replacement}${asPart}`);
      anyChange = true;
    }
    if (!anyChange) return line;
    return `${indent}import ${newSegs.join(', ')}${comment}`;
  }

  return line;
}

function invSub(pkg, inv) {
  if (pkg in inv) return inv[pkg];
  const parts = pkg.split('.');
  for (let n = parts.length - 1; n >= 1; n--) {
    const prefix = parts.slice(0, n).join('.');
    if (prefix in inv) {
      const rest = parts.slice(n).join('.');
      return `${inv[prefix]}.${rest}`;
    }
  }
  return null;
}

// Build the .ipynb JSON object from an array of Auditable cells.
//
// cells: [{ type, code }, ...]
// opts:
//   title?     — optional notebook title (added as a leading markdown cell)
//   pythonVer? — e.g. '3.11' for language_info.version (default '3.11')
export function serializeIpynb(cells, opts = {}) {
  const out = [];
  for (const cell of cells) {
    if (cell.type === 'adder') {
      out.push({
        cell_type: 'code',
        source: stringToSource(rewriteImportsBack(cell.code || '')),
        metadata: {},
        outputs: [],
        execution_count: null,
      });
    } else if (cell.type === 'md') {
      out.push({
        cell_type: 'markdown',
        source: stringToSource(cell.code || ''),
        metadata: {},
      });
    } else if (cell.type === 'code' || cell.type === 'css' || cell.type === 'html') {
      // Non-Python cells: wrap source as md block with note.
      const lang = cell.type === 'code' ? 'js' : cell.type;
      const wrapped =
        `*(auditable-native ${cell.type} cell — re-execute in Auditable)*\n\n` +
        '```' + lang + '\n' + (cell.code || '') + '\n```\n';
      out.push({
        cell_type: 'markdown',
        source: stringToSource(wrapped),
        metadata: {},
      });
    } else {
      // Unknown cell type — preserve source as code block in a md cell.
      const wrapped =
        `*(auditable cell of type "${cell.type}" — re-execute in Auditable)*\n\n` +
        '```\n' + (cell.code || '') + '\n```\n';
      out.push({
        cell_type: 'markdown',
        source: stringToSource(wrapped),
        metadata: {},
      });
    }
  }

  if (opts.title) {
    out.unshift({
      cell_type: 'markdown',
      source: stringToSource(`# ${opts.title}\n`),
      metadata: {},
    });
  }

  return {
    cells: out,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        version: opts.pythonVer || '3.11',
        mimetype: 'text/x-python',
        file_extension: '.py',
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

// Convert a string to the array-of-line-fragments form Jupyter prefers.
// Each line keeps its trailing '\n' except the last one (which may or
// may not have a newline). For an empty string, returns [].
function stringToSource(s) {
  if (!s) return [];
  const parts = s.split('\n');
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts[i] + '\n');
  }
  if (parts[parts.length - 1] !== '') {
    out.push(parts[parts.length - 1]);
  }
  return out;
}
