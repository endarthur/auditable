# @gcu/ipython-adapter

**IPython.display shim for [adder](https://www.npmjs.com/package/@gcu/adder) cells.**

Most Jupyter notebooks open with `from IPython.display import display, HTML, Image, Markdown` and then mix rich output into their cells. This adapter exposes that surface inside [@gcu/adder](https://www.npmjs.com/package/@gcu/adder) so the import resolves and the rich-display calls render correctly. Not a re-implementation of IPython — just enough glue for the rich-display protocol.

Paired with [@gcu/ipynb](https://www.npmjs.com/package/@gcu/ipynb), which does the import substitution and notebook round-trip; the adapter lets `from IPython.display import …` keep working unchanged after the conversion.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/ipython-adapter
```

## Usage

The adapter registers itself with adder when imported. In an adder cell:

```python
from IPython.display import display, HTML, Markdown, Image

display(HTML("<p>This renders as real HTML.</p>"))
display(Markdown("# Heading\n\nWith **bold** and `code`."))
display(Image("https://example.com/diagram.png"))
```

`display(x)` calls `x._repr_html_()` if the object exposes it (the rich-display protocol). `clear_output()` clears the active cell's output area.

## What's exposed

| IPython call | What it does here |
|---|---|
| `HTML(s)` | Renders raw HTML. |
| `Markdown(s)` | Renders through auditable's md pipeline. |
| `Image(url \| bytes)` | Returns a `<img>` element. |
| `SVG(s)` | Inline SVG or URL. |
| `Latex(s)`, `Math(s)` | Wraps in `$…$` / `$$…$$` for downstream KaTeX/MathJax. |
| `JSON(obj)` | Pretty-printed `<pre>`. |
| `display(x)` | Calls the rich-display hook. |
| `clear_output(wait=False)` | Clears the cell output area. |
| `get_ipython()` | Returns a minimal stub (`run_line_magic`, etc. throw). |

## What's not supported

- `%magic` commands and `%%cell magic` — adder is a pure-Python interpreter; no shell-out, no magic dispatch.
- Widget protocol (`ipywidgets`) — not implemented. Auditable has its own widgets (`ui.slider`, `ui.dropdown`, …) accessible from adder cells.
- `display_id` + `update_display` — single-shot only.

## Status

Pre-1.0. Targets the subset of IPython that real-world Jupyter notebooks use; expanded as gaps surface during `@gcu/ipynb` import testing.

## License

MIT.
