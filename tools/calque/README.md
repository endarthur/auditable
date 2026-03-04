# calque editor

a standalone editor for the calque spreadsheet language. write calque source, see a live spreadsheet grid, export to xlsx. single HTML file, zero dependencies.

## building

```
node build.js --target=calque
```

output: `tools/calque/index.html` (~720KB, includes CM6 editor + calque compiler + sheet IO)

## architecture

the editor is a single-page app with a canvas-based spreadsheet grid and a floating CodeMirror 6 editor window. the calque compiler (`ext/calque/index.js`) and sheet IO (`ext/sheet/index.js`) are prepended as dependencies during build.

### source files

```
js/
  main.js       -- entry point (import order = concat order)
  state.js      -- CQ global state: source, result, projectId, fileHandle, etc.
  grid.js       -- canvas spreadsheet: rendering, selection, cell editing, paste, drag-drop
  window.js     -- floating editor window (draggable, resizable, minimizable)
  editor.js     -- CM6 setup: stateful stream tokenizer, GCU theme, completions, signature hints
  eval.js       -- debounced calque.run() bridge, auto-saves to active project
  menu.js       -- classic dropdown menu bar, dynamic recent projects section
  file.js       -- new/open/save/saveAs/rename, import/export xlsx, drag-drop handlers
  splash.js     -- project CRUD, splash screen UI, built-in examples, inline rename prompt
  init.js       -- bootstrap IIFE, global keyboard shortcuts, splash on load
style.css       -- GCU dark theme (amber accent, monospace)
template.html   -- HTML body markup (menubar, viewport, grid, statusbar)
manifest.json   -- PWA manifest
sw.js           -- service worker for offline support
```

### project system

projects are stored in localStorage:

| key | content |
|-----|---------|
| `cq-projects` | JSON array: `[{ id, name, ts }, ...]` (max 20) |
| `cq-project:<id>` | calque source text |
| `cq-active` | ID of current project |
| `cq-col-widths` | per-sheet column width overrides |
| `cq-win-pos` | editor window position/size |

on launch, a splash screen shows recent projects with relative timestamps, plus New, Open, and Examples buttons. selecting a project loads it; "Resume Last" continues the previously active one.

first Ctrl+S on an untitled project prompts for a name via an inline input. subsequent saves are silent (localStorage auto-persists on every eval). File > Save As exports to disk.

### syntax highlighting

the CM6 editor uses a stateful `StreamLanguage` tokenizer (not the calque compiler's `tokenizeCalque`) to correctly highlight multi-line template strings and `${interpolations}`. state tracks `inTemplate` and `interpDepth` across lines.

### grid

canvas-based rendering with virtual scrolling. cells are editable inline -- double-click or type to enter a value. new bindings are inserted into the active sheet block with `@anchor` directives for grid positioning. supports multi-cell selection, copy/paste (including from Excel), and drag-drop of .xlsx and .calque files.

## keyboard shortcuts

| key | action |
|-----|--------|
| Ctrl+S | save (prompts for name if untitled) |
| Ctrl+O | open .calque file |
| Ctrl+N | new project |
| Ctrl+E | toggle editor / focus |
| Ctrl+Shift+E | jump between editor cursor and grid cell |
| F1 | keyboard shortcuts overlay |
| F2 | edit current cell |
| Arrows | navigate grid |
| Shift+Arrows | extend selection |
| Enter / Tab | move down / right |
| Delete | clear cell / remove bindings |
| Ctrl+C / Ctrl+V | copy / paste |
| Alt+V | paste with headers |
| Alt+T | create binding from selection |
| Alt+PageUp/Dn | switch sheet |

## language

see `ext/calque/SPEC.md` for the full calque language specification.
