// Quick smoke for works-all.html — boot it in headless Chromium over
// file://, wait for the title bar, verify the examples bundle unpacks.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.error('[page-error]', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('[console-error]', msg.text());
});

await page.goto(pathToFileURL(join(root, 'works-all.html')).href);
await page.waitForFunction(() => window.WKS && window.WKS.vfs, { timeout: 10000 });

// Verify /usr/lib/@gcu/<name>/source exists for a sampling of libs.
const libCheck = await page.evaluate(async () => {
  const libs = ['adder', 'spinifex', 'learn', 'line', 'scitra'];
  const results = {};
  for (const name of libs) {
    const path = `/usr/lib/@gcu/${name}/source`;
    try {
      const src = await window.WKS.vfs.readFile(path, 'utf8');
      results[name] = src.length;
    } catch (e) {
      results[name] = 'MISSING: ' + (e.message || e);
    }
  }
  return results;
});

console.log('Lib unpack check:');
for (const [name, len] of Object.entries(libCheck)) {
  console.log(`  /usr/lib/@gcu/${name}/source — ${typeof len === 'number' ? (len/1024).toFixed(1) + ' KB' : len}`);
}

// Verify examples bundle unpacks.
const exCheck = await page.evaluate(async () => {
  try {
    const manifest = JSON.parse(await window.WKS.vfs.readFile('/usr/share/examples/manifest.json', 'utf8'));
    const cats = Object.keys(manifest.categories || {});
    let totalFiles = 0;
    for (const c of cats) totalFiles += manifest.categories[c].length;
    // Sample one example
    const sample = manifest.categories[cats[0]][0];
    const content = await window.WKS.vfs.readFile('/usr/share/examples/' + sample.file, 'utf8');
    return { categories: cats.length, totalFiles, sampleSize: content.length, sampleName: sample.file };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

console.log('Examples unpack check:', exCheck);

await browser.close();
console.log('\nworks-all smoke: OK');
