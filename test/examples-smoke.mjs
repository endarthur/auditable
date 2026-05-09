// Headless smoke test: open each example, wait for autorun, assert no
// cell error elements. Catches the class of bug where AIR (or runtime)
// silently miscompiles cells that look fine in the source but throw on
// load — eg the tagged-template and for-header bugs that motivated this.
//
// Not part of `npm test`. Run with `npm run test:examples` (or directly
// `node test/examples-smoke.mjs`). Filename intentionally omits `.test.`
// so the default node --test runner skips it.
//
// Usage:
//   node test/examples-smoke.mjs                  # all examples
//   node test/examples-smoke.mjs atra/example_atra # filter by substring
//   HEADED=1 node test/examples-smoke.mjs ...     # show the browser

import { chromium } from 'playwright';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLES_DIR = path.join(ROOT, 'examples');

// Per-example timeout. Some examples pull large modules or compile Wasm;
// 30s is generous but bounded so a hang doesn't block the whole sweep.
const PER_EXAMPLE_TIMEOUT = 30_000;
// Time to wait for the autorun to finish after S.initialized flips. Most
// cells settle inside a second; we cap how long we wait for animations.
const AUTORUN_SETTLE = 8_000;

// Examples we know require a click to start (won't auto-error, but also
// won't auto-show success). Skip rather than misreport.
const SKIP = new Set([
  // 'gslib/example_gslib_sgsim.html', // play/pause widget — first realization renders on load, ok
  // Encrypted notebooks ship with a lock screen; auto-cells never run.
  'basics/example_encrypted_password-is-auditable.html',
]);

async function discoverExamples(filter) {
  const out = [];
  for await (const file of glob('**/*.html', { cwd: EXAMPLES_DIR })) {
    const rel = file.replace(/\\/g, '/');
    if (SKIP.has(rel)) continue;
    if (filter && !rel.includes(filter)) continue;
    out.push({ rel, abs: path.join(EXAMPLES_DIR, file) });
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

async function checkExample(browser, ex) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Capture page-level console errors and uncaught exceptions — these are
  // distinct from per-cell errors and easy to miss in the DOM.
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  const url = pathToFileURL(ex.abs).href;
  let cellErrors = [];

  try {
    await page.goto(url, { waitUntil: 'load', timeout: PER_EXAMPLE_TIMEOUT });

    // Wait for init: window.S.initialized flips true once cells are loaded
    // into the DOM. Autorun is kicked via setTimeout(runAll, 50) right after.
    await page.waitForFunction(
      () => window.S && window.S.initialized === true,
      { timeout: PER_EXAMPLE_TIMEOUT },
    );

    // Best-effort: wait for the autorun's runAll() to settle. We can't
    // hook _dagDone (no such hook), so we rely on the fact that cells
    // briefly carry a 'fresh' class for 800ms after success and an 'error'
    // class persistently on failure. Poll for the first moment when no
    // cell is mid-execution AND a settle window has elapsed.
    await page.waitForTimeout(AUTORUN_SETTLE);

    // Cell error elements — set by exec.js when a cell throws.
    cellErrors = await page.$$eval('.cell.error', els => els.map(el => {
      const id = el.dataset.cellId || el.id || '?';
      const out = el.querySelector('.cell-output.error');
      const msg = out ? out.textContent.trim() : '(no error text)';
      // First 30 chars of source so we can locate the cell quickly.
      const cm = el.querySelector('.cm-content');
      const head = (cm ? cm.textContent : '').slice(0, 60).replace(/\s+/g, ' ');
      return { id, msg, head };
    }));

    // Silent load failure detector: a notebook that bails out of loadFromEmbed
    // without throwing falls back to addCell('md','') + addCell('code','') —
    // two empty cells, no errors. Compare runtime cell count with what the
    // source notebook claims.
    const cellCountCheck = await page.evaluate(async () => {
      const html = document.body.innerHTML;
      // Source-of-truth cell count: try AUDITABLE-VFS (/var/notebook.txt /// form),
      // then legacy AUDITABLE-DATA JSON.
      const vfsMatch = html.match(/<!--AUDITABLE-VFS\n([\s\S]*?)\nAUDITABLE-VFS-->/);
      let expected = -1;
      if (vfsMatch) {
        try {
          const dump = JSON.parse(vfsMatch[1]);
          const txt = dump['/var/notebook.txt']?.content;
          if (typeof txt === 'string') {
            expected = (txt.match(/^\/\/\/ (?:code|md|css|html|[a-z][\w-]*)/gm) || []).length;
          }
        } catch {}
      } else {
        const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
        if (dataMatch) {
          try { expected = JSON.parse(dataMatch[1]).length; } catch {}
        }
      }
      const actual = window.S?.cells?.length ?? 0;
      const allEmpty = (window.S?.cells || []).every(c => !c.code);
      return { expected, actual, allEmpty };
    });
    if (cellCountCheck.expected > 0 && cellCountCheck.actual === 2 && cellCountCheck.allEmpty) {
      cellErrors.push({
        id: '<load>',
        msg: `loadFromEmbed silent failure: expected ${cellCountCheck.expected} cells, got 2 empty (default fallback)`,
        head: '',
      });
    }
  } catch (e) {
    cellErrors.push({ id: '<navigation>', msg: e.message, head: '' });
  }

  await ctx.close();
  return { pageErrors, cellErrors };
}

async function main() {
  const filter = process.argv[2];
  const examples = await discoverExamples(filter);
  if (examples.length === 0) {
    console.log(filter ? `no examples matched ${JSON.stringify(filter)}` : 'no examples found');
    process.exit(1);
  }

  console.log(`smoke-testing ${examples.length} example${examples.length === 1 ? '' : 's'}…`);
  const browser = await chromium.launch({ headless: !process.env.HEADED });

  let pass = 0;
  const fails = [];
  const t0 = Date.now();

  for (const ex of examples) {
    process.stdout.write(`  ${ex.rel} … `);
    const start = Date.now();
    const { pageErrors, cellErrors } = await checkExample(browser, ex);
    const ms = Date.now() - start;
    const failed = pageErrors.length > 0 || cellErrors.length > 0;
    if (failed) {
      fails.push({ ex, pageErrors, cellErrors, ms });
      console.log(`FAIL (${ms} ms)`);
    } else {
      pass++;
      console.log(`ok (${ms} ms)`);
    }
  }

  await browser.close();
  const total = Date.now() - t0;

  console.log();
  console.log(`${pass}/${examples.length} passed in ${(total / 1000).toFixed(1)}s`);

  if (fails.length) {
    console.log();
    console.log('failures:');
    for (const f of fails) {
      console.log(`  ${f.ex.rel}`);
      for (const m of f.pageErrors) console.log(`    page: ${m}`);
      for (const c of f.cellErrors) {
        console.log(`    cell ${c.id}: ${c.msg}`);
        if (c.head) console.log(`           ${c.head}`);
      }
    }
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
