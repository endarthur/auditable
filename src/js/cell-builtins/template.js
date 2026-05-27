// `template` cell builtin — VFS-backed `{{path | filter args}}` rendering.
//
// Thin wrapper over @gcu/template (ext/template/) that wires the cell's
// notebook VFS, cwd, and re-run semantics. Two call shapes:
//
//   await template('hello {{intro.md}}')                    // function call
//   await template`hello {{intro.md}} ${name}`              // tagged-template literal
//
// Both forms return a rendered string (HTML by default per the engine's
// per-extension defaults). The tagged form is the safe variant —
// ${interpolations} land as opaque AST nodes and can't introduce new
// {{...}} directives.
//
// Reactivity: every VFS path touched during the render is recorded.
// When any of those paths receive a `write` / `delete` event on the
// notebook's VFS, the cell re-runs (via runDAG). Subscriptions clear
// on cell invalidation — no leak across re-runs.

import { parseText, parseTagged, render } from '#template';
import { renderMd } from '../markdown.js';

// The notebook's `data/` subfolder is the default cwd: `{{intro.md}}`
// resolves to /projects/self/data/intro.md. Absolute paths (leading /)
// reach anywhere in the VFS, so cross-project references still work.
const DEFAULT_CWD = '/projects/self/data';

export function makeTemplate(cell, ctx, runDAG) {
  // Per-call filter overrides so the notebook gets a proper Markdown
  // renderer for .md files instead of the engine's escaped-text
  // fallback. Other extensions use the engine's built-in defaults.
  const filters = {
    '.md': {
      default: async (text) => {
        if (typeof text !== 'string') text = String(text);
        return renderMd(text);
      },
    },
  };

  // Returns a function that's BOTH a tagged-template literal tag and
  // a plain function. Detection: tagged templates pass an Array with a
  // `raw` property as the first argument; everything else is a
  // function call.
  return async function template(arg, ...values) {
    const vfs = window._notebookVFS;
    if (!vfs) throw new Error('template: notebook VFS not available');

    const cwd = DEFAULT_CWD;
    const deps = new Set();
    const ast = (Array.isArray(arg) && Array.isArray(arg.raw))
      ? parseTagged(arg, values)
      : parseText(String(arg));

    let result;
    try {
      result = await render(ast, {
        vfs, cwd, filters,
        onDependency: (path) => deps.add(path),
      });
    } catch (e) {
      // Render errors are visible — surface the error inline so the
      // user sees what broke instead of getting a half-rendered output.
      return `<div class="template-error" style="color:var(--au-error);font:11px monospace;padding:6px;border-left:3px solid var(--au-error);">template error: ${escAttr(e.message)}</div>`;
    }

    // Reactivity wiring. Hook the VFS's native write/delete events;
    // when a tracked path fires, re-run THIS cell. Invalidation
    // (next cell run) tears the subscriptions down so we don't leak.
    if (typeof vfs.on === 'function' && deps.size > 0) {
      const onChange = (ev) => {
        const p = ev && ev.path;
        if (typeof p === 'string' && deps.has(p)) {
          // Defer so we don't re-enter during the current render.
          setTimeout(() => { try { runDAG([cell.id]); } catch {} }, 0);
        }
      };
      vfs.on('write', onChange);
      vfs.on('delete', onChange);
      ctx.invalidation.then(() => {
        try { vfs.off('write', onChange); } catch {}
        try { vfs.off('delete', onChange); } catch {}
      });
    }

    return result;
  };
}

function escAttr(s) {
  return String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
