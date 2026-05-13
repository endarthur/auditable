// @gcu/learn — adder bridge integration test.
//
// Verifies that adder cells can use the sklearn-compatible namespace
// with Python kwargs (the SPEC §3.6 deviation #1 claim: "the adder
// bridge re-rehydrates Python kwargs from the trailing object, so
// Python notebook code in adder cells looks unchanged").
//
// Approach: stub a browser-shaped global (window === globalThis), load
// learn's adder.js to register the namespace, then run snippets through
// adder's pythonExecute and inspect the output / assigned scope.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── DOM shim (matches test/adder-interp.test.mjs pattern) ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };

// Load learn first so its adder.js registers into window._auditableExtensions.
await import('../ext/learn/adder.js');
const { pythonExecute } = await import('../ext/adder/src/cell.js');

// Run an adder cell and return its `defines` map so tests can inspect
// the post-execution top-level bindings.
async function runCell(code) {
  const cell = { id: `t${Math.random().toString(36).slice(2)}` };
  const { defines } = await pythonExecute(code, {}, cell);
  return { scope: defines };
}

// ────────────────────────────────────────────────────────────────────
// Module resolution + namespace access
// ────────────────────────────────────────────────────────────────────

describe('adder bridge — namespace resolution', () => {
  test('learn module resolves and exposes submodules', async () => {
    const { scope } = await runCell(
      'from learn import preprocessing\n' +
      'x = preprocessing.StandardScaler\n'
    );
    assert.equal(typeof scope.x, 'function');
    assert.equal(scope.x.name, 'StandardScaler');
  });

  test('from learn.preprocessing import StandardScaler', async () => {
    const { scope } = await runCell(
      'from learn.preprocessing import StandardScaler\n' +
      'x = StandardScaler\n'
    );
    assert.equal(typeof scope.x, 'function');
    assert.equal(scope.x.name, 'StandardScaler');
  });

  test('from learn.tree import DecisionTreeClassifier, DecisionTreeRegressor', async () => {
    const { scope } = await runCell(
      'from learn.tree import DecisionTreeClassifier, DecisionTreeRegressor\n' +
      'a = DecisionTreeClassifier\n' +
      'b = DecisionTreeRegressor\n'
    );
    assert.equal(scope.a.name, 'DecisionTreeClassifier');
    assert.equal(scope.b.name, 'DecisionTreeRegressor');
  });
});

// ────────────────────────────────────────────────────────────────────
// Kwarg rehydration — the SPEC §3.6 deviation #1 claim
// ────────────────────────────────────────────────────────────────────

describe('adder bridge — Python kwargs', () => {
  test('keyword arguments reach the JS constructor', async () => {
    const { scope } = await runCell(
      'from learn.preprocessing import StandardScaler\n' +
      'sc = StandardScaler(with_mean=True, with_std=False)\n'
    );
    assert.equal(scope.sc.with_mean, true);
    assert.equal(scope.sc.with_std, false);
  });

  test('mixed positional + keyword args (DecisionTreeClassifier)', async () => {
    const { scope } = await runCell(
      'from learn.tree import DecisionTreeClassifier\n' +
      'tree = DecisionTreeClassifier(max_depth=4, random_state=42)\n'
    );
    assert.equal(scope.tree.max_depth, 4);
    assert.equal(scope.tree.random_state, 42);
  });

  test('no-arg constructor still works', async () => {
    const { scope } = await runCell(
      'from learn.preprocessing import StandardScaler\n' +
      'sc = StandardScaler()\n'
    );
    // Defaults preserved.
    assert.equal(scope.sc.with_mean, true);
    assert.equal(scope.sc.with_std, true);
  });

  test('explicit keyword overrides default', async () => {
    const { scope } = await runCell(
      'from learn.cluster import KMeans\n' +
      'km = KMeans(n_clusters=5, random_state=7)\n'
    );
    assert.equal(scope.km.n_clusters, 5);
    assert.equal(scope.km.random_state, 7);
    assert.equal(scope.km.n_init, 10);  // default preserved
  });
});

// ────────────────────────────────────────────────────────────────────
// fit/predict/score through Python syntax
// ────────────────────────────────────────────────────────────────────

