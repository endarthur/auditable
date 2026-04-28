# @gcu/dialog

Modal dialogs: `confirm`, `prompt`, `alert`, custom forms. Promise-resolving
`show()`, focus trap, stacking, ARIA, CSS-variable themed. Zero dependencies.

```js
import { Dialog, confirm, prompt, alert } from '@gcu/dialog';
import '@gcu/dialog/dialog.css';
import '@gcu/dialog/dialog-default.css';   // optional theme

// Convenience
const ok    = await confirm('Delete 3 files?', { okLabel: 'Delete', danger: true });
const name  = await prompt('Rename to:', { defaultValue: 'untitled.csv' });
await alert('Operation complete.');

// Custom render
const result = await new Dialog({
  title: 'Export',
  width: 400,
  render(body, ctx) {
    body.innerHTML = `
      <label>Format: <select data-fmt>...</select></label>
      <button type="button" data-default="true">Export</button>
    `;
    body.querySelector('[data-default]').onclick = () => ctx.close({
      format: body.querySelector('[data-fmt]').value,
    });
  },
}).show();
```

## API surface

| Call | Returns | Use |
|------|---------|-----|
| `Dialog.confirm(msg, opts?)` / `confirm(...)` | `Promise<boolean>` | Yes/No question |
| `Dialog.prompt(msg, opts?)`  / `prompt(...)`  | `Promise<string \| null>` | Text input |
| `Dialog.alert(msg, opts?)`   / `alert(...)`   | `Promise<void>` | Single-OK notice |
| `new Dialog(config).show()`                   | `Promise<any \| null>` | Custom form |
| `dialog.close(value)`                         | — | Programmatic dismiss from outside `render` |
| `Dialog.dismissAll()`                         | — | Close every open dialog (top-down) |

## Configuration

```ts
type DialogConfig = {
  title?:    string;
  parent?:   HTMLElement;             // center within (default: viewport)
  width?:    number;                  // px (default: auto, max 90vw)
  closable?: boolean;                 // show × in corner (default: true; false for convenience APIs)
  backdrop?: boolean | "static";      // true = click-dismisses; "static" = click does nothing; false = no overlay (still modal). Default true.
  render(body: HTMLElement, ctx: RenderCtx): void;
};

type RenderCtx = {
  close(value?: any): void;           // dismisses with a value (undefined → null)
  setOk(enabled: boolean): void;      // toggles disabled on the [data-default="true"] button
  setTitle(text: string): void;       // updates title bar
  dialog: Dialog;
};
```

## Behavior

- **Promise resolves immediately on user decision.** The fade-out animation
  runs async — consumers can chain a follow-up dialog and the first one's
  fade overlaps the second's open.
- **Single Enter activation.** Enter clicks `[data-default="true"]`; in a
  `<textarea>`, plain Enter inserts a newline and Ctrl/Cmd+Enter submits.
  Focus on a `<button>` lets the button's own Enter handler fire (no
  double-activation).
- **Escape dismisses** unless `backdrop: "static"`, in which case it doesn't.
- **Focus trap.** Tab cycles through focusable elements inside the top
  dialog only. The page beneath gets the `inert` attribute so screen readers
  ignore it. (Modern browsers — Chrome 102+, Firefox 112+, Safari 15.5+.)
- **Focus return.** On open, the previously-focused element is snapshotted;
  on close, focus is restored there (or to `document.body` if it's gone).
- **Stacking.** Opening dialog B while A is open puts B on top with z-index
  `--ui-z-dialog + N*2`. A's keyboard handler is suspended while B is on
  top; closing B reactivates A.
- **`prefers-reduced-motion: reduce`** skips the fade animation entirely.

## Theming

```css
:root {
  --ui-bg-raised:     #16191e;
  --ui-fg:            #d6dae1;
  --ui-fg-error:      #e07a6a;
  --ui-fg-accent:     #6ab0ff;
  --ui-border:        #2a303a;
  --ui-shadow:        0 12px 40px rgba(0, 0, 0, 0.6);
  --ui-z-dialog:      9100;       /* above @gcu/menu (9000), below toasts (9200) */
  --ui-backdrop:      rgba(0, 0, 0, 0.4);
  --ui-dialog-max-w:  90vw;
  --ui-dialog-max-h:  80vh;
  /* see dialog-default.css for the full list */
}
```

## Files

- `src/dialog.js` — Dialog class (lifecycle, focus trap, stacking, animation, ARIA)
- `src/convenience.js` — `confirm` / `prompt` / `alert` built on Dialog
- `src/helpers.js` — pure (z-index arithmetic, validation, focusable selector)
- `src/index.js` — public re-exports + Dialog static aliases
- `dialog.css` — structural styles (no colors)
- `dialog-default.css` — GCU dark theme
- `index.js` — bundled build output (`node build.js`)

## See also

- `spec_inbox/dialog-spec.md` — full design rationale
- `demo.html` — interactive showcase (open in a browser)
