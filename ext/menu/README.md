# @gcu/menu

Popup menus and menubars: context menus, dropdowns, submenus, MenuBar.
Promise-resolving `Menu.show()`, CSS-variable themed, full keyboard,
drag-aware, ~600 LOC source. Zero dependencies.

```js
import { Menu, MenuBar } from '@gcu/menu';
import '@gcu/menu/menu.css';
import '@gcu/menu/menu-default.css';   // optional theme

// Context menu at the cursor
const action = await Menu.show([
  { label: 'Cut',   shortcut: 'Ctrl+X', action: 'cut' },
  { label: 'Copy',  shortcut: 'Ctrl+C', action: 'copy' },
  { label: 'Paste',                     action: 'paste', disabled: true },
  '---',
  { label: 'Delete', icon: '🗑',        action: 'delete', danger: true },
], { x: e.clientX, y: e.clientY });
// action === 'cut' | 'copy' | 'delete' | null
```

```js
// Anchored dropdown
Menu.dropdown(button, items, { onAction: a => handle(a) });

// Menubar with reactive sections
const bar = new MenuBar(container, () => [
  { label: 'File', items: () => [
    { label: 'New', action: 'file:new' },
    { label: 'Save', action: 'file:save', disabled: !isDirty },
  ]},
  { label: 'Edit', items: [...] },
]);
bar.on('action', a => handle(a));
bar.refresh();   // re-evaluate sections on state change
```

## Item shape

```ts
type MenuItem =
  | "---"                                    // separator
  | {
      label:     string;
      action?:   any;                        // resolved value if selected
      shortcut?: string;                     // shown right-aligned
      icon?:     string;                     // emoji, glyph, or SVG/image URL
      disabled?: boolean;
      danger?:   boolean;
      checked?:  boolean;                    // shows ✓ or ●
      group?:    string;                     // radio group key (with checked)
      children?: MenuItem[] | (() => MenuItem[]);   // submenu
    };

// Items can be a static array or a factory called when the menu opens.
type MenuItems = MenuItem[] | (() => MenuItem[]);
```

## API surface

| Call | Returns | Use |
|------|---------|-----|
| `Menu.show(items, { x, y })` | `Promise<action \| null>` | Cursor-positioned popup |
| `Menu.show(items, { anchor: el, placement })` | `Promise<action \| null>` | Element-anchored popup |
| `Menu.dismiss()` | — | Close any open menu programmatically |
| `Menu.dropdown(button, items, opts?)` | `{ open, close, destroy }` | Persistent button-anchored dropdown |
| `new MenuBar(container, sections)` | `MenuBar` instance | Horizontal trigger bar |
| `bar.on('action', fn)` | unsub fn | Subscribe to selections |
| `bar.update(label, mutate)` | — | Surgically update one section's items |
| `bar.refresh()` | — | Re-evaluate factory sections (reactive layer hook) |
| `bar.destroy()` | — | Tear down |

## Keyboard

Inside an open menu:

| key            | action                                        |
|----------------|-----------------------------------------------|
| ↑ / ↓          | move highlight (wraps)                        |
| Home / End     | jump to first / last enabled item             |
| → / ←          | open / close submenu                          |
| Enter / Space  | activate                                      |
| Escape         | dismiss (or close submenu, then dismiss)      |
| typeahead      | jump to next item starting with typed run     |
| Tab            | dismiss without swallowing — focus moves on   |

Menubar:

| key       | action                                      |
|-----------|---------------------------------------------|
| Alt / F10 | activate the bar                            |
| ← / →     | move between triggers (wraps)               |
| ↓ / Enter | open the focused trigger's menu             |
| Escape    | close menu, second press deactivates the bar |

## Theming

CSS variables on `:root` (or any ancestor) drive the look. Defaults in
`menu-default.css`. Override one or more:

```css
:root {
  --ui-bg-raised: #16191e;
  --ui-bg-hover:  #2a303a;
  --ui-fg:        #d6dae1;
  --ui-fg-error:  #e07a6a;
  --ui-border:    #2a303a;
  --ui-shadow:    0 6px 20px rgba(0, 0, 0, 0.5);
  --ui-z-dropdown: 9000;   /* above rails floats and app chrome */
  /* ...see menu-default.css for the full list */
}
```

## Behavior notes

- **One menu at a time.** Opening a new top-level menu dismisses any open one.
- **Click outside dismisses.** The dismissing click does *not* fall through
  to the underlying element. Right-click outside is the exception — it
  dismisses *and* lets the contextmenu event fire so consumers can open
  a new menu at the new position.
- **Drag-aware.** When `document.body` has class `rails-dragging` or
  `gcu-dragging`, hover-open submenus are suspended.
- **Programmatic dismiss is safe** at any time; pending `show()` promises
  resolve to `null`.
- **Reactivity is delegated.** Function-as-items evaluates on open;
  `MenuBar` factory + `refresh()` covers topology changes; CSS handles
  visual states via `data-*` and `aria-*` attributes.

## Files

- `src/menu.js` — Menu primitive (positioning, keyboard, typeahead, submenus, dismiss stack)
- `src/menubar.js` — MenuBar (delegates popups to Menu)
- `src/index.js` — public re-exports
- `menu.css` — structural styles (no colors)
- `menu-default.css` — GCU dark theme
- `index.js` — bundled build output (`node build.js`)

## See also

- `SPEC.md` (in `spec_inbox/menu-spec.md`) — full design rationale
- `demo.html` — interactive showcase (open in a browser)
