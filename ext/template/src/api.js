// Public API for @gcu/template — the surface every consumer (doc / deck /
// sheet / notebook cell builtin) reaches for. Re-exports the parser, the
// renderer, and the filter registry; adds two convenience entrypoints that
// cover the common shapes.

import { parseText, parseTagged, listPaths, TemplateParseError } from './parse.js';
import { render, resolvePath, TemplateRenderError, TemplateCycleError } from './render.js';
import { registerFilter, lookupFilter } from './filters.js';

export {
  parseText, parseTagged, listPaths,
  render, resolvePath,
  registerFilter, lookupFilter,
  TemplateParseError, TemplateRenderError, TemplateCycleError,
};

// Parse + render a plain string in one call. Most callers want this.
export async function renderText(text, opts = {}) {
  const ast = parseText(text);
  return render(ast, opts);
}

// Tagged-template-literal entry. Use as:
//   const html = await tpl(opts)`hello {{intro.md}} ${name}`;
// or with default opts:
//   const html = await tpl()`hello {{intro.md}}`;
//
// The factory shape lets the caller bind opts (vfs, cwd, filters) once and
// reuse the tag inside a render scope. ${expr} values are inserted as opaque
// literal nodes — the safety guarantee that user-controlled values can't
// inject new {{...}} directives.
export function tpl(opts = {}) {
  return async (strings, ...values) => {
    const ast = parseTagged(strings, values);
    return render(ast, opts);
  };
}

// Lower-level: just resolve the dependency set from a parsed AST, mapped
// through cwd. Useful for wiring reactivity before rendering: subscribe to
// VFS.Changed for each path, then render lazily.
export function getDependencies(ast, cwd) {
  const out = new Set();
  for (const p of listPaths(ast)) out.add(resolvePath(p, cwd || '/'));
  return out;
}
