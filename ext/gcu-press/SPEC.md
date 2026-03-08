# gcu-press language and format spec

## core insight

an auditable notebook is already a document. markdown cells are prose, code cells are computation, HTML cells are layout. gcu-press adds a second rendering backend: instead of scrolling browser output, produce paginated typeset pages (canvas for preview, PDF for export).

**the notebook IS the document. no new format needed.**

same source, two modes:

| | notebook mode | document mode |
|---|---|---|
| code cells | execute, show output | execute silently (computation) |
| markdown cells | render as HTML | typeset with KP onto pages |
| `ui.canvas()` | inline output | figure (auto-numbered) |
| `ui.table()` | inline output | typeset table |
| widgets (`ui.slider()` etc.) | interactive UI | not rendered (values available in scope) |
| CSS cells | applied to page | ignored (press handles styling) |
| output | scrolling cells | paginated A4/Letter/custom |

## prior art

- **Quarto / R Markdown** — same idea (notebook source, multiple outputs), but requires R/Python + LaTeX + pandoc. dependency hell.
- **Jupyter Book** — notebooks compiled into books. needs Python + Sphinx + LaTeX.
- **Typst** — modern TeX replacement. clean syntax, fast compiler, but still a batch toolchain. custom scripting language instead of using an existing one. PDF-only output. not self-contained.
- **Org Mode** — emacs org files export to LaTeX/PDF/HTML. powerful but emacs-bound.
- **TeX/LaTeX** — the gold standard for typesetting quality. arcane macro language, massive toolchain, steep learning curve.

**what gcu-press takes from each:**
- from Typst: content-first philosophy, declarative styling concept (realized as JS config, not custom syntax)
- from Quarto: the "notebook is the document" model, code chunks produce figures
- from TeX: Knuth-Plass line breaking, proper page breaking, typographic quality, `~` non-breaking space
- from auditable: self-contained HTML, no toolchain, browser-native, JS as scripting language

**what gcu-press avoids:**
- no new scripting language (JS already exists)
- no external toolchain (runs in the browser)
- no dependency installation (one HTML file)
- no separate source format (the notebook IS the source)

## authoring model

### writing a document in auditable

```
/// title: Velocity Field Analysis
/// type: code
// %hide
// preamble: load data, configure press
const data = await fetch("measurements.csv").then(r => r.text())
const field = std.csv(data)
const stats = { mean: std.mean(field.velocity), std: std.std(field.velocity) }

/// type: md
# Velocity Field Analysis

The mean velocity was ${stats.mean.toFixed(1)} m/s with
standard deviation ${stats.std.toFixed(2)} m/s. The spatial
distribution (Fig. 1) shows clear anisotropy along the
principal stress direction.

/// type: code
// %figure Velocity field magnitude
ui.canvas(400, 300, ctx => {
  plotField(ctx, field)
})

/// type: md
## Methodology

Measurements were taken at 500 m intervals across the study
area using standard geophysical equipment. Each station
recorded three-component velocity vectors over a 24-hour
period.

/// type: code
// %figure Station locations
const map = spx.map("#map", { center: [-43.5, -20.25], zoom: 10 })
spx.csv(map, data, { lon: "x", lat: "y", color: "velocity" })

/// type: md
## Results

Table 1 summarizes the results by region.

/// type: code
// %table Regional velocity statistics
ui.table(regionalStats)
```

in notebook mode: runs normally, interactive map, live table.
in document mode: code cells run, markdown cells get typeset with KP, canvases become numbered figures, tables become typeset tables. widgets don't appear. the map freezes as a raster image.

### writing a pure document (standalone editor)

for when you just want to write, no computation. the standalone editor (tools/gcu-press/) accepts plain markdown:

```markdown
# The Fable of the Dragon-Tyrant

Once upon a time, a dragon of staggering dimensions
tyrannized the kingdom...

## The Kingdom's Response

The kingdom had tried many times to fight the dragon.
```

this is the simpler entry point. no code, no cells, just prose. useful for letters, essays, short documents. the same KP engine typesets it.

## markdown dialect

gcu-press uses a flavor of markdown with a few additions for typesetting. the same dialect works in both the standalone editor and auditable markdown cells.

### comments

standard markdown comments are `<!-- -->` which is painful to type. gcu-press markdown also supports JS-style comments:

```markdown
// this is a comment — not rendered
/* this is also a comment
   spanning multiple lines */

<!-- this still works too -->

# My Document

Content here. // inline comments work too
```

### standard markdown (supported)

- `# heading` through `### heading` (levels 1-3)
- `**bold**` and `_italic_`
- `` `inline code` ``
- `[link text](url)`
- `---` / `***` / `___` for page breaks
- blank line separates paragraphs

### inline typesetting hints

these translate directly to KP items (penalties, glue, boxes) and give the author control over line breaking:

| syntax | meaning | KP effect |
|---|---|---|
| `~` | non-breaking space | glue with INF penalty (no break here) |
| `\-` | soft hyphen | explicit discretionary break point |
| `\` at end of line | forced line break | NEG_INF penalty |
| `[...]{.nobreak}` | keep together | INF penalties between all words |

`~` is borrowed from TeX — it's the most common typesetting hint and universally understood. use it between `Dr.~Smith`, `Figure~1`, `10~km`, etc.

### bracketed spans

`[text]{.class}` is the general extension mechanism (from Pandoc's bracketed spans). classes map to typesetting behaviors:

| class | effect |
|---|---|
| `.nobreak` | prevent line breaks within the span |
| `.smallcaps` | render in small caps |
| `.red`, `.blue`, etc. | text color (limited palette) |

this is intentionally minimal. bracketed spans are **inline** — they style a run of text within a single paragraph, like HTML `<span>`. they cannot span paragraphs or contain block elements. for block-level scoping, use cell directives (see below).

for anything fancier, use `${}` JS expressions as an escape hatch: `${press.styled("text", { font: "Courier", size: 9 })}`.

### scope layering

| scope | mechanism | example |
|---|---|---|
| document-wide | `// %press:config` object | font, margins, page size |
| cell/block | `// %press:` directive on cell | `// %press:loose`, `// %press:font Courier` |
| inline/phrase | `[text]{.class}` | `[Dr. Smith]{.nobreak}` |
| single point | `~`, `\-` | `Figure~1`, `hyper\-sonic` |

### paragraph-level tuning

when KP produces a bad paragraph and you need to nudge it, use cell/block directives:

```markdown
// %press:loose
This paragraph gets extra tolerance, so KP accepts
slightly looser lines to find a better overall layout.

// %press:tight
This paragraph gets reduced tolerance for tighter setting.
```

in the standalone editor these are inline directives. in auditable, the cell-level `// %` pattern applies to the whole markdown cell.

## document settings

a code cell with `// %press:config` sets typesetting parameters. this is the equivalent of Typst's `#set` rules but as a JS object — no new syntax, no YAML, one language:

```js
// %hide
// %press:config
({
  page: { size: "a4", margin: { t: 72, b: 72, l: 72, r: 72 } },
  text: { font: "Georgia, serif", size: 11 },
  par: { indent: "2em", justify: true },
  heading: { font: "Georgia, serif" },
  tolerance: 2,
  emergencyStretch: 20,
})
```

placed in a `// %hide` cell at the top of the notebook. in the standalone editor, the same object can appear at the top of the file.

cells can override settings locally. a markdown cell with `// %press:font Courier` scopes that change to just that cell. in a cell-based notebook, **cells are natural scopes** — no need for Typst's bracket nesting.

## press directives

cell-level directives that control document mode behavior. same `// %` pattern as existing auditable directives (`// %manual`, `// %hide`, `// %norun`).

### cell visibility

- `// %hide` — (existing) cell runs but doesn't appear in either mode
- `// %nopress` — cell appears in notebook mode, hidden in document mode
- `// %pressonly` — cell hidden in notebook mode, appears in document mode (e.g., title page formatting)

### figure and table

- `// %figure Caption text` — cell's canvas/image output becomes a numbered figure with caption
- `// %table Caption text` — cell's table output becomes a numbered table with caption

figures and tables are auto-numbered in document order. cross-references resolve during typesetting.

### page control

- `// %pagebreak` — force a page break before this cell
- `// %landscape` — this cell's output renders on a landscape page (for wide figures/tables)

## cross-references

press provides a `ref` helper in scope:

```js
// in a code cell
const fig1 = ref.fig("velocity-field")  // registers, returns "Figure 1"
const tab1 = ref.table("regional-stats") // returns "Table 1"
const sec2 = ref.section("methodology")  // returns "Section 2" or "2.1"
```

in markdown cells, use `${}` interpolation:

```markdown
As shown in ${ref.fig("velocity-field")}, the distribution
is anisotropic. ${ref.table("regional-stats")} summarizes
the regional statistics.
```

two-pass resolution: first pass collects all references, second pass resolves numbers.

## rendering pipeline

```
notebook cells (executed)
  |
  v
collect visible content
  - skip %hide, %nopress cells
  - resolve %figure, %table directives
  - extract canvas/image outputs from code cells
  |
  v
parse markdown cells
  - headings, paragraphs, bold/italic, code, links
  - ${} interpolation with scope values
  - build box/glue/penalty items via KP model
  |
  v
typeset
  - Knuth-Plass line breaking (paragraph -> lines)
  - page breaking with penalties (widows, orphans, heading-keep)
  - figure/table placement
  - header/footer insertion, page numbers
  |
  v
render
  - canvas pages (for live preview)
  - PDF export (positioned glyphs + embedded images)
```

## what auditable needs

### already exists
- `// %hide` directive
- `// %norun` directive
- markdown cells with `${}` interpolation (HTML cells have this; markdown cells need it)
- `ui.canvas()`, `ui.table()` for outputs
- `notebook` builtin for cell introspection

### needed for M1 (basic typesetting)
- **press as a loadable module**: `const press = await load("gcu-press")`
- **markdown cell `${}` interpolation**: HTML cells already do this. markdown cells should too.
- **notebook output introspection**: extend `notebook.cells` to include rendered output DOM

