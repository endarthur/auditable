// Parallel scan driver over REAL @gcu/proc workers (Node worker_threads via
// createNodeWorker). Proves the §7a worker backend: a scan fanned across worker
// chunks + merged == a single-pass scan. Run with --test-force-exit (worker
// threads hold the event loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as sluice from '../ext/sluice/src/main.js';
import { ProcessManager } from '../ext/proc/src/main.js';
import { createNodeWorker } from '../ext/proc/src/node-worker-shim.js';
import { scanParallel, _scanChunk } from '../works/js/pipeline-workers.js';

// The sluice bundle as an import()-able data: URL — the worker imports this to
// rebuild accumulators (the shell uses a blob URL of the bundled lib instead).
const sluiceUrl = 'data:text/javascript;base64,'
  + Buffer.from(fs.readFileSync(new URL('../ext/sluice/index.js', import.meta.url))).toString('base64');

const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

test('_scanChunk runs a spec-built scan over one Blob (in-process sanity)', async () => {
  const blob = new Blob(['X\n1\n2\n3\n']);
  const st = await _scanChunk(blob, sluiceUrl, { header: ['X'] },
    { kind: 'collect', fields: { X: { column: 'X', of: { kind: 'welford' } } } });
  // _scanChunk returns the raw state; finalize with a matching accumulator
  const acc = sluice.accumulatorFromSpec({ kind: 'collect', fields: { X: { column: 'X', of: { kind: 'welford' } } } });
  assert.equal(acc.result(st).X.count, 3);
});

test('scanParallel across real proc workers == single-pass scan', async () => {
  let csv = 'X,G\n';
  for (let i = 0; i < 3000; i++) csv += `${i},${i % 4}\n`;
  const blob = new Blob([csv]);
  const accSpec = { kind: 'collect', fields: {
    X: { column: 'X', of: { kind: 'welford' } },
    G: { column: 'G', of: { kind: 'topK' } },
  } };

  // single-pass reference
  const single = await sluice.scan(
    sluice.recipe(sluice.fromText(csv), sluice.parseCsv({})),
    sluice.accumulatorFromSpec(accSpec));

  const pm = new ProcessManager({ createWorker: createNodeWorker });
  const pool = pm.createPool(3);
  try {
    const out = await scanParallel({ sluice, pool, sluiceUrl, blob, accSpec, workers: 4 });
    assert.equal(out.X.count, 3000, 'all rows scanned');
    assert.equal(out.X.count, single.X.count);
    assert.ok(approx(out.X.mean, single.X.mean), 'mean matches single pass');
    assert.ok(approx(out.X.variance, single.X.variance, 1e-3), 'variance matches (Pébay merge across workers)');
    assert.deepEqual(out.G.counts, single.G.counts, 'topK counts merged across chunks');
  } finally {
    pool.terminate();
  }
});
