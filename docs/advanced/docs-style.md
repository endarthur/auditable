# Documentation Style Guide

How `README.md` and `SPEC.md` are organised across the GCU codebase. Derived from the strongest existing docs (`ext/{air,adder,calque,crypto,switchboard,atra}/SPEC.md`) — the template is what these documents already share, not a new ceremony.

The goal: a reader landing in any `ext/<name>/` folder should find the same structural skeleton, so they can navigate by section name instead of by hunting. And the docs surface (Ctrl+K search) should return uniformly readable snippets — the first paragraph of every doc matters most because that's what shows up as a result.

## Audience split

Three doc tiers, each with a different reader in mind. A package can ship any subset.

| Doc | Reader | Voice |
|---|---|---|
| `README.md` | *Someone who wants to **use** this package.* | Concrete, examples-first, API-as-table-of-contents. |
| `SPEC.md` | *Someone who wants to **understand** this package.* | Design-first, prose-heavy, lineage and rationale, longer-lived. |
| `INTERNALS.md` | *Someone who wants to **modify** this package.* | Implementation notes, walks, gotchas. Only adder + air have one today. |

Don't repeat content between them. README points readers at SPEC for "why"; SPEC points at README for "how to call it."

## The first paragraph rule

The first paragraph of every doc is its **elevator pitch** — single sentence first, optionally one expanding paragraph. No throat-clearing, no historical preamble, no "this document describes…". Two reasons:

1. The docs surface uses this as the search snippet. A bad first paragraph looks bad in every search result that hits it.
2. The reader has already decided to click into your doc; they want to confirm they're in the right place inside two seconds.

Good first paragraphs from existing specs:

```
A Python interpreter in JavaScript for auditable.
                                                            — adder

A spreadsheet language that compiles to xlsx.
                                                            — calque

The GCU canonical design system.
                                                            — switchboard

Arithmetic TRAnspiler — wat, but for humans.
                                                            — atra
```

Each is one bold sentence that tells you exactly what to expect.

## README.md template

For user-facing docs (npm-published packages, importable libraries).

```markdown
# @gcu/<name>

<one bold sentence — elevator pitch>

<one paragraph expanding the pitch: what it is, what it isn't, who it's
for. Avoid history; lead with capability.>

<optional: a minimal working example as a code block, OR an ASCII
diagram for systems with topology.>

<optional: "Pre-1.0 — APIs may change on minor version bumps." or
similar stability disclaimer.>

## Install

(only if npm-published or installable; otherwise drop)

```sh
npm install @gcu/<name>
```

## Quick start

A code block under 30 lines that shows the package doing its main job
end-to-end. The reader copies and runs this; if it doesn't work, the
doc has failed.

## API

The public surface. Each entry: signature, one-line summary, optional
example. Order by importance, not alphabetically — the most-used calls
go first.

## Usage patterns

How users *actually* use this in real code. Several worked examples
covering the common cases. Don't make the reader assemble a real
program out of API fragments.

## Options / Configuration

If the package accepts an options bag, document every key here.

## Data model

If the package has a vocabulary (types, IRs, schemas), describe it
once, here. Other sections can refer back without re-defining.

## Architecture            (optional)

One-paragraph overview of how the package is laid out. Defer the
deep design to SPEC.md if you have one.

## What's not supported

Honest enumeration of known limitations. Better to acknowledge than to
have users discover them via bug reports.

## Status                  (optional)

Pre-1.0 / stable / experimental, with a date. What APIs are stable
vs. subject to change.

## License                 (optional)

MIT, etc.
```

## SPEC.md template

For design-facing docs (contributor-onboarding, longer-lived
architectural decisions, anything that needs to outlast the next
refactor).

