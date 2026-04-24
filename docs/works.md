# Auditable Works

Auditable Works is a tabbed workspace shell for managing multiple
notebooks, similar to JupyterLab. It hosts auditable notebooks as iframes and
provides a file tree, tab management, and persistent storage.

## Building

Works requires the base `auditable.html` to exist first, since it embeds the
notebook runtime as a template literal.

```bash
node build.js                   # build auditable.html
node build.js --target=works    # build works.html (embeds auditable.html)
```

The output is a single self-contained `works.html` file.

## Features

### File Tree

The sidebar displays a file tree with folders and notebooks. Interact with it
using the context menu (right-click) to create, rename, delete, or move files.

### Tab Management

| Action | Behavior |
|--------|----------|
| Single-click a file | Opens a **preview tab** (italic title, replaced by next preview) |
| Double-click a file | Opens a **permanent tab** |
| Edit a previewed notebook | Automatically promotes to permanent |
| Drag a tab | Reorder tabs |
| Middle-click or close button | Close tab |

### Save Integration

**Ctrl+S** inside a notebook iframe sends the serialized HTML back to the
workspace via postMessage. The workspace writes it to the active storage
backend.

### Persistence

Works restores workspace state on reload:

- Open directory roots (FSAA) and boxes
- Active tabs and their order
- Sidebar width
- Last selected tab

## Storage Backends

Works supports two storage backends that can be used simultaneously.

### FSAA (File System Access API)

!!! info "Browser support"
    FSAA requires a Chromium-based browser (Chrome, Edge, Brave, Opera).
    Firefox and Safari do not support `showDirectoryPicker()`.

Opens real filesystem directories via `showDirectoryPicker()`. Changes are
written directly to disk. The browser will prompt for permission on first
access and after restart.

- Full read/write access to the selected directory tree
- Notebooks are stored as standard `.html` files
- Works with version control (git)

### Box (IndexedDB)

A virtual filesystem stored entirely in the browser's IndexedDB. Works in all
modern browsers, no filesystem permissions needed.

- Portable: export a box as a self-contained `works.html` file
- Import: drop a box-exported `works.html` to restore it
- Data persists until browser storage is cleared

!!! warning "Box durability"
    IndexedDB storage can be cleared by the browser under storage pressure.
    Export important boxes regularly or use FSAA for critical work.

## Lightweight Notebook Format

Notebooks stored inside Works boxes use a compact JSON format instead of full
self-contained HTML:

```json
{
  "format": "auditable-notebook",
  "v": 1,
  "title": "my notebook",
  "cells": [
    {"type": "code", "code": "const x = 1", "collapsed": true},
    {"type": "md", "code": "# Hello"}
  ],
  "settings": {"theme": "dark", "width": "860"},
  "modules": {
    "lodash": {"ref": "a1b2c3d4e5f6..."}
  }
}
```

The `ref` values are SHA-256 hashes pointing to the Works content-addressed blob store in IndexedDB.

### Content-Addressed Module Storage

Modules and binaries are stored separately in the Works blob store, keyed by
content hash. This provides deduplication across notebooks — if ten notebooks
use the same library, only one copy is stored.

| Operation | What happens |
|-----------|-------------|
| Open notebook | Works hydrates JSON into the runtime template (injects data blocks into iframe `srcdoc`) |
| Save notebook | Works dehydrates: extracts cells/settings, stores each module by content hash, replaces inline data with refs |
| Drop `.html` into box | Auto-converts: extracts data blocks, deduplicates modules into blob store, stores lightweight JSON |
| Export from box | Produces a full standalone `auditable.html` with all modules inlined |

## Bridge Protocol

Works and notebook iframes communicate via `postMessage`. The protocol handles
save workflows, UI state sync, file operations, and layout coordination.

```
Works Shell                       Notebook Iframe
───────────                       ───────────────
         ◄── works:ready          (iframe loaded)
works:serialize ──►
         ◄── works:serialized     (full HTML)
         ◄── works:dirty          (unsaved changes)
         ◄── works:titleChanged   (title updated)
works:storage ──►
         ◄── works:saved
         ◄── works:fileRequest    (file picker proxy)
works:fileResult ──►
         ◄── works:download       (download proxy)
works:resize ──►
works:setTitle ──►
```

!!! note "Works bridge detection"
    When a notebook detects it is running inside a Works iframe, it sets
    `window.__WORKS_BRIDGE__ = true` and routes save/file/download operations
    through the bridge instead of using browser-native APIs.
