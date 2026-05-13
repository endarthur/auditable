// @gcu/learn ColumnTransformer test suite — heterogeneous-column
// routing for mixed-type pipelines.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ColumnTransformer, make_column_transformer,
  StandardScaler, MinMaxScaler, OneHotEncoder,
  Pipeline, DecisionTreeClassifier,
  dump, load, clone,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-10) => Math.abs(a - b) < tol;

// ────────────────────────────────────────────────────────────────────
// Basic ColumnTransformer
// ────────────────────────────────────────────────────────────────────

describe('ColumnTransformer', () => {
  test('routes columns to different transformers and concatenates', () => {
    const X = [
      [1, 100], [2, 200], [3, 300], [4, 400],
    ];
    const ct = new ColumnTransformer({
      transformers: [
        ['a', new StandardScaler(), [0]],
        ['b', new MinMaxScaler(), [1]],
      ],
    });
    ct.fit(X);
    const Xt = ct.transform(X);
    assert.deepEqual(Xt.shape, [4, 2]);
    // First col is StandardScaler over [1,2,3,4] → mean=2.5, var=1.25, scale=√1.25
    // Last value (4) → (4 - 2.5) / √1.25
    assert.ok(close(Xt[6], 1.5 / Math.sqrt(1.25), 1e-10));
    // Second col is MinMaxScaler over [100..400] → [0, 1/3, 2/3, 1]
    assert.ok(close(Xt[1], 0));
    assert.ok(close(Xt[7], 1));
  });

  test('remainder="passthrough" appends unrouted columns', () => {
    const X = [[1, 100, 1000], [2, 200, 2000], [3, 300, 3000]];
    const ct = new ColumnTransformer({
      transformers: [['a', new MinMaxScaler(), [0]]],
      remainder: 'passthrough',
    });
    ct.fit(X);
    const Xt = ct.transform(X);
    assert.deepEqual(Xt.shape, [3, 3]);
    // Col 0: MinMax of [1,2,3] → [0, 0.5, 1]
    assert.deepEqual(Array.from(Xt.subarray(0, 1)), [0]);
    // Cols 1, 2: passthrough.
    assert.equal(Xt[1], 100); assert.equal(Xt[2], 1000);
    assert.equal(Xt[7], 300); assert.equal(Xt[8], 3000);
  });

  test('remainder="drop" excludes unrouted columns (default)', () => {
    const X = [[1, 100, 1000], [2, 200, 2000]];
    const ct = new ColumnTransformer({
      transformers: [['a', new MinMaxScaler(), [0]]],
    });
    ct.fit(X);
    const Xt = ct.transform(X);
    assert.deepEqual(Xt.shape, [2, 1]);
  });

  test('OneHotEncoder + StandardScaler on mixed data', () => {
    const X = [
      [1.0, 'cat'], [2.0, 'dog'], [3.0, 'cat'], [4.0, 'bird'],
    ];
    const ct = new ColumnTransformer({
      transformers: [
        ['num', new StandardScaler(), [0]],
        ['cat', new OneHotEncoder(), [1]],
      ],
    });
    ct.fit(X);
    const Xt = ct.transform(X);
    // 1 numeric col + 3 categorical (one-hot of bird/cat/dog) = 4 cols.
    assert.deepEqual(Xt.shape, [4, 4]);
    // Verify the categorical block is one-hot per row.
    for (let i = 0; i < 4; i++) {
      let s = 0;
      for (let j = 1; j < 4; j++) s += Xt[i * 4 + j];
      assert.equal(s, 1, `row ${i} categorical block sums to ${s}`);
    }
  });

  test('out-of-range column raises with a clear message', () => {
    assert.throws(
      () => new ColumnTransformer({
        transformers: [['x', new StandardScaler(), [99]]],
      }).fit([[1, 2]]),
      /column index 99 out of range/);
  });

  test('fit_transform avoids redundant double-fit', () => {
    const X = [[1, 100], [2, 200], [3, 300]];
    const ct = new ColumnTransformer({
      transformers: [
        ['a', new StandardScaler(), [0]],
        ['b', new MinMaxScaler(), [1]],
      ],
    });
    const Xt = ct.fit_transform(X);
    assert.deepEqual(Xt.shape, [3, 2]);
    // Equivalent to fit then transform.
    const ct2 = new ColumnTransformer({
      transformers: [
        ['a', new StandardScaler(), [0]],
        ['b', new MinMaxScaler(), [1]],
      ],
    });
    const Xt2 = ct2.fit(X).transform(X);
    assert.deepEqual(Array.from(Xt), Array.from(Xt2));
  });

  test('clone produces independent copies of inner transformers', () => {
    const ct = new ColumnTransformer({
      transformers: [['a', new MinMaxScaler({ feature_range: [0, 5] }), [0]]],
    });
    const c = clone(ct);
    assert.notEqual(c.transformers[0][1], ct.transformers[0][1]);
    c.transformers[0][1].feature_range = [99, 100];
    assert.deepEqual(ct.transformers[0][1].feature_range, [0, 5]);
  });
});

