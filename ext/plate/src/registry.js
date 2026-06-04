// @gcu/plate — the panel-kind registry.
//
// A panel kind = a domain render capability (a chart, a table excerpt, a
// stereonet, a map) wrapped in a thin adapter that plate can place in a box,
// bind to data, and link via the selection contract. This mirrors Works' own
// surface registry: plate is the layout engine OVER the registry and knows
// nothing about HOW any kind draws — only that a kind can render itself into a
// frame from (spec, data, ctx) and react to a selection.
//
// A panel-kind def:
//   {
//     kind:    string,
//     defaultSpec(data) → spec,                  // a sane starting panel
//     render(el, spec, data, ctx) → instance,    // draw into el; ctx.onSelect(desc)
//   }
// The returned instance:
//   { update(spec), setData(data), setHighlight(keySet|null), destroy() }
//
// Panels self-register at module-init (see panels/plot.js), the same pattern
// AIR lowerers use. When the 3rd panel kind arrives this registry is a clean
// extraction candidate (the two-examples discipline — plot + table are first).

const KINDS = new Map();

export function registerPanelKind(kind, def) {
  if (!kind || typeof kind !== 'string') throw new Error('plate: panel kind needs a name');
  if (!def || typeof def.render !== 'function') throw new Error('plate: panel kind "' + kind + '" needs render()');
  KINDS.set(kind, { kind, ...def });
}

export function getPanelKind(kind) {
  return KINDS.get(kind) || null;
}

export function listPanelKinds() {
  return [...KINDS.keys()];
}
