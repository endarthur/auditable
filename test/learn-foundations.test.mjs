// @gcu/learn v0.1 foundations test suite.
//
// Covers:
//   - BaseEstimator: get_params/set_params (incl. dotted nested), clone,
//     check_is_fitted, NotFittedError, mixins, __sklearn_tags__.
//   - serialize: dump/load round-trip via mimic-io, learnRegistry isolation.
//   - StandardScaler: fit/transform/inverse_transform numerical correctness,
//     with_mean/with_std combinations, dump/load round-trip exactness.
//   - check_estimator: harness passes for StandardScaler, fails for buggy
//     estimators that violate the contract.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BaseEstimator, TransformerMixin, ClassifierMixin, RegressorMixin,
  clone, check_is_fitted, NotFittedError,
  dump, load, learnRegistry, check_estimator,
  StandardScaler,
} from '../ext/learn/src/main.js';

// ────────────────────────────────────────────────────────────────────
// BaseEstimator
// ────────────────────────────────────────────────────────────────────

class Toy extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.alpha = params.alpha ?? 1.0;
    this.beta = params.beta ?? 'square';
  }
}

class Wrapper extends BaseEstimator {
  constructor(params = {}) {
    super();
    this.inner = params.inner ?? new Toy();
    this.scale = params.scale ?? 1.0;
  }
}

describe('BaseEstimator', () => {
  test('get_params(false) returns only top-level params', () => {
    const t = new Toy({ alpha: 2.5, beta: 'circle' });
    assert.deepEqual(t.get_params(false), { alpha: 2.5, beta: 'circle' });
  });

  test('get_params(true) expands nested estimator with __ notation', () => {
    const w = new Wrapper({ inner: new Toy({ alpha: 7 }), scale: 3 });
    const p = w.get_params(true);
    assert.equal(p.scale, 3);
    assert.ok(p.inner instanceof Toy);
    assert.equal(p.inner__alpha, 7);
    assert.equal(p.inner__beta, 'square');
  });

  test('set_params updates direct params', () => {
    const t = new Toy();
    t.set_params({ alpha: 99 });
    assert.equal(t.alpha, 99);
  });

  test('set_params dispatches dotted params to nested estimator', () => {
    const w = new Wrapper({ inner: new Toy(), scale: 1 });
    w.set_params({ 'inner__alpha': 42, 'scale': 5 });
    assert.equal(w.inner.alpha, 42);
    assert.equal(w.scale, 5);
  });

  test('set_params raises on unknown param', () => {
    const t = new Toy();
    assert.throws(() => t.set_params({ gamma: 1 }), /Invalid parameter 'gamma'/);
  });

  test('set_params raises when dotted root is not an estimator', () => {
    const t = new Toy();
    assert.throws(() => t.set_params({ 'alpha__sub': 1 }), /not an estimator/);
  });

  test('set_params returns this', () => {
    const t = new Toy();
    assert.equal(t.set_params({ alpha: 5 }), t);
  });

  test('toString is sorted and stable', () => {
    const t = new Toy({ alpha: 1, beta: 'x' });
    assert.equal(t.toString(), "Toy(alpha=1, beta='x')");
  });
});

// ────────────────────────────────────────────────────────────────────
// clone
// ────────────────────────────────────────────────────────────────────

describe('clone', () => {
  test('returns fresh independent instance', () => {
    const t = new Toy({ alpha: 3 });
    const c = clone(t);
    assert.notEqual(c, t);
    assert.ok(c instanceof Toy);
    assert.equal(c.alpha, 3);
    c.alpha = 999;
    assert.equal(t.alpha, 3);
  });

  test('recursively clones nested estimators', () => {
    const w = new Wrapper({ inner: new Toy({ alpha: 7 }), scale: 2 });
    const c = clone(w);
    assert.notEqual(c.inner, w.inner);
    assert.equal(c.inner.alpha, 7);
    c.inner.alpha = 0;
    assert.equal(w.inner.alpha, 7);
  });

  test('discards fitted state', () => {
    const t = new Toy({ alpha: 1 });
    t.fitted_ = new Float64Array([1, 2, 3]);
    const c = clone(t);
    assert.equal(c.fitted_, undefined);
  });

  test('respects __sklearn_clone__ override', () => {
    class Custom extends BaseEstimator {
      constructor(params = {}) { super(); this.x = params.x ?? 0; this._cloned = false; }
      __sklearn_clone__() {
        const c = new Custom({ x: this.x });
        c._cloned = true;
        return c;
      }
    }
    const c = clone(new Custom({ x: 5 }));
    assert.equal(c.x, 5);
    assert.equal(c._cloned, true);
  });
});

// ────────────────────────────────────────────────────────────────────
// check_is_fitted
// ────────────────────────────────────────────────────────────────────

