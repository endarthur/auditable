# @gcu/mimic-io

JSON serialization format for sklearn-shaped fitted estimators. Human-readable, language-independent, security-bounded via closed class registry, signable byte-for-byte via canonical serialization.

The format spec is `SPEC-mimic-io.md` (kept alongside `@gcu/learn`'s spec). This package is the JS reference implementation.

## Usage

```js
import { dump, load, register, createRegistry } from '@gcu/mimic-io';

// 1) Register your estimator classes with the loader. The registry is
//    per-consumer, not global — only classes you register can be
//    instantiated from a JSON file. This is the security boundary.
register('StandardScaler', StandardScaler, { module: '@gcu/learn.preprocessing' });
register('DecisionTreeClassifier', DecisionTreeClassifier, { module: '@gcu/learn.tree' });

// 2) Dump a fitted estimator to JSON.
const json = dump(scaler);
// json: { format: 'mimic-io', version: 2, class: 'StandardScaler',
//         module: '@gcu/learn.preprocessing',
//         params: { with_mean: true, with_std: true, copy: true },
//         fitted: { n_features_in_: 4,
//                   mean_:  { $dtype: 'float64', $shape: [4], $data: '…' },
//                   scale_: { $dtype: 'float64', $shape: [4], $data: '…' } } }

// 3) Load it back.
const scaler2 = load(json);
// scaler2.transform(X) produces bit-identical output to scaler.transform(X)
```

## What the format does for you

- **Plain text JSON.** Diffable in git, readable in any editor, parseable in any language. No binary opcodes, no language-locked types.
- **Closed registry = security boundary.** `load()` only instantiates classes you registered. Unlike pickle (which is arbitrary code execution on load), an unknown class in a JSON file fails with a clear error.
- **Cross-language by design.** A Python `mimic-io` reference implementation reads what this writes and vice versa. The contract is the JSON file, not a Python pickle protocol.
- **Signable.** `canonicalize(json)` produces a stable byte representation; sign it with Ed25519 (or whatever) and any verifier reproducing the canonical form gets the same bytes.
- **Typed-array compact.** Big numeric `fitted` arrays use a `{ $dtype, $shape, $data }` form with base64-encoded raw bytes, ~2.5× smaller than JSON arrays of decimal floats.
- **Backward compatible with arborist's v1.** Old `.mimic-io.json` files from arborist load cleanly via the v1 → v2 normalization in `normalizeV1()`. arborist itself will migrate to writing v2 in a near-future PR.

## API

### `dump(estimator, opts?) → object`

Build a v2 mimic-io JSON dict from a fitted estimator. The estimator should expose:

- `constructor.name` (or an explicit `_class_id` field) for the class identifier;
- `get_params()` returning the hyperparameter dict (or a `_params` field);
- Trailing-underscore attributes (`coef_`, `tree_`, `n_features_in_`, etc.) for fitted state.

`opts.module` overrides the module identifier (defaults to `<unknown>` if the estimator doesn't carry one).

You can also pass a pre-shaped v2 dict — useful for testing or hand-building. Typed-array fields in it get encoded.

### `load(json, opts?) → estimator`

Parse a v2 (or v1) mimic-io JSON dict / string into a constructed estimator. Lookup is:

1. Parse if string;
2. v1 → v2 normalize if `version === 1`;
3. Find the class in `opts.registry` (defaults to `defaultRegistry`);
4. Construct with `params`;
5. Assign fitted attributes.

If a class isn't registered, throws `MimicIOUnsupportedClass`. Pass `opts.strict = false` to receive a decoded dict instead of an error.

`opts.rejectBigInt = false` opts in to BigInt typed-array loading for `int64` / `uint64` fields (default rejects — most consumers can't handle BigInt values cleanly).

### `register(class_id, ClassCtor, opts?)`

Register a class in the default registry. `opts.module` is the module identifier accepted on load (e.g. `'@gcu/learn.tree'`). `opts.schema` is an optional JSON Schema for params + fitted validation.

### `createRegistry()`

Build a fresh, isolated registry. Use this if you don't want to share state with the default registry — e.g. test isolation, multi-tenant consumers.

### `canonicalize(value, opts?) → string`

Serialize a value into canonical form for signing. Sorted keys, 2-space indent, shortest-round-trippable floats, LF line endings, trailing newline. NaN/Infinity emit as `null`; pass `opts.rejectNonFinite = true` to fail loudly instead.

### `encodeTypedArray(arr, shape?)` / `decodeTypedArray(ref, opts?)`

Direct access to the typed-array codec. Most callers don't need these — `dump`/`load` handle typed arrays automatically — but they're exposed for ad-hoc use.

### `normalizeV1(v1Dict) → v2Dict`

Transform an arborist-shaped v1 JSON dict into a v2 dict. The `load` path does this automatically; expose it directly for tooling that needs the data-only transform without instantiation.

## Status

v0.1. Single-file ESM, zero deps. Targets v2 of the SPEC format. v1 files (arborist exports) load via the §3.5 normalization.

Per-class JSON Schemas (DecisionTreeClassifier, StandardScaler, Pipeline, etc.) are not yet written; the format accepts any well-formed v2 input.

A Python reference implementation (also `mimic-io`) is not yet built. Cross-language round-trip tests will live in `test/cross-language/` once both are ready.

## License

MIT. The format spec is BSD-3-Clause where it lives in `spec_inbox/` (auditable repo convention).
