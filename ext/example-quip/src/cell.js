// CellType handler for `/// quip` cells. Implements the §3.1 contract:
// parseNames / findUses / execute.
//
// Each `/// quip` cell defines ONE scope variable, named via the
// `// %cellName <var>` directive at the top of the cell (or `quip`
// as a default). Downstream cells reach the parsed phrases through
// that variable.

import { parseQuip, makePhrases } from './parse.js';

const CELL_NAME_RE = /^\s*\/\/\s*%cellName\s+([A-Za-z_]\w*)/m;

function _exportName(code) {
  const m = CELL_NAME_RE.exec(code);
  return m ? m[1] : 'quip';
}

// EXTENSION_SPEC §3.1: declared by `capabilities.definesScope: true`.
// Return value drives the DAG — names listed here are what downstream
// cells can reference. One symbol per quip cell.
export function quipParseNames(code) {
  return new Set([_exportName(code)]);
}

// quip cells don't read upstream scope (there's nowhere in the syntax
// to reference an outer variable). Returning an empty set keeps the
// DAG honest: no false edges, no spurious re-runs.
export function quipFindUses(_code, _allDefined, _selfDefined) {
  return new Set();
}

// EXTENSION_SPEC §3.1: declared by `capabilities.executable: true`.
// `code` is the cell source, `upstream` the upstream scope (unused
// for quip), `cell` the live cell (use cell._ctx for builtins like
// ui.display when you want to surface output to the user).
export async function quipExecute(code, _upstream, cell) {
  const exportName = _exportName(code);
  // Strip the cell-name directive line before parsing so it doesn't
  // appear as a malformed quip statement.
  const stripped = code.replace(CELL_NAME_RE, '').trim();
  let templates;
  try {
    templates = parseQuip(stripped);
  } catch (e) {
    // SPEC §3.1 convention: throw with a meaningful message; the host
    // catches + renders in the cell's output area.
    throw e;
  }
  const phrases = makePhrases(templates);

  // Surface a one-line summary in the cell output area — same way
  // adder / soft / md cells display their result.
  const ctx = cell?._ctx;
  if (ctx && typeof ctx.display === 'function') {
    const names = Object.keys(templates);
    const summary = names.length === 0
      ? '(empty quip block)'
      : `${exportName}: ${names.length} phrase${names.length === 1 ? '' : 's'} — ${names.join(', ')}`;
    ctx.display(summary);
  }

  return { defines: { [exportName]: phrases } };
}
