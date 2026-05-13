// @gcu/learn pipeline test suite — Pipeline + make_pipeline.
//
// Coverage:
//   - basic chain (transform → predict)
//   - make_pipeline auto-naming + collision suffixing
//   - set_params dotted nested update reaches the right step
//   - clone produces independent copies of all steps
//   - dump/load round-trip via the custom _toMimicIo / _fromMimicIo hooks
//   - end-to-end through cross_val_score
//   - check_estimator passes for an instantiated Pipeline

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  Pipeline, make_pipeline,
  StandardScaler, DecisionTreeClassifier, DecisionTreeRegressor,
  clone, dump, load, check_estimator,
  cross_val_score, KFold,
} from '../ext/learn/src/main.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) < tol;

function makeXy(n, m, k) {
  const X = [];
  const y = [];
  for (let c = 0; c < k; c++) {
    for (let i = 0; i < n / k; i++) {
      const row = [];
      for (let j = 0; j < m; j++) row.push(c * 5 + Math.sin(c + i * j));
      X.push(row);
      y.push(c);
    }
  }
  return [X, y];
}

// ────────────────────────────────────────────────────────────────────
// Basic Pipeline
// ────────────────────────────────────────────────────────────────────

describe('Pipeline', () => {
  test('chain of [scaler, tree] fits and predicts', () => {
    const [X, y] = makeXy(30, 3, 3);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ max_depth: 4 })],
      ],
    });
    pipe.fit(X, y);
    const yhat = pipe.predict(X);
    assert.equal(yhat.length, X.length);
    // Should fit reasonably on this easy data.
    let hits = 0;
    for (let i = 0; i < y.length; i++) if (yhat[i] === y[i]) hits++;
    assert.ok(hits / y.length > 0.7);
  });

  test('predict_proba routes to the final classifier', () => {
    const [X, y] = makeXy(20, 2, 2);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['clf', new DecisionTreeClassifier()],
      ],
    });
    pipe.fit(X, y);
    const P = pipe.predict_proba(X);
    assert.deepEqual(P.shape, [20, 2]);
    for (let i = 0; i < 20; i++) {
      const sum = P[i * 2] + P[i * 2 + 1];
      assert.ok(close(sum, 1, 1e-10), `row ${i} sums to ${sum}`);
    }
  });

  test('score routes to the final estimator', () => {
    const [X, y] = makeXy(20, 2, 2);
    const pipe = new Pipeline({
      steps: [['scaler', new StandardScaler()], ['clf', new DecisionTreeClassifier()]],
    });
    pipe.fit(X, y);
    const s = pipe.score(X, y);
    assert.ok(Number.isFinite(s));
    assert.ok(s >= 0 && s <= 1);
  });

  test('transform-only chain works when last step is a transformer', () => {
    const X = [[1, 2], [3, 4], [5, 6]];
    const pipe = new Pipeline({
      steps: [
        ['scaler1', new StandardScaler()],
        ['scaler2', new StandardScaler()],
      ],
    });
    pipe.fit(X);
    const Xt = pipe.transform(X);
    assert.deepEqual(Xt.shape, [3, 2]);
  });

  test('predict on non-predictor last step raises clear error', () => {
    const pipe = new Pipeline({
      steps: [['scaler', new StandardScaler()]],
    });
    pipe.fit([[1, 2], [3, 4]]);
    assert.throws(() => pipe.predict([[1, 2]]), /no \.predict/);
  });

  test('intermediate non-transformer step raises at fit', () => {
    const pipe = new Pipeline({
      steps: [
        ['clf', new DecisionTreeClassifier()],   // intermediate, no transform
        ['scaler', new StandardScaler()],
      ],
    });
    assert.throws(() => pipe.fit([[1, 2], [3, 4]], [0, 1]),
                  /every step except the last must be a transformer/);
  });

  test('named_steps lookup works', () => {
    const sc = new StandardScaler();
    const tree = new DecisionTreeClassifier();
    const pipe = new Pipeline({ steps: [['s', sc], ['t', tree]] });
    assert.equal(pipe.named_steps.s, sc);
    assert.equal(pipe.named_steps.t, tree);
  });
});

// ────────────────────────────────────────────────────────────────────
// make_pipeline
// ────────────────────────────────────────────────────────────────────

