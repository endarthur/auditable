// @gcu/scitra — adder bridge integration test.
//
// Same shape as learn-adder-bridge.test.mjs: stub browser globals, load
// scitra's adder.js to register the `scitra` namespace, then run
// snippets through adder's pythonExecute.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── DOM shim ──
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

await import('../ext/scitra/adder.js');
const { pythonExecute } = await import('../ext/adder/src/cell.js');

async function runCell(code) {
  const cell = { id: `t${Math.random().toString(36).slice(2)}` };
  const { defines } = await pythonExecute(code, {}, cell);
  return { scope: defines };
}

describe('adder bridge — namespace resolution', () => {
  test('scitra module resolves and exposes submodules', async () => {
    const { scope } = await runCell(
      'from scitra import stats\n' +
      'x = stats.norm\n'
    );
    assert.equal(typeof scope.x, 'function');
  });

  test('from scitra.stats import norm', async () => {
    const { scope } = await runCell(
      'from scitra.stats import norm\n' +
      'x = norm\n'
    );
    assert.equal(typeof scope.x, 'function');
  });

  test('from scitra.spatial import KDTree', async () => {
    const { scope } = await runCell(
      'from scitra.spatial import KDTree\n' +
      'x = KDTree\n'
    );
    assert.equal(typeof scope.x, 'function');
    assert.equal(scope.x.name, 'KDTree');
  });

  test('from scitra.spatial.distance import cdist, pdist, squareform', async () => {
    const { scope } = await runCell(
      'from scitra.spatial.distance import cdist, pdist, squareform\n' +
      'a = cdist\n' +
      'b = pdist\n' +
      'c = squareform\n'
    );
    assert.equal(typeof scope.a, 'function');
    assert.equal(typeof scope.b, 'function');
    assert.equal(typeof scope.c, 'function');
  });

  test('from scitra.optimize import curve_fit, least_squares', async () => {
    const { scope } = await runCell(
      'from scitra.optimize import curve_fit, least_squares\n' +
      'a = curve_fit\n' +
      'b = least_squares\n'
    );
    assert.equal(typeof scope.a, 'function');
    assert.equal(typeof scope.b, 'function');
  });

  test('from scitra.special import erf, gamma', async () => {
    const { scope } = await runCell(
      'from scitra.special import erf, gamma\n' +
      'a = erf\n' +
      'b = gamma\n'
    );
    assert.equal(typeof scope.a, 'function');
    assert.equal(typeof scope.b, 'function');
  });
});

describe('adder bridge — call into scipy-shape primitives', () => {
  test('scitra.special.erf returns a scalar', async () => {
    const { scope } = await runCell(
      'from scitra.special import erf\n' +
      'y = erf(0.5)\n'
    );
    assert.ok(typeof scope.y === 'number');
    // erf(0.5) ≈ 0.5204998778
    assert.ok(Math.abs(scope.y - 0.5204998778) < 1e-6);
  });

  test('norm() frozen distribution: pdf / cdf', async () => {
    const { scope } = await runCell(
      'from scitra.stats import norm\n' +
      'd = norm(0, 1)\n' +
      'p = d.pdf(0)\n' +
      'c = d.cdf(0)\n'
    );
    // pdf(0) for N(0,1) = 1/sqrt(2π) ≈ 0.3989422804
    assert.ok(Math.abs(scope.p - 0.3989422804) < 1e-6);
    // cdf(0) for N(0,1) = 0.5
    assert.ok(Math.abs(scope.c - 0.5) < 1e-9);
  });

  test('norm.cdf as class-method shortcut', async () => {
    const { scope } = await runCell(
      'from scitra.stats import norm\n' +
      'c = norm.cdf(0, 0, 1)\n'
    );
    assert.ok(Math.abs(scope.c - 0.5) < 1e-9);
  });

  test('KDTree query returns nearest indices', async () => {
    // scitra's KDTree.query returns { dist, idx } (TypedArrays), not the
    // scipy tuple shape. Bridge passes through verbatim — see ROADMAP
    // entry "scitra KDTree query — scipy tuple-return parity".
    const { scope } = await runCell(
      'from scitra.spatial import KDTree\n' +
      'pts = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]\n' +
      'tree = KDTree(pts)\n' +
      'r = tree.query([0.1, 0.1])\n' +
      'i = r.idx[0]\n' +
      'd = r.dist[0]\n'
    );
    assert.equal(scope.i, 0);
    assert.ok(scope.d < 0.2);
  });
});