describe('check_is_fitted', () => {
  test('raises NotFittedError on unfitted estimator', () => {
    const t = new Toy();
    assert.throws(() => check_is_fitted(t), NotFittedError);
  });

  test('passes when at least one trailing-underscore attribute is present', () => {
    const t = new Toy();
    t.coef_ = new Float64Array([1, 2]);
    assert.doesNotThrow(() => check_is_fitted(t));
  });

  test('attributes argument requires specific attribute', () => {
    const t = new Toy();
    t.coef_ = new Float64Array([1, 2]);
    assert.doesNotThrow(() => check_is_fitted(t, 'coef_'));
    assert.throws(() => check_is_fitted(t, 'tree_'), NotFittedError);
  });

  test('respects __sklearn_is_fitted__ override', () => {
    const t = new Toy();
    t.__sklearn_is_fitted__ = () => true;
    assert.doesNotThrow(() => check_is_fitted(t));
    t.__sklearn_is_fitted__ = () => false;
    assert.throws(() => check_is_fitted(t), NotFittedError);
  });

  test('NotFittedError carries estimator name in message', () => {
    const t = new Toy();
    try { check_is_fitted(t); }
    catch (e) { assert.match(e.message, /Toy/); }
  });
});

// ────────────────────────────────────────────────────────────────────
// Mixins / tags
// ────────────────────────────────────────────────────────────────────

describe('mixins and tags', () => {
  test('TransformerMixin sets estimator_type=transformer', () => {
    class T extends BaseEstimator {}
    Object.assign(T.prototype, TransformerMixin);
    assert.equal(new T().__sklearn_tags__().estimator_type, 'transformer');
  });

  test('ClassifierMixin sets estimator_type=classifier and requires_y=true', () => {
    class C extends BaseEstimator {}
    Object.assign(C.prototype, ClassifierMixin);
    const tags = new C().__sklearn_tags__();
    assert.equal(tags.estimator_type, 'classifier');
    assert.equal(tags.requires_y, true);
  });

  test('RegressorMixin score returns R²', () => {
    class R extends BaseEstimator {
      predict() { return [1, 2, 3]; }
    }
    Object.assign(R.prototype, RegressorMixin);
    const r = new R();
    assert.equal(r.score(null, [1, 2, 3]), 1);  // perfect
  });
});

// ────────────────────────────────────────────────────────────────────
// StandardScaler — numerical correctness
// ────────────────────────────────────────────────────────────────────

