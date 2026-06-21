# Switchboard

**The GCU UI toolkit** (the canonical design system + the component contract).

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 1.2.0                                          |
| Status     | Canon                                          |
| License    | MIT                                            |
| Org        | Geoscientific Chaos Union                      |
| Repo       | `github.com/gentropic/switchboard` *(reserved)*|
| Owner      | endarthur                                      |
| Lineage    | RelayKVM theme → generalised March 2026        |

> Shuttle flight deck, not blank paper. Cool neutral surfaces, six functional accents, two typefaces with a strict semantic split, and a hard "no piss filter" rule. Single-file deployable; no build step required.

---

## 1. Premise

Switchboard is the shared visual language for everything that ships under the GCU org — Auditable Works, Arborist, `@gcu/plan`, the handheld platform, every single-file tool that lives in someone's Downloads folder. The premise is that serious geoscientific work deserves an interface that looks like **instrument equipment**, not a SaaS dashboard.

Three commitments drive every choice:

1. **Eye-comfort first.** The brightest pixel on screen is never `#FFFFFF` and the text is never `#000000`. Max contrast is around 12:1 — above WCAG AAA, well below the retina-searing 21:1 of pure black-on-white. The interface must be readable for hours under variable lighting. This is the problem flight decks solved in 1981.
2. **Accents are events, not ambience.** The stage is cool. Orange and amber register as *something happened* — a button pressed, a warning raised — not as the colour temperature of the entire interface. (See §10. The "piss filter" rule.)
3. **Single-file deployable.** The whole system fits inside `<style>` and `<script>` blocks in one HTML file. No build step, no CSS-in-JS, no preprocessor. CSS custom properties carry all the tokens.

### 1.1 Two tiers

Switchboard is a *toolkit*, not a runtime widget framework — and the toolkit is two tiers, with Switchboard the umbrella over both:

- **Tier 1 — the language (this document):** tokens, the accent mapping, typography, the component *patterns* (§6), theming (§7), accessibility (§8). Runtime-free CSS-variables-and-class-names, so it composes with any idiom — CodeMirror chrome, native canvas, firmware-rendered keypad UI — without a runtime (§9).
- **Tier 2 — the DOM components:** separate zero-dep `@gcu/*` packages (`@gcu/menu`, `@gcu/dialog`, `@gcu/rails`, `@gcu/loom`, `@gcu/term`) that *implement* tier-1 patterns for the browser. Switchboard **rosters and contracts** them (§6.0); it does not absorb them — that would forfeit the runtime-agnosticism tier 1 exists to protect.

The boundary is the point: a sibling tool can take tier 1 alone (just the look) or tier 1 + the tier-2 components it needs, and either way stays consistent because both obey the same token contract.

---

## 2. Token map — surfaces

Four surface registers, ordered deep → bright. Lower registers recede; higher registers carry the actively-read content.

### Light mode (`:root`, equipment gray)

| Token              | Hex        | Role                                  |
|--------------------|------------|---------------------------------------|
| `--sw-bg-deep`     | `#C2C1BE`  | Recessed: terminal, readout substrate |
| `--sw-bg`          | `#D2D1CE`  | Page background                       |
| `--sw-bg-raised`   | `#E4E3E1`  | Panel body                            |
| `--sw-bg-bright`   | `#EDECEB`  | Panel header, input wells, hover      |
| `--sw-text`        | `#232322`  | Primary text                          |
| `--sw-text-mid`    | `#504F4C`  | Secondary text, supporting copy       |
| `--sw-text-soft`   | `#5A5856`  | Labels, captions, equipment text      |
| `--sw-border`      | `#B3B1AD`  | Default border                        |
| `--sw-border-soft` | `#C6C4C1`  | Inner dividers, dashed rules          |
| `--sw-rule`        | `#A5A3A0`  | Section rules, masthead divider       |

### Dark mode (`[data-theme="dark"]`, basalt)

