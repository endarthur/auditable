# Switchboard

**The GCU design system.** Auditable's visual language — colors, typography, components, layout conventions. Shared with Arborist, `@gcu/plan`, and every other tool that ships under the [Geoscientific Chaos Union](https://gentropic.org) org.

> Shuttle flight deck, not blank paper.

```css
:root {
  --au-bg:        var(--sw-bg);
  --au-text:      var(--sw-text);
  --au-action:    var(--sw-action);   /* orange */
  --au-info:      var(--sw-info);     /* teal */
  --au-go:        var(--sw-go);       /* green */
  --au-caution:   var(--sw-caution);  /* amber */
  --au-fault:     var(--sw-fault);    /* red */
  --au-selected:  var(--sw-selected); /* indigo */
}
```

## What you see is what you get

Switchboard isn't a CSS framework; it's a set of rules. The whole system fits in a `<style>` block and a small JS theme-switcher. No build step, no preprocessor, no class library. CSS custom properties carry all the tokens; you read them from `var(--au-*)` and Switchboard owns whether `--au-action` resolves to orange-on-dark or orange-on-light.

The full canon lives in [ext/switchboard/SPEC.md](https://github.com/gentropic/auditable/blob/main/ext/switchboard/SPEC.md) (version 1.0, MIT). This page is the user-facing summary — what to expect, how to extend cleanly, where to look when something's off.

## Three commitments

1. **Eye-comfort first.** The brightest pixel on screen is never `#FFFFFF` and the text is never `#000000`. Max contrast is around 12:1 — above WCAG AAA, well below the retina-searing 21:1 of pure black-on-white. Readable for hours under variable lighting. The same problem flight decks solved in 1981.
2. **Accents are events, not ambience.** The stage is cool. Orange and amber register as *something happened* — a button pressed, a warning raised — not as the temperature of the entire interface. No "piss filter" gradient overlays.
3. **Single-file deployable.** The whole system fits in `<style>` and `<script>` blocks. CSS custom properties carry the tokens; no CSS-in-JS, no preprocessor, no toolchain on the consumer side.

## The three-layer cascade

Auditable's theming uses a strict three-layer cascade:

```
Layer 1   Switchboard swatches    --sw-bg-deep, --sw-action, --sw-text-soft, ...
Layer 2   Auditable semantic      --au-bg, --au-action, --au-text, ...
Layer 3   Component CSS           reads only --au-*, never --sw-*
```

Layer 1 is the raw color palette. Layer 2 maps swatches to semantic roles (`--au-action` is "the orange thing the user clicks"). Layer 3 (every component CSS) reads only `--au-*` tokens — never reaches past layer 2.

This split is what lets a third-party plugin theme cleanly: it consumes `--au-*` tokens, gets the GCU look, and never has to know which Switchboard swatch corresponds to "action."

## Light and dark

Both modes are first-class. Light is the default (`:root`, equipment-gray surfaces); dark is opt-in via `[data-theme="dark"]` on `<html>` (basalt). First-paint reads `prefers-color-scheme` and applies the matching theme before any style block paints.

```html
<html data-theme="dark">
  <!-- ... -->
</html>
```

User overrides go in `/home/nb/theme.css` (auto-loaded by the notebook as `<style id="user-theme">`). Drop a token override there:

```css
:root { --au-bg: #181818; }
[data-theme="dark"] { --au-action: #ffa540; }
```

## The six accents — hard role mapping

Every interaction Switchboard hands you maps to exactly one of six accent colors. The mapping is hard — you don't get to choose "red looks nicer here." Reds mean failures; oranges mean actions; ambers mean warnings.

| Accent | CSS | Role |
|---|---|---|
| **Orange** | `--au-action` | The primary action. Save buttons, run buttons, "open" links. |
| **Teal** | `--au-info` | Informational chrome. Notebook titles, file inspectors, code-line numbers. |
| **Green** | `--au-go` | Success / "all clear" / connected. |
| **Amber** | `--au-caution` | Warnings, "this will overwrite," "running locally without verification." |
| **Red** | `--au-fault` | Errors, failed runs, broken state. |
| **Indigo** | `--au-selected` | Selection — selected cells, selected rows, focused inputs. |

The discipline pays off: a user who has worked in any GCU surface knows that orange = action and red = problem, regardless of which surface they're in.

## Typography

A **monospace + sans split** with a hard semantic line between them:

- **Monospace** (Space Mono on bundled-fonts; system monospace by default) — code, data, labels, anything that wants to read as instrument output. Numbers, identifiers, file paths.
- **Sans** (Barlow on bundled-fonts; system sans by default) — prose, headlines, anything you read continuously. The notebook's text content; documentation prose; UI labels that aren't equipment readouts.

The rule is *strict*: a number rendered as a label is monospace; the body of a markdown cell is sans. Inline code inside a sans paragraph switches to monospace for the duration of the `<code>`.

### Bundled fonts

By default, Switchboard uses the system fallback stack:

```
font-family: 'Space Mono', ui-monospace, monospace;
font-family: 'Barlow', ui-sans-serif, system-ui, sans-serif;
```

For projects that want the canonical look on machines without Space Mono / Barlow installed, opt in to bundled fonts via **Settings → embed fonts** — this fetches the two families from Google Fonts the first time and caches them in localStorage.

In Auditable Works, bundled fonts are on by default — Works is the "GCU desktop" so the canonical type is the right baseline.

## Component patterns

Switchboard ships a small library of component conventions. Code lives inline in each consumer; the conventions are documented in the SPEC.

### Buttons

```html
<button class="au-btn">Save</button>
<button class="au-btn primary">Run</button>
<button class="au-btn caution">Discard</button>
```

`au-btn` is the base; modifiers (`primary`, `caution`, `fault`, `selected`) map to the accent table above.

### Panels

```html
<div class="au-panel">
  <div class="au-panel-header">Files</div>
  <div class="au-panel-body">
    <!-- ... -->
  </div>
</div>
```

Panels are the rectangular containers that hold most chrome — toolbars, file trees, settings sections. The `au-panel-header` uses `--au-bg-bright`; the body uses `--au-bg-raised`. Inner dividers via `border-color: var(--au-border-soft)`.

### Inputs

Inputs sit on `--au-bg-bright` (slightly brighter than the panel body — they read as "wells"). Focus state turns the border `--au-selected` and inset-shadows the box.

### Code blocks

`<pre><code>` uses monospace, `--au-bg-deep` background (the recessed terminal-substrate look), `--au-text` foreground. Syntax-highlighted output uses the six accents semantically: numbers as `--au-info`, keywords as `--au-action`, strings as `--au-go`, comments as `--au-text-soft`.

## Anti-patterns

Things to avoid. Listed because they're easy to drift into.

- **Pure black on pure white.** Use `--au-text` on `--au-bg`. The retina-searing maximum-contrast pairing is what Switchboard exists to prevent.
- **Gradient overlays on chrome.** No "piss filter" yellow gradient under buttons, no diagonal stripes, no glassmorphism. The interface is matte instrument equipment, not a SaaS sign-in screen.
- **Decorative emoji in chrome.** Functional Unicode is fine (✓, ✗, ⚠, →); decorative emoji isn't. The interface reads as equipment, not as a Discord message.
- **Custom accent colors.** If you find yourself adding a seventh accent, the design discipline is to remap an existing one rather than expand the palette.
- **Inline color values.** `color: #d97a3c` is a bug; use `var(--au-action)`. The whole point of the three-layer cascade is that components don't carry the raw swatch.
- **Layer-skipping.** Component CSS reads `--au-*` only. Reaching into `--sw-*` from layer 3 makes the component impossible to retheme.

## Extending

A new component that needs to fit cleanly:

1. Read tokens from `--au-*` only.
2. Map any "what color is this?" decisions to the six-accent table by role, not by hex.
3. Match the spacing scale (multiples of 4 px; Switchboard uses an 8 px base column for chrome paddings).
4. Match the type split (monospace for instrument readouts; sans for prose).
5. If the new component needs a token that doesn't exist, propose adding it at the `--au-*` layer; don't reach past it.

A new surface that wants its own palette tweaks: define them as additional `--au-*` tokens, never raw hex. Surface-local themes override `:root` declarations inside the surface's own iframe; the parent shell's theme remains canonical for chrome.

## See also

- [ext/switchboard/SPEC.md](https://github.com/gentropic/auditable/blob/main/ext/switchboard/SPEC.md) — full canon (version 1.0). Token tables, component reference, accessibility notes, the "piss filter" anti-pattern explained.
- [Settings → Appearance](settings.md) — toggle bundled fonts, override theme, edit `/home/nb/theme.css`.
- [Auditable Works](works.md) — the consumer that bundled fonts default to "on" for.
