// .ipynb JSON → array of Auditable cells.
//
// Returns `{ cells, warnings, rewrites }`:
//   cells     — [{ type, code }] in source order, ready for an Auditable
//               notebook to consume (the loader assigns IDs).
//   warnings  — strings describing things we dropped or simplified (magics,
//               raw cells, outputs, shell escapes).
//   rewrites  — flat list of all the substitutions that fired across all
//               code cells, e.g. `{original: 'numpy', rewritten: 'natra'}`.
//
// Cell mapping:
//   ipynb code     → auditable adder cell (Python); imports rewritten via
//                    substitutions.js
//   ipynb markdown → auditable md cell
//   ipynb raw      → auditable md cell wrapping the content in a fenced
//                    block + a warning (Auditable has no equivalent of
//                    Jupyter's raw cell)
//
// What we drop:
//   - cell `outputs` (cells re-run on load anyway)
//   - cell `execution_count`, `metadata`
//   - line magics (`%matplotlib inline`, `%pip install …`) — commented
//   - cell magics (`%%timeit`, `%%capture`) — line commented, body kept
//   - shell escapes (`!pip install`, `!ls`) — commented
//
// Notebook-level metadata (kernelspec, language_info) is examined to
// confirm it's a Python notebook; non-Python kernels emit a warning but
// still import (we just send the code to adder and let it error).

import { rewriteImports } from './substitutions.js';

export function parseIpynb(jsonText) {
  let nb;
  if (typeof jsonText === 'string') {
    try {
      nb = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`ipynb parse: invalid JSON (${e.message})`);
    }
  } else {
    nb = jsonText;
  }

  const warnings = [];
  const rewrites = [];
  const cells = [];

  // Confirm format. nbformat 3 had a different shape (worksheets); we
  // only handle nbformat 4 + 5.
  const nbformat = nb.nbformat;
  if (nbformat !== undefined && nbformat < 4) {
    warnings.push(`nbformat ${nbformat} is older than 4; import may be incomplete`);
  }

  // Sanity-check kernel. Most notebooks won't have a kernelspec; that's
  // fine — assume Python. Only warn if we can SEE it's not Python.
  const kernel = nb.metadata?.kernelspec?.language;
  if (kernel && kernel.toLowerCase() !== 'python') {
    warnings.push(
      `kernel is "${kernel}" — code cells will be imported as Python ` +
      `(adder cells) and likely fail`,
    );
  }

  for (const cell of nb.cells || []) {
    const source = sourceToString(cell.source);
    if (cell.cell_type === 'markdown') {
      cells.push({ type: 'md', code: source });
    } else if (cell.cell_type === 'code') {
      const { code, cellWarnings, cellRewrites } = processCodeCell(source);
      cells.push({ type: 'adder', code });
      warnings.push(...cellWarnings);
      rewrites.push(...cellRewrites);
    } else if (cell.cell_type === 'raw') {
      warnings.push('raw cell converted to md (no Auditable equivalent)');
      cells.push({
        type: 'md',
        code: '```\n' + source + '\n```\n\n*(imported from a Jupyter raw cell — Auditable has no raw cell type)*',
      });
    } else {
      warnings.push(`unknown cell_type "${cell.cell_type}" skipped`);
    }
  }

  return { cells, warnings, rewrites };
}

// ipynb source can be either a single string or an array of line-fragment
// strings that should be concatenated. The array form is more common.
function sourceToString(s) {
  if (Array.isArray(s)) return s.join('');
  if (typeof s === 'string') return s;
  return '';
}

// Strip outputs / magics from a code cell, rewrite imports.
function processCodeCell(source) {
  const cellWarnings = [];
  // Strip cell magics first (lines starting with `%%` at the top of the
  // cell, possibly preceded by blank lines / comments).
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('%%')) {
      // Cell magic — keep as comment so the user sees what was there.
      out.push('# ' + line);
      cellWarnings.push(`dropped cell magic: ${trimmed.split(/\s+/)[0]}`);
      continue;
    }
    if (trimmed.startsWith('%')) {
      // Line magic.
      out.push('# ' + line);
      cellWarnings.push(`dropped line magic: ${trimmed.split(/\s+/)[0]}`);
      continue;
    }
    if (trimmed.startsWith('!')) {
      // Shell escape.
      out.push('# ' + line);
      cellWarnings.push(`dropped shell escape: ${trimmed.split(/\s+/)[0]}`);
      continue;
    }
    out.push(line);
  }
  const stripped = out.join('\n');

  // Rewrite imports.
  const { source: rewritten, rewrites: cellRewrites } = rewriteImports(stripped);

  return {
    code: rewritten,
    cellWarnings,
    cellRewrites,
  };
}
