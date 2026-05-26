// Outline extractor — pure, no DOM dependencies.
//
// Walks a notebook's cells and produces a flat list of outline entries
// in document order, plus the document title at level 0. Three kinds
// of entry contribute:
//
//   - `title`     — the notebook's docTitle, one entry at the top
//   - `header`    — every markdown header in every md cell (line-anchored
//                   ^#{1,6}\s+ — one cell can contribute several)
//   - `cellname`  — any cell carrying `%cellName <name>`. Nests under
//                   the last open header (level = lastHeaderLevel + 1)
//
// Persistence is JSON via persist.js; tree-side rendering builds the
// nested hierarchy from the flat list by walking levels.

import { parseCellName } from './dag-core.js';

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function extractOutline(cells, title) {
  const entries = [];
  if (title) {
    entries.push({ kind: 'title', cellId: null, headerIdx: null, level: 0, text: title });
  }

  let lastHeaderLevel = 0;
  for (const cell of cells || []) {
    if (cell.type === 'md' && cell.code) {
      const lines = cell.code.split('\n');
      let headerIdx = 0;
      let inFence = false;
      for (const line of lines) {
        // Skip fenced code blocks — ```python … ``` shouldn't contribute
        // their own internal "# foo" comment lines as headers.
        if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = HEADER_RE.exec(line);
        if (m) {
          const level = m[1].length;
          entries.push({
            kind: 'header', cellId: cell.id, headerIdx,
            level, text: m[2].trim(),
          });
          lastHeaderLevel = level;
          headerIdx++;
        }
      }
    }
    const cellName = cell.code ? parseCellName(cell.code) : null;
    if (cellName) {
      entries.push({
        kind: 'cellname', cellId: cell.id, headerIdx: null,
        level: lastHeaderLevel + 1, text: cellName,
      });
    }
  }

  return { version: 1, title: title || '', entries };
}
