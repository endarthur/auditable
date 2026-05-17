// Tests for @gcu/ipynb — import/export bridge between Jupyter .ipynb and
// Auditable cells. Covers the substitution table, code/markdown/raw
// mapping, magic stripping, and round-trip preservation for the cells
// that have an Auditable equivalent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rewriteImports,
  rewriteImportLine,
  rewriteImportsBack,
  parseIpynb,
  serializeIpynb,
  importNotebook,
  exportNotebook,
  SUBSTITUTIONS,
} from '../ext/ipynb/src/api.js';

test('substitutions: bare import numpy', () => {
  const { rewritten } = rewriteImportLine('import numpy');
  assert.equal(rewritten, 'import natra as numpy');
});

test('substitutions: import numpy as np', () => {
  const { rewritten, applied } = rewriteImportLine('import numpy as np');
  assert.equal(rewritten, 'import natra as np');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].original, 'numpy');
  assert.equal(applied[0].rewritten, 'natra');
});

test('substitutions: from numpy import linalg, array', () => {
  const { rewritten } = rewriteImportLine('from numpy import linalg, array');
  assert.equal(rewritten, 'from natra import linalg, array');
});

test('substitutions: from numpy.linalg import inv', () => {
  // Prefix substitution: numpy is in the table, .linalg is preserved.
  const { rewritten } = rewriteImportLine('from numpy.linalg import inv');
  assert.equal(rewritten, 'from natra.linalg import inv');
});

test('substitutions: matplotlib.pyplot is an exact key', () => {
  // @gcu/plot registers in adder as `plt` (not `plot`), so the mapping
  // is matplotlib.pyplot → plt. The `as plt` alias survives.
  const { rewritten } = rewriteImportLine('import matplotlib.pyplot as plt');
  assert.equal(rewritten, 'import plt as plt');
});

test('substitutions: pandas, scipy, sklearn', () => {
  assert.equal(rewriteImportLine('import pandas as pd').rewritten, 'import sadpan as pd');
  // Bare `import scipy` becomes `import scitra as scipy` to preserve
  // the user's reference name — later code that does `scipy.linalg.X`
  // would break if the alias were dropped.
  assert.equal(rewriteImportLine('import scipy').rewritten, 'import scitra as scipy');
  assert.equal(rewriteImportLine('from sklearn.tree import DecisionTreeClassifier').rewritten,
    'from learn.tree import DecisionTreeClassifier');
});

test('substitutions: bare imports get an as-alias to preserve name', () => {
  assert.equal(rewriteImportLine('import numpy').rewritten, 'import natra as numpy');
  assert.equal(rewriteImportLine('import sklearn').rewritten, 'import learn as sklearn');
});

test('substitutions: explicit alias survives', () => {
  // User-provided `as` shouldn't be clobbered by the auto-alias.
  assert.equal(rewriteImportLine('import numpy as foo').rewritten, 'import natra as foo');
});

test('substitutions: comma-separated import', () => {
  // Bare `numpy` gets `as numpy` to preserve the name; `pandas as pd`
  // already had an alias so it survives; `json` isn't in the table so
  // it stays unchanged.
  const { rewritten } = rewriteImportLine('import numpy, pandas as pd, json');
  assert.equal(rewritten, 'import natra as numpy, sadpan as pd, json');
});

test('substitutions: unknown package passes through', () => {
  const { rewritten, applied } = rewriteImportLine('import requests');
  assert.equal(rewritten, 'import requests');
  assert.equal(applied, null);
});

test('substitutions: preserves indentation', () => {
  const { rewritten } = rewriteImportLine('    import numpy as np');
  assert.equal(rewritten, '    import natra as np');
});

test('substitutions: preserves trailing comment', () => {
  const { rewritten } = rewriteImportLine('import numpy as np  # the workhorse');
  assert.equal(rewritten, 'import natra as np # the workhorse');
});

test('substitutions: rewriteImports over multi-line source', () => {
  const src = 'import numpy as np\nimport pandas as pd\n\nx = np.array([1, 2, 3])';
  const { source, rewrites } = rewriteImports(src);
  assert.match(source, /import natra as np/);
  assert.match(source, /import sadpan as pd/);
  assert.match(source, /x = np\.array/);  // body unchanged
  assert.equal(rewrites.length, 2);
});

