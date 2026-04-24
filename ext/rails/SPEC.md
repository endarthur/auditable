# SPEC-rails

**Package:** `@gcu/rails`
**Status:** Draft (0.3)
**Role:** Layout engine for docked tab-based workspaces with floating groups.
**Dependencies:** Zero. Uses only DOM, CSS flexbox, pointer events, and `ResizeObserver`.
**Size estimate:** ~7 KB gzipped for library + structural CSS; +2 KB for optional default theme. See §11 — informative, not a hard budget.
**Design stance:** Mechanism, not policy. Rails provides hooks and events; consumers decide behavior.

---

## 1. Motivation

Notebook workspaces, dashboards, and analysis shells need multi-panel layouts with tabs, splits, floats, and drag-to-rearrange. The standard answer is a full docking library (Dockview, GoldenLayout, FlexLayout), which ship ~50 KB gzipped because they implement *freeform* docking: recursive arbitrary splits, drag-to-any-edge-of-any-panel to create a split in that direction, popout windows, rich built-in behaviors for every plausible user workflow.

The vast majority of real notebook workflows do not use arbitrary recursive splits or popout windows. Their layouts are expressible as a fixed, shallow structure: a row of columns, each column a vertical stack of tab groups, optionally with a handful of floating panels for tools and transient views. The expressive power lost by dropping recursion and OS-window popout is negligible; the complexity saved is roughly 10×.

Beyond size, there is a second axis where monolithic libraries bloat: **built-in behaviors**. Dockview decides what minimize means, which tabs can close, what context menus exist, how themes work, how focus propagates. These decisions are reasonable for generic web apps and wrong for almost every specific consumer, leading to either accepting the default or fighting the library. `@gcu/rails` takes the opposite stance: the library exposes hooks and events, and the consumer decides. Minimize fires an event; the consumer turns that into collapse-in-place, dock-strip, tray-icon, or nothing. Closing a tab runs through `canCloseTab`; the consumer vetoes based on dirty state or ownership rules. No baked-in policy means fewer configuration knobs to document, and consumers never have to fight the library to get the behavior they want.

`@gcu/rails` is the library that occupies this design point. It refuses freeform docking and popout windows; it provides rails, stacks, tabs, and in-workspace floating groups; it delegates every behavioral decision to the consumer via hooks; and it fits in under 6 KB.

## 2. Model

### 2.1 Workspace shape

A workspace is a two-level tree of rails/stacks/tabs, plus a flat list of floats:

```
workspace
├── rail[]              (columns, arranged horizontally)
│   └── stack[]         (tab groups, stacked vertically within a rail)
│       └── tab[]       (one active, rest inactive)
└── float[]             (independently-positioned stacks overlaying rails)
    └── stack           (same shape; a float contains exactly one stack)
        └── tab[]
```

No recursion in the rails part. A rail contains stacks, not rails. A stack contains tabs, not stacks. Floats are a separate flat list; a float holds exactly one stack, which in turn holds one or more tabs. Floats render above rails and can be dragged/resized/minimized/maximized independently.

### 2.2 Invariants

1. A stack always contains at least one tab.
2. A rail always contains at least one stack.
3. A float's stack always contains at least one tab (otherwise the float is removed).
4. Exactly one tab per stack is marked `active`.
5. `active` references a tab that exists in the stack.
6. Float `z` values are unique per workspace and determine stacking order (higher `z` renders later/on top).
7. The workspace itself may be empty (`state.rails.length === 0` and `state.floats.length === 0`). This arises naturally when the last tab is closed; invariants 1–6 apply vacuously.

Any operation that would violate these is followed by a cleanup pass that removes empty stacks, rails, and floats, and reselects `active` when needed. Cascade-cleanup to an empty workspace is legal — consumers provide a `renderEmpty()` callback (§5.1) to customize the empty-state affordance (e.g., a "no documents open" placeholder with a "New tab" button).

**State is owned by the library.** Consumers read `state` freely but must not mutate it directly — changes go through the API methods (§5.2) or `deserialize()`. Direct mutation will not trigger re-render and will desync the DOM from state. For bulk changes, use `batch(fn)` (§5.2) or `deserialize()`.

### 2.3 Coordinate spaces

- **Workspace** — bounding rectangle of the host element. All positioning is relative to this.
- **Chrome** — rails, stacks, tab strips, splitters, float frames. Rebuilt on every mutation. Lives in an absolute layer at `inset: 0`.
- **Content** — panels (tab bodies). Lives in a separate absolute layer at `inset: 0`, always on top of chrome but behind interactive overlays. Panels are positioned with `left/top/width/height` derived from the chrome's panel-slot rects — whether those slots belong to a rail-stack or a float. Panels are never reparented.

This separation is the core architectural decision and is non-negotiable. See §4.

## 3. State shape

```ts
type State = {
  rails: Rail[];
  floats: Float[];
};

type Rail = {
  id: string;
  flex: number;           // proportional weight
  width?: number;         // pixel width (overrides flex when present)
  stacks: Stack[];
};

type Stack = {
  id: string;
  flex: number;           // proportional weight
  height?: number;        // pixel height (overrides flex when present)
  tabs: Tab[];
  active: string;         // tab id
  tabPosition?: 'top' | 'bottom';  // overrides construction-time default; see §6.13
};

type Float = {
  id: string;
  stack: Stack;           // same Stack type; flex/height unused
  x: number; y: number;   // top-left in workspace coordinates
  w: number; h: number;
  z: number;              // stacking order among floats
  minimized?: boolean;    // consumer-defined semantics; see §5.6
  maximized?: boolean;    // fills workspace when true; previous bounds preserved elsewhere
};

type Tab = {
  id: string;
  title: string;
  closeable?: boolean;    // default true
  draggable?: boolean;    // default true
  [k: string]: unknown;   // consumer payload (kind, url, doc handle, etc.)
};
```

`Tab` is intentionally open. The library reads `id`, `title`, `closeable`, and `draggable` only. Everything else is consumer-defined and passed through to the panel renderer verbatim.

### 3.1 Sizing

`flex` values are proportional weights. A rail with `flex: 2` is twice as wide as a sibling with `flex: 1`. Splitter drags adjust the two adjacent weights while preserving their sum, so resizing rail *i* does not disturb rails *j ≠ i, i+1*.

`width` (on rails) or `height` (on stacks) can be specified as an alternative for pixel-fixed sizing. When present, the element uses `flex: 0 0 Npx`. Mixing fixed and proportional in the same parent is supported — proportional siblings share the remaining space.

Floats use explicit `x/y/w/h` in workspace coordinates. The library enforces a minimum float size (default 200×120px) but otherwise does not constrain positioning — a float can overhang the workspace edge if the consumer doesn't clamp it.

### 3.2 Per-tab policy flags

The library reads four optional flags on each tab:

- **`closeable`** — default `true`. When `false`, the tab's × affordance is not rendered and click-close is a no-op. `closeTab(id)` called programmatically still closes; the flag is a UI policy, not a data integrity lock. Consumers wanting hard locking should reject via the `canCloseTab` hook.
- **`draggable`** — default `true`. When `false`, pointerdown on the tab does not initiate drag; the tab can still be activated by click. Useful for permanent "home" tabs.
- **`preserveOnClose`** — default `false`. When `true`, UI-driven close (× click, Ctrl-W, float close) routes through `closeTab(id, { preserve: true })` — the tab is removed from state but its panel stays in the cache (hidden) so re-adding with the same ID reuses it. Programmatic `closeTab(id)` is NOT affected by this flag; callers must pass `{ preserve: true }` explicitly for programmatic preserve. Useful for inspectors, sidebars, devtools — anything whose mounted state matters across close/reopen.
- **`badge`** — optional string or number. When set, renders as a pill after the title. Chrome-visible: changes trigger a strip rebuild via `updateTab(id, { badge })`.

