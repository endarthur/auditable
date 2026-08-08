// micro shared mutable state. One S object imported by every module — ES module
// bindings can't be reassigned across modules, so cross-module state lives as
// S.* properties (same pattern as auditable's src/js/state.js).
//
// Only state that more than one module reads belongs here. Transient
// single-function locals (dialog handles, gesture state) stay where they live.
export const S = {
  // ── layers (micro-layers spec §1): each opened dataset is a layer — its docs,
  // bbox, view state (color/clip/filter), and visibility. The renderer partitions
  // record ids (layer << 29 | record), so picks resolve to the right source.
  layers: [],
  activeId: 0,
  layerTree: [],                                            // tree nodes: layer refs + groups (persisted in project.json)

  // ── project (File menu): the open project folder, bookmarks, scenes
  project: null,                                            // { dir: FileSystemDirectoryHandle, name, dirty }
  views: [],                                                // bookmarks (viewpoints): { name, camera, section, file? }
  scenes: [],                                               // scenes (full working state): { name, camera, section, layers:[…], file? }

  // ── recipes (Tools → Recipes): op-shaped YAML files in recipes/
  recipes: [],                                              // { name, tool, params, file }

  // ── long-lived app objects, assigned once at boot (the renderer is created by
  // the app module; modules that need it read it here)
  renderer: null,
};

export const layerById = (id) => S.layers.find((l) => l.id === id) || null;
export const activeLayer = () => layerById(S.activeId);
// the ACTIVE layer's docs (always an object) — the one way to ask "what file is
// under the shared controls right now"; replaces the _blockDoc/… shadow globals
export const activeDocs = () => { const L = activeLayer(); return (L && L.docs) || {}; };
