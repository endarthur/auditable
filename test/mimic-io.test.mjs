// @gcu/mimic-io v0.1 test suite — typed-array codec, canonical serialization,
// registry, dump/load round-trip, v1 normalization.
//
// Browser-only APIs used: btoa/atob (built into the codec) — both available
// in Node 16+ as globals, so the suite runs under `node --test` without
// shimming. DOMParser isn't needed here (mimic-io is pure JSON/JS).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dump, load, MimicIOUnsupportedClass,
  register, createRegistry,
  canonicalize,
  encodeTypedArray, decodeTypedArray, isTypedArrayRef,
  normalizeV1, isV1,
} from '../ext/mimic-io/src/main.js';

// ────────────────────────────────────────────────────────────────────
// Typed-array codec
// ────────────────────────────────────────────────────────────────────

describe('typed-array codec', () => {
  test('round-trips a Float64Array exactly', () => {
    const arr = new Float64Array([1.5, -2.25, Math.PI, 0, Number.MIN_VALUE, Number.MAX_VALUE]);
    const ref = encodeTypedArray(arr);
    assert.equal(ref.$dtype, 'float64');
    assert.deepEqual(ref.$shape, [arr.length]);
    const back = decodeTypedArray(ref);
    assert.ok(back instanceof Float64Array);
    assert.deepEqual(Array.from(back), Array.from(arr));
  });

  test('round-trips an Int32Array', () => {
    const arr = new Int32Array([0, 1, -1, 1 << 30, -(1 << 30)]);
    const back = decodeTypedArray(encodeTypedArray(arr));
    assert.ok(back instanceof Int32Array);
    assert.deepEqual(Array.from(back), Array.from(arr));
  });

  test('preserves shape on 2D arrays', () => {
    const arr = new Float64Array([1, 2, 3, 4, 5, 6]);
    const ref = encodeTypedArray(arr, [2, 3]);
    assert.deepEqual(ref.$shape, [2, 3]);
    const back = decodeTypedArray(ref);
    assert.deepEqual(Array.from(back), [1, 2, 3, 4, 5, 6]);
  });

  test('accepts plain JSON arrays as semantically equivalent', () => {
    // Spec §5.3: consumer must accept either form. The plain-array form
    // decodes into a Float64Array.
    const back = decodeTypedArray([1.5, -2.25, 0]);
    assert.ok(back instanceof Float64Array);
    assert.deepEqual(Array.from(back), [1.5, -2.25, 0]);
  });

  test('rejects shape/data length mismatch', () => {
    const bad = { $dtype: 'float64', $shape: [10], $data: encodeTypedArray(new Float64Array([1])).$data };
    assert.throws(() => decodeTypedArray(bad), /decoded.*bytes.*expected/);
  });

  test('rejects unsupported dtypes', () => {
    assert.throws(() => decodeTypedArray({ $dtype: 'float128', $shape: [1], $data: 'AA==' }),
      /unsupported dtype/);
  });

  test('rejects int64 by default (BigInt asymmetry)', () => {
    const bigArr = new BigInt64Array([1n, 2n, 3n]);
    const ref = encodeTypedArray(bigArr);
    assert.throws(() => decodeTypedArray(ref), /BigInt typed arrays/);
  });

  test('accepts int64 when rejectBigInt:false', () => {
    const bigArr = new BigInt64Array([1n, 2n, 3n]);
    const ref = encodeTypedArray(bigArr);
    const back = decodeTypedArray(ref, { rejectBigInt: false });
    assert.ok(back instanceof BigInt64Array);
    assert.deepEqual(Array.from(back), [1n, 2n, 3n]);
  });

  test('isTypedArrayRef discriminates correctly', () => {
    assert.equal(isTypedArrayRef({ $dtype: 'float64', $shape: [3], $data: 'AA==' }), true);
    assert.equal(isTypedArrayRef([1, 2, 3]), false);
    assert.equal(isTypedArrayRef({ random: 'obj' }), false);
    assert.equal(isTypedArrayRef(null), false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Canonical serialization
// ────────────────────────────────────────────────────────────────────

describe('canonical', () => {
  test('sorts object keys lexicographically', () => {
    const out = canonicalize({ b: 1, a: 2, c: 3 });
    // Keys should appear in a, b, c order
    const aIdx = out.indexOf('"a"');
    const bIdx = out.indexOf('"b"');
    const cIdx = out.indexOf('"c"');
    assert.ok(aIdx < bIdx && bIdx < cIdx);
  });

  test('emits trailing newline', () => {
    const out = canonicalize({ a: 1 });
    assert.equal(out[out.length - 1], '\n');
  });

  test('LF line endings only', () => {
    const out = canonicalize({ a: 1, b: { c: 2 } });
    assert.equal(out.includes('\r'), false);
  });

  test('integers emit without trailing .0', () => {
    const out = canonicalize({ n: 42 });
    assert.ok(out.includes('"n": 42'));
    assert.ok(!out.includes('42.0'));
  });

  test('floats use shortest round-trippable form', () => {
    const out = canonicalize({ pi: Math.PI });
    // JS's Number.toString() for PI is exactly "3.141592653589793"
    assert.ok(out.includes('3.141592653589793'));
  });

  test('inlines short scalar arrays under 80 columns', () => {
    const out = canonicalize({ vals: [1, 2, 3, 4] });
    // Should be on one line
    assert.match(out, /"vals": \[1, 2, 3, 4\]/);
  });

  test('block-formats long scalar arrays', () => {
    const out = canonicalize({ x: Array.from({ length: 50 }, (_, i) => i) });
    // Should NOT be inline (well over 80 cols)
    assert.ok(!out.match(/"x": \[.*49\]/));
  });

  test('NaN/Infinity emit as null without rejectNonFinite', () => {
    const out = canonicalize({ a: NaN, b: Infinity, c: -Infinity });
    assert.ok(out.includes('"a": null'));
    assert.ok(out.includes('"b": null'));
    assert.ok(out.includes('"c": null'));
  });

  test('rejectNonFinite throws on NaN', () => {
    assert.throws(() => canonicalize({ a: NaN }, { rejectNonFinite: true }),
      /non-finite/);
  });

  test('is idempotent: canonicalize(parse(canonicalize(x))) === canonicalize(x)', () => {
    const original = { z: 1, a: { y: 2, x: [3, 4, 5] }, m: 'hello' };
    const once = canonicalize(original);
    const twice = canonicalize(JSON.parse(once));
    assert.equal(once, twice);
  });

  test('round-trip-stable across different input orderings', () => {
    const a = canonicalize({ x: 1, y: 2 });
    const b = canonicalize({ y: 2, x: 1 });
    assert.equal(a, b);
  });
});

// ────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────

describe('registry', () => {
  class FakeScaler {
    constructor(params = {}) {
      this.params = params;
      this._params = params;
    }
    get_params() { return this.params; }
    transform(x) { return x; }
  }

  test('createRegistry returns an isolated registry', () => {
    const r1 = createRegistry();
    const r2 = createRegistry();
    r1.register('FakeScaler', FakeScaler);
    assert.equal(r1.has('FakeScaler'), true);
    assert.equal(r2.has('FakeScaler'), false);
  });

  test('register validates inputs', () => {
    const r = createRegistry();
    assert.throws(() => r.register('', FakeScaler), /non-empty/);
    assert.throws(() => r.register('Foo', 'not-a-function'), /must be a function/);
  });

  test('list() returns sorted class identifiers', () => {
    const r = createRegistry();
    r.register('Zeta', FakeScaler);
    r.register('Alpha', FakeScaler);
    r.register('Mu', FakeScaler);
    assert.deepEqual(r.list(), ['Alpha', 'Mu', 'Zeta']);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump / load round-trip
// ────────────────────────────────────────────────────────────────────

describe('dump / load', () => {
  // A minimal sklearn-shaped fake estimator for round-trip tests.
  class FakeScaler {
    constructor(params = {}) {
      this._params = {
        with_mean: params.with_mean ?? true,
        with_std:  params.with_std  ?? true,
      };
    }
    get _class_id() { return 'FakeScaler'; }
    get _module() { return '@test/fake.preprocessing'; }
    get_params() { return { ...this._params }; }
    transform(X) { return X; }
  }

  test('round-trips a fitted estimator via pre-shaped dict', () => {
    // We build the v2 dict manually since the fake estimator isn't
    // fully sklearn-shaped. Tests the load → dump roundtrip on the dict.
    const r = createRegistry();
    r.register('FakeScaler', FakeScaler, { module: '@test/fake.preprocessing' });

    const original = {
      format: 'mimic-io', version: 2,
      class: 'FakeScaler', module: '@test/fake.preprocessing',
      params: { with_mean: true, with_std: true },
      fitted: {
        n_features_in_: 4,
        mean_:  encodeTypedArray(new Float64Array([1.0, 2.0, 3.0, 4.0])),
        scale_: encodeTypedArray(new Float64Array([0.5, 0.5, 0.5, 0.5])),
      },
    };
    const est = load(original, { registry: r });
    assert.ok(est instanceof FakeScaler);
    assert.equal(est.n_features_in_, 4);
    assert.ok(est.mean_ instanceof Float64Array);
    assert.deepEqual(Array.from(est.mean_), [1.0, 2.0, 3.0, 4.0]);
  });

  test('dump on a fitted estimator produces v2 shape', () => {
    const scaler = new FakeScaler({ with_mean: true, with_std: false });
    scaler.n_features_in_ = 3;
    scaler.mean_ = new Float64Array([1, 2, 3]);
    scaler.scale_ = new Float64Array([1, 1, 1]);

    const out = dump(scaler);
    assert.equal(out.format, 'mimic-io');
    assert.equal(out.version, 2);
    assert.equal(out.class, 'FakeScaler');
    assert.equal(out.module, '@test/fake.preprocessing');
    assert.deepEqual(out.params, { with_mean: true, with_std: false });
    assert.equal(out.fitted.n_features_in_, 3);
    assert.ok(isTypedArrayRef(out.fitted.mean_));
    assert.equal(out.fitted.mean_.$dtype, 'float64');
  });

  test('full dump → load round-trip preserves typed arrays exactly', () => {
    const r = createRegistry();
    r.register('FakeScaler', FakeScaler);

    const scaler = new FakeScaler({ with_mean: true, with_std: true });
    scaler.n_features_in_ = 4;
    scaler.mean_ = new Float64Array([1.5, 2.5, 3.5, 4.5]);
    scaler.scale_ = new Float64Array([0.1, 0.2, 0.3, 0.4]);

    const json = dump(scaler);
    const back = load(json, { registry: r });

    assert.ok(back instanceof FakeScaler);
    assert.equal(back.n_features_in_, 4);
    assert.deepEqual(Array.from(back.mean_), [1.5, 2.5, 3.5, 4.5]);
    assert.deepEqual(Array.from(back.scale_), [0.1, 0.2, 0.3, 0.4]);
  });

  test('load throws MimicIOUnsupportedClass on unknown class', () => {
    const r = createRegistry();
    const json = {
      format: 'mimic-io', version: 2,
      class: 'Mystery', module: '@nowhere',
      params: {},
      fitted: {},
    };
    assert.throws(() => load(json, { registry: r }),
      (e) => e instanceof MimicIOUnsupportedClass && /Mystery/.test(e.message));
  });

  test('load with strict:false returns decoded dict for unregistered class', () => {
    const r = createRegistry();
    const json = {
      format: 'mimic-io', version: 2,
      class: 'Unknown', module: '@nowhere',
      params: { foo: 42 },
      fitted: { weight_: encodeTypedArray(new Float64Array([7.5])) },
    };
    const out = load(json, { registry: r, strict: false });
    assert.equal(out.class, 'Unknown');
    assert.deepEqual(out.params, { foo: 42 });
    assert.ok(out.fitted.weight_ instanceof Float64Array);
    assert.deepEqual(Array.from(out.fitted.weight_), [7.5]);
  });

  test('load rejects non-mimic-io files', () => {
    assert.throws(() => load({ format: 'pickle', version: 1 }, { registry: createRegistry() }),
      /not a mimic-io file/);
  });

  test('load rejects unsupported version', () => {
    assert.throws(() => load({ format: 'mimic-io', version: 99 }, { registry: createRegistry() }),
      /unsupported version/);
  });

  test('load accepts JSON string input', () => {
    const r = createRegistry();
    r.register('FakeScaler', FakeScaler);
    const scaler = new FakeScaler();
    scaler.n_features_in_ = 2;
    const jsonString = JSON.stringify(dump(scaler));
    const back = load(jsonString, { registry: r });
    assert.equal(back.n_features_in_, 2);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1 → v2 normalization (arborist legacy format)
// ────────────────────────────────────────────────────────────────────

describe('v1 normalization', () => {
  // Synthetic arborist-shaped v1 export — same shape as src/export.js in
  // the arborist repo emits.
  const v1Tree = {
    format: 'mimic-io',
    version: 1,
    algorithm: 'CART',
    criterion: 'gini',
    mode: 'classification',
    n_features: 3,
    n_classes: 2,
    feature_names: ['SiO2', 'Al2O3', 'Fe2O3'],
    class_names: ['oxide', 'sulphide'],
    target_name: 'litho',
    tree: {
      node_count: 3,
      children_left:  [1, -1, -1],
      children_right: [2, -1, -1],
      feature:   [0, -1, -1],
      threshold: [12.5, -2, -2],
      category:  [null, null, null],
      impurity:  [0.5, 0.0, 0.0],
      n_node_samples: [100, 50, 50],
      value: [[50, 50], [50, 0], [0, 50]],
    },
    bonsai: {
      forced_splits: [0],
      forced_classes: {},
      pruned_nodes: [],
    },
    exported_at: '2026-05-12T10:00:00Z',
  };

  test('isV1 recognises a v1 file', () => {
    assert.equal(isV1(v1Tree), true);
    assert.equal(isV1({ format: 'mimic-io', version: 2 }), false);
    assert.equal(isV1({ format: 'pickle' }), false);
  });

  test('normalizeV1 maps flat fields into v2 shape', () => {
    const v2 = normalizeV1(v1Tree);
    assert.equal(v2.format, 'mimic-io');
    assert.equal(v2.version, 2);
    assert.equal(v2.class, 'DecisionTreeClassifier');
    assert.equal(v2.module, 'arborist');
    assert.equal(v2.params.criterion, 'gini');
    assert.equal(v2.params._mode, 'classification');
    assert.equal(v2.fitted.n_features_in_, 3);
    assert.deepEqual(v2.fitted.feature_names_in_, ['SiO2', 'Al2O3', 'Fe2O3']);
    assert.deepEqual(v2.fitted.classes_, ['oxide', 'sulphide']);
    assert.equal(v2.fitted.n_classes_, 2);
    assert.equal(v2.fitted.tree_.node_count, 3);
    assert.equal(v2.metadata.target_name, 'litho');
    assert.deepEqual(v2.metadata.bonsai.forced_splits, [0]);
    assert.equal(v2.metadata.fitted_at, '2026-05-12T10:00:00Z');
  });

  test('regression v1 → DecisionTreeRegressor', () => {
    const regV1 = { ...v1Tree, mode: 'regression', criterion: 'variance' };
    const v2 = normalizeV1(regV1);
    assert.equal(v2.class, 'DecisionTreeRegressor');
    assert.equal(v2.params._mode, 'regression');
    assert.equal(v2.params.criterion, 'variance');
  });

  test('load accepts a v1 file end-to-end via normalization', () => {
    class FakeTree {
      constructor(params = {}) { this._params = params; }
      get _class_id() { return 'DecisionTreeClassifier'; }
    }
    const r = createRegistry();
    r.register('DecisionTreeClassifier', FakeTree, { module: 'arborist' });

    const back = load(v1Tree, { registry: r });
    assert.ok(back instanceof FakeTree);
    assert.equal(back.n_features_in_, 3);
    assert.deepEqual(back.classes_, ['oxide', 'sulphide']);
    assert.equal(back.tree_.node_count, 3);
    assert.equal(back.metadata_.target_name, 'litho');
  });

  test('normalizeV1 rejects non-v1 input', () => {
    assert.throws(() => normalizeV1({ format: 'mimic-io', version: 2 }),
      /expected version 1/);
    assert.throws(() => normalizeV1({ format: 'pickle', version: 1 }),
      /not a mimic-io file/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Cross-property: canonicalize + load are independent
// ────────────────────────────────────────────────────────────────────

describe('integration', () => {
  test('canonicalize → parse → load works on a real-shaped estimator', () => {
    class FakeScaler {
      constructor(params = {}) { this._params = params; }
      get _class_id() { return 'FakeScaler'; }
    }
    const r = createRegistry();
    r.register('FakeScaler', FakeScaler);
    const scaler = new FakeScaler({ with_mean: true });
    scaler.n_features_in_ = 2;
    scaler.mean_ = new Float64Array([1, 2]);

    const json = dump(scaler);
    const canonical = canonicalize(json);
    const reparsed = JSON.parse(canonical);
    const back = load(reparsed, { registry: r });

    assert.equal(back.n_features_in_, 2);
    assert.deepEqual(Array.from(back.mean_), [1, 2]);
  });
});