```markdown
# <name>

**<one bold sentence — elevator pitch>**

<one paragraph framing: what this is, what problem it solves, what's
distinctive about the approach.>

<optional: a code example or ASCII diagram within the first 30 lines.
This is the reader's "I'm in the right place" anchor.>

<optional: status / version / implementation table — see "Metadata
block" below for the canonical shape.>

---

## Lineage                 (recommended)

Where this came from, what it's like, what it's not. Even one sentence
("C is to the PDP-11 as Calque is to xlsx") earns its keep. Helps a
reader place the work in their mental map.

## Premise / Overview

The motivating argument. Why does this exist? What's the design
commitment? This is the section where you state your three big
non-negotiables (switchboard does this well: "eye-comfort first /
accents are events / single-file deployable").

## <Core domain sections>

Per-package. Examples:
- a language → Syntax, Semantics, Types, Operators
- an IR → Types, SSA, Operations, Regions, Cell Module
- a design system → Token map, Components, Theme switching
- a crypto scheme → Threat Model, Cryptographic Design, Storage Format

Order by dependency: each section should be readable using only what
came before it.

## Design principles / rationale  (recommended)

Why the package made the choices it did. Especially valuable for
choices a reader might want to revisit later — anchor the original
trade-off here so the next contributor doesn't have to reverse-engineer
it.

## Architecture / Project structure  (recommended)

The file tree, with one-line summaries per file. Calque does this in
"Project Structure"; air does it in "§14 Project Structure". Keep the
descriptions short.

## API reference            (optional)

If there's no companion README.md, document the public surface here.
Otherwise leave to README and link.

## Testing                  (optional)

What's covered, where the tests live, what running them looks like.

## Open questions / Future / Roadmap

Honest list of deferred work, known limitations, things being argued
about. Future-you will thank present-you for writing these down.

## What <name> is NOT       (recommended)

Scoping note. Forces the reader to drop expectations the package
isn't trying to meet. ("adder is not CPython"; "atra is not LLVM";
"switchboard is not a CSS framework".)

## Versioning               (optional)

Version policy. Pre-1.0 caveats. What constitutes a breaking change.
```

## Metadata block

When a doc warrants it — typically SPECs of substantial packages —
include a metadata table near the top. Switchboard's shape is the
recommended canonical:

```markdown
| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 1.0                                            |
| Status     | Canon / Draft / Implemented / Pre-1.0          |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | What this descends from, dated                 |
```

Smaller packages can use bold-prefix lines instead:

```markdown
**Status:** Implemented (v1 format)
**Date:** 2026-03-18
**Author:** Arthur (endarthur)
**Implementation:** `src/js/crypto.js`, tests: `test/crypto.test.mjs`.
```

## Anti-patterns

Things to avoid:

- **Opening with definitions of unrelated context.** ("Markdown is a
  lightweight markup language…") → cut. The reader knows.
- **API-as-prose paragraphs.** API surfaces are tables or code blocks,
  not running text. If you find yourself writing "the function `foo`
  accepts a `bar` and returns a `baz`," reach for the markdown table.
- **Hidden capabilities.** If a feature exists, it goes in the doc.
  Don't bury non-obvious switches in inline comments — promote them to
  a §Options section.
- **Stale "todo" markers without dates.** A `TODO` from two years ago
  pretending to be a roadmap item is a lie. Date your roadmap items
  so the staleness is visible.
- **"This document describes…" / "This README explains…"** The doc
  describes itself by existing. Lead with the subject, not the
  meta-subject.
- **Decorative emoji.** GCU aesthetic — functional over decorative.
  Symbols with semantic meaning (✓, ✗, ⚠, →) are fine if used
  consistently. Decorative emoji isn't.
- **Marketing voice.** "Powerful, flexible, and easy-to-use" is a
  smell. Show, don't claim.

## When to write what

- A new ext under ~500 lines of source: **README only** is usually
  enough. The package isn't load-bearing enough to need a SPEC.
- A new ext that introduces a *vocabulary* (a language, an IR, a
  protocol, a format): **SPEC required.** README optional but
  recommended.
- A new ext that's *application infrastructure* (rails, dialog,
  menu, …): **README only**, with the SPEC subsumed into the spec of
  the consumer (e.g. rails contributes to the Works spec).
- An ext that ships to npm: **README required** (it's what npmjs.com
  shows on the package page); SPEC optional.

## File location and naming

- `ext/<name>/README.md` — user-facing.
- `ext/<name>/SPEC.md` — design-facing.
- `ext/<name>/INTERNALS.md` — implementation-deep, optional.
- All caps. Markdown extension. UTF-8. Use raw Unicode characters
  (`—`, `×`, `α`, `→`, `·`) — no `\uXXXX` escapes.

The docs surface (Ctrl+K) auto-ingests every `ext/*/SPEC.md` and
`ext/*/README.md` it can find. Keep that in mind: if you write it,
people will search it.
