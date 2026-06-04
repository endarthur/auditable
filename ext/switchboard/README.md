# Switchboard

**The GCU UI toolkit.** Cool neutral surfaces, six functional accents, two typefaces (Barlow + Space Mono) with a strict semantic split. Single-file deployable; no build step.

Used by everything that ships under the GCU org — Auditable, ep, Arborist, `@gcu/plan`, the handheld platform. If you're building a GCU tool's UI (in this repo or another), **this is the front door.**

## The toolkit — two tiers

Switchboard is a *toolkit*, not a runtime widget framework. That distinction is deliberate (SPEC §9): it composes with whatever idiom the host tool already uses — CodeMirror chrome, a native canvas, firmware-rendered keypad UI — without dragging in a component runtime. So the toolkit is two tiers, and Switchboard is the umbrella + the contract over both:

**Tier 1 — the language (runtime-free).** Tokens, the six-accent semantic mapping, typography, the documented component *patterns* (Panel, Button, Badge, Form field, Device readout, Terminal, accent band), theming, accessibility. This is what lives here, in `SPEC.md`. It composes into anything.

**Tier 2 — the DOM components.** Separate zero-dep `@gcu/*` packages that *implement* the tier-1 patterns for the browser. Switchboard rosters and contracts them; it does **not** absorb them (that would forfeit runtime-agnosticism). Each ships its own structural CSS + a `-default` theme:

| package | what | doc |
|---|---|---|
| `@gcu/menu`   | popup menus, dropdowns, MenuBar | `ext/menu/README.md` |
| `@gcu/dialog` | modal confirm / prompt / alert + custom dialogs | `ext/dialog/README.md` |
| `@gcu/rails`  | docked tab / stack / float layout engine | `ext/rails/README.md` (+ `INTEGRATION.md`) |
| `@gcu/loom`   | virtualized data grid (rich async cell provider) | `ext/loom/README.md` |
| `@gcu/term`   | VT/ANSI terminal emulator + DOM renderer | `ext/term/README.md` |

**The authoring contract** (one rule, so tier 2 stays consistent — and so *new* components, here or in a sibling repo, fit): a DOM component ships **structure-only CSS that reads `--au-*` semantic tokens** (never `--sw-*` swatches directly, never hard-coded colors), plus an optional `-default` theme for standalone use. The host app supplies the `--sw-* → --au-*` mapping; re-skinning happens at that layer without touching component CSS. See SPEC §6 (patterns) + §11 (conventions).

## What's in this directory

- **[`SPEC.md`](./SPEC.md)** — the canonical design document. Token map, accent semantics, typography rules, component patterns, accessibility requirements, anti-patterns. Read this before adding a UI to a GCU tool.
- **[`fonts/`](./fonts/)** — Barlow (sans, for humans) + Space Mono (mono, for the machine) as `.woff2` binaries, plus the combined `OFL.txt` license notice. Loaded on demand when the user enables "embed fonts" in settings; otherwise the system font fallback in the stack is used.

The implementation itself — the actual CSS custom properties and the `--sw-*` → `--au-*` semantic mapping — lives at the top of `src/style.css` (lines 1-100ish). That's where to look if you want to see what tokens are bound to what values, or copy the block into a new GCU surface.

## How it's used in this repo

The `--sw-*` tokens are the Switchboard swatches (raw colors and font stacks). The `--au-*` tokens are auditable's semantic layer that consumes them (e.g. `--au-action: var(--sw-orange)`, `--au-error: var(--sw-red)`). Component CSS reads only `--au-*` — never `--sw-*` directly. This indirection lets us re-skin auditable by remapping the `--au-*` layer without touching component CSS.

Light is `:root` (Switchboard default = equipment gray); dark is `[data-theme="dark"]` on `<html>` (= basalt). First paint reads `prefers-color-scheme`. Users can layer their own overrides via `/home/nb/theme.css` in the notebook VFS, which is loaded as `<style id="user-theme">` after the base stylesheet.

## Versioning and stability

Switchboard is at **1.0**. The accent → semantic mapping (orange=action, teal=info, green=go, amber=caution, red=fault, indigo=selected) is the stability anchor — it does not change in 1.x. See SPEC §12 for the full semver policy.

## The installable package (v0.1)

The SPEC §9 "future" is now here, in this directory:

- **[`switchboard.css`](./switchboard.css)** — the **canonical design tokens** (Layer 1 `--sw-*` swatches + Layer 2 `--au-*` semantic mapping, light `:root` + dark `[data-theme="dark"]`). The single source of truth. Drop it into any GCU tool to inherit the look; a component reading `--au-*` then themes + light/darks for free.
- **[`theme.js`](./theme.js)** — the tiny (~1KB) helper: `initTheme()` (first-paint from storage or OS), `toggleTheme()`, `applyTheme()`, `onThemeChange()`. For standalone/sibling consumers; auditable + Works keep their own richer theme systems.

The in-repo copies (`src/style.css`, `works/style.css`, `works/surfaces/_theme.css`) are **parity-tested** against `switchboard.css` (`test/switchboard-tokens.test.mjs`) so they can't silently drift — each may define a subset, but every token it defines must match the canon, except the documented Works brighter-dark-accent delta. The next step is the build-inline consumption (deleting the copies, sourcing them from this file); until then, the test holds the line.

There is **no** React/Vue component library, by design — Switchboard is just CSS variables + class names + a token file, so it composes with whatever idiom the host tool uses (CodeMirror chrome, native canvas, firmware-rendered keypad UI) without dragging in a runtime. The DOM *components* are separate tier-2 packages (see the roster above).

## License

MIT.
