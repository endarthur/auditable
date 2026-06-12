// renderMd — the notebook's markdown entry point: @gcu/markdown with the
// notebook preset. The engine lives in ext/markdown (SPEC.md there); this
// wrapper pins the preset and keeps the renderMd/slugify surface its eleven
// consumers (cell-render, cell-dom, ui, workshop, template, find, update,
// globals, app export, …) already import.
//
// SECURITY: the notebook preset is html-INERT — raw HTML in md cells renders
// as escaped text. md cells render on OPEN while code cells run on consent,
// so md is the one place a received notebook acts without consent; it must be
// data-safe. The old blacklist sanitizer died with this wrapper ("generate,
// never sanitize" — @gcu/markdown SPEC §5). HTML cells are the sanctioned
// escape hatch, and the dialect carries md-native sub/sup/mark/kbd/tables.
//
// The aliased _md* names matter: in the app-export concat build this module's
// import is stripped and the names resolve against build.js's IIFE-wrapped
// engine prelude (the app scope has a conflicting top-level `render` stub).

import { render as _mdRender, presets as _mdPresets, slugify as _mdSlugify } from './gcu-markdown.js';

export const slugify = _mdSlugify;

export function renderMd(src) {
  return _mdRender(String(src ?? ''), _mdPresets.notebook);
}
