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

// VFS — adder's os/path/etc and sadpan's to_csv-to-path need this.
const { VFS, MemoryBackend, path: vfsPath } = await import('../ext/vfs/index.js');
const _vfs = new VFS();
_vfs._mounts.set('/home/nb', new MemoryBackend());
_vfs._mounts.set('/var', new MemoryBackend());
_vfs._mounts.set('/tmp', new MemoryBackend());
_vfs._mounts.set('/usr/lib/python', new MemoryBackend());
window._notebookVFS = _vfs;
window._vfsPath = vfsPath;

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

describe('plt + scitra + sadpan: sweep-surfaced gaps', () => {
  test('plt.subplot(1,1,1) returns axes', async () => {
    const { scope } = await runCell([
      'import plt',
      'ax = plt.subplot(1, 1, 1)',
      'has_plot = hasattr(ax, "plot")',
    ].join('\n'));
    assert.equal(scope.has_plot, true);
  });

  test('plt.cm.viridis is a colormap function', async () => {
    const { scope } = await runCell([
      'import plt',
      'cmap = plt.cm.viridis',
      'color = cmap(0.5)',
    ].join('\n'));
    assert.ok(typeof scope.color === 'string');
    assert.ok(scope.color.startsWith('rgb('));
  });

  test('df.transpose() swaps rows + cols', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2,3], "b":[10,20,30]})',
      't = df.transpose()',
      'shape = t.shape',
    ].join('\n'));
    // Original was 3×2 (3 rows, 2 cols) → transposed is 2×3
    assert.deepEqual(scope.shape, [2, 3]);
  });

  test('df.T property is transpose', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2], "b":[10,20], "c":[100,200]})',
      'shape = df.T.shape',
    ].join('\n'));
    assert.deepEqual(scope.shape, [3, 2]);  // 2 rows → 2 cols, 3 cols → 3 rows
  });

  test('scitra.stats.t.cdf(0, 10) is ~0.5', async () => {
    const { scope } = await runCell([
      'from scitra import stats',
      'p = stats.t.cdf(0, 10)',
    ].join('\n'));
    assert.ok(Math.abs(scope.p - 0.5) < 1e-9);
  });

  test('scitra.stats.t(df).ppf(0.975) for df=10 is ~2.228', async () => {
    const { scope } = await runCell([
      'from scitra import stats',
      'crit = stats.t(10).ppf(0.975)',
    ].join('\n'));
    // R: qt(0.975, 10) = 2.228139
    assert.ok(Math.abs(scope.crit - 2.228139) < 0.001);
  });
});

describe('sadpan: to_csv path vs string', () => {
  test('df.to_csv() returns the CSV text', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2], "b":[10,20]})',
      'text = df.to_csv()',
    ].join('\n'));
    assert.ok(typeof scope.text === 'string');
    assert.ok(scope.text.includes('a,b'));
    assert.ok(scope.text.includes('1,10'));
  });

  test('df.to_csv("/home/nb/out.csv") writes to VFS', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2], "b":[10,20]})',
      'result = df.to_csv("/home/nb/out.csv")',
    ].join('\n'));
    // pandas returns None on file write
    assert.equal(scope.result, null);
    // File should be readable via VFS
    const text = await window._notebookVFS.readFile('/home/nb/out.csv', 'text');
    assert.ok(text.includes('a,b'));
    assert.ok(text.includes('1,10'));
  });

  test('df.to_csv("relative.csv") writes under /home/nb/', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"x":[7]})',
      'result = df.to_csv("relative.csv")',
    ].join('\n'));
    assert.equal(scope.result, null);
    const text = await window._notebookVFS.readFile('/home/nb/relative.csv', 'text');
    assert.ok(text.includes('x'));
    assert.ok(text.includes('7'));
  });
});

describe('sadpan: drop() row + column', () => {
  test('df.drop("a", axis=1) removes the column', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2,3], "b":[10,20,30]})',
      'df2 = df.drop("a", axis=1)',
      'cols = df2.columns',
      'n = df2.shape[0]',
    ].join('\n'));
    assert.deepEqual(scope.cols, ['b']);
    assert.equal(scope.n, 3);
  });

  test('df.drop(2, axis=0) drops a row by index', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[10,20,30,40], "b":[1,2,3,4]})',
      'df2 = df.drop(2, axis=0)',
      'shape = df2.shape',
      'first_a = df2.iloc[0, 0]',
      'last_a = df2.iloc[-1, 0]',
    ].join('\n'));
    assert.deepEqual(scope.shape, [3, 2]);
    assert.equal(scope.first_a, 10);
    assert.equal(scope.last_a, 40);   // row 2 (value 30) gone
  });

  test('df.drop([0, 2], axis=0) drops multiple rows', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[10,20,30,40]})',
      'df2 = df.drop([0, 2], axis=0)',
      'shape = df2.shape',
      'first = df2.iloc[0, 0]',
      'second = df2.iloc[1, 0]',
    ].join('\n'));
    assert.deepEqual(scope.shape, [2, 1]);
    assert.equal(scope.first, 20);
    assert.equal(scope.second, 40);
  });

  test('df.drop(columns=["a"]) infers axis=1', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2], "b":[10,20]})',
      'df2 = df.drop(columns=["a"])',
      'cols = df2.columns',
    ].join('\n'));
    assert.deepEqual(scope.cols, ['b']);
  });

  test('df.drop(index=[1]) infers axis=0', async () => {
    const { scope } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[10,20,30]})',
      'df2 = df.drop(index=[1])',
      'shape = df2.shape',
      'first = df2.iloc[0, 0]',
      'second = df2.iloc[1, 0]',
    ].join('\n'));
    assert.deepEqual(scope.shape, [2, 1]);
    assert.equal(scope.first, 10);
    assert.equal(scope.second, 30);
  });
});

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

describe('adder: rebind self pattern (x = x.method(...))', () => {
  test('df = df.rename(...) reads upstream df, then rebinds', async () => {
    // Set up df in scope (simulates upstream cell).
    const { scope: s1 } = await runCell([
      'import sadpan as pd',
      'df = pd.DataFrame({"a":[1,2,3]})',
    ].join('\n'));
    // Then a cell that rebinds: must see upstream df on RHS.
    const cell2 = { id: 'rebind', _ctx: null };
    const { defines } = await import('../ext/adder/src/cell.js').then(m => m.pythonExecute(
      'import sadpan as pd\ndf = df.rename(columns={"a":"b"})\n',
      s1, cell2,
    ));
    assert.ok(defines.df, 'df should be defined post-cell');
    assert.deepEqual(defines.df.columns, ['b']);
  });

  test('y = x + 1 with x upstream + y self-defined', async () => {
    const { scope: s1 } = await runCell('x = 5');
    const cell2 = { id: 'arith', _ctx: null };
    const { defines } = await import('../ext/adder/src/cell.js').then(m => m.pythonExecute(
      'y = x + 1\n', s1, cell2,
    ));
    assert.equal(defines.y, 6);
  });

  test('forward-ref inside function body still works', async () => {
    // outer() references inner() before inner is defined at module
    // level — adder must NOT try to import inner from upstream.
    const { scope } = await runCell([
      'def outer():',
      '    return inner()',
      'def inner():',
      '    return 42',
      'v = outer()',
    ].join('\n'));
    assert.equal(scope.v, 42);
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
