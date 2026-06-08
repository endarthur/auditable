# Settings

Open the settings panel from the toolbar overflow menu (**...** → **settings**) or via
the mobile action bar. Settings are saved with the notebook — each notebook carries its
own configuration.

---

## Theme

| Setting | Options | Default |
|---------|---------|---------|
| Color scheme | `dark`, `light` | dark |
| Embed fonts | `system`, `bundled` | system |

The theme follows the [Switchboard](switchboard.md) design system — dark uses the **basalt** surface palette; light uses **equipment gray**. Either way the accent palette is the canonical six (orange action, teal info, green go, amber caution, red fault, indigo selected). The selected theme applies to both the UI chrome and the CodeMirror editors.

**Embed fonts** controls whether the notebook uses system-fallback fonts (Space Mono / Barlow → system monospace / sans, the default) or fetches the canonical Space Mono + Barlow from Google Fonts and caches them in localStorage (slightly larger first load; canonical look on any machine). In [Auditable Works](works.md), bundled fonts are the workspace default — Works is the "GCU desktop" and the canonical type is the right baseline.

User theme overrides go in `/home/nb/theme.css` inside the notebook's VFS — drop CSS variable overrides there and they apply on next load:

```css
:root { --au-bg: #181818; }
[data-theme="dark"] { --au-action: #ffa540; }
```

See [Switchboard](switchboard.md) for the full token reference.

---

## Editor

| Setting | Options | Default |
|---------|---------|---------|
| Font size | 10–20 px (slider) | 13 |
| Line numbers | `on`, `off` | on |

Font size controls the `--editor-font-size` CSS variable. Line numbers can also be toggled
per-session with the **l** key in command mode (see [Keyboard Shortcuts](keyboard.md)).

---

## Notebook

| Setting | Options | Default |
|---------|---------|---------|
| Max width | `narrow` (720), `default` (860), `wide` (1100), `full` (100%) | default |
| Cell header | `auto`, `always visible`, `compact`, `hover only` | auto |
| Default view | `notebook`, `editor (split)` | notebook |

**Max width** sets the `max-width` on the notebook container.

**Cell header** controls how cell type labels and controls are displayed:

- **auto** — responsive behavior via CSS media queries
- **always visible** — headers always shown
- **compact** — minimal header display
- **hover only** — headers appear on mouse hover

**Default view** determines whether the notebook opens in the standard cell-by-cell
interface or the split editor view. See [Split View](cells.md#split-view) for details.

---

## Execution

| Setting | Options | Default | Scope |
|---------|---------|---------|-------|
| Mode | `reactive`, `manual` | reactive | per-notebook |
| Run on load | `yes`, `no` | yes | per-notebook |
| Show run toggle | `yes`, `no` | yes | per-notebook |
| Global override | `(notebook default)`, `always reactive`, `always manual` | notebook default | localStorage |
| Global run on load | `(notebook default)`, `always run`, `never run` | notebook default | localStorage |

**Reactive mode** — cells auto-run when edited and changes propagate through the DAG.
**Manual mode** — cells only run via ++ctrl+enter++, ++shift+enter++, or Run All.

The execution mode toggle (the ++arrow-right++ / ++pause++ button in the toolbar) can be
hidden with **Show run toggle**.

!!! tip "Global overrides"
    The global override settings are stored in `localStorage`, not in the notebook file.
    They apply to *every* notebook opened in that browser profile — useful if you always
    want manual mode regardless of what each notebook specifies. The priority chain is:
    localStorage override > notebook setting > build default.

---

## Presentation Mode

Toggle presentation mode with **p** in command mode or via the toolbar overflow menu
(**...** → **present**).

In presentation mode:

- All editors become **read-only** — no editing, only viewing outputs
- Cells marked with `// %hide` are hidden
- A floating **exit** button appears to return to editing
- Cell type labels and controls are hidden

Presentation mode is a session-only state — it is not saved with the notebook. Use it
for live demos, teaching, or sharing a clean output view.

!!! note "Styling for presentation"
    Use `// %outputId` and `// %outputClass` directives to assign IDs and classes to cell
    outputs, then style them with CSS cells. Combined with `// %hide` on code cells, you
    can build app-like presentations. See [Directives](directives.md) for details.

---

## Modules & Binaries

The bottom of the settings panel lists all installed modules and binary assets. Each
entry shows:

- The module URL or identifier
- The cell that installed it (if applicable)
- File size (actual bytes for modules, decoded size for binaries)
- A remove button (**x**) to uninstall

Removing a module deletes it from `_installedModules` and the import cache. If the module
was installed by a cell, running that cell again will re-install it.

See [Modules](modules.md) for more on `load()`, `install()`, and `installBinary()`.

---

## Encryption

Encrypt the entire notebook with a passphrase. When enabled, cell data, settings, modules,
and filesystem contents are encrypted as a single AES-256-GCM blob — the HTML/CSS/JS
runtime stays cleartext.

| Setting | Description |
|---------|-------------|
| **Enable encryption** | Set a passphrase and save a recovery key |
| **Change passphrase** | Re-wrap the data key with a new passphrase |
| **Regenerate recovery key** | Create a new recovery key (invalidates the old one) |
| **Lock notebook** | Clear the decryption key from memory immediately |
| **Disable encryption** | Remove encryption (requires current passphrase) |

!!! warning
    Save your recovery key somewhere safe — it's the only way to access the notebook
    if you forget the passphrase.

See [Encryption](encryption.md) for the full guide.

---

## About

The settings panel footer shows version information:

- **Version** — the auditable version number
- **Build** — release type and build date
- **Runtime** — base runtime size in KB
- A link to the [GitHub repository](https://github.com/gentropic/auditable)