describe('make_pipeline', () => {
  test('auto-names from class name', () => {
    const pipe = make_pipeline(new StandardScaler(), new DecisionTreeClassifier());
    assert.deepEqual(pipe.steps.map(([n]) => n),
                     ['standardscaler', 'decisiontreeclassifier']);
  });

  test('suffixes duplicate class names', () => {
    const pipe = make_pipeline(new StandardScaler(), new StandardScaler());
    assert.deepEqual(pipe.steps.map(([n]) => n),
                     ['standardscaler', 'standardscaler-1']);
  });
});

// ────────────────────────────────────────────────────────────────────
// set_params + clone
// ────────────────────────────────────────────────────────────────────

describe('set_params + clone', () => {
  test('dotted set_params reaches the right step', () => {
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ max_depth: 5 })],
      ],
    });
    pipe.set_params({ 'tree__max_depth': 9, 'scaler__with_mean': false });
    assert.equal(pipe.named_steps.tree.max_depth, 9);
    assert.equal(pipe.named_steps.scaler.with_mean, false);
  });

  test('clone produces independent copies of all steps', () => {
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ max_depth: 4 })],
      ],
    });
    const c = clone(pipe);
    assert.notEqual(c, pipe);
    assert.notEqual(c.named_steps.scaler, pipe.named_steps.scaler);
    assert.notEqual(c.named_steps.tree, pipe.named_steps.tree);
    // Mutating clone shouldn't affect original.
    c.named_steps.tree.max_depth = 99;
    assert.equal(pipe.named_steps.tree.max_depth, 4);
  });
});

// ────────────────────────────────────────────────────────────────────
// dump / load round-trip
// ────────────────────────────────────────────────────────────────────

describe('Pipeline dump/load', () => {
  test('round-trip preserves predictions exactly', () => {
    const [X, y] = makeXy(40, 3, 3);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ max_depth: 5 })],
      ],
    });
    pipe.fit(X, y);
    const before = Array.from(pipe.predict(X));
    const proba_before = Array.from(pipe.predict_proba(X));

    const json = dump(pipe);
    assert.equal(json.format, 'mimic-io');
    assert.equal(json.class, 'Pipeline');
    assert.equal(json.module, '@gcu/learn.pipeline');
    // params.steps each carry a nested mimic-io block.
    for (const [, child] of json.params.steps) {
      assert.equal(child.format, 'mimic-io');
      assert.equal(child.version, 2);
      assert.ok(child.class === 'StandardScaler' || child.class === 'DecisionTreeClassifier');
    }

    const reloaded = load(json);
    assert.ok(reloaded instanceof Pipeline);
    assert.deepEqual(Array.from(reloaded.predict(X)), before);
    assert.deepEqual(Array.from(reloaded.predict_proba(X)), proba_before);
  });

  test('JSON-string round-trip works', () => {
    const pipe = new Pipeline({
      steps: [['scaler', new StandardScaler()], ['tree', new DecisionTreeClassifier()]],
    }).fit([[0, 0], [1, 1], [10, 10], [11, 11]], [0, 0, 1, 1]);
    const text = JSON.stringify(dump(pipe));
    const pipe2 = load(text);
    assert.deepEqual(Array.from(pipe2.predict([[0.5, 0.5], [10.5, 10.5]])),
                     [0, 1]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration with cross_val_score
// ────────────────────────────────────────────────────────────────────

describe('Pipeline + cross_val_score', () => {
  test('end-to-end CV scoring', () => {
    const [X, y] = makeXy(40, 3, 2);
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier({ max_depth: 4, random_state: 0 })],
      ],
    });
    const scores = cross_val_score(pipe, X, y,
      { cv: new KFold({ n_splits: 4, shuffle: true, random_state: 0 }) });
    assert.equal(scores.length, 4);
    for (const s of scores) assert.ok(Number.isFinite(s));
  });
});

// ────────────────────────────────────────────────────────────────────
// check_estimator
// ────────────────────────────────────────────────────────────────────

describe('check_estimator (Pipeline)', () => {
  test('passes for instantiated Pipeline', () => {
    // check_estimator's default-construct path can't handle Pipeline (it
    // requires steps), so we pass an instance form.
    const pipe = new Pipeline({
      steps: [
        ['scaler', new StandardScaler()],
        ['tree', new DecisionTreeClassifier()],
      ],
    });
    const errs = check_estimator(pipe, { collect: true });
    // Pipeline's tags inherit from final step (classifier here), so the
    // harness drives it as a classifier — should pass everything.
    assert.deepEqual(errs, [], `unexpected violations:\n  ${errs.join('\n  ')}`);
  });
});