test('inverse: rewriteImportsBack reverses the table', () => {
  const src = 'import natra as np\nfrom sadpan import DataFrame\nfrom learn.tree import DecisionTreeClassifier';
  const back = rewriteImportsBack(src);
  assert.match(back, /import numpy as np/);
  assert.match(back, /from pandas import DataFrame/);
  assert.match(back, /from sklearn\.tree import DecisionTreeClassifier/);
});

test('inverse: matplotlib.pyplot round-trips', () => {
  const original = 'import matplotlib.pyplot as plt';
  const { rewritten } = rewriteImportLine(original);
  assert.equal(rewritten, 'import plt as plt');
  const back = rewriteImportsBack(rewritten);
  assert.equal(back, original);
});

test('rewriteImports: matplotlib.pyplot import gets a plt.style.use injection', () => {
  // Notebooks loaded via .ipynb should automatically switch to a light
  // matplotlib-shaped palette, since that's what the author saw in
  // Jupyter. We inject the call right after the import; the sentinel
  // comment lets the inverse pass strip it cleanly on export.
  const src = 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])';
  const { source } = rewriteImports(src);
  const lines = source.split('\n');
  assert.equal(lines[0], 'import plt as plt');
  assert.match(lines[1], /^plt\.style\.use\('default'\)/);
  assert.match(lines[1], /# auditable: ipynb-theme-inject/);
  assert.equal(lines[2], 'plt.plot([1,2,3])');
});

test('rewriteImports: pyplot injection preserves indent', () => {
  // Indented import (inside a function) keeps the injected line at the
  // same indent so Python parsing stays valid.
  const src = '    import matplotlib.pyplot as plt';
  const { source } = rewriteImports(src);
  const lines = source.split('\n');
  assert.equal(lines[0], '    import plt as plt');
  assert.match(lines[1], /^    plt\.style\.use\('default'\)/);
});

test('rewriteImports: non-matplotlib imports do NOT trigger injection', () => {
  // Only matplotlib.pyplot specifically gets the style.use injection.
  // Other rewrites (numpy, pandas, etc.) leave the source flat.
  const src = 'import numpy as np\nimport pandas as pd';
  const { source } = rewriteImports(src);
  assert.equal(source, 'import natra as np\nimport sadpan as pd');
});

test('rewriteImportsBack: strips the injected plt.style.use line', () => {
  // Round-trip: forward injects, back strips. User sees their original
  // import line on .ipynb export, not our adaptation.
  const src = 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])';
  const forward = rewriteImports(src).source;
  const back = rewriteImportsBack(forward);
  assert.equal(back, 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])');
});

test('rewriteImportsBack: keeps a manually-written plt.style.use', () => {
  // A plt.style.use call without our sentinel comment is treated as
  // user code and survives the round-trip.
  const src = "import plt as plt\nplt.style.use('seaborn')\nplt.plot([1])";
  const back = rewriteImportsBack(src);
  assert.match(back, /plt\.style\.use\('seaborn'\)/);
});

test('parse: minimal notebook with one code cell', () => {
  const ipynb = {
    cells: [
      { cell_type: 'code', source: ['import numpy as np\n', 'x = np.zeros(5)\n'] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
  const { cells, warnings } = parseIpynb(ipynb);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].type, 'adder');
  assert.match(cells[0].code, /import natra as np/);
  assert.match(cells[0].code, /x = np\.zeros/);
  assert.deepEqual(warnings, []);
});

test('parse: mixed code + markdown', () => {
  const ipynb = {
    cells: [
      { cell_type: 'markdown', source: ['# Hello\n', 'Some prose.'] },
      { cell_type: 'code', source: 'print(1)' },
    ],
  };
  const { cells } = parseIpynb(ipynb);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].type, 'md');
  assert.equal(cells[0].code, '# Hello\nSome prose.');
  assert.equal(cells[1].type, 'adder');
  assert.equal(cells[1].code, 'print(1)');
});

test('parse: source can be array OR string', () => {
  const a = parseIpynb({ cells: [{ cell_type: 'code', source: ['a = 1\n', 'b = 2'] }] });
  const b = parseIpynb({ cells: [{ cell_type: 'code', source: 'a = 1\nb = 2' }] });
  assert.equal(a.cells[0].code, b.cells[0].code);
});

