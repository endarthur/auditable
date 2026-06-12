# `@gcu/markdown` — the GCU markdown engine

**Status:** SPEC — not built. Supersedes the reconstructed `@gcu/md` draft (2026-04,
re-emitted from Claude web; archived at `spec_inbox/old/gcu-md-spec-reconstructed.md`).
**Package:** `@gcu/markdown` (`ext/markdown/`, bundled to `index.js`; the name matches the
existing works shared-lib slot, so landing here retires build.js's
`SHARED_LIB_SOURCE_OVERRIDES.markdown` special-case).
**Dependencies:** none. Math rendering, syntax highlighting, and HTML sanitization are
explicitly *not* dependencies — the first two are downstream hooks, the third does not exist.

---

## 1. Why

The GCU currently runs **six** markdown implementations:

| Where | What | Lines | Posture |
|---|---|---|---|
| `src/js/markdown.js` | `renderMd` — the canonical mid-weight renderer | ~250 | regex passes; raw HTML allowed, **blacklist**-sanitized |
| `works/surfaces/preview.html` | self-contained mini fork | ~45 | escape-everything; no tables/images |
| `works/surfaces/doc.html` | the same fork + raw-HTML line pass-through | ~45 | escape + per-line raw HTML |
| `../cradle/doc/` | **vendored markdown-it + 4 plugins** | 133 KB raw / ~57 KB gz | `html:false`, renderer-rule overrides, allowlists — "generate, never sanitize" |
| `../cradle/ext/shared/inline.js` | safe-inline core for field renderers (menu/contact/bio/recipe) | ~35 | escape-first + link allowlist |
| `ext/gcu-press/src/parse.js` | md → typesetting AST | ~70 | headings/paragraphs only; **ignores inline markup** |

cradle vendored markdown-it because `renderMd` failed it twice: dialect coverage
(no nested lists, footnotes, sup/sub/mark, autolinks) and security model (sanitize-after
vs inert-by-construction). The surface forks exist because they predate the lib-inlining
mechanism. gcu-press can't typeset emphasis because nothing hands it an inline AST.

One engine, with the right architecture, replaces all of these over time and gives the
stack a markdown it *owns* — the `@gcu/yaml` move: not spec-compliance theater, a
**well-specified dialect** with cross-parser tests.

## 2. Design principles

1. **Liberal reading, strict authoring.** Markdown *arrives* from outside (`.ipynb`
   imports, READMEs of installed packages, gcu-library books, agent-authored cradle
   docs) — the reader accepts the high-frequency variants of the wild. The one-way
   "sane-md" dialect survives as a **lint profile** enforced at authoring time, the same
   place cradle puts strictness (`validate`, not `render`). Liberality is bounded:
   constructs that cause *true* ambiguity or parser pathology are removed outright (§3.3).
2. **No regexes in the engine.** A character scanner; block pass + inline pass; linear
   time in input length. (Anti-ReDoS by construction, and the perf story for long docs.)
3. **No raw HTML execution — and no sanitizer.** Two-position toggle, nothing between
   (§5). The blacklist sanitizer in `markdown.js` is *deleted*, not ported.
4. **AST with source offsets.** Every node carries `{ start, end }` into the source.
   The AST is a public surface: renderer-rule overrides hang off it, tooling
   (lint/diagnostics) reads it, and gcu-press typesets from it.
5. **Lenient degradation.** Malformed input never throws and never corrupts structure —
   unterminated emphasis, broken tables, stray markers render as literal text.
6. **The consumer owns the output.** cradle's renderer-rule pattern: every emitter
   (link, image, heading, code fence, …) is overridable per call, so a consumer applies
   its own policy/markup without forking the parser.

## 3. Dialect

### 3.1 Blocks (reading grammar)

- **Headings** — ATX only: `#` … `######`. Optional trailing `#`s tolerated.
- **Paragraphs** — runs of non-blank lines. Soft break = single newline → space
  (CommonMark/Jupyter behavior). Hard break = trailing `\` (canonical) **or** trailing
  two-spaces (accepted on read — ubiquitous in wild md; flagged by `strict`).
- **Fenced code** — ``` or ~~~, optional info string → `class="language-<tag>"` on
  `<code>`. No highlighter bundled; the class is the hook.
