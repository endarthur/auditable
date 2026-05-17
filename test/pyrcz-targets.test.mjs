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

// ── DOM shim (browser-like globals with no-op Canvas 2D context) ──
import { installDomShim } from './helpers/dom-shim.mjs';
installDomShim();

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

await import('../ext/sadpan/index.js');

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

describe('sadpan: iloc / loc / at / iat accessors', () => {
  test('df.iloc[r, c] scalar', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30], "b": [1, 2, 3]})',
      'v = df.iloc[1, 0]',
    ].join('\n'));
    assert.equal(scope.v, 20);
  });

  test('df.iloc[:, 0] returns Series', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30], "b": [1, 2, 3]})',
      'col = df.iloc[:, 0]',
      'first = col[0]',
      'n = len(col)',
    ].join('\n'));
    assert.equal(scope.first, 10);
    assert.equal(scope.n, 3);
  });

  test('df.iloc[0:2] slice returns DataFrame', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30], "b": [1, 2, 3]})',
      'sub = df.iloc[0:2]',
      'nrows = sub.shape[0]',
    ].join('\n'));
    assert.equal(scope.nrows, 2);
  });

  test('df.loc[:, "a"] by column name returns Series', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30], "b": [1, 2, 3]})',
      'col = df.loc[:, "a"]',
      'first = col[0]',
    ].join('\n'));
    assert.equal(scope.first, 10);
  });

  test('df.at[1, "b"] scalar by label', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30], "b": [1, 2, 3]})',
      'v = df.at[1, "b"]',
    ].join('\n'));
    assert.equal(scope.v, 2);
  });

  test('df.iat[2, 1] scalar by position', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30], "b": [1, 2, 3]})',
      'v = df.iat[2, 1]',
    ].join('\n'));
    assert.equal(scope.v, 3);
  });

  test('df.iloc[0, 0] = value assignment', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30]})',
      'df.iloc[0, 0] = 99',
      'v = df.iloc[0, 0]',
    ].join('\n'));
    assert.equal(scope.v, 99);
  });

  test('df.index is a RangeIndex', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20, 30]})',
      'idx = df.index',
      'n = len(idx)',
      'first = idx[0]',
    ].join('\n'));
    assert.equal(scope.n, 3);
    assert.equal(scope.first, 0);
  });

  test('df.to_numpy() returns 2D nested list', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a": [10, 20], "b": [1, 2]})',
      'arr = df.to_numpy()',
      'first = arr[0][0]',
      'last = arr[1][1]',
    ].join('\n'));
    assert.equal(scope.first, 10);
    assert.equal(scope.last, 2);
  });

  test('pd.NaN is a NaN value', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'x = pd.NaN',
      'is_nan = x != x',  // standard NaN check
    ].join('\n'));
    assert.equal(scope.is_nan, true);
  });
});

describe('adder: multi-dim subscript (arr[i, j])', () => {
  test('read: scalar 2D index on natra ndarray', async () => {
    const { scope } = await runCell([
      'import natra as np',
      'a = np.zeros([3, 4])',
      'a[1, 2] = 42.0',
      'v = a[1, 2]',
      'z = a[0, 0]',
    ].join('\n'));
    assert.equal(scope.v, 42);
    assert.equal(scope.z, 0);
  });

  test('read: slice + scalar (arr[:, 0])', async () => {
    const { scope } = await runCell([
      'import natra as np',
      'a = np.zeros([3, 4])',
      'a[0, 0] = 1.0',
      'a[1, 0] = 2.0',
      'a[2, 0] = 3.0',
      'col0 = a[:, 0]',
      'sum0 = float(np.sum(col0))',
    ].join('\n'));
    assert.equal(scope.sum0, 6);
  });

  test('Pyrcz-shape: arr[i, j] in for-loop body', async () => {
    // Same shape as Bootstrap.ipynb cell that broke before:
    // draw[isample, ireal] = rand.choice(data)
    const { scope } = await runCell([
      'import natra as np',
      'n = 3',
      'a = np.zeros([n, n])',
      'for i in range(n):',
      '    for j in range(n):',
      '        a[i, j] = float(i * n + j)',
      'last = a[n-1, n-1]',
    ].join('\n'));
    assert.equal(scope.last, 8);  // 2*3+2
  });
});

describe('plt: hist counts + np.max round-trip', () => {
  test('bins[0] from plt.hist is iterable for np.max', async () => {
    const { scope } = await runCell([
      'import natra as np',
      'import plt',
      'y = np.exp(np.random.normal(loc=2.0, scale=1.0, size=10000))',
      'bins_edges = np.logspace(start=np.log10(0.01), stop=np.log10(10000), num=100)',
      'result = plt.hist(y, bins=bins_edges)',
      'counts = result[0]',
      'top = np.max(counts) * 1.1',
    ].join('\n'));
    // Should land somewhere between 100 and 2000 (10000 samples spread
    // over 100 log-spaced bins, lognormal — bulk in 10ish bins → ~500-1500).
    assert.ok(typeof scope.top === 'number',
      `expected number, got ${typeof scope.top}: ${scope.top}`);
    assert.ok(scope.top > 50 && scope.top < 5000,
      `np.max(counts)*1.1 = ${scope.top}, expected somewhere in [50, 5000]`);
  });
});

describe('plt: hist with ndarray bins', () => {
  test('plt.hist(y, bins=ndarray, color=, edgecolor=, alpha=, zorder=)', async () => {
    // Matches the Pyrcz Central Tendency plot cell line 11.
    const { scope } = await runCell([
      'import natra as np',
      'import plt',
      'y = np.exp(np.random.normal(loc=2.0, scale=1.0, size=1000))',
      'bins = np.logspace(start=np.log10(0.01), stop=np.log10(10000), num=100)',
      'h = plt.hist(y, bins=bins, color="darkorange", edgecolor="black", alpha=1.0, zorder=10)',
    ].join('\n'));
    assert.ok(scope.h !== undefined);
  });
});

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