describe('StandardScaler', () => {
  // Canonical small dataset with closed-form expected outputs.
  // X = [[1,2],[3,4],[5,6]], col means = [3,4], col vars = [8/3, 8/3],
  // scales = [√(8/3), √(8/3)].
  const X = [[1, 2], [3, 4], [5, 6]];

  test('fit computes per-column mean/var/scale', () => {
    const sc = new StandardScaler();
    sc.fit(X);
    assert.deepEqual(Array.from(sc.mean_), [3, 4]);
    const expectedVar = 8 / 3;
    for (let j = 0; j < 2; j++) {
      assert.ok(Math.abs(sc.var_[j] - expectedVar) < 1e-12);
      assert.ok(Math.abs(sc.scale_[j] - Math.sqrt(expectedVar)) < 1e-12);
    }
    assert.equal(sc.n_samples_seen_, 3);
    assert.equal(sc.n_features_in_, 2);
  });

  test('fit returns this', () => {
    const sc = new StandardScaler();
    assert.equal(sc.fit(X), sc);
  });

  test('transform produces zero mean unit variance per column', () => {
    const sc = new StandardScaler().fit(X);
    const Xt = sc.transform(X);
    assert.deepEqual(Xt.shape, [3, 2]);
    // Column means of transformed data ≈ 0.
    let m0 = 0, m1 = 0;
    for (let i = 0; i < 3; i++) { m0 += Xt[i * 2]; m1 += Xt[i * 2 + 1]; }
    assert.ok(Math.abs(m0) < 1e-12);
    assert.ok(Math.abs(m1) < 1e-12);
  });

  test('inverse_transform recovers the original', () => {
    const sc = new StandardScaler().fit(X);
    const Xt = sc.transform(X);
    const X_back = sc.inverse_transform(Xt);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        assert.ok(Math.abs(X_back[i * 2 + j] - X[i][j]) < 1e-12);
      }
    }
  });

  test('with_mean=false skips centering', () => {
    const sc = new StandardScaler({ with_mean: false }).fit(X);
    const Xt = sc.transform(X);
    // Should equal X / scale_, not (X - mean) / scale_.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        assert.ok(Math.abs(Xt[i * 2 + j] - X[i][j] / sc.scale_[j]) < 1e-12);
      }
    }
  });

  test('with_std=false skips scaling', () => {
    const sc = new StandardScaler({ with_std: false }).fit(X);
    // scale_ should be all 1s since with_std=false.
    assert.deepEqual(Array.from(sc.scale_), [1, 1]);
    const Xt = sc.transform(X);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        assert.ok(Math.abs(Xt[i * 2 + j] - (X[i][j] - sc.mean_[j])) < 1e-12);
      }
    }
  });

  test('zero-variance feature gets scale=1', () => {
    const Xz = [[1, 5], [2, 5], [3, 5]];  // second column is constant
    const sc = new StandardScaler().fit(Xz);
    assert.equal(sc.scale_[1], 1.0);
    assert.equal(sc.var_[1], 0);
  });

  test('transform raises on n_features mismatch', () => {
    const sc = new StandardScaler().fit(X);
    assert.throws(() => sc.transform([[1, 2, 3]]), /3 features.*fitted with 2/);
  });

  test('fit raises on 1D input with helpful message', () => {
    const sc = new StandardScaler();
    assert.throws(() => sc.fit([1, 2, 3]), /expected 2D/);
  });

  test('fit raises on NaN input', () => {
    const sc = new StandardScaler();
    assert.throws(() => sc.fit([[1, NaN], [2, 3]]), /non-finite/);
  });

  test('matches sklearn output bit-for-bit on canonical fixture', () => {
    // sklearn StandardScaler() on [[0,0],[0,0],[1,1],[1,1]] produces
    // mean=[0.5,0.5], var=[0.25,0.25], scale=[0.5,0.5].
    const sc = new StandardScaler().fit([[0, 0], [0, 0], [1, 1], [1, 1]]);
    assert.deepEqual(Array.from(sc.mean_), [0.5, 0.5]);
    assert.deepEqual(Array.from(sc.var_), [0.25, 0.25]);
    assert.deepEqual(Array.from(sc.scale_), [0.5, 0.5]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Serialization round-trip
// ────────────────────────────────────────────────────────────────────

describe('serialize: dump / load', () => {
  test('StandardScaler round-trips through dump/load preserving predictions', () => {
    const X = [[1, 2], [3, 4], [5, 6], [7, 8]];
    const sc = new StandardScaler().fit(X);
    const Xt_before = Array.from(sc.transform(X));

    const json = dump(sc);
    assert.equal(json.format, 'mimic-io');
    assert.equal(json.version, 2);
    assert.equal(json.class, 'StandardScaler');
    assert.equal(json.module, '@gcu/learn.preprocessing');
    assert.deepEqual(json.params, { with_mean: true, with_std: true });
    assert.ok(json.fitted.mean_);
    assert.ok(json.fitted.scale_);

    const reloaded = load(json);
    assert.ok(reloaded instanceof StandardScaler);
    const Xt_after = Array.from(reloaded.transform(X));
    assert.deepEqual(Xt_after, Xt_before);
  });

  test('JSON-string round-trip works', () => {
    const sc = new StandardScaler().fit([[1, 2], [3, 4]]);
    const text = JSON.stringify(dump(sc));
    const reloaded = load(text);
    assert.deepEqual(Array.from(reloaded.mean_), Array.from(sc.mean_));
  });

  test('learnRegistry is isolated from mimic-io defaultRegistry', () => {
    assert.ok(learnRegistry.has('StandardScaler'));
  });

  test('load with hyperparameter changes reflects in reload', () => {
    const sc = new StandardScaler({ with_mean: false }).fit([[1, 2], [3, 4]]);
    const reloaded = load(dump(sc));
    assert.equal(reloaded.with_mean, false);
    assert.equal(reloaded.with_std, true);
  });
});

// ────────────────────────────────────────────────────────────────────
// check_estimator harness
// ────────────────────────────────────────────────────────────────────

describe('check_estimator', () => {
  test('passes for StandardScaler', () => {
    const errs = check_estimator(StandardScaler, { collect: true });
    assert.deepEqual(errs, [], `unexpected violations:\n  ${errs.join('\n  ')}`);
  });

  test('passes for instance form', () => {
    const errs = check_estimator(new StandardScaler({ with_mean: false }),
                                 { collect: true });
    assert.deepEqual(errs, []);
  });

  test('throws on first failure when collect=false', () => {
    class Broken extends BaseEstimator {
      constructor(params = {}) {
        super();
        this.alpha = params.alpha ?? 1;
        this.bogus_ = 99;  // fitted attr at construction — violation
      }
    }
    assert.throws(() => check_estimator(Broken),
      /fitted attribute 'bogus_' present after construction/);
  });

  test('catches estimator that does not return this from fit', () => {
    class NoReturn extends BaseEstimator {
      constructor(params = {}) { super(); this.alpha = params.alpha ?? 1; }
      fit() { this.coef_ = new Float64Array([1]); /* no return */ }
      transform(X) {
        const m = (X.shape ?? [X.length, X[0].length])[1];
        const n = (X.shape ?? [X.length, X[0].length])[0];
        const out = new Float64Array(n * m);
        out.shape = [n, m];
        return out;
      }
    }
    Object.assign(NoReturn.prototype, TransformerMixin);
    NoReturn._estimator_type = 'transformer';
    const errs = check_estimator(NoReturn, { collect: true });
    assert.ok(errs.some(e => /fit:.*did not return this/.test(e)),
              `expected 'did not return this' in:\n  ${errs.join('\n  ')}`);
  });
});
