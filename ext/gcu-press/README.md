# gcu-press

Typesetting engine for auditable notebooks. Produces beautifully typeset PDFs from notebook content.

## concept

An auditable notebook is already a programmable document: markdown cells for prose, JS cells for computation, CSS for styling, HTML for layout. gcu-press adds a typesetting backend — same source, two outputs (browser for authoring, PDF for distribution).

The author writes in an auditable notebook. Markdown cells are prose. Code cells compute cross-references, generate tables, produce figures. `// %hide` cells are the "preamble" — they run but don't appear in output. The `notebook` builtin provides introspection (cell types, source, rendered output, scope). gcu-press reads this and typesets it.

Usage from a code cell:

```js
const press = await load("gcu-press")
const pdf = await press.typeset(notebook, {
  fonts: { body: 'CMU Serif', code: 'CMU Typewriter' },
  page: 'A5',
})
```

## architecture

### pipeline

```
notebook (cells + executed outputs)
  → collect visible content (skip %hide, %norun)
  → resolve cross-references (ref.ch(), ref.ex(), ref.fig())
  → Knuth-Plass line breaking (paragraph → lines)
  → page breaking (lines → pages, with headers/footers/TOC)
  → PDF emission (positioned glyphs + images)
```

### components

1. **layout engine** — Knuth-Plass optimal line breaking, page breaking with penalties (keep heading with next paragraph, avoid widows/orphans). the core algorithm is ~200-300 lines of dynamic programming on arrays of box/glue/penalty items.

2. **font metrics** — opentype.js or similar for glyph widths, kerning pairs, ligatures. needed to feed accurate measurements into line breaking. fonts: CMU (Computer Modern Unicode) for TeX-quality output, or any OTF/TTF.

3. **PDF emitter** — PDF is a simple format for positioned text: "place glyph X at (x,y)". pdf-lib or raw PDF stream generation. also needs image embedding for canvas outputs (figures, plots).

4. **notebook bridge** — walks `notebook.cells`, collects rendered content. markdown cells → parsed prose (headings, paragraphs, emphasis, code spans). code cells → syntax-highlighted code blocks + output captures. HTML cells → rendered content. CSS cells → skipped (styling is for browser view, not PDF).

5. **cross-reference system** — `std.refs()` or `press.refs()` helper that code cells use to register and reference figures, examples, chapters, equations. two-pass: first pass collects all refs, second pass resolves numbers.

### what makes TeX output beautiful (and what we need)

- **Knuth-Plass line breaking** — considers all possible break points in a paragraph simultaneously, minimizes total "badness" (deviation from ideal line width). this is the single biggest quality difference vs greedy line breaking. well-documented algorithm, has been reimplemented many times.

- **Kerning and ligatures** — "fi", "fl", "ffi" ligatures, pair-wise kerning (AV, To, etc.). comes free from OpenType font metrics.

- **Microtypography** — hanging punctuation, optical margin alignment, character protrusion. nice to have, not essential for v1.

- **Hyphenation** — Liang's algorithm (also by Knuth). pattern-based, compact, effective. needed for good line breaking in narrow columns. tex hyphenation patterns are public domain.

### what we DON'T need from TeX

- macro expansion engine (we have JS)
- TeX's input language/parser (we have markdown + JS)
- math typesetting (atra book has minimal math; add later if needed)
- float placement algorithm (figures go where the author puts them)
- bibliography/citation system (not needed for v1)

## prerequisites (auditable changes)

before gcu-press can work, auditable needs a few small additions:

### 1. markdown cell `${expr}` interpolation

HTML cells already evaluate `${expr}` against scope. markdown cells should too. this lets authors write `As shown in ${ref.fig("dot")}...` in prose cells.

### 2. split view mode

side-by-side layout: cells (editors) on the left, continuous output flow on the right. this is the authoring experience for gcu-press — you edit on the left, see the "page" on the right. also a general UX improvement for auditable on wide screens.

### 3. notebook output introspection

extend `notebook.cells` to include rendered output — the innerHTML or DOM content of each cell's output element. gcu-press needs this to know what a code cell actually produced (a canvas? a table? text?).

## the atra book

the first project for gcu-press. a concise language reference and tutorial for atra.

### structure

1. **what is atra** — one page. Wasm compilation target, tagged templates, numerical focus.
2. **first program** — running atra in an auditable notebook and from JS. "hello world" equivalents.
3. **types and values** — f64, i32, bool. literals, type inference.
4. **variables and expressions** — `:=` assignment, arithmetic, comparison, logical operators, precedence.
5. **control flow** — if/else, begin/end blocks, for (range), while, early return.
6. **functions** — fn declaration, parameters, return types, multiple returns, recursion.
7. **memory** — linear memory model, load/store, pointers as i32 offsets, arrays, structs-by-convention.
8. **interop** — JS host imports, exports, tagged templates, `${}` interpolation (numbers, strings, functions), curried form `atra({imports})`.
9. **libraries** — std.include, source distributions (.src.js), binary distributions, alpack as example.
10. **worked examples** — 3-4 programs of increasing complexity: vector math → matrix operations → a small simulation.

### tone

like the Go Tour or K&R C — concise, practical, progressive. not a reference manual (that's the SPEC.md). not a textbook. assumes the reader can program but hasn't seen atra or Wasm before. ~40-60 pages typeset.

## naming

gcu-press. from Geoscientific Chaos Union. the typesetting engine for auditable notebooks.

## prior art and references

- Knuth, "Breaking Paragraphs into Lines" (1981) — the line-breaking algorithm
- Liang, "Word Hy-phen-a-tion by Com-put-er" (1983) — hyphenation patterns
- opentype.js — JS OpenType font parser
- pdf-lib — JS PDF creation library
- Computer Modern Unicode fonts — free, high-quality, the TeX look