| Token              | Hex        |
|--------------------|------------|
| `--sw-bg-deep`     | `#0E1012`  |
| `--sw-bg`          | `#15171A`  |
| `--sw-bg-raised`   | `#1D2024`  |
| `--sw-bg-bright`   | `#25282D`  |
| `--sw-text`        | `#DDDCDA`  |
| `--sw-text-mid`    | `#9E9C98`  |
| `--sw-text-soft`   | `#83817E`  |
| `--sw-border`      | `#2F3338`  |
| `--sw-border-soft` | `#24272B`  |
| `--sw-rule`        | `#3A3E44`  |

The dark register is named **basalt**. The light register is **equipment gray** — explicitly *not* paper, *not* cream, *not* warm.

---

## 3. Token map — accents

Six functional accents. Each has a desaturated **soft** variant used for tinted backgrounds (badges, focus rings, callout fills). The accent → semantic mapping is **not negotiable inside a tool**.

| Accent | Semantic   | Light hex  | Light soft | Dark hex   | Dark soft  |
|--------|------------|------------|------------|------------|------------|
| Orange | **Action** — you initiated it; primary buttons; ET-foam | `#954015` | `#E8D8CF` | `#D4672E` | `#2E1F18` |
| Teal   | **Info** — links, info badges, terminal prompt           | `#196369` | `#CEE2E4` | `#3A9BA3` | `#16272A` |
| Green  | **Go** — success, connected, verified, GO                | `#356437` | `#D2E4D4` | `#5A9B5E` | `#18261A` |
| Amber  | **Caution** — weak signal, low battery, pending          | `#755314` | `#E4DCCC` | `#C49540` | `#2A2316` |
| Red    | **Fault** — error, dead device, failed auth              | `#A43029` | `#E8D6D4` | `#D05048` | `#2C1A18` |
| Indigo | **Selected** — focus, standby, idle, highlighted         | `#4E5580` | `#D8D9E2` | `#7E86B8` | `#1E2030` |

CSS variable naming: `--sw-{name}` for the accent, `--sw-{name}-soft` for the tint. Example: `--sw-orange`, `--sw-orange-soft`.

**Do not introduce additional accents.** If the design needs a seventh colour, it almost certainly needs a re-think of the semantic load instead.

---

## 4. Other tokens

| Token              | Value     | Role                              |
|--------------------|-----------|-----------------------------------|
| `--sw-radius`      | `3px`     | Default — buttons, badges, inputs |
| `--sw-radius-lg`   | `4px`     | Panels, readouts, terminal        |
| `--sw-mono`        | `'Space Mono', 'JetBrains Mono', 'Consolas', monospace` | All mono surfaces |
| `--sw-sans`        | `'Barlow', system-ui, sans-serif`                       | All sans surfaces |
| `--sw-z-raised` … `-shield` | `10 / 100 / 1000 / 2000 / 2147483647` | Layering ladder: raised → dropdown → overlay → modal → shield. One scale so overlays don't fight; `-shield` is the cross-origin iframe pointer-shield (above everything). |
| `--sw-dur-fast` / `--sw-dur` | `0.12s / 0.2s` | Motion durations — short by default |
| `--sw-ease`        | `cubic-bezier(0.2, 0, 0, 1)` | The one easing curve (ease-out, no bounce) |
| `--sw-tap`         | `44px`    | Minimum interactive target on touch (`pointer: coarse`) |

Each has a `--au-*` mirror (the component-facing layer), same as `--sw-radius → --au-radius`. Z-index, motion, and tap are theme-independent (defined once in `:root`, not re-mapped in dark).

