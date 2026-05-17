# @gcu/plot

Matplotlib-style plotting for the browser. Canvas-based, zero runtime dependencies. Thin familiar API: `subplots`, `plot`, `scatter`, `imshow`, `hist`, `bar`.

Part of [Auditable](https://github.com/endarthur/auditable).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/plot
```

## Usage

```js
import { subplots, scatter } from '@gcu/plot';

const { fig, ax } = subplots(1, 1);
ax.scatter([1, 2, 3, 4], [1, 4, 9, 16]);
ax.xlabel('x');
ax.ylabel('y²');
document.body.append(fig.canvas);
```

Quick helpers (`plot`, `scatter`, `imshow`, `hist`, `bar`) accept an options object with `ax` to target an existing axes, otherwise create a new figure.

`subplots(R, C)` with both `R` and `C` greater than 1 returns a nested 2D axes array (matplotlib shape, for `[[a,b],[c,d]] = ...` destructuring) with a non-enumerable `.flat` property carrying the row-major flat axes list — mirrors matplotlib's `ndarray.flat`, so `axes.flat[k]` works without manual row/col math.

## Style palette

`plt.style.use(name)` swaps the module-level palette read by Axes / Figure / legend fallbacks (per-Axes `_bgcolor` / `_textColor` / `_gridColor` / `_frameColor` overrides still win). Default is auditable-native dark (`#1a1a1a` plot bg, `#ccc` text, transparent figure facecolor). `'default'` / `'classic'` / `'matplotlib'` / `'seaborn'` / `'ggplot'` / `'bmh'` flip to a light matplotlib-shape palette (white plot bg, dark text, opaque `#fafafa` figure card). `'dark_background'` restores dark. Unknown names are silently ignored.

## Figure layout extras

- `gap` / `wspace` / `hspace` (px, default 10) on `subplots(..., { gap })` or `Figure` — inter-subplot spacing.
- Figure-level `fig._rowLabels` / `fig._colLabels` (arrays of strings) render in 28px-left / 18px-bottom gutters reserved outside the subplot grid. Used by `sadpan.plotting.scatter_matrix` to live the column names on the figure edges instead of cluttering each cell with axis labels.
- Per-Axes `ax._margins = {left, right, top, bottom}` overrides the label/tick-driven margin computation — lets a grid of cells pin identical plot rects.
- `aspect='equal'` for `imshow`-dominated axes shrinks the plot rect to match data aspect (was: expanded the data range). `colorbar` is pinned to the cell's right edge using the pre-aspect plot height so it doesn't shrink along.

## Matplotlib compatibility

- `scatter` default marker size is 20 (matplotlib parity; was 4).
- `scatter` accepts plural matplotlib forms `edgecolors` / `linewidths` as aliases for `edgecolor` / `linewidth`.
- `plot` / `scatter` / `bar` / `barh` coerce x/y/heights/widths through `_toArr` at trace ingress, so sadpan `Series` / numpy-shaped wrappers without a `.length` plot correctly.

## License

MIT.
