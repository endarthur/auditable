// notebook = { fs, cells, scope, addCell, scrollTo, focus, collapse, expand, run }
// — programmatic notebook control surfaced inside every cell.

import { S } from '../state.js';
import { addCell } from '../cell-ops.js';
import { createNotebookFs } from '../fs.js';
import { getEditor } from '../cm6.js';
import { makeShell } from './shell.js';
import { makeAbus } from './abus.js';

export function makeNotebookApi(cell, ctx, runDAG) {
  const abus = makeAbus(cell, ctx);
  return {
    fs: createNotebookFs(),
    shell: makeShell(cell, ctx),
    tag: abus.tag,            // A-Bus topic publish/subscribe/latest (Works-only)
    call: abus.call,          // call a declared-public surface interface (no prompt)
    requestBus: abus.requestBus, // raw A-Bus client (// %abus + consent prompt)
    get cells() { return S.cells.map(c => ({ id: c.id, type: c.type, code: c.code })); },
    get scope() { return { ...S.scope }; },
    addCell: (type, code, afterId) => addCell(type, code, afterId),
    scrollTo: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c?.el) c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    focus: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c?.el) {
        c.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const editor = getEditor(id);
        if (editor) editor.focus();
        else { const ta = c.el.querySelector('textarea'); if (ta) ta.focus(); }
      }
    },
    collapse: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c) { c.collapsed = true; if (c.el) c.el.classList.add('collapsed'); }
    },
    expand: (id) => {
      const c = S.cells.find(c => c.id === id);
      if (c) { c.collapsed = false; if (c.el) c.el.classList.remove('collapsed'); }
    },
    run: (ids) => runDAG(Array.isArray(ids) ? ids : [ids], true),
  };
}
