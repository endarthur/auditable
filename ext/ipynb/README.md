# @gcu/ipynb

Jupyter `.ipynb` ↔ Auditable bridge with automatic substitution of
Python scientific-stack imports.

The strategic value: instead of asking users to abandon their existing
Jupyter work, "bring what you already have, swap the imports, keep
going." Bidirectional, so users can hand a finished notebook back to a
Python-using colleague.

## Substitution table

| Jupyter import | Auditable equivalent |
|---|---|
| `numpy` / `np` | `natra` |
| `pandas` / `pd` | `sadpan` |
| `scipy` | `scitra` |
| `sklearn` | `learn` |
| `matplotlib.pyplot` / `plt` | `plot` |

Submodule prefixes substitute correctly: `from numpy.linalg import inv`
becomes `from natra.linalg import inv`. Anything not in the table passes
through unchanged — the user will see a normal `ModuleNotFoundError` at
runtime, which is the honest signal for "this dependency isn't in the
GCU stack yet."

### Side effect: matplotlib theme inject

When the forward rewriter sees `import matplotlib.pyplot`, it appends
`plt.style.use('default')  # auditable: ipynb-theme-inject` on the next
line (indent preserved). Notebook authors saw matplotlib's light palette
in Jupyter; this opts the .ipynb-loaded notebook into that palette
without changing the auditable-native dark default for cells that don't
import matplotlib. The sentinel comment lets `exportNotebook` strip the
line cleanly on the inverse pass, so the round-trip doesn't leak our
injection into the user's source — delete the comment if you want the
call preserved as your own style choice.

## Usage

```js
import { importNotebook, exportNotebook } from '@gcu/ipynb';

// Import
const ipynbText = await fetch('analysis.ipynb').then(r => r.text());
const { cells, warnings, rewrites } = importNotebook(ipynbText);
// cells: [{ type: 'adder' | 'md', code }] in source order
// warnings: dropped magics, raw cells, non-Python kernels
// rewrites: [{ original, rewritten, type }] — every substitution that fired

// Export
const json = exportNotebook(cells, { title: 'My Notebook' });
// json: full .ipynb JSON, ready to save
```

## What's dropped on import

- Cell `outputs` — cells re-run on load in Auditable, so saved outputs
  are stale by definition.
- Line magics (`%matplotlib inline`) — kept as commented lines.
- Cell magics (`%%timeit`) — directive line commented, body kept.
- Shell escapes (`!pip install …`) — kept as commented lines.
- `raw` cells → markdown cell with a note (Auditable has no raw type).

## What happens to non-Python cells on export

JS / HTML / CSS cells become markdown blocks containing the source
verbatim, prefixed with a note that they're Auditable-native and need
re-execution there. Honest framing: "the Python parts of your work,
intact."

## Layout

```
src/
  substitutions.js  — table + line-level rewriter (both directions)
  parse.js          — .ipynb JSON → auditable cells
  serialize.js      — auditable cells → .ipynb JSON
  api.js            — importNotebook / exportNotebook
```

## Status

`v0.1` — parser + emitter + substitution + 27-test conformance suite.
No auditable.html integration yet (drag-drop detection, save-tray menu
items). Coming next.
