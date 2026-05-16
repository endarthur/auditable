// Pyrcz-shaped adder cells — pre-flight tester for ipynb compat.
//
// Mirrors the kind of code Jupyter notebooks (Pyrcz's geostatistics
// demos in particular) throw at us after the @gcu/ipynb rewrite:
// `from scipy import stats; stats.gmean(np.exp(np.random.normal(...)))`
// etc. Runs natra + scitra + plt + IPython.display together through
// adder's pythonExecute, so we catch missing API surface from node
// before round-tripping through a browser.
//
// Add a new `test(...)` for each notebook idiom that breaks; each one
// is a small reproduction of the actual failing line. When the test
// passes, the corresponding browser path works too.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── DOM shim (browser-like globals) ──
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
    src: '', width: 0, height: 0, alt: '',
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

// Order matters: each `import` triggers a side-effect registration
// (window._auditableExtensions). natra needs its own load + adapter
// step, scitra and plt self-register from their bundles, IPython
// adapter registers from its own file.
const _natra = await import('../ext/natra/index.js');
window._importCache = window._importCache || {};
window._importCache['../ext/natra/index.js'] = _natra;
await import('../ext/natra/adder.js');

await import('../ext/scitra/index.js');
window._importCache['@gcu/scitra'] = await import('../ext/scitra/index.js');
await import('../ext/scitra/adder.js');

await import('../ext/plot/index.js');

await import('../ext/ipython-adapter/adder.js');

const { pythonExecute } = await import('../ext/adder/src/cell.js');

async function runCell(code) {
  const cell = { id: `t${Math.random().toString(36).slice(2)}` };
  const { defines, output } = await pythonExecute(code, {}, cell);
  return { scope: defines, output };
}

// ── natra: numpy basics ──

describe('natra: numpy basics', () => {
  test('np.linspace, np.arange', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'a = np.linspace(0, 10, 5)\n' +
      'b = np.arange(0, 5)\n'
    );
    assert.ok(scope.a);
    assert.ok(scope.b);
  });

  test('np.random.normal accepts size= scalar', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'x = np.random.normal(loc=2.0, scale=1.0, size=100)\n'
    );
    assert.ok(scope.x);
  });

  test('np.exp on ndarray', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'x = np.random.normal(size=10)\n' +
      'y = np.exp(x)\n'
    );
    assert.ok(scope.y);
  });

  test('np.average — scalar reduction', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'y = np.linspace(0, 10, 5)\n' +
      'm = np.average(y)\n'
    );
    assert.ok(typeof scope.m === 'number');
    assert.ok(Math.abs(scope.m - 5) < 1e-9);
  });

  test('np.percentile — median', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'y = np.arange(0, 11)\n' +
      'p = np.percentile(y, 50)\n'
    );
    assert.equal(scope.p, 5);
  });

  test('np.logspace — log-spaced bins', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'b = np.logspace(0, 2, 3)\n'  // 1, 10, 100
    );
    assert.ok(scope.b);
  });

  test('np.sort', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'a = np.sort(np.random.normal(size=10))\n'
    );
    assert.ok(scope.a);
  });
});

// ── scitra: scipy.stats basics ──

describe('scitra: scipy.stats basics', () => {
  test('stats.gmean on natra ndarray', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'from scitra import stats\n' +
      'x = np.linspace(1.0, 10.0, 10)\n' +
      'g = stats.gmean(x)\n'
    );
    assert.ok(typeof scope.g === 'number');
    assert.ok(scope.g > 0);
    assert.ok(!Number.isNaN(scope.g));
  });

  test('stats.hmean on natra ndarray', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'from scitra import stats\n' +
      'x = np.linspace(1.0, 10.0, 10)\n' +
      'h = stats.hmean(x)\n'
    );
    assert.ok(typeof scope.h === 'number');
    assert.ok(scope.h > 0);
  });

  test('stats.norm(loc, scale).cdf — frozen distribution on natra array', async () => {
    const { scope } = await runCell(
      'import natra as np\n' +
      'from scitra import stats\n' +
      'd = stats.norm(0, 1)\n' +
      'c = d.cdf(1.96)\n'
    );
    assert.ok(Math.abs(scope.c - 0.975) < 0.001);
  });
});

// ── Pyrcz-shape: the actual failing cell ──

describe('Pyrcz Central Tendency notebook — synthesized', () => {
  test('whole cell runs end-to-end', async () => {
    const { scope } = await runCell([
      'import natra as np',
      'from scitra import stats',
      'x = np.random.normal(loc=2.0, scale=1.0, size=1000)',
      'y = np.exp(x)',
      'arith = np.average(y)',
      'geo = stats.gmean(y)',
      'harm = stats.hmean(y)',
      'med = np.percentile(y, 50)',
    ].join('\n'));
    assert.ok(typeof scope.arith === 'number');
    assert.ok(typeof scope.geo === 'number');
    assert.ok(typeof scope.harm === 'number');
    assert.ok(typeof scope.med === 'number');
    // geo mean < arith mean for lognormal — sanity check
    assert.ok(scope.geo < scope.arith);
    assert.ok(scope.harm < scope.geo);
  });
});