- **Lists** — bullets `-` / `*` / `+` (accepted; `-` canonical), ordered `1.` / `1)`.
  **Nested** via indentation: 2 spaces per level canonical; 2–4 accepted per parent
  marker width (the pragmatic middle of CommonMark's rule, without its full laziness
  machinery). Tight/loose list spacing per the usual blank-line rule.
- **Blockquotes** — `>` prefix, nestable. No lazy continuation (§3.3).
- **Thematic break** — `---` / `***` / `___` on its own line (3+ chars).
- **Tables** — GFM pipe tables with `:--` / `:-:` / `--:` alignment (extension, §4).
- **Link reference definitions** — `[label]: url "title"` collected in a first pass;
  `[text][label]` and collapsed `[label][]` / shortcut `[label]` resolve against them.
  (Old draft dropped these; READMEs use them constantly — reading-liberality wins.)

### 3.2 Inlines (reading grammar)

- `` `code` `` (backtick runs balance per CommonMark's simple rule)
- `**bold**` / `__bold__`; `*italic*` / `_italic_` — **simplified flanking**: a run
  opens if followed by non-space, closes if preceded by non-space; intraword `_` does
  not trigger (the one flanking rule worth keeping). No `***bold-italic***` resolution
  gymnastics — `***x***` parses as bold(italic(x)) by greedy-outer rule, documented.
- `~~strikethrough~~`
- `[text](url "title")`, `![alt](url "title")`, reference forms (§3.1)
- Autolinks — `<https://…>` always; bare-URL linkification as an extension (§4)
- Hard-break `\`, escapes `\*` etc. for all marker characters

### 3.3 Removals (parse-level, not lint-level — these never parse as markup)

| Removed | Why |
|---|---|
| Setext headings (`===` / `---` underlines) | ambiguous with hr + table rows; the classic md footgun |
| Indented (4-space) code blocks | silent data-mangler #1 in wild md; fences are universal now |
| Lazy continuation (quote/list text without prefix) | the single largest source of CommonMark parser complexity |
| Raw HTML as markup | escaped to literal text — §5; the entire injection class removed |
| Tab-stop arithmetic | tabs in indentation count as a fixed width; no column-4 expansion rules |

### 3.4 The `strict` authoring profile (lint, not parse)

`lint(src)` returns source-mapped findings for everything the reader accepts but the
GCU dialect canonicalizes away: `*`/`+` bullets (→ `-`), `__`/`*` emphasis (→ `**`/`_`),
two-space hard breaks (→ `\`), `1)` ordered markers, indentation that isn't 2/level,
heading-level jumps, reference-link defs that are never used. Authoring tools (the doc
surface, cradle's validate kit, a future `fmt`) consume this; `render` never rejects.

## 4. Extensions

Individually toggleable; presets bundle them (§7). Each is a small, contained grammar
addition — no plugin API in v1, they live in-tree (the registry IS the option flags).

| Extension | Syntax | Notes |
|---|---|---|
| `tables` | GFM pipes | on in every preset |
| `tasklists` | `- [ ]` / `- [x]` | renders disabled checkboxes |
| `strike` | `~~x~~` | on everywhere |
| `footnotes` | `[^1]` + `[^1]: …` | cradle-doc parity; hoisted to a `<section class="footnotes">` |
| `math` | `$inline$`, `$$display$$` | AST nodes carry raw LaTeX + mode; rendering via `mathRenderer(latex, mode)` hook — **zero math dep** (temml ≈ 48 KB gz, KaTeX ≈ 74 KB gz stay downstream) |
| `admonitions` | MkDocs `!!! type "title"` | renderMd parity; recursive body |
| `kbd` | `++ctrl+enter++` | renderMd parity |
| `headingIds` | explicit `{#id}` suffix **and** opt-in auto-slugs | explicit ids are the cradle P1 finding (markdown-it silently corrupts them); auto-slug stays available because docs.html/notebook TOCs depend on it. Explicit wins over auto; collisions deduped `-2`, `-3` |
| `autolinkBare` | linkify bare `https://…` | off for prose-heavy content (false positives), on for READMEs |
| `subsup` / `mark` | `~x~` / `^x^` / `==x==` | covers the common inline-HTML uses (`<sub>`, `<sup>`, `<mark>`) so banning HTML costs less |
| `comments` | `// line comments`, `\//` escape | the GCU addition from the old draft. **Off except in `gcu` preset** — wild prose contains `//` (paths, URLs already protected by code spans, but bare prose too) |

## 5. Security model

**Two positions. No third.**

- **`html: false` (default).** Raw HTML — block or inline — is escaped to literal text.
  Inert by construction; there is nothing to sanitize because nothing is interpreted.
- **`html: true`.** Verbatim pass-through, **zero filtering**. For contexts where the
  author already holds code execution: app export, self-authored generation, the
  template layer's `${{ }}`. If the author can run code, sanitizing their HTML is theater.

There is deliberately no `html: 'sanitize'`. A correct sanitizer is an HTML parser plus
a policy engine — a second product, and the bug class this design exits. If a "basic
tags" allowlist is ever genuinely needed, it is a separate opt-in module with its own
spec and adversarial review, not a render option.

**The notebook uses `html: false`.** The load-bearing observation: *md cells render on
open; code cells run on consent.* A received notebook is readable without executing
anything — except md cells, which render immediately. They are therefore the one place
a hostile notebook acts without consent, and must be data-safe. The sanctioned escape
hatch is the **HTML cell** — a first-class cell type with clear semantics — plus the
md-native equivalents (`subsup`/`mark`/`kbd` extensions, `\` breaks, native images and
tables) that cover most legitimate inline-HTML habits. Existing notebooks with raw HTML
in md cells degrade to visible escaped text (not corruption); pre-1.0 this is an
accepted break, and the `.ipynb` importer should flag md cells containing `<` markup.

**URL policy (active in both html modes — these govern md-generated output):**

- Links: scheme allowlist `https: http: mailto: tel:` + in-page `#anchor` + relative
  paths. Scheme detection strips ASCII controls/whitespace first (`java\tscript:` does
  not slip). Disallowed → rendered as plain text, never as a dead link.
- Images: `https:`/relative, plus `data:image/(png|jpe?g|gif|webp)` — raster only,
  **no SVG** (script vector). Disallowed → alt text.
- Both policies are renderer rules (§6), so a consumer can tighten (cradle: no remote
  images at all) or relax (notebook: allow `blob:`) explicitly.

**DoS posture:** linear-time scanner, no backtracking, optional `maxBytes` input cap,
reference/footnote maps bounded by definition count (no quadratic resolution).

## 6. API

```js
parse(src, opts)          → { ast, refs, warnings }     // AST nodes carry {start,end}
render(src, opts)         → html string                 // parse + renderAst
renderAst(ast, opts)      → html string
lint(src, opts)           → [{ rule, message, start, end }]   // the strict profile
```

`opts`:

```js
{
  html: false,                  // §5 — the only two-position toggle
  extensions: { tables: true, footnotes: false, /* … §4 */ },
  rules: {                      // renderer-rule overrides (cradle's pattern)
    link({ href, title, children }, ctx) { … },   // return html string
    image({ src, alt, title }, ctx) { … },
    heading({ level, id, children }, ctx) { … },
    codeBlock({ lang, code }, ctx) { … },
    // … one per node type; unset rules use the defaults (which implement §5 policy)
  },
  mathRenderer: (latex, mode) => string,   // absent → <span class="math">$…$</span> passthrough
  linkPolicy / imagePolicy,                // override the §5 allowlists explicitly
  maxBytes,                                // input cap; beyond → throw (caller-visible, not a truncation)
}
```

**Presets** (plain exported opts objects, not magic): `presets.notebook` (auditable md
cells — admonitions/kbd/math/auto-slug ids on, html off), `presets.docs` (works
docs/reader — same + footnotes), `presets.wild` (READMEs/ipynb — autolinkBare on,
comments off, everything tolerant), `presets.gcu` (strict-authored content — comments
on), `presets.doc1` (cradle-doc parity — footnotes/subsup/mark/headingIds, cradle's
image policy). A preset is a starting point; consumers spread-and-override.

**Interpolation is NOT in the engine.** The old draft folded `${}` / `${{}}` / `${node}`
typed interpolation into the renderer; auditable already has a working two-track DOM
patching layer (cell-render's comment markers + `data-audit-abind`) that must keep
working. The engine's contribution is the AST + a stable `text` node boundary so the
cell-render layer finds interpolation sites without string-hacking rendered HTML. The
`${node}` DOM-splice idea (live sideact widgets in prose, no string round-trip) is
endorsed and lives in cell-render, where the DOM already is. cradle's `${{ }}`-style
caller-raw belongs to `@gcu/template`'s filter, same reasoning.

## 7. Output compatibility

`renderMd`'s consumers have CSS and tooling against its markup. The default rules keep:
admonition classes (`admonition admonition-<type>`), table markup shape, heading
auto-slug algorithm (so existing TOC anchors don't move), `language-<tag>` code classes,
`<kbd>` pills. Divergences get called out in the migration notes, verified by golden
files diffed against current `renderMd` output over the test corpus.

## 8. Consumers & migration

In order:

1. **Build `ext/markdown/`** (src/ + concat build like every ext; `index.js` output).
   Tests first-class: the adversarial corpus (port cradle's + current `markdown.test.mjs`
   XSS cases), golden files vs current `renderMd`, **cross-parser diffing vs markdown-it**
   over the declared dialect (the `@gcu/yaml`-vs-ruamel play), fuzz for the never-throw
   guarantee.
2. **`src/js/markdown.js` → re-export stub** (the `vfs.js` pattern) exposing
   `renderMd = (src) => render(src, presets.notebook)`. Kills
   `SHARED_LIB_SOURCE_OVERRIDES.markdown`. The blacklist sanitizer dies here.
3. **Surface forks die** — preview.html and doc.html take `markdown` as a surface dep
   (the inlining mechanism three surfaces already use); doc's raw-HTML-line pass-through
   becomes a rule override at its template layer, not a parser fork.
4. **gcu-press** (later) — `parse()` AST replaces its own block scanner; it gains
   inline markup (bold/italic into box-glue runs) for free. Its own SPEC item.
5. **cradle** (their call, separate repo) — once cross-parser parity holds over `doc1`'s
   declared features, swapping markdown-it drops its doc engine ~57 KB → ~8 KB gz and
   fixes its `{#id}` P1. cradle's SPEC-doc names markdown-it behavior, so this is a
   cradle spec revision, not a drop-in. `ext/shared/inline.js` could become the inline
   parser in field mode, but at 2 KB and reviewed, there's no urgency.

## 9. Size budget

| Component | Target |
|---|---|
| Block scanner | ~250 lines |
| Inline scanner | ~200 lines |
| Renderer + default rules + policies | ~150 lines |
| Extensions (§4, all) | ~200 lines |
| Lint profile | ~80 lines |
| **Total** | **~850–900 lines, ≈ 8–10 KB gz** |

An order of magnitude under markdown-it+plugins; small enough for works-core's floppy
budget without lazy-loading.

## 10. Non-goals

- Full CommonMark conformance (we declare a dialect and test what we declare).
- HTML sanitization (§5 — structurally refused).
- Syntax highlighting, math rendering (class hooks + `mathRenderer` only).
- A plugin API (extensions are in-tree; revisit only if a real third-party need appears).
- MDX/JSX anything.

## 11. Open questions

- **Emphasis corpus check.** Before freezing §3.2's simplified flanking, run it against
  a sample of real .ipynb md cells + top-npm READMEs and count divergences vs
  markdown-it; tune only if the misrender rate is embarrassing.
- **`presets.wild` autolink default** — on is friendlier for READMEs, off is safer for
  prose; decide from the same corpus.
- **Name** — `@gcu/markdown` here for the lib-slot match; the naming reckoning
  (`spec_inbox/gcu-naming-reckoning.md`) may shorten to `@gcu/md` at npm-publish time;
  the directory and slot don't care.