Rails themselves also have two optional UI flags:

- **`collapsible`** — opt-in per rail. When `true`, a collapse button (◀) is rendered on the rail; clicking it flips `collapsed`.
- **`collapsed`** — current state. Collapsed rails render as a 32px icon strip with an expand button (▶); their stacks and slots aren't rendered and their tabs' panels go to `display: none`. Consumers can decorate the collapsed state via the `.rails-collapsed` class.

These are intentionally coarse. Finer-grained policy (can-move-to-specific-stack, can-close-when-dirty) flows through hooks (§5.4), not flags.

### 3.3 Serialization

`State` is plain JSON. `JSON.stringify(state)` round-trips losslessly if consumer-added fields on `Tab` are JSON-serializable. A `serialize(replacer?)` method is provided; consumers embedding non-serializable handles (e.g., open notebook doc references) should pass a replacer that emits `{$ref: ...}` placeholders and rehydrate on `deserialize`.

## 4. Architecture

### 4.1 Layered rendering

```
host
├── .rails-chrome                 (absolute, inset: 0)
│   ├── .rails-rails               — rail/stack layout
│   │   └── .rails-rail[] > .rails-stack[] > (.rails-strip, .rails-slot)
│   └── .rails-floats              — float frames (drawn above rails)
│       └── .rails-float[] > (.rails-titlebar, .rails-strip, .rails-slot, .rails-resize-handle[])
└── .rails-content                (absolute, inset: 0, pointer-events: none)
    └── .rails-panel[]             — absolute, positioned to match slots from either chrome sub-layer
```

On mutation, chrome is rebuilt from scratch. Content panel elements are created once per tab (lazily) and thereafter positioned via `style.left/top/width/height`. **Panels are never moved in the DOM tree.** A panel belonging to a float vs a rail-stack is the same panel element; only its target slot changes.

### 4.2 Why panels are never reparented

When a DOM node is moved via `appendChild` to a new parent:
- `<iframe>` reloads its document in every browser except Chrome with `moveBefore()`.
- `<video>` and `<audio>` pause and lose playback position.
- Focused form elements lose focus.
- Some component libraries reinitialize on mount/unmount.

By keeping panels in a flat layer and repositioning them numerically, these all survive every drag, split, move, workspace resize, tear-off into a float, and redock back into a rail. This is the property that makes rails suitable as the base layer for a real workspace.

### 4.3 ResizeObserver

A single `ResizeObserver` observes the host element. On any size change — window resize, host element flex recalculation, external style change — the observer fires `reposition()`, which reads every panel-slot rect (across rails and floats) and updates the corresponding panel's position. This is the sole mechanism keeping the two layers in sync; no explicit resize event plumbing is required.

### 4.4 Drag scrim

During an active drag (tab drag, splitter drag, float drag, float resize), a transparent `position: absolute; inset: 0` div is inserted into the host above the content layer. It guarantees pointer events reach the document's move/up listeners regardless of what sits beneath — including sandboxed iframes, `<canvas>`, and anything else that could capture gestures internally. The scrim is removed at drag end.

### 4.5 Float z-ordering

Floats stack via `style.zIndex = float.z`, not DOM order. Pointerdown on any part of a float's chrome (titlebar, strip, resize handle) raises that float to `max(z) + 1` by updating `state.floats[i].z` and writing `zIndex` on the single float element — no DOM children reorder, no chrome rebuild. Floats do not affect the z-order of rails; the entire `.rails-floats` sublayer sits above `.rails-rails` in DOM order, so any float is always drawn above any rail regardless of its `z`.

### 4.6 Structural rebuild vs in-place update

Mutations fall into two categories. The library never rebuilds more than needed.

**Structural rebuild** — chrome DOM is torn down and reconstructed from state:
- Add or close tab
- Move tab between stacks (including tear-off and redock)
- Create or destroy float
- Change a stack's `tabPosition`
- `updateTab` when a chrome-visible field changed (`title`, `closeable`, `draggable`, icon-backing fields)