describe('adder bridge — fit/predict cycle', () => {
  test('StandardScaler fit + transform on a Python list-of-lists', async () => {
    const { scope } = await runCell(
      'from learn.preprocessing import StandardScaler\n' +
      'sc = StandardScaler()\n' +
      'X = [[1, 2], [3, 4], [5, 6]]\n' +
      'sc.fit(X)\n' +
      'mean = list(sc.mean_)\n' +
      'scale = list(sc.scale_)\n'
    );
    assert.deepEqual(scope.mean, [3, 4]);
    assert.ok(Math.abs(scope.scale[0] - Math.sqrt(8 / 3)) < 1e-12);
  });

  test('DecisionTreeClassifier fit + predict + accuracy', async () => {
    const { scope } = await runCell(
      'from learn.tree import DecisionTreeClassifier\n' +
      'from learn.metrics import accuracy_score\n' +
      'X = [[0, 0], [1, 0], [0, 1], [1, 1], [10, 10], [11, 10], [10, 11], [11, 11]]\n' +
      'y = [0, 0, 0, 0, 1, 1, 1, 1]\n' +
      'tree = DecisionTreeClassifier(random_state=0)\n' +
      'tree.fit(X, y)\n' +
      'yhat = list(tree.predict(X))\n' +
      'acc = accuracy_score(y, tree.predict(X))\n'
    );
    assert.deepEqual(scope.yhat, [0, 0, 0, 0, 1, 1, 1, 1]);
    assert.equal(scope.acc, 1);
  });

  test('Pipeline chain with kwargs at every step', async () => {
    const { scope } = await runCell(
      'from learn.pipeline import Pipeline\n' +
      'from learn.preprocessing import StandardScaler\n' +
      'from learn.tree import DecisionTreeClassifier\n' +
      'pipe = Pipeline(steps=[\n' +
      '  ("scaler", StandardScaler()),\n' +
      '  ("clf", DecisionTreeClassifier(max_depth=3, random_state=0)),\n' +
      '])\n' +
      'X = [[0, 0], [1, 1], [10, 10], [11, 11]]\n' +
      'y = [0, 0, 1, 1]\n' +
      'pipe.fit(X, y)\n' +
      'yhat = list(pipe.predict(X))\n'
    );
    assert.deepEqual(scope.yhat, [0, 0, 1, 1]);
    assert.equal(scope.pipe.named_steps.clf.max_depth, 3);
  });

  test('cross_val_score with KFold', async () => {
    const { scope } = await runCell(
      'from learn.tree import DecisionTreeClassifier\n' +
      'from learn.model_selection import cross_val_score, KFold\n' +
      'X = [[i, i] for i in range(20)]\n' +
      'y = [i % 2 for i in range(20)]\n' +
      'cv = KFold(n_splits=4, shuffle=True, random_state=0)\n' +
      'tree = DecisionTreeClassifier(random_state=0)\n' +
      'scores = list(cross_val_score(tree, X, y, cv=cv))\n'
    );
    assert.equal(scope.scores.length, 4);
    for (const s of scope.scores) assert.ok(Number.isFinite(s));
  });
});

// ────────────────────────────────────────────────────────────────────
// dump / load through Python syntax
// ────────────────────────────────────────────────────────────────────

describe('adder bridge — mimic-io dump/load', () => {
  test('round-trip a DecisionTreeClassifier through dump/load', async () => {
    const { scope } = await runCell(
      'from learn.tree import DecisionTreeClassifier\n' +
      'from learn import dump, load\n' +
      'X = [[0, 0], [1, 1], [10, 10], [11, 11]]\n' +
      'y = [0, 0, 1, 1]\n' +
      'tree = DecisionTreeClassifier(random_state=0)\n' +
      'tree.fit(X, y)\n' +
      'before = list(tree.predict(X))\n' +
      'reloaded = load(dump(tree))\n' +
      'after = list(reloaded.predict(X))\n'
    );
    assert.deepEqual(scope.before, [0, 0, 1, 1]);
    assert.deepEqual(scope.after, [0, 0, 1, 1]);
  });
});
