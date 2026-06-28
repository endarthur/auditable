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

export class Model {
  constructor(doc = null) {
    this.doc = doc || emptyDoc();
    this.rev = 0;          // bumped on every mutation — the scene re-derives off this
    this._undo = [];
    this._redo = [];
  }

  get frame() { return this.doc.frame; }
  get features() { return this.doc.features; }

  // Append a feature (already WORLD-canonical — the tool converts local→world on commit).
  add(feature) {
    this.doc.features.push(feature);
    this._undo.push({ kind: 'add', feature });
    this._redo.length = 0;
    this.rev++;
    return feature;
  }

  undo() {
    const e = this._undo.pop();
    if (!e) return false;
    if (e.kind === 'add') { const i = this.doc.features.indexOf(e.feature); if (i >= 0) this.doc.features.splice(i, 1); }
    this._redo.push(e);
    this.rev++;
    return true;
  }

  redo() {
    const e = this._redo.pop();
    if (!e) return false;
    if (e.kind === 'add') this.doc.features.push(e.feature);
    this._undo.push(e);
    this.rev++;
    return true;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }
  isEmpty() { return this.doc.features.length === 0; }
}