**In-place update** — DOM elements persist; only styles or classes change:
- Splitter drag (updates `flex` / `width` / `height` on existing rail/stack elements, then `reposition()`)
- Float drag (updates `style.left/top` on the float element, then `reposition()` for its panel)
- Float resize (updates `style.width/height`, and `left/top` for N/W handles)
- Float raise (updates `style.zIndex` to `float.z`; §4.5)
- Maximize toggle (updates float element `style.left/top/width/height`)
- **Activate tab** (swaps `.rails-active` class in the strip; swaps `display` visibility among the stack's cached panels via `reposition()`)
- `updateTab` when only non-chrome-visible fields changed (consumer payload only)

The raise-by-zIndex scheme makes pointerdown on any float O(1): update `state.floats[i].z = max + 1`, set `style.zIndex` on that one element. With 50 floats on screen, pointerdown-to-paint is a single style write.

Activate-as-in-place is similarly cheap — clicking between tabs in a stack is a class swap plus a panel visibility toggle, not a full rebuild. The panel being activated is already positioned correctly in the content layer from the last `reposition`, so no layout work is needed either.

Consumers can coalesce many mutations into a single structural rebuild via `batch(fn)` (§5.2).

## 5. API

### 5.1 Construction

```js
const rails = createRails(hostElement, {
  initialState,           // State object (optional; defaults to empty workspace)
  renderPanel(tab),       // required — returns HTMLElement for the tab
  renderEmpty(),          // optional — returns HTMLElement shown when state.rails is empty
  onPanelDestroy(tab, el),// optional — called just before a panel element is removed

  // Optional hooks (see §5.4)
  canCloseTab(tab),       // default: () => true
  canMoveTab(tab, from, to),
  canCreateFloat(tab, at),
  canDropOn(zone, tab),   // veto a drop zone during drag

  // Optional event handlers (shortcut for rails.on(...))
  onChange(state),
  onFloatMinimize({ float }),
  onFloatMaximize({ float }),
  // ...other events

  // Optional behavior config
  minFloatSize: { w: 200, h: 120 },
  dragThreshold: 4,       // px
  tabPosition: 'top',     // 'top' | 'bottom' — default 'top'; overridable per-stack via Stack.tabPosition
  dropZones: {            // enable/disable drop zone categories (all default true)
    'tab-insert': true,
    'tab-append-strip': true,
    'tab-append-body': true,
    'new-rail': true,
    'new-stack': true,
    'new-float': true,
    'float-titlebar': true
  }
});
```

### 5.2 Returned object

```ts
{
  state: State;                 // read-only — do not mutate directly (see §2.2)
  render(): void;               // force a chrome rebuild
  serialize(replacer?): string;
  deserialize(str): void;       // replace state, fire onPanelDestroy for evicted tabs
  destroy(): void;              // tear down observers, listeners, DOM; fires onPanelDestroy for every live tab

  // Batching
  batch(fn): void;              // defers render until fn returns; N mutations → 1 rebuild

  // Tab operations
  addTab(tab, target?): void;   // target: MoveTarget (see below); default: first stack (creates one if empty)
  closeTab(tabId, opts?): void; // opts.preserve keeps panel cached + hidden; re-addTab(sameId) reuses it
  activateTab(tabId): void;
  moveTab(tabId, target): void; // target: MoveTarget
  updateTab(tabId, patch): void;// merge-patch tab fields; chrome rebuild only if chrome-visible field changed (§4.6)

  // Preserved-panel lifecycle
  releasePreservedPanel(tabId): void;     // force-destroy a preserved panel (fires onPanelDestroy)
  listPreservedPanels(): Array<{ id: string, tab: Tab }>;  // audit preserved panels

  // Rail collapse
  toggleRailCollapsed(railId): void;      // flips rail.collapsed; emits rail:collapse / rail:expand

  // Float operations
  floatTab(tabId, bounds?): void;         // tear off into a new float
  redockTab(tabId, target): void;         // inverse of floatTab; target: MoveTarget
  setFloatBounds(floatId, bounds): void;
  raiseFloat(floatId): void;              // bring to top of z-order (in-place, O(1))
  toggleFloatMinimized(floatId): void;    // flips state.floats[i].minimized, emits event
  toggleFloatMaximized(floatId): void;    // flips state.floats[i].maximized, emits event

  // Event subscription
  on(event, handler): () => void;         // returns unsubscribe fn
  off(event, handler): void;
}

type MoveTarget =
  | { to: 'stack',     stackId: string, at?: number }   // insert at index (default: append)
  | { to: 'float',     floatId: string, at?: number }
  | { to: 'new-rail',  at: number }                     // rail index (0 = leftmost)
  | { to: 'new-stack', railId: string, at: number }     // stack index within rail
  | { to: 'new-float', x: number, y: number, w?: number, h?: number };
```

`batch(fn)` executes `fn` synchronously with render deferred. The deferred render fires once after `fn` returns, covering every mutation made inside. Useful for session-restore, bulk tab creation, programmatic layout changes. Nested `batch` calls collapse — only the outermost triggers a render. Exceptions inside `fn` still trigger the final render so state and DOM stay consistent.

### 5.3 The `renderPanel` contract

Receives a `Tab`, returns an `HTMLElement`. Called at most once per tab id; the returned element is cached and reused across all subsequent layout changes, including moves between rail-stacks, between floats, and between rails and floats.

```js
renderPanel(tab) {
  switch (tab.kind) {
    case 'notebook': return auditable.mount(tab.doc);
    case 'plot':     return gcuPlot(tab.data);
    case 'iframe':   { const f = document.createElement('iframe'); f.src = tab.url; return f; }
    default:         return defaultFallback(tab);
  }
}
```

The returned element may be anything — a plain `<div>`, an iframe, a canvas, a Shadow DOM root, a Web Component. The library makes no assumptions about its contents.

### 5.3.1 Panel lifecycle

Panel elements are created lazily on first activation and cached for the tab's lifetime. Eviction happens when:

- **Tab close** — the tab is removed from state (via `closeTab`, cascade-cleanup after move, etc.). The panel element is removed from the DOM.
- **`deserialize()`** — state is replaced; panels whose tab ids no longer exist are evicted.
- **`destroy()`** — the entire rails instance is torn down; every cached panel is evicted.

Before eviction, if the consumer provided `onPanelDestroy(tab, element)`, it is called with the soon-to-be-removed panel. This is the hook for disposing resource-holding elements — WebGL/Audio contexts, WebSockets, `setInterval` handles, media elements, MutationObservers. Without this hook a consumer using such resources will leak on tab close.

```js
createRails(host, {
  renderPanel(tab) {
    const canvas = document.createElement('canvas');
    canvas._gl = canvas.getContext('webgl2');
    canvas._ws = new WebSocket(tab.stream);
    return canvas;
  },
  onPanelDestroy(tab, el) {
    el._ws?.close();
    el._gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
});
```

`onPanelDestroy` runs synchronously. Moves (between stacks, into/out of floats) do **not** destroy panels — that's the point of §4.2. Destruction is reserved for the eviction paths listed above. If the consumer needs async cleanup (flush buffers, confirm close), gate it via `canCloseTab` instead — that hook vetoes close entirely, preventing destruction.

`onPanelDestroy` is also the natural cleanup point for any reactive framework mounted inside a panel — sideact effects, React effect cleanups, Svelte `onDestroy`, Vue `onUnmounted`, signals disposers. Rails has no opinion about what's inside a panel; the destroy hook is the one place a consumer is guaranteed a chance to run framework-specific teardown before the element leaves the DOM.

```js
// Sideact panel: collect disposers, run them on destroy.
renderPanel(tab) {
  const el = document.createElement('div');
  const dispose = sr.render(sr.h`<div>${tab.data}</div>`, el);
  el._dispose = dispose;
  return el;
},
onPanelDestroy(tab, el) {
  el._dispose?.();
}
```

Panel elements are **never** recreated for the same tab id. If a consumer needs to force re-render (tab data changed materially), they must `closeTab(id)` + `addTab(newTab)` with a new id, or deserialize.

### 5.3.2 Tab metadata updates

`updateTab(tabId, patch)` merge-patches fields on a tab. The library classifies each changed field:

- **Chrome-visible** (`title`, `closeable`, `draggable`, plus any field the default theme reads) — triggers a structural rebuild of the affected stack's strip. Panel layer untouched.
- **Non-chrome-visible** (consumer payload: `kind`, `doc`, `url`, etc.) — state is updated; no re-render. Consumer is responsible for whatever side-effect the data change implies (e.g., reload inside the panel).

```js
// Rename: chrome rebuild, panel preserved.
rails.updateTab('t42', { title: 'scratch.saved.txt' });

// Update consumer payload: no re-render, panel stays mounted.
rails.updateTab('t42', { doc: newDocHandle });
```

### 5.4 Hooks

Hooks are synchronous functions returning a boolean. They run before the corresponding mutation and can cancel it.

| Hook | Signature | Purpose |
|------|-----------|---------|
| `canCloseTab` | `(tab) => boolean` | Veto tab close. Default: `true`. |
| `canMoveTab` | `(tab, from, to) => boolean` | Veto tab move. `from` and `to` are target descriptors. Default: `true`. |
| `canCreateFloat` | `(tab, at) => boolean` | Veto tear-off into a float. Default: `true`. |
| `canDropOn` | `(zone, tab) => boolean` | Filter drop zones at drag start. `zone: { type, stackId?, railId?, floatId?, at? }`. Default: `true`. Vetoed zones are not computed into hit-testing and do not highlight, giving immediate visual feedback to the user. |

Consumers use hooks for policy that depends on runtime state — "can't close if dirty," "this tab cannot leave this rail," "no floats in the sidebar zone." Hooks are the right place for this logic because they run synchronously during the interaction and cleanly block it.

`canDropOn` runs once per potential zone at drag start, not per pointermove — cheap. It's the preferred way to prevent moves because vetoing *before* the drop (zone hidden) feels correct; vetoing *at* the drop (via `canMoveTab`) looks like a bug to the user. Use `canMoveTab` only for programmatic-move protection that must apply regardless of UI path.

### 5.5 Events

Events fire *after* the corresponding mutation and are for notification, not control. Handlers registered via `rails.on(event, handler)` receive an object whose fields depend on the event.

| Event | Payload | Fires when |
|-------|---------|------------|
| `tab:move` | `{ tab, from, to }` | A tab is moved (reorder, cross-stack, cross-float, tear-off, redock) |
| `tab:close` | `{ tab, from }` | A tab is closed |
| `tab:activate` | `{ tab, stack }` | A tab becomes active in its stack |
| `tab:contextmenu` | `{ tab, stack, x, y }` | Right-click on a tab header |
| `strip:contextmenu` | `{ stack, x, y }` | Right-click on a tab strip (not on a tab) |
| `float:create` | `{ float, tab }` | A new float is created (from tear-off or `floatTab`) |
| `float:close` | `{ float }` | A float is removed (last tab left, or explicit close) |
| `float:move` | `{ float, from, to }` | A float's position changes |
| `float:resize` | `{ float, from, to }` | A float's size changes |
| `float:minimize` | `{ float }` | `toggleFloatMinimized` was called. **Library does not change float rendering — the consumer decides what minimized means.** |
| `float:maximize` | `{ float, from }` | `toggleFloatMaximized` was called. Library *does* resize the float to workspace bounds and preserves `from` for restore. |
| `float:raise` | `{ float }` | A float was brought to top of z-order |
| `float:titlebar:contextmenu` | `{ float, x, y }` | Right-click on a float titlebar |
| `layout:change` | `{ state }` | Any mutation (debounced). Useful for autosave. |

### 5.6 Mechanism, not policy

The library's design is that mechanisms (render, position, detect drag, compute drop zones, fire events, expose state) are in the library; behaviors (what minimize means, whether unsaved tabs can close, what context menus exist, which keyboard shortcuts do what) are in the consumer.

This means:

- **Minimize does nothing by default.** Clicking the minimize button on a float emits `float:minimize`. If the consumer does not handle it, nothing happens. A GCU shell might handle it by collapsing the float to its titlebar; another consumer might move the float to a dock strip; a third might hide it and add an entry to a command palette. The library has no opinion.
- **Close has a default (remove) but is vetoable.** The common case is that closing a tab means removing it, so the library ships that default. The `canCloseTab` hook vetoes. Keeps 90% of consumers working out of the box while still giving power users full control.
- **Maximize has a default (fill workspace) and is not vetoable.** This is the one place the library takes a position: maximize is universally "make this as big as possible," and the meaning is obvious enough that a hook would be overkill. Consumers who want non-maximize behavior can listen for `float:maximize` and call `setFloatBounds` to undo or modify.

The distinction between "library acts + emits event" (maximize, close) and "library only emits event" (minimize) is case-by-case. The guiding heuristic: if there is one obviously right behavior that nobody would override, the library does it; if the right behavior depends on the consumer's shell, the library emits and steps back.

## 6. Interactions

### 6.1 Drop zones

Computed at drag start from the current layout.

| Type | Shape | Effect on drop |
|------|-------|----------------|
| `new-rail` | 18px-wide vertical strip between rails and at outer left/right edges | Create new rail with one stack containing the dragged tab |
| `new-stack` | 18px-tall horizontal strip between stacks in a rail, and at rail top/bottom edges | Create new stack in that rail with the dragged tab |
| `tab-insert` | 6px-wide vertical strip at each tab's leading edge in any strip (rail-stack or float), plus trailing edge | Insert the tab at that index in that stack |
| `tab-append` (strip) | The whole tab strip | Append tab to that stack |
| `tab-append` (body) | The whole panel body area, lowest priority | Append tab to that stack |
| `new-float` | Everywhere inside the workspace not covered by a higher-priority zone | Create new float at cursor position with the dragged tab |
| `float-titlebar` | The titlebar of each existing float | Append tab to that float's stack |

### 6.2 Precedence

When the cursor is inside multiple overlapping zones, the smallest-area zone wins, except:
- `tab-append` on the body is demoted by a large penalty.
- `new-float` is demoted below every rails zone so it only activates in genuinely empty workspace areas.
- Within a float, `float-titlebar` wins over `new-float`.

This produces the expected behavior: precise inserts near tab edges, gap-creation near splitters, titlebar-drop for joining an existing float, append elsewhere on rails, and new-float only when the cursor is in unclaimed workspace space.

### 6.3 Splitter resize

- **Rail splitter** — 6px-wide vertical handle between two rails. Drag adjusts adjacent rail `flex` (or `width`) values preserving their sum.
- **Stack splitter** — 6px-tall horizontal handle between two stacks in the same rail.
- Minimums: 140px rail width, 100px stack height. Clamped.

### 6.4 Close tab

Click on the `×` affordance. If `tab.closeable === false`, no × is rendered and click-close is a no-op. If the `canCloseTab` hook returns `false`, the close is cancelled. Otherwise: remove the tab; if it was active and the stack is non-empty, the tab to its left becomes active; cascade-cleanup removes empty stacks, rails, and floats.

### 6.5 Activate tab

Click (no drag threshold crossed) on a tab header sets that tab as active in its stack and raises the containing float (if any) to top of z-order. Activate is an in-place update (§4.6): the strip's `.rails-active` class moves, panel visibility toggles, no chrome rebuild — clicking between tabs is a two-attribute write.

### 6.6 Drag threshold

A pointerdown on a draggable tab followed by pointermove exceeding 4px (Manhattan distance, configurable) initiates a drag. Below threshold, pointerup is treated as a click (activate). Tabs with `draggable === false` never initiate drag.

### 6.7 Float drag

Pointerdown on a float's titlebar, pointermove updates `x/y`, pointerup commits. Scrim captures events. If the drag ends over a rails drop zone, the float's last tab is redocked instead — the float is destroyed and its tabs are inserted at the drop target. Otherwise the float stays a float at the new position.

### 6.8 Float resize

Eight resize handles: 4 edges (6px thick), 4 corners (12×12px overlapping the edges). Cursors: `ns-resize`, `ew-resize`, `nwse-resize`, `nesw-resize`. Drag updates `w/h` (and `x/y` for top/left edges). Minimum size enforced per `minFloatSize`.

### 6.9 Float minimize / maximize / close

Titlebar buttons emit the corresponding events. Maximize is handled by the library (resize to workspace bounds, preserve previous bounds in float state); minimize is consumer-driven (§5.6); close removes the float and its tabs (subject to `canCloseTab` for each).

### 6.10 Tear off

Dragging a tab into the `new-float` zone creates a float at the cursor position with sensible default size (configurable; defaults to 400×300). Alternatively: right-click → "Float tab" or a consumer-wired keyboard shortcut calling `floatTab(id)`.

### 6.11 Redock

Dragging a float's titlebar onto any rails drop zone destroys the float and inserts its tabs into the drop target. This is the same drop-zone machinery used for regular tab drags; the library does not distinguish "dragging a tab from a stack" from "dragging a float's titlebar" at the drop target level.

### 6.12 Drop zone filtering

Two mechanisms, both evaluated at drag start:

- **`dropZones` option** (static, per-category). An object keyed by zone type with boolean values. Any type set to `false` is omitted from the computed zone list for every drag. Useful for app-wide policies: disable `tab-append-body` to make `new-float` easier to trigger; disable `new-rail`/`new-stack` for a fixed-structure app; disable `new-float` for a no-floats app.
- **`canDropOn(zone, tab)` hook** (dynamic, per-zone-per-drag). Called once per candidate zone with the specific zone and the tab being dragged. Returning `false` omits that zone. Runtime-dependent policy goes here: "this tab cannot leave its rail," "only leaf tabs can create new rails," "controls tabs cannot float."

The static config is equivalent to `canDropOn(z) => dropZones[z.type] !== false`; the hook runs in addition. Both must pass for a zone to be considered.

**Interaction with drag initiation.** If *every* candidate zone is filtered out for the dragged tab, drag still initiates and the ghost still follows the cursor, but no zone highlights and pointerup snaps the tab back to its origin. This matches desktop-window behavior where picking something up and putting it down without moving it is a no-op, not an error. If the consumer wants to prevent the drag from initiating at all, use `draggable: false` on the tab.

### 6.13 Tab position

Tabs render above the panel (`tabPosition: 'top'`, default) or below it (`tabPosition: 'bottom'`). Set via the construction option as an app-wide default, overridable per-stack via `Stack.tabPosition`.

Affects only the rendering order inside a stack: strip-then-slot vs slot-then-strip. Drop zone math adjusts automatically (the `tab-insert` zones are still computed from the strip's bounding rect, wherever the strip lives). Floats default to `top` regardless and do not support bottom-tabs — a float's titlebar is already "above the content" and putting tabs below the content in a float would orphan them from the drag handle.

Practical use: bottom tabs for terminal-style stacks ("Terminal 1 / Output / Problems" below the shell panel), top tabs for document-style stacks. Named because this is the specific pattern VSCode, tmux, and most IDEs use — and users expect it.

### 6.14 Drag cancel

Pressing `Escape` during any active drag (tab drag, splitter drag, float drag, float resize) cancels it. The ghost, drop zones, and scrim are torn down and state is not mutated: splitter drag reverts by simply not applying the pending flex change; float drag/resize restore the pre-drag `x/y/w/h` snapshot captured at drag start. The subsequent pointerup is ignored.

This is a universal desktop affordance — every drag is Escape-cancellable; users will try it, and its absence reads as broken.

## 7. Styling

The library ships two stylesheets:

- **`rails.css`** — structural CSS only. Mandatory. Covers layout, overflow, pointer-events, transitions, positioning. Contains no colors, fonts, or decorative properties. The library does not function correctly without it.
- **`rails-default.css`** — opinionated default theme. Optional. Provides a GCU-aesthetic default so consumers can drop in the library and have it look reasonable immediately. Consumers can skip it entirely, import it and override via class specificity, or import it and wrap in a scope.

**Panel transitions are structural, not decorative.** `rails.css` transitions `.rails-panel` `left/top/width/height` (140ms ease) so panels slide between positions when the layout changes. During active drags the `.rails-dragging` class disables transitions for a direct 1:1 cursor response. This behavior is part of the library's identity — consumers who want it off do `.rails-panel { transition: none !important; }` in their own CSS.

### 7.1 Exposed classes

| Class | Role |
|-------|------|
| `.rails-root` | Host element (added automatically) |
| `.rails-chrome`, `.rails-rails`, `.rails-floats`, `.rails-content` | Layer containers |
| `.rails-rail`, `.rails-stack`, `.rails-strip`, `.rails-slot` | Rails-side layout |
| `.rails-stack.rails-tabs-bottom` | Stack with tabs rendered below the panel |
| `.rails-tab` | A tab header |
| `.rails-tab.rails-active` | The active tab in its stack |
| `.rails-tab.rails-pinned-closed` | A tab with `closeable: false` (for styling the absent ×) |
| `.rails-tab.rails-locked` | A tab with `draggable: false` |
| `.rails-x` | The close affordance (absent when `closeable: false`) |
| `.rails-panel` | A panel (in content layer) |
| `.rails-panel.rails-dragging` | Active during any drag |
| `.rails-rail-split`, `.rails-stack-split` | Rail/stack splitter handles |
| `.rails-float` | A float frame |
| `.rails-float.rails-minimized` | A float whose state has `minimized: true` (library adds the class; visual effect is consumer CSS) |
| `.rails-float.rails-maximized` | A float whose state has `maximized: true` |
| `.rails-float.rails-topmost` | The highest-z float |
| `.rails-titlebar` | Float titlebar (drag handle + buttons) |
| `.rails-titlebar-buttons` | Button container (minimize, maximize, close) |
| `.rails-btn-minimize`, `.rails-btn-maximize`, `.rails-btn-close` | Titlebar buttons |
| `.rails-resize-handle` | Float resize handle |
| `.rails-resize-handle-n`, `-s`, `-e`, `-w`, `-ne`, `-nw`, `-se`, `-sw` | Edge/corner variants |
| `.rails-ghost` | Drag ghost following the cursor |
| `.rails-zone` | Drop zone overlay |
| `.rails-zone.rails-active` | Currently highlighted drop zone |
| `.rails-zone.rails-zone-insert` | The narrow between-tabs variant |

### 7.2 The defaults sheet

`rails-default.css` ships:
- Cool-neutral surface palette (configurable via CSS custom properties: `--rails-bg`, `--rails-chrome`, `--rails-border`, `--rails-accent`, etc.)
- Monospace font stack defaulting to Space Mono fallbacks
- Subtle drop shadows on floats
- Animated drop-zone highlights
- Tab hover/active states
- Default titlebar button icons as inline SVG

Consumers can override any of it. All colors are CSS custom properties at `:root`; changing the palette is a handful of `--rails-*` overrides. Font stack is a single `--rails-font-mono` override.

## 8. Examples

### 8.1 Minimal tabbed container

Single rail, single stack, N tabs. Degenerate case — common for settings panels.

```js
const rails = createRails(host, {
  initialState: {
    rails: [{ id: 'r1', flex: 1, stacks: [{
      id: 's1', flex: 1, active: 'general',
      tabs: [
        { id: 'general', title: 'General' },
        { id: 'appearance', title: 'Appearance' },
        { id: 'keybindings', title: 'Keybindings' }
      ]
    }] }],
    floats: []
  },
  renderPanel(tab) {
    const el = document.createElement('div');
    el.innerHTML = settingsMarkupFor(tab.id);
    return el;
  }
});
```

If you want to prevent users from creating rails/stacks/floats in this simple container, veto via hooks:

```js
createRails(host, {
  // ...
  canMoveTab(tab, from, to) { return to.stackId === 's1'; },  // only within-stack reorder
  canCreateFloat: () => false
});
```

### 8.2 Auditable Works notebook workspace

Multiple notebooks open in rails and floats, with dirty-tab close protection and layout autosave.

```js
const rails = createRails(host, {
  initialState: await loadLayout() ?? defaultLayout(),
  renderPanel(tab) {
    switch (tab.kind) {
      case 'notebook':  return Auditable.mount({ doc: tab.doc, readOnly: false });
      case 'preview':   return Auditable.mount({ doc: tab.doc, readOnly: true });
      case 'inspector': return new Inspector({ target: tab.target }).mount();
      case 'glass':     return Glass.open(tab.ref);
    }
  },
  canCloseTab(tab) {
    if (tab.kind === 'notebook' && tab.doc.dirty) {
      return confirm(`${tab.title} has unsaved changes. Close anyway?`);
    }
    return true;
  },
  onChange(state) {
    debouncedSave(rails.serialize((key, value) => {
      if (key === 'doc' && value) return { $ref: value.id };
      if (key === 'target' && value) return { $ref: value.id };
      return value;
    }));
  }
});

// Consumer decides what minimize means — here: collapse to titlebar in place via CSS.
// The library has already toggled state.floats[i].minimized and added .rails-minimized;
// consumer CSS below handles the visual collapse.
```

```css
.rails-float.rails-minimized .rails-strip,
.rails-float.rails-minimized .rails-slot,
.rails-float.rails-minimized .rails-resize-handle {
  display: none;
}
.rails-float.rails-minimized { height: auto !important; }
```

### 8.3 Arborist-style analysis layout with permanent controls

Fixed-width controls rail that cannot be reorganized; proportional visualization rail that can. Inspector windows are floats.

```js
const rails = createRails(host, {
  initialState: {
    rails: [
      { id: 'controls', width: 280, stacks: [{
        id: 'cs', flex: 1, active: 'tree',
        tabs: [
          { id: 'tree', title: 'tree.ctl', kind: 'tree-controls', draggable: false, closeable: false },
          { id: 'cv',   title: 'cv.ctl',   kind: 'cv-config',     draggable: false, closeable: false }
        ]
      }] },
      { id: 'viz', flex: 1, stacks: [
        { id: 'vs1', flex: 1.5, tabs: [{ id: 'scatter', title: 'scatter', kind: 'plot-scatter' }], active: 'scatter' },
        { id: 'vs2', flex: 1,   tabs: [{ id: 'cm', title: 'confusion', kind: 'plot-cm' }],         active: 'cm' }
      ] }
    ],
    floats: []
  },
  canMoveTab(tab, from, to) {
    // controls tabs never leave their stack; other tabs never enter it
    if (from.stackId === 'cs') return to.stackId === 'cs';
    if (to.stackId === 'cs') return false;
    return true;
  },
  renderPanel: renderArboristPanel
});

// A right-click "Inspect" action tears off an inspector into a float.
document.addEventListener('arborist:inspect', (e) => {
  rails.addTab({
    id: `insp-${e.detail.id}`,
    title: `inspect: ${e.detail.id}`,
    kind: 'inspector',
    target: e.detail
  });
  rails.floatTab(`insp-${e.detail.id}`, { x: 100, y: 100, w: 400, h: 300 });
});
```

### 8.4 Shell with fixed-width sidebars (IDE pattern)

Three rails: file explorer (240px), main editor area with a terminal stack below it (proportional), inspector (300px).

```js
const initialState = {
  rails: [
    { id: 'sidebar', width: 240, stacks: [
      { id: 'files', flex: 1, tabs: fileExplorerTabs, active: 'fe' }
    ] },
    { id: 'main', flex: 1, stacks: [
      { id: 'editors',  flex: 2, tabs: openFiles, active: openFiles[0]?.id },
      { id: 'terminal', flex: 1, tabs: terminals, active: terminals[0]?.id,
        tabPosition: 'bottom' }  // VSCode-style: Terminal / Output / Problems below the shell
    ] },
    { id: 'inspector', width: 300, stacks: [
      { id: 'insp', flex: 1, tabs: inspectorTabs, active: 'props' }
    ] }
  ],
  floats: []
};
```

Note the limitation: this cannot express "terminal spans under both sidebar and main but not under inspector" — that's the VSCode terminal layout, which requires asymmetric splits (§9). Either accept that the terminal is scoped to the main rail, or lift to Dockview.

### 8.5 Float-first app with disabled body drops

A desktop-heritage shell where floats are the primary organizing metaphor. Dragging a tab out of a strip should create a float immediately unless the user aims at another strip or an inter-rail/inter-stack gap. Disable body drops to keep the workspace "open" for new-float creation.

```js
const rails = createRails(host, {
  initialState,
  renderPanel,
  dropZones: {
    'tab-append-body': false   // dragging onto a panel's body area does nothing;
                                // new-float takes that space instead
  }
});
```

Combine with per-tab policy if some tabs should never float:

```js
createRails(host, {
  // ...
  canDropOn(zone, tab) {
    if (zone.type === 'new-float' && tab.kind === 'system-log') return false;
    return true;
  }
});
```

Result: the system-log tab can be reordered and moved between stacks/rails but refuses to become a float; every other tab floats on any drop that isn't a strip or gap.

## 9. Non-goals

The following are **deliberately excluded**. Each entry names the alternative pattern for the use case it covers.

- **Freeform recursive docking.** Use Dockview if you need this.
- **Asymmetric splits.** A panel cannot span two rails.
- **Popout to real OS windows.** Use named workspaces (§10.3) for "I want this on another monitor" semantics. Real popout requires cross-window state coordination outside the scope of a layout library.
- **Modals, dialogs, confirmations.** Use the native `<dialog>` element. Consider a thin `@gcu/modal` wrapper if you want GCU-consistent styling.
- **Popovers, dropdowns, menus.** Use the native `popover` attribute and CSS anchor-positioning. Context menus on tab right-click are a rails concern only to the extent of emitting a `tab:contextmenu` event; the menu UI itself is consumer.
- **Sliding edge drawers.** Use a sibling `@gcu/drawer` library. Drawers are not documents arranged in space; they are edge-docked tool panels, a different concern.
- **Toasts, notifications.** Consumer concern. Typically their own overlay layer with their own animation logic.
- **Command palette, status bar, menu bar.** Shell-level concerns.
- **Theming as a framework.** Library exposes CSS custom properties and class hooks; the optional default theme uses them. Anything richer (theme switcher, runtime palette editing) is consumer territory.
- **Routing.** Consumer decides how tab state maps to URLs, if at all.
- **Tab pinning** as a built-in behavior. `draggable: false` + `closeable: false` covers the functional case; "pinning" as a visual pattern is consumer CSS.
- **Built-in minimize behavior.** Library emits `float:minimize`; consumer decides semantics (§5.6).

## 10. Roadmap

### 10.1 Short-term (required for 1.0)

- **Floats.** State, rendering, titlebar drag, edge/corner resize, tear-off drop zone, redock via existing drop zones, z-ordering via `style.zIndex` (§4.5), maximize/restore, minimize event emission, close.
- **Hooks.** `canCloseTab`, `canMoveTab`, `canCreateFloat`, `canDropOn`, plus the event surface described in §5.5.
- **Panel lifecycle.** `onPanelDestroy` called on every eviction path (close, deserialize, destroy).
- **Empty workspace.** Legal state; `renderEmpty()` callback for consumer placeholder.
- **Batching.** `batch(fn)` defers render; covers bulk session-restore and programmatic layout changes.
- **Tab metadata updates.** `updateTab(tabId, patch)` with chrome-only re-render when a chrome-visible field changed (§5.3.2).
- **Per-tab policy flags.** `closeable`, `draggable` read and respected in render + interaction.
- **Drop zone filtering.** `dropZones` config object for per-category enable/disable. Implementation is a predicate filter applied during zone computation; boolean config is sugar over it.
- **Tab position.** `tabPosition: 'top' | 'bottom'` as construction default and per-stack override. Affects only render order of strip vs slot inside a stack.
- **Fixed-width rails / fixed-height stacks.** `width`/`height` as alternatives to `flex`.
- **Drag cancel.** `Escape` cancels any active drag (§6.14).
- **In-place activate.** Clicking between tabs in a stack is a class swap + visibility toggle, not a chrome rebuild (§4.6).
- **In-place raise.** Float raise is a single `zIndex` write (§4.5).
- **Touch sizing.** Drop zones widen to ~20–40px when `pointerType === 'touch'`. `touch-action: none` and `-webkit-touch-callout: none` on tabs, splitters, titlebars, resize handles only — never the workspace root or panels. `setPointerCapture` on dragged elements. Long-press (~300ms) before drag on touch.
- **Keyboard navigation.** Arrow keys navigate tabs within a strip. `Ctrl-Tab`/`Ctrl-Shift-Tab` cycle tabs in active stack. `Ctrl-W` closes active tab (subject to `canCloseTab`). `Ctrl-Enter` cycles active stack across rails. Focus rings.
- **ARIA roles.** `role="tablist"` on strips, `role="tab"` on tabs, `role="tabpanel"` on panels where feasible, `role="dialog"` on floats. `aria-selected`, `aria-controls`, `aria-labelledby`.
- **Context menu events.** Right-click emits `tab:contextmenu`, `strip:contextmenu`, `float:titlebar:contextmenu`. Actual menu UI is consumer (using `popover` or `<dialog>`).
- **Default theme.** `rails-default.css` with GCU-aesthetic defaults and CSS custom properties.

### 10.2 Medium-term (1.x)

- **Tab overflow affordance.** When tab count exceeds strip width, a dropdown at the right edge lists overflow tabs.
- **Scroll-during-drag.** Drag near edge of an overflowing strip → scroll the strip. Same for scrollable panel content under a dragged tab.
- **Auto-activate on hover during drag.** Hold over an inactive tab for ~500ms while dragging → that tab becomes active.
- **Snap-to-preset layouts.** Named layout templates the consumer can register and snap to, preserving tabs across snaps.
- **Collapsible rails.** A rail can collapse to a thin icon-only strip. Opt-in per rail.
- **Drag-and-drop from outside.** Consumer-registered handler for external drops (OS file drag, etc.).
- **Float docking hints.** When a float is dragged near a workspace edge, show a preview of "drop here to dock as a new rail." Visual only; underlying mechanism is redock, which already exists.

### 10.3 Long-term (2.x or later, subject to demand)

- **Named workspaces.** Multiple saved layouts, switchable via palette. Each workspace is its own `State`. The rails answer to "popout" — switch workspaces instead of tearing off to another monitor.
- **Split-view of one buffer.** Two stacks render independent views over the same underlying document. Requires `renderPanel` to produce multiple live views per tab, which is a consumer capability. Library needs to extend the panel cache to `(tabId, viewId) → element`. Real Emacs buffer/window separation. ~1–2 days of library work, gated on consumer need.
- **Persistence driver.** Pluggable backend for layout autosave. Most consumers have their own.
- **Animation polish.** Subtle tab enter/exit animations, float summon/dismiss animations.

### 10.4 Explicitly not planned

- Popout windows to real OS browser windows (see §9).
- Recursive / asymmetric splits (see §9).
- Built-in tab pinning UI (achievable via `draggable: false` + `closeable: false` + consumer CSS).
- Built-in minimize behavior (library emits the event; consumer decides semantics, §5.6).
- An opinion on how tab contents should look. `@gcu/rails` renders chrome and slots; everything else is `renderPanel`.

## 11. Reference implementation

The pre-floats reference POC is 348 lines of JavaScript and 91 lines of CSS, measuring at 3.5 KB gzipped combined. Adding floats, hooks, panel lifecycle, batching, metadata updates, drag cancel, and the rest of §10.1 will grow this meaningfully. Rough estimates (informative, not budgets):

| Artifact | Estimated raw | Estimated gzipped |
|----------|---------------|-------------------|
| `rails.js` | ~25 KB | ~6 KB |
| `rails.css` (structural) | ~4 KB | ~1 KB |
| `rails-default.css` (optional) | ~7 KB | ~2 KB |
| Total minimum (js + structural css) | — | **~7 KB** |
| Total with default theme | — | **~9 KB** |

For comparison: Dockview core is 51 KB gzipped. Even at the upper end of our estimate, rails with floats and default theme is ~5× smaller, and the consumer gets first-class control over every behavioral decision rather than Dockview's fixed policies. Features that pay for themselves in consumer ergonomics (`onPanelDestroy`, `batch`, `updateTab`) are in regardless of size.

## 12. Testing

Tests are layered so each tier is independent and failures localize. The interaction layer is the canary; it breaks on refactor more than anything else.

### 12.1 Unit tests

Pure functions on the state tree, no DOM. Target vitest or equivalent.

- `findTab(state, id)` across rails and floats
- `cleanup(state)` removes empty stacks/rails/floats, reselects `active` correctly
- Insert/move/remove operations preserve §2.2 invariants including float constraints
- Cascade-cleanup to empty workspace is legal; `state.rails === []` round-trips through serialize/deserialize
- Splitter math preserves adjacent flex sums within floating-point tolerance, clamping works
- Float z-ordering — `raiseFloat` assigns max+1, multiple raises don't create duplicates
- Tab policy flags honored — `closeable: false` makes close a no-op, `draggable: false` blocks drag initiation
- Hooks cancel correctly — returning `false` prevents the mutation and leaves state unchanged
- `updateTab` merge-patches correctly; classifies chrome-visible vs non-chrome-visible fields
- `batch(fn)` emits exactly one `layout:change` regardless of N mutations inside; nested `batch` collapses to one render
- `moveTab` accepts every `MoveTarget` variant and rejects malformed targets with a clear error

High coverage of non-DOM paths; runs in milliseconds.

### 12.2 Render tests

Given a state, does the DOM match? Runs under jsdom.

- Rail / stack / tab / float counts match state
- Active tab has `.rails-active`; close button absent when `closeable: false`; `.rails-locked` present when `draggable: false`
- Splitters between siblings only, never at outer edges
- Floats carry `style.zIndex` matching `float.z`; `raiseFloat` updates `zIndex` on that one element without mutating any other DOM node (test element identity stable)
- `data-slot-for` attributes on every slot, including float slots
- `.rails-minimized` / `.rails-maximized` classes present on float elements when their state flags are set
- Stack with `tabPosition: 'bottom'` carries `.rails-tabs-bottom` and renders strip after slot in DOM order
- Empty workspace mounts `renderEmpty()` output into chrome; switches back to rails rendering when `addTab` is called
- `updateTab({title: 'x'})` rewrites the tab's strip text; panel element identity is stable (no reparent)
- Activate tab swaps `.rails-active` class and panel visibility; strip DOM nodes are the same elements before and after

### 12.3 Interaction tests (Playwright, real browsers)

Rails scenarios (from pre-floats POC, retained):

1. Tab reorder within strip — `[A, B, C]` → drag B before A → `[B, A, C]`
2. Tab move between stacks
3. New stack via inter-stack gap drop
4. New rail via outer-edge drop
5. Empty stack cleanup
6. Empty rail cleanup
7. Splitter resize preserves total flex within ε
8. Splitter respects minimums
9. Textarea content and focus survive any drag
10. Iframe content (srcdoc timestamp, counter, input) survives any drag — applies to moves between rails, into floats, between floats, and back to rails
11. Canvas pixel state survives drag
12. Click-vs-drag disambiguation
13. ResizeObserver sync
14. Drag scrim blocks iframe event capture

Float scenarios (new):

15. Tear off — drag tab to empty workspace area → new float created at cursor
16. Float titlebar drag — position updates, scrim captures events
17. Float resize — all 8 handles work; minimum size clamps
18. Redock — drag float titlebar to rails drop zone → float destroyed, tabs redocked, panel state preserved
19. Z-order — click inactive float → raises above others
20. Maximize/restore — fills workspace; toggle restores previous bounds exactly
21. Minimize emits event but does not auto-collapse (unless consumer CSS does)
22. Last-tab-out destroys float — empty floats never persist
23. Cross-float tab move — drag tab from float A to float B's strip
24. Tab-into-float via titlebar drop — drop on existing float's titlebar appends there

Hook scenarios (new):

25. `canCloseTab` returning `false` prevents close
26. `canMoveTab` returning `false` prevents move (including across floats)
27. `canCreateFloat` returning `false` prevents tear-off
28. `closeable: false` tabs have no × and ignore UI close
29. `draggable: false` tabs do not initiate drag but remain clickable for activate

Panel lifecycle scenarios (new):

29a. `closeTab` fires `onPanelDestroy(tab, el)` before DOM removal; consumer cleanup runs and the element is then gone from the DOM
29b. Moves (between stacks, tear-off, redock, cross-float) do **not** fire `onPanelDestroy` — the same panel element survives
29c. `deserialize()` fires `onPanelDestroy` for every tab whose id is not in the new state
29d. `destroy()` fires `onPanelDestroy` for every live tab, then detaches observers/listeners
29e. Iframe srcdoc timestamp and WebSocket state survive `updateTab({title: 'x'})` — chrome rebuild does not touch panel layer

Batch / empty scenarios (new):

29f. `batch(() => { for 100 tabs ... addTab })` produces exactly one chrome rebuild and one `layout:change` event
29g. `batch` with exception inside still renders once after the exception propagates; state is the partial state at the point of throw
29h. Closing the last tab leaves `state.rails === []` and mounts the `renderEmpty()` element; `addTab` from that state creates a default rail+stack+tab
29i. Empty workspace when no `renderEmpty` provided: chrome sublayer is simply empty; content layer holds no panels; `reposition` is a no-op

Drag cancel scenarios (new):

29j. Escape during tab drag removes ghost/zones/scrim, no mutation, source stack unchanged
29k. Escape during splitter drag reverts adjacent flex to pre-drag values
29l. Escape during float drag restores pre-drag `x/y`
29m. Escape during float resize restores pre-drag `x/y/w/h`
29n. Pointerup after Escape is ignored (no second cancel, no mutation)

Drop zone filtering scenarios (new):

30. `dropZones: { 'tab-append-body': false }` → drag onto panel body does not highlight; cursor over body falls through to `new-float`
31. `dropZones: { 'new-float': false }` → drag to empty area does not create a float; tab snaps back
32. `canDropOn` returning `false` for specific zone-tab pair hides only that zone; other zones remain available
33. Drag with *all* zones filtered → ghost follows cursor, no highlights, drop snaps back (no state change)

Tab position scenarios (new):

34. Stack with `tabPosition: 'bottom'` renders strip below slot; `tab-insert` zones compute from bottom strip correctly
35. Mixed `top`/`bottom` stacks in the same rail render independently and allow cross-drag between them
36. Changing `tabPosition` at runtime (by mutating state + re-render) preserves panel state — no reparenting triggered

### 12.4 Touch scenarios

Same interaction battery under `pointerType: 'touch'` simulation, plus:

- Enlarged drop zones activate from touch-sized coordinates
- Long-press threshold does not fire on scroll gestures inside panels
- `touch-action: none` scoped correctly — tabs/splitters/titlebars/handles yes, panel content no
- No text selection leaks on drag
- Float resize handles enlarged appropriately for touch

### 12.5 Browser matrix

Playwright CI runs Chromium, Firefox, WebKit. Per-release manual testing on iOS Safari and Android Chrome — Playwright's WebKit is not iOS Safari and they diverge on pointer event delivery during heavy touch gestures. Budget ~half a day of device testing per tagged release.

### 12.6 Performance smoke tests

Regression traps, not benchmarks.

- Render 20 rails × 5 stacks × 10 tabs + 10 floats (1010 tabs total). Chrome rebuild ≤ 60ms.
- `reposition()` after host resize on same workspace ≤ 6ms.
- Cold start from `createRails` to first paint ≤ 25ms.
- Float drag at 60fps with 50 floats on screen — per-frame work ≤ 8ms.
- Activate tab (in-place, §4.6) ≤ 1ms — no chrome rebuild.
- Raise float (in-place, §4.5) ≤ 0.5ms — single `zIndex` write.
- `batch(() => { addTab × 100 })` ≤ one chrome rebuild; total time ≤ single-rebuild time + O(N) state mutation.

Failures fail CI.

### 12.7 Regression corpus

Bug fixes add minimal repros (state snapshot + scripted operation sequence) to a regression directory, run alongside §12.3. Prevents bugs from returning. Over time the most effective test suite — every entry is a real problem that once existed.

## 13. Open questions

- **Should the factory API accept a string `kind` and a registry, or just `renderPanel(tab)`?** POC uses registry; library proposal uses function. Function is more minimal; registry is more structured and validates unknown kinds. Leaning function.
- **Should `flex` values be stored as normalized fractions (sum to 1) or arbitrary weights?** Weights are simpler and what the POC does. Normalization is implicit via sum-preserving splitter math. Probably fine.
- **Should `serialize()` strip consumer-specific tab fields, or preserve everything?** Preserve everything by default; consumers pass a replacer to filter. Consistent with `JSON.stringify`.
- **Should floats be constrained to the workspace rectangle or allowed to overhang?** Overhang is easier and gives users the expected desktop feel. Clamping is a consumer concern. Leaning no constraint; let consumers clamp in `float:move`/`float:resize` if they want.
- **Should `canCloseTab` etc. be allowed to return `Promise<boolean>` for async confirmation dialogs?** Synchronous is simpler; async opens coordination issues (what if another event fires while the promise pends?). Consumers wanting async can fire their own dialog and replay the operation. Leaning synchronous.
- **Should float maximize be per-float or global (only one float maximized at a time)?** Per-float is consistent with desktop. Global would prevent "two maximized floats stacked" weirdness but requires library state for "which float is currently maximized" that nothing else needs. Leaning per-float, document the edge case.
- **Do `canDropOn` and `canMoveTab` both need to exist, or is one redundant?** `canDropOn` vetoes at drag start (zone filtering, transparent UX); `canMoveTab` vetoes at drop commit (runs regardless of UI path, so `moveTab(id, target)` called programmatically still checks). Both serve different purposes — keep both, document that `canDropOn` is the UX-facing filter and `canMoveTab` is the last-resort integrity guard.
- **Split-view of one buffer (§10.3): is the cost worth the feature?** Deepest architectural change on the roadmap. Defer until a consumer explicitly needs it. Auditable Works might.
- **`onPanelDestroy` sync-vs-async.** Synchronous, matching hooks. If a consumer needs async cleanup (flush buffer, write to disk before teardown), they gate via `canCloseTab` — veto close, do async work, then call `closeTab` again. Opening async destroy would require a "pending destruction" state in the library that nothing else needs.
- **`updateTab` field classification.** Which fields count as "chrome-visible" and trigger rebuild? Firm: `title`, `closeable`, `draggable`. Soft: anything the default theme reads (icon backing fields). Consumers with custom themes that read additional fields will need to call `rails.render()` explicitly, or we expose a `chromeVisibleFields: string[]` construction option. Leaning simple firm set + explicit `render()` escape hatch; add the option if it comes up.
- **`batch` and exceptions.** If `fn` throws, render fires with the partial state as of the throw point, and the exception propagates. Alternative: roll back state via snapshot. Rollback is expensive (deep-copy of `state` at batch start) and the "partial state + exception" behavior matches how most imperative frameworks handle it. Leaning no rollback; document clearly.
- **Empty-workspace `renderEmpty` update cadence.** Re-rendered on every transition empty ↔ non-empty. What if consumer wants `renderEmpty()` to be sticky or preserve its own state (e.g., form input in a "start new" screen)? Probably fine to say: just like `renderPanel`, the element is cached for the lifetime of the empty state and torn down when rails become non-empty. If the consumer wants cross-empty persistence they keep state outside.
