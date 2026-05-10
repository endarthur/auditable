// Verify: 1M wasm OOB is a scope-promotion leak, not a kernel bug.

import { natra } from '../ext/natra/index.js';

async function tryCase(label, fn) {
  console.log('\n' + label);
  try {
    await fn();
    console.log('  → OK');
  } catch (e) {
    console.log('  → FAIL: ' + e.message);
  }
}

// Confirm the leak: returning from scope promotes to perm memory.
await tryCase('1000 × 1M scope.add WITH return (promotes result each iter)', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.arange(0, 1_000_000);
  const b = ctx.arange(0, 1_000_000);
  for (let i = 0; i < 1000; i++) ctx.scope(s => s.add(a, b));
});

// Same workload, but discard result via braced arrow → no promotion.
await tryCase('1000 × 1M scope.add WITHOUT return (discards each iter)', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.arange(0, 1_000_000);
  const b = ctx.arange(0, 1_000_000);
  for (let i = 0; i < 1000; i++) ctx.scope(s => { s.add(a, b); });
});

// Memory growth comparison.
await tryCase('memory growth — discard pattern, 100 × 1M', async () => {
  const ctx = await natra({ pages: 256 });
  const a = ctx.arange(0, 1_000_000);
  const b = ctx.arange(0, 1_000_000);
  const mem = ctx._memory ?? ctx.memory;
  if (mem) console.log(`  start: ${(mem.buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
  for (let i = 0; i < 100; i++) ctx.scope(s => { s.add(a, b); });
  if (mem) console.log(`  end:   ${(mem.buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);
});
