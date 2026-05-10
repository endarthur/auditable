# @gcu/registry — cross-package provider/consumer protocol

A tiny convention for GCU packages to discover one another at runtime
without hard dependencies. There is no `@gcu/registry` package — the
"registry" is one shared object on the JavaScript global, and this
document is its only specification.

## Why

The GCU packages (`@gcu/natra`, `@gcu/vec`, `@gcu/alpack`, `@gcu/scitra`,
`@gcu/sadpan`, `@gcu/plot`, ...) are designed to compose without forcing
users to install the whole stack. Most of them work fully on their own.
But some pairings have real performance wins when both halves are
present:

| Consumer | Provider | What it gets |
|---|---|---|
| `@gcu/scitra` | `@gcu/natra` | SIMD-accelerated `cdist` for n*m ≥ 250k |
| `@gcu/sadpan` | `@gcu/vec`   | small-matrix eigendecomposition for stereonets |
| `@gcu/plot`   | `@gcu/natra` | zero-copy raster paths for big arrays |

Wiring those up via explicit `setBackend()` calls works, but in a
notebook context the user shouldn't have to thread a backend object
through every consumer. Auto-detect via globals fixes the ergonomics
but pollutes the global namespace with one ad-hoc key per package
(`__scitraBackend__`, `__sadpanBackend__`, ...).

This spec replaces all of that with one rooted namespace.

## The registry

Exactly one key on `globalThis`:

```js
globalThis.__gcu__ = {
  providers: {},   // { name → instance } — see "Providers" below
  version: 1,      // bumped only when the shape of this object changes
};
```

Implementations MUST use the `??=` idiom so that loading multiple GCU
packages in any order is safe:

```js
const root = (globalThis.__gcu__ ??= { providers: {}, version: 1 });
```

The registry is a plain object. There is no event bus, no async, no
capability negotiation — yet. If one of those becomes necessary it gets
added as a sibling to `providers`, and `version` bumps to `2`. Existing
consumers that only read `providers` are unaffected.

## Providers

A *provider* is any GCU package that registers itself for use by other
packages. The provider key in `providers` is the last segment of the
package name (`@gcu/natra` → `natra`, `@gcu/vec` → `vec`).

Provider responsibilities:

- **Register on instance creation, not on module import.** Many GCU
  modules are factories (e.g. `await natra()` returns one runtime).
  Register the *instance*, after it's fully initialized, at the end of
  the factory.
- **The registered value SHOULD be the public API surface of the
  package**, i.e. the same thing a consumer would get via
  `import * as foo from '@gcu/foo'` or `await foo()`. Don't expose
  raw kernels or internal state — wrap them.
- **Last write wins** when multiple instances are created. This is the
  expected behaviour: most users only ever instantiate one. Providers
  MAY emit a `console.debug` notice when overwriting (not warn — it's
  not an error).
- **Don't fail loudly if globalThis is frozen** (worker contexts,
  CSP-locked builds). Catch the assignment in a try/catch and silently
  no-op; consumers will fall back to their non-accelerated paths.

Reference implementation (`ext/natra/index.js`):

```js
async function natra(opts = {}) {
  // ... factory work ...
  const instance = { array, matmul, scope, /* full public API */ };
  try {
    const root = (globalThis.__gcu__ ??= { providers: {}, version: 1 });
    root.providers.natra = instance;
  } catch { /* frozen global, ignore */ }
  return instance;
}
```

## Consumers

A *consumer* is any GCU package that opportunistically uses another's
acceleration. Consumer responsibilities:

- **Lazy lookup at the call site.** Read `globalThis.__gcu__?.providers?.<name>`
  inside the hot function, not at module load. The provider may register
  *after* the consumer module is imported.
- **Always work without the provider.** The consumer's public API must
  produce correct results whether or not the provider is present. The
  provider only changes performance.
- **Always offer an explicit override.** Consumers expose
  `setBackend({ <name>: instance })` (or equivalent) so tests, node
  scripts, and CSP-locked builds can wire the dependency without going
  through the global. The explicit override wins over the registry.
- **Validate the provider's shape minimally** before using it. Confirm
  the methods you need exist; on missing methods, fall back rather than
  throwing.

Reference implementation (`ext/scitra/src/util/backend.js`):

```js
let _explicit = { natra: undefined };

export function setBackend(b) { Object.assign(_explicit, b); }
export function clearBackend() { _explicit = { natra: undefined }; }

export function getNatra() {
  // Explicit override wins.
  if (_explicit.natra !== undefined) return _explicit.natra;
  // Fall back to the registry.
  const candidate = globalThis.__gcu__?.providers?.natra;
  if (candidate
      && typeof candidate.scope === 'function'
      && typeof candidate.array === 'function'
      && typeof candidate.toTypedArray === 'function') {
    return candidate;
  }
  return null;
}
```

## What does NOT belong in the registry

- **Internal state of an extension** (`_alpackKernels`, `_importCache`,
  `_installedModules`). Those are auditable-runtime internals; they
  belong to the auditable-runtime, not the GCU package ecosystem.
- **Raw wasm kernels or memory.** Wrap them in a typed JS façade and
  register the façade.
- **Per-call configuration** (e.g. "use f32 instead of f64"). That's
  what function options are for. The registry is a place for
  *capabilities*, not *settings*.
- **Anything user-visible.** No DOM elements, no event listeners, no
  localStorage keys. The registry is purely an in-process discovery
  hook for code-to-code coordination.

## Version field

The integer at `__gcu__.version` describes the shape of the registry
object itself, not the providers it holds. It bumps when:

- a sibling key is added to `__gcu__` (e.g. `events`, `capabilities`)
- the shape of `providers` changes (it's been a flat name→instance map
  since v1; if we ever go to namespaced keys, that's a v2)

It does *not* bump when:

- a provider's API changes — that's the provider's own semver
- a new provider is added to the ecosystem
- a consumer adds new lookup logic

Consumers SHOULD check the version and refuse to use the registry if
they don't understand it:

```js
const root = globalThis.__gcu__;
if (!root || root.version !== 1) return null;
return root.providers?.natra ?? null;
```

For v1 we don't enforce this; if and when v2 ships, v1 consumers either
get migrated or stay on whatever provider they shipped against.

## Migration from per-package globals

The pre-spec ad-hoc globals (`__scitraBackend__`, etc.) are removed
without a deprecation window — pre-1.0 GCU has no public-API stability
guarantees. Each consumer's `setBackend()` API stays unchanged; only
the auto-detect lookup site changes from `globalThis.__<pkg>Backend__`
to `globalThis.__gcu__.providers.<pkg>`.

Auditable-internal globals (`__WORKS_BRIDGE__`, `_importCache`,
`_installedModules`, `_air*`, `auditable.hooks`) are NOT in scope here.
Those serve the auditable runtime's own internal coordination and use
different patterns (event bus, registry on `window.auditable`, etc.).

## See also

- `ext/scitra/src/util/backend.js` — first consumer
- `ext/natra/index.js` — first provider
- `ext/scitra/SCITRA.md` — talks about which scitra paths are
  accelerated when natra is in the registry
