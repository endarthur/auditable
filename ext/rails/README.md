# @gcu/rails

Layout engine for docked tab-based workspaces with floating groups.

Rails, stacks, tabs, floats — no recursion, no OS popout. Panels never reparent, so iframes, canvases, focused inputs, and running media survive every drag.

Zero dependencies. Structural CSS is ~1 KB gzipped; the library is ~6 KB gzipped.

Part of [Auditable](https://github.com/endarthur/auditable). Designed first for the Auditable Works workspace shell.

Pre-1.0 — APIs may break on minor version bumps. Floats are in progress.

## Install

```sh
npm install @gcu/rails
```

## Usage

```js
import { createRails } from '@gcu/rails';
import '@gcu/rails/rails.css';

const rails = createRails(document.getElementById('workspace'), {
  initialState: {
    rails: [{ id: 'r1', flex: 1, stacks: [{
      id: 's1', flex: 1, active: 'a',
      tabs: [
        { id: 'a', title: 'notes' },
        { id: 'b', title: 'output' }
      ]
    }] }],
    floats: []
  },
  renderPanel(tab) {
    const el = document.createElement('div');
    el.textContent = `panel for ${tab.title}`;
    return el;
  }
});
```

Drag tabs between strips, drop in gaps to create new rails or stacks, splitters resize. Panel contents persist across every move.

### Sizing your panel content

`.rails-panel` is `display: flex; flex-direction: column`. The element you return from `renderPanel(tab)` is its sole child — size it with `flex: 1; min-height: 0` to fill. Inner elements (iframes, canvases, textareas) typically need the same treatment to fill the outer.

```css
.my-panel-body {
  flex: 1;
  min-height: 0;
  /* then your own layout inside */
}
.my-panel-body iframe,
.my-panel-body canvas {
  flex: 1;
  min-height: 0;
  width: 100%;
}
```

Height fallbacks via `height: 100%` are unreliable inside flex containers — use `flex: 1; min-height: 0` instead.

## What's in this release

- Rails + stacks + tabs
- **Floats** — tear off tabs into draggable/resizable frames, 8 resize handles, maximize/minimize/close, redock by dragging the titlebar onto any rail zone, z-raise on focus
- **Panel preservation** — `closeTab(id, { preserve: true })` hides the panel instead of destroying it. Per-tab `preserveOnClose: true` flag routes UI close (× / Ctrl-W) through preserve. `releasePreservedPanel(id)` / `listPreservedPanels()` round out the lifecycle. Iframe, canvas, form state intact across close → re-open.
- **Tab overflow** — when the tab count exceeds the strip width, a `⋯` button appears at the right edge. Clicking emits `strip:overflow` with the list of clipped tabs and a screen-space anchor — consumer renders the menu UI.
- **Drag ergonomics** — hover-to-activate during drag (hold over an inactive tab for 500ms), auto-scroll overflowing strips when the drag cursor nears the edges, Escape to cancel.
- **Collapsible rails** — opt-in per rail via `collapsible: true`. `rail.toggleRailCollapsed(railId)` flips `collapsed`. Collapsed rails render as a 32px strip with a restore button; consumers can decorate further via `.rails-rail.rails-collapsed`.
- **Tab badges** — `badge?: string | number` on a tab renders as a pill after the title (styled by default theme). Updated via `updateTab(id, { badge })`.
- Drop zones: reorder, new rail, new stack, append, new float, float titlebar
- Rail and stack splitters with flex preservation
- Panel cache with `onPanelDestroy` cleanup hook (fires for any reactive-framework teardown)
- `renderEmpty()` for the empty workspace state
- `batch(fn)` for bulk mutations
- `updateTab(id, patch)` with chrome-vs-payload classification
- `Escape` cancels any drag (tab, splitter, float drag, float resize)
- Activate-in-place and float-raise-in-place — no chrome rebuild on click
- Per-tab `closeable` / `draggable` flags
- `canCloseTab` / `canMoveTab` / `canCreateFloat` / `canDropOn` hooks
- Serialize / deserialize
- Event subscription (`on`/`off` + shortcut handlers): `tab:move/close/activate/contextmenu`, `float:create/close/move/resize/minimize/maximize/raise`, `layout:change`, `strip:contextmenu`, `float:titlebar:contextmenu`
- ARIA (tablist/tab/tabpanel/dialog) + keyboard nav (arrow keys in strip, Ctrl-Tab/Ctrl-Shift-Tab cycle, Ctrl-W close)
- Touch support: touch-action on interactive elements, setPointerCapture, enlarged drop zones
- Optional theme (`rails-default.css`) — GCU aesthetic, CSS custom properties for overrides

## Docs

- [`SPEC.md`](./SPEC.md) — full design document
- [`INTEGRATION.md`](./INTEGRATION.md) — integration patterns, common migrations, real pitfalls

## License

MIT.