test('parse: line magic is commented', () => {
  const ipynb = { cells: [{ cell_type: 'code', source: '%matplotlib inline\nimport matplotlib.pyplot as plt' }] };
  const { cells, warnings } = parseIpynb(ipynb);
  assert.match(cells[0].code, /^# %matplotlib inline/);
  assert.match(cells[0].code, /import plt as plt/);
  assert.ok(warnings.some(w => /dropped line magic/.test(w)));
});

test('parse: cell magic kept as comment, body preserved', () => {
  const ipynb = { cells: [{ cell_type: 'code', source: '%%timeit\nx = sum(range(1000))' }] };
  const { cells, warnings } = parseIpynb(ipynb);
  assert.match(cells[0].code, /^# %%timeit/);
  assert.match(cells[0].code, /x = sum/);
  assert.ok(warnings.some(w => /dropped cell magic/.test(w)));
});

test('parse: shell escape is commented', () => {
  const ipynb = { cells: [{ cell_type: 'code', source: '!pip install requests\nimport requests' }] };
  const { cells, warnings } = parseIpynb(ipynb);
  assert.match(cells[0].code, /^# !pip install/);
  assert.ok(warnings.some(w => /dropped shell escape/.test(w)));
});

test('parse: raw cell becomes md with note', () => {
  const ipynb = { cells: [{ cell_type: 'raw', source: 'raw content' }] };
  const { cells, warnings } = parseIpynb(ipynb);
  assert.equal(cells[0].type, 'md');
  assert.match(cells[0].code, /raw content/);
  assert.ok(warnings.some(w => /raw cell/.test(w)));
});

test('parse: non-Python kernel emits a warning', () => {
  const ipynb = {
    cells: [{ cell_type: 'code', source: 'puts "hi"' }],
    metadata: { kernelspec: { language: 'ruby' } },
  };
  const { warnings } = parseIpynb(ipynb);
  assert.ok(warnings.some(w => /kernel is "ruby"/.test(w)));
});

test('parse: JSON-text input also works', () => {
  const text = JSON.stringify({ cells: [{ cell_type: 'code', source: 'x = 1' }] });
  const { cells } = parseIpynb(text);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].code, 'x = 1');
});

test('serialize: minimal cells → valid ipynb shape', () => {
  const cells = [
    { type: 'md', code: '# Title' },
    { type: 'adder', code: 'import natra as np\nx = np.zeros(5)' },
  ];
  const nb = serializeIpynb(cells);
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[0].cell_type, 'markdown');
  assert.equal(nb.cells[1].cell_type, 'code');
  // Imports rewritten back to numpy
  assert.match(nb.cells[1].source.join(''), /import numpy as np/);
});

test('serialize: JS / html / css cells become md notes', () => {
  const cells = [
    { type: 'code', code: 'const x = 1;' },
    { type: 'html', code: '<div>hi</div>' },
    { type: 'css', code: 'body { color: red; }' },
  ];
  const nb = serializeIpynb(cells);
  assert.equal(nb.cells.length, 3);
  for (const c of nb.cells) {
    assert.equal(c.cell_type, 'markdown');
    assert.match(c.source.join(''), /auditable-native/);
  }
});

test('serialize: title option prepends md heading', () => {
  const nb = serializeIpynb([{ type: 'adder', code: 'x = 1' }], { title: 'My Notebook' });
  assert.equal(nb.cells[0].cell_type, 'markdown');
  assert.match(nb.cells[0].source.join(''), /^# My Notebook/);
});

test('round-trip: ipynb → cells → ipynb preserves code + imports', () => {
  const original = {
    cells: [
      { cell_type: 'markdown', source: '# Demo' },
      { cell_type: 'code', source: 'import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\n\nx = np.zeros(5)\ndf = pd.DataFrame({"a": x})\nplt.plot(x)' },
    ],
    nbformat: 4,
    nbformat_minor: 5,
  };
  const { cells } = parseIpynb(original);
  const round = serializeIpynb(cells);
  const codeJoined = round.cells[1].source.join('');
  assert.match(codeJoined, /import numpy as np/);
  assert.match(codeJoined, /import pandas as pd/);
  assert.match(codeJoined, /import matplotlib\.pyplot as plt/);
  assert.match(codeJoined, /x = np\.zeros\(5\)/);
});

test('one-shot importNotebook + exportNotebook', () => {
  const ipynbText = JSON.stringify({
    cells: [{ cell_type: 'code', source: 'import numpy as np\nprint(np.zeros(3))' }],
  });
  const { cells } = importNotebook(ipynbText);
  const out = exportNotebook(cells);
  assert.match(out, /import numpy as np/);
  // Output is valid JSON
  assert.doesNotThrow(() => JSON.parse(out));
});