// ────────────────────────────────────────────────────────────────────
// make_column_transformer
// ────────────────────────────────────────────────────────────────────

describe('make_column_transformer', () => {
  test('auto-names from class name', () => {
    const ct = make_column_transformer(
      [new StandardScaler(), [0]],
      [new MinMaxScaler(), [1]],
    );
    assert.deepEqual(ct.transformers.map(t => t[0]),
                     ['standardscaler', 'minmaxscaler']);
  });

  test('suffixes duplicate class names', () => {
    const ct = make_column_transformer(
      [new StandardScaler(), [0]],
      [new StandardScaler(), [1]],
    );
    assert.deepEqual(ct.transformers.map(t => t[0]),
                     ['standardscaler', 'standardscaler-1']);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump/load
// ────────────────────────────────────────────────────────────────────

describe('ColumnTransformer dump/load', () => {
  test('round-trip preserves transform output', () => {
    const X = [
      [1, 100], [2, 200], [3, 300], [4, 400], [5, 500],
    ];
    const ct = new ColumnTransformer({
      transformers: [
        ['a', new StandardScaler(), [0]],
        ['b', new MinMaxScaler(), [1]],
      ],
    });
    ct.fit(X);
    const before = Array.from(ct.transform(X));
    const r = load(dump(ct));
    assert.ok(r instanceof ColumnTransformer);
    assert.deepEqual(Array.from(r.transform(X)), before);
  });

  test('passthrough remainder preserved', () => {
    const X = [[1, 100, 1000], [2, 200, 2000]];
    const ct = new ColumnTransformer({
      transformers: [['a', new MinMaxScaler(), [0]]],
      remainder: 'passthrough',
    });
    ct.fit(X);
    const r = load(dump(ct));
    assert.equal(r.remainder, 'passthrough');
    assert.deepEqual(Array.from(r.transform(X)), Array.from(ct.transform(X)));
  });
});

// ────────────────────────────────────────────────────────────────────
// End-to-end Pipeline integration
// ────────────────────────────────────────────────────────────────────

describe('ColumnTransformer + Pipeline', () => {
  test('mixed numeric + categorical preprocessing into a classifier', () => {
    // 6 samples, 2 numeric + 1 categorical column. Class separable on
    // numeric col 0 alone, but the pipeline must route through both.
    const X = [
      [1, 10, 'cat'], [2, 20, 'dog'], [3, 30, 'bird'],
      [10, 100, 'cat'], [11, 110, 'dog'], [12, 120, 'bird'],
    ];
    const y = [0, 0, 0, 1, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['preproc', new ColumnTransformer({
          transformers: [
            ['num', new StandardScaler(), [0, 1]],
            ['cat', new OneHotEncoder(), [2]],
          ],
        })],
        ['clf', new DecisionTreeClassifier({ random_state: 0 })],
      ],
    });
    pipe.fit(X, y);
    const yhat = pipe.predict(X);
    let hits = 0;
    for (let i = 0; i < y.length; i++) if (yhat[i] === y[i]) hits++;
    assert.ok(hits / y.length >= 5 / 6);
  });

  test('end-to-end dump/load preserves pipeline predictions', () => {
    const X = [[1, 'cat'], [2, 'dog'], [3, 'cat'], [10, 'dog'], [11, 'cat']];
    const y = [0, 0, 0, 1, 1];
    const pipe = new Pipeline({
      steps: [
        ['preproc', new ColumnTransformer({
          transformers: [
            ['num', new StandardScaler(), [0]],
            ['cat', new OneHotEncoder(), [1]],
          ],
        })],
        ['clf', new DecisionTreeClassifier()],
      ],
    });
    pipe.fit(X, y);
    const before = Array.from(pipe.predict(X));
    const r = load(dump(pipe));
    assert.deepEqual(Array.from(r.predict(X)), before);
  });
});
