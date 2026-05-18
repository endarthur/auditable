# Switchboard

The GCU canonical design system. Cool neutral surfaces, six functional accents, two typefaces (Barlow + Space Mono) with a strict semantic split. Single-file deployable; no build step.

Used by everything that ships under the GCU org — Auditable, ep, Arborist, `@gcu/plan`, the handheld platform.

## What's in this directory

- **[`SPEC.md`](./SPEC.md)** — the canonical design document. Token map, accent semantics, typography rules, component patterns, accessibility requirements, anti-patterns. Read this before adding a UI to a GCU tool.
- **[`fonts/`](./fonts/)** — Barlow (sans, for humans) + Space Mono (mono, for the machine) as `.woff2` binaries, plus the combined `OFL.txt` license notice. Loaded on demand when the user enables "embed fonts" in settings; otherwise the system font fallback in the stack is used.

The implementation itself — the actual CSS custom properties and the `--sw-*` → `--au-*` semantic mapping — lives at the top of `src/style.css` (lines 1-100ish). That's where to look if you want to see what tokens are bound to what values, or copy the block into a new GCU surface.

## How it's used in this repo

The `--sw-*` tokens are the Switchboard swatches (raw colors and font stacks). The `--au-*` tokens are auditable's semantic layer that consumes them (e.g. `--au-action: var(--sw-orange)`, `--au-error: var(--sw-red)`). Component CSS reads only `--au-*` — never `--sw-*` directly. This indirection lets us re-skin auditable by remapping the `--au-*` layer without touching component CSS.

Light is `:root` (Switchboard default = equipment gray); dark is `[data-theme="dark"]` on `<html>` (= basalt). First paint reads `prefers-color-scheme`. Users can layer their own overrides via `/home/nb/theme.css` in the notebook VFS, which is loaded as `<style id="user-theme">` after the base stylesheet.

## Versioning and stability

Switchboard is at **1.0**. The accent → semantic mapping (orange=action, teal=info, green=go, amber=caution, red=fault, indigo=selected) is the stability anchor — it does not change in 1.x. See SPEC §12 for the full semver policy.

## Future: standalone package

SPEC §9 reserves `github.com/gentropic/switchboard` for a future standalone `@gcu/switchboard` package — a single `switchboard.css` file plus a tiny JS helper for theme persistence. Until that ships, each GCU project either inlines the tokens (auditable does this in `src/style.css`) or copies the block from this SPEC.

There is no plan for a React/Vue component library. Switchboard is intentionally just CSS variables and class names so it composes with whatever idiom the host tool is already using (CodeMirror chrome, native canvas, firmware-rendered keypad UI, etc.) without dragging in a runtime.

## License

MIT.
