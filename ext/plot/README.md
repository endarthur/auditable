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

## License

MIT.