### needed for M2 (figures and cross-refs)
- **figure/table directives**: `// %figure`, `// %table`
- **ref system**: `ref.fig()`, `ref.table()`, `ref.section()`
- **canvas-to-image**: convert `ui.canvas()` output to raster for embedding in pages

### needed for M3 (PDF export)
- **PDF emitter**: pdf-lib or raw PDF generation
- **font embedding**: subset fonts into PDF
- **image embedding**: canvas outputs as PNG/JPEG in PDF

### needed for M4 (math)
- **math typesetting**: `$inline$` and `$$display$$` LaTeX math syntax in markdown cells
- **KaTeX integration**: KaTeX renders LaTeX math to SVG. we render the SVG onto canvas pages. this avoids reimplementing 40 years of math layout. KaTeX covers most LaTeX math; MathJax is the fallback if we hit gaps.
- **math as inline box**: inline math (`$x^2$`) becomes a box item in the KP stream — measured width from the rendered SVG, placed on the line like a word. display math (`$$..$$`) becomes a centered block between paragraphs.

### needed for M5 (bibliography)
- **citation system**: `${cite("smith2020")}` → `[Smith et al., 2020]` in text
- **bibliography source**: parse BibTeX (`.bib`) or a simple JSON format. stored as an installed module or fetched.
- **reference list**: auto-generated "References" section at end of document, formatted per citation style (APA, Chicago, etc.)
- **citation styles**: start with author-year (most common in geoscience), add numbered styles later

### needed for M6 (thesis-ready)
- **table of contents**: collect headings during first pass, emit as a page. auto-generated page numbers. two-pass: first pass collects, second pass resolves.
- **list of figures / list of tables**: same mechanism as TOC but for `// %figure` and `// %table` entries
- **numbered sections**: 1, 1.1, 1.1.1 hierarchy. configurable depth. headings auto-number.
- **front matter**: title page, abstract, acknowledgements. separate page numbering (roman numerals for front matter, arabic for body).
- **footnotes**: `[^1]` or `${footnote("text")}` in markdown. collected and placed at page bottom during layout. auto-numbered.

### nice to have (later)
- split view mode (editor left, typeset preview right)
- columns, margin notes
- hanging punctuation, microtypography
- float placement (figures that drift to top/bottom of page)
- **index generation**: auto-index scans typeset pages for a list of terms (defined in `press:config`) and records page numbers. manual entries via `${index("term", "sub-entry")}` for finer control. generates a formatted index section. no `\index{}` spam throughout the text.
- multi-file documents (chapters as separate notebooks)
- **LaTeX fallback transpiler**: safety net — convert gcu-press source to `.tex` files. the mapping is nearly 1:1 (headings → `\section{}`, bold → `\textbf{}`, `$math$` passes through unchanged, `cite()` → `\cite{}`, `ref.fig()` → `\ref{}`). if gcu-press's own rendering isn't ready for a deadline, export to LaTeX and compile with pdflatex. insurance policy, not the goal.

## the standalone editor

`tools/gcu-press/` is a separate entry point for pure document writing. no cells, no code, no DAG. just a markdown editor on the left, typeset pages on the right.

it uses the same KP engine (`ext/gcu-press/`) but with a simpler pipeline: markdown text -> parse -> linebreak -> layout -> render.

this is what we've built so far (M1 of the standalone editor). it evolves into a lightweight writing tool for when you don't need computation.

the standalone editor and the auditable integration share the engine but have different authoring experiences:

| | standalone editor | auditable integration |
|---|---|---|
| input | plain markdown text | notebook cells |
| computation | none | full JS via code cells |
| figures | none (future: image embed) | canvas/table outputs |
| cross-refs | none | ref system |
| output | canvas pages | canvas pages + PDF |
| use case | writing, letters, essays | papers, reports, books |

## milestones

**M1 (done):** standalone editor with KP typesetting. markdown -> pages. headings, paragraphs, hyphenation, two-pass emergency stretch.

**M2:** auditable integration. `load("gcu-press")` typesets the current notebook's markdown cells onto pages. basic figure support (canvas outputs as images).

**M3:** cross-references, figure/table numbering, `// %figure` directive, page numbers, headers/footers. numbered sections.

**M4:** math typesetting. KaTeX integration for `$inline$` and `$$display$$` LaTeX math. math expressions rendered to SVG, placed as box items in KP stream (inline) or centered blocks (display).

**M5:** PDF export. font embedding, image embedding, math as vector graphics, downloadable output.

**M6:** bibliography and citations. BibTeX/.bib parsing, `cite()` helper, auto-generated reference list. citation styles (author-year, numbered).

**M7:** thesis-ready. table of contents, list of figures/tables, front matter (title page, abstract, roman numeral page numbering), footnotes.

**M8:** advanced typography. proper hyphenation (Liang's patterns), kerning, ligatures, OpenType features. microtypography.

**M9:** the atra book. first real document produced with gcu-press.

## naming

gcu-press. the GCU's printing press. takes the raw material of a notebook and produces a finished document.