No shadow tokens. Switchboard does not use drop shadows — depth comes from surface register and 1px borders. (Exception: a 3px outer ring of the accent's `-soft` variant on focused inputs.)

No spacing scale tokens. Use plain `rem` values; the codebase has been consistent on `0.3rem / 0.45rem / 0.6rem / 0.85rem / 1rem / 1.25rem / 1.5rem` without needing to name them.

**Touch / mobile.** Desktop is the default density and the "just use rem" rule above holds there. On `pointer: coarse` (handheld — FieldWorks et al.), interactive controls grow to `--sw-tap` (44px) minimum, and density loosens by feel — but a *named* density scale (comfortable/compact) is intentionally deferred until a real mobile surface (FieldWorks) forces the exact values, rather than guessed up front. Don't ship a sub-44px tap target on a touch build.

---

## 5. Typography

Two typefaces, with a **strict semantic split**.

### Barlow — for humans

Body, headings, descriptions, prose. The California public-infrastructure signage font: utilitarian, plain-spoken, slightly geometric, never generic. Weights used: 400 / 500 / 600 / 700.

| Style    | Family  | Size      | Weight | LH    | Tracking |
|----------|---------|-----------|--------|-------|----------|
| Display  | Barlow  | 1.9rem    | 700    | 1.1   | -0.015em |
| H2       | Barlow  | 1.45rem   | 600    | 1.2   | -0.01em  |
| Heading  | Barlow  | 1.2rem    | 600    | 1.3   | 0        |
| Body     | Barlow  | 1rem      | 400    | 1.55  | 0        |
| Default  | Barlow  | 14.5px    | 400    | 1.55  | 0        |

### Space Mono — for the machine

Labels, data values, terminal output, code, gauges, equipment text. Carries everything technical. If it's mono, it's **a quantity, a token, or something the machine cares about**.

| Style             | Family     | Size    | Weight | Tracking |
|-------------------|------------|---------|--------|----------|
| Caption           | Space Mono | 0.78rem | 400    | 0.06em   |
| Section label     | Space Mono | 0.68rem | 700    | 0.22em UPPERCASE |
| Panel header      | Space Mono | 0.72rem | 400    | 0.14em UPPERCASE |
| Field label       | Space Mono | 0.7rem  | 400    | 0.12em UPPERCASE |
| Button            | Space Mono | 0.78rem | 700    | 0.10em UPPERCASE |
| Gauge label       | Space Mono | 0.62rem | 400    | 0.18em UPPERCASE |
| Gauge value       | Space Mono | 1.35rem | 700    | tabular-nums    |

**The split is doctrinal.** Switching between mono and sans within the same surface — for example, "readable" sans-serif body inside an otherwise mono control panel — looks like the tool can't decide what it is. Pick the surface's idiom and stay there.

---

## 6. Components

The patterns below (§6.1–6.6) are the **tier-1 specification** — what each thing
looks like, in tokens. The **tier-2 DOM packages** implement them for the browser.
§6.0 is the contract that keeps the two tiers — and any *new* component, here or in
a sibling repo — consistent.

The §6.1–6.6 patterns are the *primitives*; the higher-traffic composite
components live as tier-2 packages and are specified **by their package**, not
re-documented here. The catalog, complete-by-reference:

| Component | Spec home |
|---|---|
| Panel · Button · Badge · Form field · Device readout · Terminal | §6.1–6.6 (here) |
| Popup menu · menubar · context menu | `@gcu/menu` |
| Modal · confirm · prompt | `@gcu/dialog` |
| Docked tabs · stacks · floats | `@gcu/rails` |
| Table / data grid | `@gcu/loom` |
| Terminal emulator (runtime) | `@gcu/term` |
| Tree / file explorer · toast / status · tooltip · slider & widgets | *not yet a documented pattern — see the consuming surface; promote to a tier-2 package or a §6.x pattern when a second consumer appears* |

The last row is the honest edge: those exist in the app but aren't yet a *named*
Switchboard pattern. They obey §6.0 by construction (they read `--au-*`); formalize
each the moment a second surface needs it.

### 6.0 The component-authoring contract

A Switchboard tier-2 component (a runtime DOM widget that wants to belong to the
toolkit) obeys four rules:

1. **Read `--au-*`, never `--sw-*` or hard-coded color.** Component CSS consumes
   the host app's *semantic* layer (`--au-action`, `--au-info`, `--au-error`, …),
   never the raw swatches and never literal hex. The host maps `--sw-* → --au-*`
   once; re-skinning happens there, untouched component CSS. (Hard-coding a color
   is the one unforgivable break — it desyncs from light/dark and from re-skins.)
2. **Ship structure-only CSS + an optional `-default` theme.** The package's main
   CSS carries layout/structure that references `--au-*`; a separate
   `<name>-default.css` provides a standalone fallback mapping so the component
   renders correctly with no host. (Pattern in `@gcu/menu`: `menu.css` structural +
   `menu-default.css` theme; a host that already defines `--au-*` includes only the
   structural sheet — auditable strips the `-default`'s `:root` block so it doesn't
   fight the host tokens.)
3. **Obey the accent semantics (§3) and the anti-patterns (§10).** action=orange,
   info=teal, go=green, caution=amber, fault=red, selected=indigo — non-negotiable;
   no drop shadows (depth = surface register + 1px borders); no piss filter.
4. **No runtime dependency leak.** A tier-2 component is a zero-dep leaf (it may use
   the bus/VFS via injection, like surfaces do, but it doesn't drag a framework).
   This is what lets a host compose only the components it needs.

A component that honors §6.0 drops into any GCU tool and inherits its theme,
light/dark, and user overrides for free.

### 6.1 Panel

The atomic container. `--sw-bg-raised` body, 1px `--sw-border`, `--sw-radius-lg` corner. Optional header on `--sw-bg-bright` with a 1px bottom border.

```html
<div class="panel">
  <div class="panel-header">
    <span class="panel-tag"><span class="dot"></span>SURFACES</span>
    <span>--sw-bg-*</span>
  </div>
  <div class="panel-body">…</div>
</div>
```

The `.dot` is a 7px circle in `--sw-green` with a 2px `box-shadow` ring of `--sw-green-soft` — equipment status light. Tag text is mono, uppercase, `--sw-text-mid`.

### 6.2 Button

Three variants. All mono, uppercase, 0.1em tracking, `--sw-radius`.

| Variant    | Background        | Text       | Border        | Hover                          |
|------------|-------------------|------------|---------------|--------------------------------|
| `primary`  | `--sw-orange`     | `#FFFFFF`  | none          | `filter: brightness(1.08)`     |
| `secondary`| transparent       | `--sw-text`| `--sw-border` | border + text → `--sw-orange`  |
| `ghost`    | transparent       | `--sw-teal`| none          | brightness                     |

Orange is always primary. Teal is always the ghost / link-style variant. Do not introduce other coloured buttons.

### 6.3 Badge

Inline pill with a leading `currentColor` dot. Background is the accent's `-soft`, text is the accent. Mono, uppercase, 0.1em tracking. Six variants — one per accent — and one only per accent.

```html
<span class="badge action">Action</span>
<span class="badge go">Go</span>
<span class="badge fault">Fault</span>
```

### 6.4 Form field

Stacked label + input. Label is mono, uppercase, `--sw-text-soft`. Input is mono `0.9rem`, `--sw-bg` background, 1px `--sw-border`. Focus state replaces border with `--sw-orange` and adds a 3px `box-shadow` ring of `--sw-orange-soft`.

```html
<div class="field-row">
  <label>Project ID</label>
  <input type="text" value="QF-2026-S11D-DH-0184">
</div>
```

### 6.5 Device readout

The signature Switchboard component. Sits on `--sw-bg-deep` (terminal substrate), 1px border, `--sw-radius-lg`.

Structure:

1. **Top bar** — mono uppercase, ID and status, `--sw-text-mid`.
2. **Body** — grid of `.gauge` cells.

Gauge cell: mono label (`--sw-text-soft`), large tabular-nums value (state-coloured), small unit.

```html
<div class="readout">
  <div class="readout-top">
    <span>DEVICE READOUT · NODE-03</span>
    <span>UPLINK ◉</span>
  </div>
  <div class="readout-body">
    <div class="gauge go">
      <div class="label">Signal</div>
      <div class="value">-42<span class="unit">dBm</span></div>
    </div>
    …
  </div>
</div>
```

State classes on `.gauge` (`go`, `caution`, `fault`) colour the **value** only — never the label, never the cell background.

### 6.6 Terminal

`--sw-bg-deep` substrate. Mono throughout. ANSI colour slots map to the six accents:

| Slot      | Token            | Use                                    |
|-----------|------------------|----------------------------------------|
| prompt    | `--sw-teal`      | Hostname/path prompt                   |
| user      | `--sw-orange`    | `$` / user input glyph; cursor         |
| ok        | `--sw-green`     | `✓` lines, success output              |
| warn      | `--sw-amber`     | `⚠` lines, deprecation warnings        |
| err       | `--sw-red`       | `✗` lines, errors                      |
| dim       | `--sw-text-soft` | Subprocess noise, hints                |

Cursor: 0.55em × 1.05em solid block in `--sw-orange`, blinking at 1.05s with `steps(1)`. (Crucially `steps(1)`, not a smooth transition — the cursor should jump, not fade.)

### 6.7 Interaction states

The states every interactive component shares (transitions use `--au-dur` /
`--au-ease`; all freeze under `prefers-reduced-motion`, §8):

| State | Treatment |
|---|---|
| hover | `brightness(1.08)` (lighten); cursor `pointer` |
| active | `brightness(0.92)` (press) — never a transform/bounce |
| focus-visible | buttons: 2px `--au-action` outline, 1px offset · inputs: 3px `--au-action-soft` ring (§6.4) |
| disabled | `opacity: 0.5` + `cursor: not-allowed`; no hover/active response |
| selected | `--au-selected` (indigo) border/tint — the one accent reserved for it (§3) |

No positional motion on hover/active — depth and feedback come from brightness +
border, the same restraint as "no drop shadows." See it live in `styleguide.html`.

---

## 7. Theme switching

Switchboard ships dark-default. Theme is controlled by `data-theme` on `<html>`:

```html
<html data-theme="dark">   <!-- basalt -->
<html>                     <!-- equipment gray (default :root) -->
```

CSS uses `[data-theme="dark"] { … }` to override the base tokens. Every component reads from CSS custom properties, so a single attribute flip re-themes the entire page with no JS beyond toggling the attribute.

Persistence and system-preference detection (`prefers-color-scheme`) are application-level concerns and out of scope for the spec — but the recommended pattern is `localStorage` + `matchMedia` for first-paint, written to the attribute before the first render to avoid flash.

---

## 8. Accessibility

Hard requirements:

- **All text against its primary surface ≥ WCAG AA (4.5:1).** Most pairings hit AAA (7:1+).
- **All six accents distinguishable under deuteranopia, protanopia, and tritanopia simulation.** Tested via CIE ΔE2000.
- **Never carry meaning in colour alone.** Status colours are always paired with an icon, glyph, badge text, or position. A red value without an `✗` or "FAULT" label is non-compliant. The canonical status/action glyph set (`✓` go · `⚠` caution · `✗` fault · `◉` live · `⊕` add · …) is unicode (no icon font) — rostered in `styleguide.html`.
- **Focus states are visible.** Inputs get the 3px `--sw-orange-soft` ring. Buttons get a 2px outline of `--sw-orange` on `:focus-visible`.
- **Hit targets:** ≥ `--sw-tap` (44×44px) on touch (`pointer: coarse` — the handheld/FieldWorks builds); ≥ 32×32px on fine pointers (desktop). Never below 44 on a touch surface.
- **Honor `prefers-reduced-motion`.** Transitions/animations use `--au-dur*` + `--au-ease`; under `@media (prefers-reduced-motion: reduce)` components drop them to ~0. (The terminal cursor blink may stay — it carries state, not decoration.)

Contrast reference, **dark mode on the primary surface `#15171A`** (the surface the "≥ AA against its primary surface" rule actually scopes to — `styleguide.html` computes these **live per theme**, flagging any text tier below AA). Measured, not approximate:

| Token       | Hex       | Ratio   | Level    |
|-------------|-----------|---------|----------|
| text        | `#DDDCDA` | 13.1:1  | AAA      |
| text-mid    | `#9E9C98` | 6.6:1   | AA       |
| text-soft   | `#83817E` | 4.6:1   | AA       |
| orange      | `#D4672E` | 4.9:1   | AA       |
| teal        | `#3A9BA3` | 5.5:1   | AA       |
| green       | `#5A9B5E` | 5.4:1   | AA       |
| amber       | `#C49540` | 6.6:1   | AA       |
| red         | `#D05048` | 4.2:1   | AA large |
| indigo      | `#7E86B8` | 5.1:1   | AA       |

(Earlier this table was measured on `#0E1012` (deep), which masked that `text-soft` failed AA on the *primary* surface — caught by the live readout, fixed in 1.1.1. The accents are AA / AA-large on surface; they carry meaning only glyph-paired, §8 above, so AA-large is compliant for them. Light mode runs a touch tighter — re-check via the styleguide.)

---

## 9. Implementation pattern

Switchboard is consumed in two shapes:

1. **Inline `<style>` block** — the single-file deploy default. Paste the tokens block at the top of `:root`, paste components as needed.
2. **`@gcu/switchboard` package** *(v0.1, shipped)* — `ext/switchboard/switchboard.css` (the canonical token file) + `theme.js` (the ~1KB persist/toggle/first-paint helper). No JS runtime, no React component layer; the system is just CSS variables and class names. The in-repo token copies are parity-tested against `switchboard.css` (`test/switchboard-tokens.test.mjs`); build-inline consumption (deleting the copies, sourcing from the package) is the next step.

There is no plan for a Switchboard React/Vue component library. The whole point is that the tokens compose with whatever idiom the tool is already in — Auditable's CodeMirror chrome, Arborist's panel layout, the handheld's keypad firmware-rendered UI all share the palette without sharing a runtime.

---

## 10. Anti-patterns

**The piss filter.** The first draft of Switchboard was warm — putty surfaces, sepia accents. It looked like a faded crew manual. Don't warm the stage. Warmth across the entire interface makes orange and amber stop reading as events and start reading as the ambient colour temperature. Stage stays cool. Accents play.

**Sans for data.** Body sans-serif inside a control panel reads as a SaaS dashboard. If it's a value, a label, a token, or equipment text — it's mono.

**Decorative accents.** Orange means action. It does not mean "I felt like adding an orange thing here." A purely decorative use of an accent dilutes the semantic load of every other use. The whole system collapses into "colours I like" without discipline.

**Drop shadows.** Switchboard does not have drop shadows. Depth is surface register + 1px borders. Adding `box-shadow` to a panel makes it look like Material Design wandered into the building.

**Inventing a seventh accent.** If a design needs purple/pink/cyan/lime, the design is leaking semantic load that should be solved by composition (badges + glyphs + labels) instead.

**Pure black or pure white text.** Never `#000` and never `#FFF`. The eye-comfort rule is the foundational commitment.

---

## 11. File and naming conventions

- Tool stylesheets that embed Switchboard live at the top of the file as a single `<style>` block, ordered: tokens → resets → typography → layout → components → utilities.
- Class names use BEM-ish flat naming: `.panel`, `.panel-header`, `.panel-body`, `.field-row`, `.badge.action`. No SCSS, no nesting, no naming framework dependency.
- Two custom-property layers, both **canonical GCU vocabulary** (not app-specific despite the `au` reading): `--sw-*` are the raw **swatches** (Layer 1 — the only things a theme re-skins), `--au-*` are the **semantic** tokens components read (Layer 2 — `--au-action`, `--au-surface`, `--au-z-modal`, …). The `--au-` prefix is *shared across every GCU app* — `@gcu/menu` and friends read `--au-action`, so ep/weir/koma/Arborist all define the same `--au-*` names (it's a Switchboard contract, not Auditable's private namespace; the `au` is historical, read it as "the canonical semantic layer"). A true rename to a neutral prefix is a possible future major, but the *names are the contract* regardless of the letters. Never read `--sw-*` from a component (§6.0); never hard-code hex.
- Token order in `:root` follows §2 → §3 → §4 (surfaces → accents → other). Dark mode overrides go in a single `[data-theme="dark"] { … }` block at the end of the token section.

---

## 12. Versioning

Switchboard follows semver:

- **MAJOR** — token name changes, semantic remapping of an accent, removing a component.
- **MINOR** — new component, new soft tint, new utility class. Tokens stable.
- **PATCH** — hex value tweaks within ≤ 2 ΔE, contrast-table refresh, doc fixes.

**1.2.0** — **light accents darkened to clear AA as text on the primary surface.** The readout showed the light six at 3.38–4.69:1 (all but indigo below AA-normal) — fine for glyph-paired status, but accent *text* (links use `info`, headers use `action`) was sub-AA. Darkened each just to ~4.55:1, hue preserved (scaled toward black), indigo left (already 4.69): orange `#B54E1A→#954015`, teal `#1B6B72→#196369`, green `#3D7340→#356437`, amber `#8E6518→#755314`, red `#A8312A→#A43029`. Light-only (dark accents already pass); `-soft` tints unchanged (badge/fill contrast only improves — darker accent on the same pale tint). MINOR not PATCH: a coordinated, *visible* palette shift, though names + semantics are stable (orange is still action). The muted equipment palette absorbs the darkening as "deeper," not "muddier" — but `amber`/`orange` shifted most; if either loses character, give *that one* a text-only `-ink` variant rather than the whole set going two-tier. All four token copies updated; parity green.

**1.1.1** — accessibility fix the live readout surfaced: `--sw-text-soft` failed AA on the *primary* surface (3.43:1 dark / 2.88:1 light — the old §8 table hid it by measuring on the deep surface). Bumped to **`#83817E` (dark, 4.64:1)** / **`#5A5856` (light, 4.63:1)**; the warm-gray hue is preserved (scaled in place). A visible nudge (slightly beyond the ≤2 ΔE PATCH guideline) but it's a compliance fix, not a restyle — kept PATCH. §8 table rebased to the primary surface with measured values; all four token copies updated in lockstep (parity test green).

Current: **1.1.1**. The accent mapping (orange=action, teal=info, green=go, amber=caution, red=fault, indigo=selected) is the stability anchor — it does not change in 1.x.

**1.1.0** — additive (MINOR; existing tokens stable). New token groups in `:root`: z-index ladder (`--sw-z-*`), motion (`--sw-dur*` / `--sw-ease`), touch target (`--sw-tap`), each with an `--au-*` mirror. New: §4 touch/mobile guidance, §6 complete-by-reference component catalog, §8 `prefers-reduced-motion` requirement + 44px touch target. §11 now documents the two-layer naming and **canonicalizes `--au-*` as the shared GCU semantic vocabulary** (clarifies the cross-app contract; not a rename — a true neutral-prefix rename would be a future MAJOR). New **§6.7 interaction states** (hover/active/focus/disabled/selected — filling the slot the removed band vacated), and **§8 names the unicode glyph set**. A living styleguide (`styleguide.html`) renders the whole language in both themes — and adds **live per-theme WCAG contrast** (flagging any text tier below AA), the interaction-state matrix, and the glyph roster.

**1.0.1** — removed the *module identification band* (the six-accent stripe) from the device readout and as a standalone component. Treated as a PATCH/doc-fix, not the MAJOR a component removal would normally be (above): the band was only ever spec text — never implemented in `switchboard.css`, never used by a surface — so nothing consuming the language breaks. It was decorative inheritance from the original RelayKVM draft that didn't earn its place against the functional-over-decorative rule.

---

## 13. Lineage

Switchboard descended from the RelayKVM theme prototyped in March 2026. The RelayKVM connection manager needed a UI that looked like rack-mount equipment without being kitsch, and the first draft landed on the shuttle flight deck idiom — Tektronix bezels, Rockwell Collins MFDs, crew procedure manuals. When the GCU stack started needing a shared visual language across Auditable, Arborist, and the handheld platform, the RelayKVM tokens were lifted, the warm cream surfaces were exorcised (the "piss filter" critique), and the six-accent system was formalised.

The earlier GCU colour system v5 (dark background, copper/amber cursor, dual-temperature ANSI) was a precursor; Switchboard supersedes it for all new work.

One element from that first draft was later dropped: the six-accent *module identification band* (the coloured stripe). It read as equipment-language flavour on paper but, in practice, was decoration that never got built or used — and a full-spectrum stripe sits awkwardly against the hard "each accent means one thing" rule. Removed in 1.0.1; the accents earn their place by carrying state, not by lining up as a swatch.

---

*Geoscientific Chaos Union · MIT · 2026 · single-file*
