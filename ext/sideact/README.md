# @gcu/sideact

Signals + templates + DOM binding. Standalone reactive UI library — zero dependencies.

Part of [Auditable](https://github.com/endarthur/auditable). Exposed inside notebooks as the `sr` namespace, where `sr.state()` additionally persists signals across cell re-executions.

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/sideact
```

## Usage

```js
import { signal, computed, effect, h, each, render } from '@gcu/sideact';

const [count, setCount] = signal(0);
const doubled = computed(() => count() * 2);

const app = h`
  <div>
    <p>count: ${count}</p>
    <p>doubled: ${doubled}</p>
    <button onclick=${() => setCount(c => c + 1)}>+</button>
  </div>
`;

render(app, document.body);
```

### Signals only (no DOM)

```js
import { signal, computed, effect, batch } from '@gcu/sideact/signals';
// Same primitives, pulled without pulling any DOM code — usable in Node or workers.
```

### Sub-paths

- `@gcu/sideact/signals` — `signal`, `computed`, `effect`, `batch` (no DOM)
- `@gcu/sideact/dom` — `h`, `_isNode`
- `@gcu/sideact/render` — `each`, `render`

## License

MIT.
