// moncad model — the working model: a live @gcu/dxf-shaped Document, WORLD-canonical.
//
// SPEC §4 (canonical vs derived): the Document IS the canonical thing — bulge-native
// features in world/UTM coordinates, exactly what @gcu/dxf's read/write speak. The board
// renders + snaps a DERIVED local view (sceneFromDxf), regenerated whenever the model
// changes. Editing happens in the small local frame; commits convert local→world via
// @gcu/frame and land here, so the file you save is the file you'd read back. No silent
// shifts: the readout reconstructs world, the model stores world.
//
// Pure: no DOM/WebGL, zero imports — it owns the plain-object Document SHAPE plus a
// monotonic revision counter and an undo/redo stack (same dependency-free convention as
// scene.js/snap.js, so it stays node-testable). v0 edits are append-only (draw);
// move/trim/offset will add edit kinds to the same stack without changing this contract.

// The identity frame (world == local), in the @gcu/frame value shape. Used as the default
// working frame until a DXF is opened or the user sets one.
const IDENTITY = { origin: [0, 0, 0], crs: null, units: 'm' };

// A blank Document in the @gcu/dxf shape.
export function emptyDoc(frame = IDENTITY) {
  return { frame, layers: {}, blocks: {}, features: [], warnings: [] };
}

// Default palette for a new layer's colour (ACI 1..6 = red/yellow/green/cyan/blue/magenta,
// 7 = white) — cycled when you click a layer's swatch.
export const LAYER_PALETTE = [1, 3, 5, 4, 2, 6, 7];

// Ensure the layer table is usable: '0' always exists, every feature-referenced layer has a
// record, and each carries the moncad-local display fields (visible / opacity) the DXF table
// doesn't store. The @gcu/dxf writer only reads { color, linetype } back out, so the extra
// fields are harmless on round-trip. Mutates + returns doc.layers.
export function hydrateLayers(doc) {
  const layers = doc.layers || (doc.layers = {});
  if (!layers['0']) layers['0'] = { name: '0', color: { mode: 'aci', index: 7 } };
  for (const f of doc.features) { const n = f.properties && f.properties.layer; if (n && !layers[n]) layers[n] = { name: n, color: { mode: 'aci', index: 7 } }; }
  for (const n in layers) { const L = layers[n]; L.name = n; if (L.visible === undefined) L.visible = true; if (L.opacity === undefined) L.opacity = 1; }
  return layers;
}

export class Model {
  constructor(doc = null) {
    this.doc = doc || emptyDoc();
    hydrateLayers(this.doc);
    this.rev = 0;          // bumped on every mutation — the scene re-derives off this
    this._undo = [];
    this._redo = [];
  }

  get frame() { return this.doc.frame; }
  get features() { return this.doc.features; }
  get layers() { return this.doc.layers; }

  layerList() { return Object.values(this.doc.layers); }
  getLayer(name) { return this.doc.layers[name]; }
  // Add a layer (no-op if it exists); returns the record. Not undoable in v0 (layers are
  // light document furniture, not geometry edits).
  addLayer(name, color = { mode: 'aci', index: 7 }) {
    if (!this.doc.layers[name]) { this.doc.layers[name] = { name, color, visible: true, opacity: 1 }; this.rev++; }
    return this.doc.layers[name];
  }

  // Append a feature (already WORLD-canonical — the tool converts local→world on commit).
  add(feature) {
    this.doc.features.push(feature);
    this._undo.push({ kind: 'add', features: [feature] });
    this._redo.length = 0;
    this.rev++;
    return feature;
  }

  // Append several features at once (copy/array) — one undoable step.
  addMany(features) {
    if (!features.length) return;
    for (const f of features) this.doc.features.push(f);
    this._undo.push({ kind: 'add', features: features.slice() });
    this._redo.length = 0;
    this.rev++;
  }

  // Replace features in place (move/rotate/mirror/scale of a selection). `edits` =
  // [{ i, feature }] — the prior features are captured so undo restores them exactly.
  applyEdit(edits) {
    if (!edits.length) return;
    const prior = edits.map((e) => ({ i: e.i, feature: this.doc.features[e.i] }));
    for (const e of edits) this.doc.features[e.i] = e.feature;
    this._undo.push({ kind: 'edit', prior, next: edits.map((e) => ({ i: e.i, feature: e.feature })) });
    this._redo.length = 0;
    this.rev++;
  }

  // Delete features by index (one undoable step). Removed entries are kept (with their
  // indices) so undo re-inserts them where they were.
  remove(indices) {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    if (!sorted.length) return;
    const removed = sorted.map((i) => ({ i, feature: this.doc.features[i] }));
    for (let k = sorted.length - 1; k >= 0; k--) this.doc.features.splice(sorted[k], 1);
    this._undo.push({ kind: 'remove', removed });
    this._redo.length = 0;
    this.rev++;
  }

  _invert(e, redo) {
    if (e.kind === 'add') {
      if (redo) for (const f of e.features) this.doc.features.push(f);
      else for (const f of e.features) { const i = this.doc.features.indexOf(f); if (i >= 0) this.doc.features.splice(i, 1); }
    } else if (e.kind === 'edit') {
      const set = redo ? e.next : e.prior;
      for (const { i, feature } of set) this.doc.features[i] = feature;
    } else if (e.kind === 'remove') {
      if (redo) for (let k = e.removed.length - 1; k >= 0; k--) this.doc.features.splice(e.removed[k].i, 1);
      else for (const { i, feature } of e.removed) this.doc.features.splice(i, 0, feature);   // ascending → indices stay valid
    }
  }

  undo() {
    const e = this._undo.pop();
    if (!e) return false;
    this._invert(e, false);
    this._redo.push(e);
    this.rev++;
    return true;
  }

  redo() {
    const e = this._redo.pop();
    if (!e) return false;
    this._invert(e, true);
    this._undo.push(e);
    this.rev++;
    return true;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }
  isEmpty() { return this.doc.features.length === 0; }
}
