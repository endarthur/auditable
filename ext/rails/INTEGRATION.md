# @gcu/rails — integration guide

How to use `@gcu/rails` in your project. Covers the mental model, common patterns, and real pitfalls encountered while building it.

For the full design and API surface, see [`SPEC.md`](./SPEC.md). For installation, see [`README.md`](./README.md).

---

## Mental model

Three layers, three concerns:

1. **Chrome** — rails, stacks, tab strips, splitters, float frames. Rebuilt on structural mutation. Lives in `.rails-chrome`.
2. **Content** — panels (your tab bodies). Absolutely positioned in `.rails-content`. **Panels are never reparented.** They move by `style.left/top/width/height` only.
3. **State** — a plain JSON object. Read freely; mutate via API methods only.

A **tab** is your unit of content. Each tab owns one panel (created once by `renderPanel(tab)`, cached for the tab's lifetime). A tab lives in exactly one **stack** (a tab group with one active tab), which lives in exactly one **rail** (a column of stacks) or one **float** (a draggable frame overlaying rails).

Panels never reparent means: iframes don't reload, canvases don't redraw, `<video>` keeps playing, form focus survives. Across every move, between rails, into floats, back to rails — one cached HTMLElement per tab, repositioned numerically.

## Minimal integration

```js
import { createRails } from '@gcu/rails';
import '@gcu/rails/rails.css';
import '@gcu/rails/rails-default.css'; // optional GCU theme

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
    el.textContent = `panel ${tab.title}`;
    el.style.padding = '16px';
    return el;
  }
});
```

That's it. Drag tabs between strips, drop in gaps to create new rails/stacks, tear off into floats, redock by dragging float titlebars. All interactions work out of the box.

---

## Integration patterns

### Iframe panels

The reason rails exists. No special setup required — return an iframe (or a wrapper containing one) from `renderPanel`.

```js
renderPanel(tab) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;';
  const f = document.createElement('iframe');
  f.src = tab.url;
  f.style.cssText = 'flex:1;border:none;';
  wrap.appendChild(f);
  return wrap;
}
```

The iframe will not reload across any drag, split, float, redock, or workspace resize.

### Canvas / WebGL / resource-holding panels

Anything holding a resource (WebGL context, AudioContext, WebSocket, `setInterval`, MediaStream) needs cleanup when the tab closes. Use `onPanelDestroy`:

```js
createRails(host, {
  renderPanel(tab) {
    const canvas = document.createElement('canvas');
    canvas._gl = canvas.getContext('webgl2');
    canvas._raf = requestAnimationFrame(tick);
    canvas._ws = new WebSocket(tab.stream);
    return canvas;
  },
  onPanelDestroy(tab, el) {
    cancelAnimationFrame(el._raf);
    el._ws?.close();
    el._gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
});
```

`onPanelDestroy` fires only on genuine eviction (close, `deserialize`, `destroy`). Moves don't trigger it.

### Reactive frameworks (sideact, React, Svelte, Vue)

`onPanelDestroy` is the universal cleanup point. Collect disposers on mount, run them on destroy:

```js
// Sideact
renderPanel(tab) {
  const el = document.createElement('div');
  el._dispose = sr.render(sr.h`<div>${tab.data}</div>`, el);
  return el;
}
onPanelDestroy(tab, el) { el._dispose?.(); }

// React
renderPanel(tab) {
  const el = document.createElement('div');
  const root = ReactDOM.createRoot(el);
  root.render(<Panel tab={tab} />);
  el._root = root;
  return el;
}
onPanelDestroy(tab, el) { el._root?.unmount(); }

// Svelte
renderPanel(tab) {
  const el = document.createElement('div');
  el._cmp = new PanelComponent({ target: el, props: { tab } });
  return el;
}
onPanelDestroy(tab, el) { el._cmp?.$destroy(); }
```

### Autosave layout

Subscribe to `layout:change` (debounced) or pass `onChange`:

```js
import { debounce } from './utils.js';

const saveLayout = debounce(() => {
  localStorage.setItem('workspace-layout', rails.serialize());
}, 500);

createRails(host, {
  renderPanel,
  onChange: saveLayout
});
```

### Serialize with non-JSON consumer fields

Tabs are open-ended — put whatever you want on them. If you add non-serializable handles (a document object, a DOM ref), pass a replacer:

```js
rails.serialize((key, value) => {
  if (key === 'doc' && value) return { $ref: value.id };      // dehydrate
  if (key === 'target' && value?.nodeType) return undefined;   // strip
  return value;
});
```

On load, rehydrate in your `renderPanel`:

```js
renderPanel(tab) {
  if (tab.doc?.$ref) tab.doc = documentStore.get(tab.doc.$ref);
  // ...
}
```

### Dirty-tab close guard

Use `canCloseTab` — synchronous veto. For async confirmation, gate via `canCloseTab` first, show your own dialog, replay `closeTab` on resolve:

```js
createRails(host, {
  renderPanel,
  canCloseTab(tab) {
    if (tab.dirty) return confirm(`${tab.title} has unsaved changes. Close?`);
    return true;
  }
});
```

For async dialogs:

```js
let pendingAsync = null;
createRails(host, {
  renderPanel,
  canCloseTab(tab) {
    if (!tab.dirty) return true;
    if (pendingAsync === tab.id) { pendingAsync = null; return true; }  // resolved
    confirmAsync(`${tab.title} has unsaved changes. Close?`).then(yes => {
      if (yes) { pendingAsync = tab.id; rails.closeTab(tab.id); }
    });
    return false;
  }
});
```

### Bulk mutations (session restore, many-tab open)

Wrap in `batch(fn)` — defers render until the callback returns. N mutations → 1 chrome rebuild.

```js
rails.batch(() => {
  for (const tabSpec of session.tabs) {
    rails.addTab(tabSpec, tabSpec.target);
  }
});
```

### Restrict moves / prevent tear-off

Per-tab flags for ergonomic policy, hooks for runtime policy:

```js
// Permanent home tab that can't be closed or moved.
{ id: 'home', title: 'home', closeable: false, draggable: false }

// Dynamic policy — this tab can only stay in its original rail.
createRails(host, {
  renderPanel,
  canMoveTab(tab, from, to) {
    if (tab.pinned && to.to !== 'stack') return false;
    if (tab.kind === 'system' && to.to === 'new-float') return false;
    return true;
  },
  canCreateFloat(tab) {
    return tab.kind !== 'controls';
  }
});
```

---

## Migrating from a linear tab system

Most existing tab UIs (VS Code editors, Chrome tabs, AF's current tabs.js) are one flat list. Migrating to rails:

1. **Wrap your tab array in the state shape:**
   ```js
   // Before: flat array
   const tabs = [{ id, title, doc }, ...];

   // After: rails shape
   const initialState = {
     rails: [{ id: 'r1', flex: 1, stacks: [{
       id: 's1', flex: 1,
       active: tabs[0]?.id ?? null,
       tabs
     }] }],
     floats: []
   };
   ```

2. **Move tab-body rendering into `renderPanel`.** If you currently render into a sibling div by tab id, switch to creating the element and returning it. Remove your manual show/hide logic — rails handles it.

3. **Replace direct DOM manipulations with API calls.** `appendTab` → `rails.addTab`, `removeTab` → `rails.closeTab`, activate → `rails.activateTab`. Move all UI state through the library.

4. **Hook up dirty-state guards** via `canCloseTab`, iframe cleanup via `onPanelDestroy`.

5. **Wire autosave** via `onChange` + `serialize`. Stop maintaining your own "active tab" variable — use `rails.state`.

Expect the migration to shrink the tab-handling code meaningfully (most of it was reimplementing parts of rails).

---

## Pitfalls

Real ones encountered while building rails:

- **Panel sizing.** `.rails-panel` is `display: flex; flex-direction: column`. Your returned element is its sole child — size it with `flex: 1; min-height: 0` to fill. Heights via `height: 100%` don't resolve reliably in flex containers. Inner iframes/canvases/textareas need the same treatment. See README sizing note.

- **Custom float theming — never give `.rails-float` an opaque background.** The float frame must be transparent so the panel (in `contentLayer`, behind the floats layer) shows through the slot. Put backgrounds on `.rails-titlebar` and `.rails-strip` instead. Default theme does this correctly.

- **Seed-state ID collisions.** Library-generated IDs use `freshId(state, prefix)` which scans current state and guarantees uniqueness. If you seed state with IDs like `'s1'`, `'r1'`, `'t1'`, library-generated IDs will skip those. Safe. But **don't** generate your own IDs naively with a counter — they may collide with existing state too.

- **Don't mutate `rails.state` directly.** Setting `state.rails[0].flex = 2` doesn't trigger re-render and desyncs state from DOM. Go through API methods, or call `rails.render()` if you absolutely must mutate directly.

- **Reserved z-index ranges.** The library uses:
  - `2` — rail/stack splitters
  - `5` — rail-tab panels
  - `100 + float.z * 10` — float chrome
  - `100 + float.z * 10 + 5` — float-tab panels
  - `500` — drop zones during drag
  - `9500` — drag scrim
  - `10000` — drag ghost

  Don't assign values in these ranges to your own overlays unless you know what you're doing.

- **Panels outlive activations.** A panel is created lazily on first activation and cached forever (until tab close). If your tab data changes in a way that requires a fresh mount (e.g., tab kind changes), close the old tab and add a new one with a different ID. Don't try to force re-render.

- **Event handlers throw in silence.** Hook errors are caught and `console.error`'d but don't break rails' operation. Check the console if something looks off after a mutation.

---

## Hooks vs events cheat sheet

| | Hooks (`canX`) | Events (`tab:X`, `float:X`, `layout:change`) |
|---|---|---|
| When | Before mutation | After mutation |
| Return | `boolean` — false cancels | Nothing (notification only) |
| Synchronous | Yes | Yes (but consumer can do async work) |
| Purpose | Runtime policy, guard rails | Autosave, logging, UI sync |

Rule: if a consumer decision needs to *prevent* something, it's a hook. If a consumer just wants to *know* something happened, it's an event.

---

## When NOT to use rails

Rails is scoped to "docked tab-based workspaces with floating groups." Use something else if you need:

- Recursive arbitrary splits (any panel splits in any direction). Use Dockview or GoldenLayout.
- Real OS popout windows. Use named workspaces as an approximation, or accept that cross-window coordination is outside rails' scope.
- Asymmetric splits ("terminal spans main + sidebar"). Lift to Dockview.
- Non-tabbed layout (pure grid, graph, tree, freeform). Rails has tabs at every stack; if you don't want tabs, it's the wrong tool.

For in-scope use cases (notebooks, IDE-style workspaces, analysis dashboards, tool shells), rails gives you the 20% of docking that covers 95% of real UIs at roughly 1/6 the size of a full docking library and with first-class control over every behavior.
