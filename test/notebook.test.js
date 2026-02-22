const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Replicate notebook.js functions for Node.js testing ──
// These mirror the browser-side implementations but use Node crypto

async function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeModulesB64(obj) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

function decodeModulesB64(raw) {
  const b64 = raw.replace(/\s/g, '');
  if (b64.startsWith('{') || b64.startsWith('%7B')) return JSON.parse(raw);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function isLightweight(content) {
  if (typeof content !== 'string') return false;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    return obj.format === 'auditable-notebook';
  } catch {
    return false;
  }
}

// Mock blob store for testing
function createBlobStore() {
  const store = new Map();
  return {
    blobPut: async (hash, source) => store.set(hash, source),
    blobGet: async (hash) => store.get(hash) ?? null,
    store,
  };
}

async function dehydrate(html, blobStore) {
  if (/<meta\s+name="auditable-packed"/i.test(html)) return null;

  const titleMatch = html.match(/id="docTitle"\s+value="([^"]*)"/);
  const title = titleMatch
    ? titleMatch[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    : 'untitled';

  const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  let cells = [];
  if (dataMatch) {
    try { cells = JSON.parse(dataMatch[1]); } catch {}
  }

  const setMatch = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  let settings = {};
  if (setMatch) {
    try { settings = JSON.parse(setMatch[1]); } catch {}
  }

  const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  let modules = null;
  if (modMatch) {
    try {
      const decoded = decodeModulesB64(modMatch[1]);
      modules = {};
      for (const [url, entry] of Object.entries(decoded)) {
        const source = entry.source;
        const hash = await sha256hex(source);
        await blobStore.blobPut(hash, source);
        const ref = { ref: hash };
        if (entry.cellId != null) ref.cellId = entry.cellId;
        if (entry.binary) ref.binary = true;
        if (entry.compressed) ref.compressed = true;
        if (entry.type) ref.type = entry.type;
        modules[url] = ref;
      }
    } catch (e) {
      // skip modules on error
    }
  }

  const notebook = {
    format: 'auditable-notebook',
    v: 1,
    title,
    cells,
    settings,
  };
  if (modules && Object.keys(modules).length > 0) {
    notebook.modules = modules;
  }

  return JSON.stringify(notebook);
}

async function hydrate(jsonStr, runtime, blobStore) {
  const notebook = JSON.parse(jsonStr);
  let html = runtime;

  html = html.replace(
    '<title>Auditable</title>',
    '<title>Auditable \u2014 ' + escAttr(notebook.title || 'untitled') + '</title>'
  );

  html = html.replace(
    'id="docTitle" value="untitled"',
    'id="docTitle" value="' + escAttr(notebook.title || 'untitled') + '"'
  );

  const dataComment = '<!-- cell data: JSON array of {type, code, collapsed?} -->\n<!--AUDITABLE-DATA\n' + JSON.stringify(notebook.cells || []) + '\nAUDITABLE-DATA-->';

  let modulesComment = '';
  if (notebook.modules && Object.keys(notebook.modules).length > 0) {
    const resolved = {};
    for (const [url, entry] of Object.entries(notebook.modules)) {
      const source = await blobStore.blobGet(entry.ref);
      if (source === null) continue;
      const mod = { source };
      if (entry.cellId != null) mod.cellId = entry.cellId;
      if (entry.binary) mod.binary = true;
      if (entry.compressed) mod.compressed = true;
      if (entry.type) mod.type = entry.type;
      resolved[url] = mod;
    }
    if (Object.keys(resolved).length > 0) {
      modulesComment = '<!-- installed modules: base64-encoded JSON mapping URLs to {source, cellId} -->\n<!--AUDITABLE-MODULES\n' + encodeModulesB64(resolved) + '\nAUDITABLE-MODULES-->';
    }
  }

  const settingsComment = '<!-- notebook settings: JSON {theme, fontSize, width, ...} -->\n<!--AUDITABLE-SETTINGS\n' + JSON.stringify(notebook.settings || {}) + '\nAUDITABLE-SETTINGS-->';

  const insertion = '\n' + dataComment + '\n' + (modulesComment ? modulesComment + '\n' : '') + settingsComment + '\n\n<script>';
  html = html.replace('\n<script>', () => insertion);

  return html;
}

// ── Test runtime template (minimal) ──

const RUNTIME = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Auditable</title>
<style>body{}</style>
</head>
<body>
<input id="docTitle" value="untitled">

<script>
console.log('runtime');
</script>
</body>
</html>`;

// ── Tests ──

describe('isLightweight', () => {
  it('detects valid lightweight format', () => {
    const json = JSON.stringify({ format: 'auditable-notebook', v: 1, title: 'test', cells: [], settings: {} });
    assert.ok(isLightweight(json));
  });

  it('rejects HTML content', () => {
    assert.ok(!isLightweight('<!DOCTYPE html><html>...'));
  });

  it('rejects plain JSON without format field', () => {
    assert.ok(!isLightweight(JSON.stringify({ title: 'test' })));
  });

  it('rejects wrong format value', () => {
    assert.ok(!isLightweight(JSON.stringify({ format: 'other', v: 1 })));
  });

  it('rejects non-string input', () => {
    assert.ok(!isLightweight(null));
    assert.ok(!isLightweight(42));
    assert.ok(!isLightweight(undefined));
  });

  it('rejects invalid JSON', () => {
    assert.ok(!isLightweight('{invalid'));
  });

  it('handles leading whitespace', () => {
    const json = '  \n' + JSON.stringify({ format: 'auditable-notebook', v: 1, title: 'x', cells: [], settings: {} });
    assert.ok(isLightweight(json));
  });
});

describe('sha256hex', () => {
  it('produces consistent 64-char hex hash', async () => {
    const h = await sha256hex('hello');
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('same input produces same hash', async () => {
    const a = await sha256hex('test data');
    const b = await sha256hex('test data');
    assert.equal(a, b);
  });

  it('different input produces different hash', async () => {
    const a = await sha256hex('hello');
    const b = await sha256hex('world');
    assert.notEqual(a, b);
  });
});

describe('encodeModulesB64 / decodeModulesB64', () => {
  it('round-trips simple modules', () => {
    const obj = { 'https://cdn.example.com/lib.js': { source: 'export default 42;', cellId: 0 } };
    const encoded = encodeModulesB64(obj);
    const decoded = decodeModulesB64(encoded);
    assert.deepEqual(decoded, obj);
  });

  it('handles unicode in module source', () => {
    const obj = { 'mod.js': { source: 'const \u00e9 = "\u2603 snowman";' } };
    const encoded = encodeModulesB64(obj);
    const decoded = decodeModulesB64(encoded);
    assert.deepEqual(decoded, obj);
  });

  it('handles empty modules object', () => {
    const obj = {};
    const encoded = encodeModulesB64(obj);
    const decoded = decodeModulesB64(encoded);
    assert.deepEqual(decoded, obj);
  });

  it('wraps at 76 characters', () => {
    const obj = { 'https://cdn.example.com/very-long-module-name.js': { source: 'x'.repeat(200) } };
    const encoded = encodeModulesB64(obj);
    const lines = encoded.split('\n');
    for (const line of lines) {
      assert.ok(line.length <= 76, `line too long: ${line.length} chars`);
    }
  });

  it('detects legacy raw JSON format', () => {
    const raw = '{"mod.js": {"source": "code"}}';
    const decoded = decodeModulesB64(raw);
    assert.deepEqual(decoded, { 'mod.js': { source: 'code' } });
  });
});

describe('escAttr', () => {
  it('escapes HTML special characters', () => {
    assert.equal(escAttr('a & b'), 'a &amp; b');
    assert.equal(escAttr('a "b" c'), 'a &quot;b&quot; c');
    assert.equal(escAttr('a < b > c'), 'a &lt; b &gt; c');
  });

  it('leaves safe strings unchanged', () => {
    assert.equal(escAttr('hello world'), 'hello world');
  });
});

describe('dehydrate', () => {
  it('extracts cells, settings, and title from full HTML', async () => {
    const blobs = createBlobStore();
    const html = `<!DOCTYPE html>
<html><head><title>Auditable \u2014 my notebook</title></head>
<body>
<input id="docTitle" value="my notebook">
<!-- cell data: JSON array of {type, code, collapsed?} -->
<!--AUDITABLE-DATA
[{"type":"code","code":"const x = 1"},{"type":"md","code":"# Hello"}]
AUDITABLE-DATA-->
<!-- notebook settings: JSON {theme, fontSize, width, ...} -->
<!--AUDITABLE-SETTINGS
{"theme":"dark","fontSize":13,"width":"860"}
AUDITABLE-SETTINGS-->
<script>/*runtime*/</script>
</body></html>`;

    const result = await dehydrate(html, blobs);
    assert.ok(result);
    const parsed = JSON.parse(result);
    assert.equal(parsed.format, 'auditable-notebook');
    assert.equal(parsed.v, 1);
    assert.equal(parsed.title, 'my notebook');
    assert.equal(parsed.cells.length, 2);
    assert.equal(parsed.cells[0].type, 'code');
    assert.equal(parsed.cells[0].code, 'const x = 1');
    assert.equal(parsed.cells[1].type, 'md');
    assert.deepEqual(parsed.settings, { theme: 'dark', fontSize: 13, width: '860' });
    assert.equal(parsed.modules, undefined); // no modules
  });

  it('extracts modules and stores blobs', async () => {
    const blobs = createBlobStore();
    const modules = {
      'https://cdn.example.com/lib.js': { source: 'export default 42;', cellId: 2 },
    };
    const modulesEncoded = encodeModulesB64(modules);

    const html = `<!DOCTYPE html>
<html><head><title>Auditable</title></head>
<body>
<input id="docTitle" value="with modules">
<!--AUDITABLE-DATA
[{"type":"code","code":"import lib"}]
AUDITABLE-DATA-->
<!--AUDITABLE-MODULES
${modulesEncoded}
AUDITABLE-MODULES-->
<!--AUDITABLE-SETTINGS
{"theme":"dark"}
AUDITABLE-SETTINGS-->
<script>/*runtime*/</script>
</body></html>`;

    const result = await dehydrate(html, blobs);
    const parsed = JSON.parse(result);

    // modules should have refs instead of source
    assert.ok(parsed.modules);
    const mod = parsed.modules['https://cdn.example.com/lib.js'];
    assert.ok(mod.ref);
    assert.equal(mod.ref.length, 64); // SHA-256 hex
    assert.equal(mod.cellId, 2);
    assert.equal(mod.source, undefined); // source removed, replaced by ref

    // blob store should have the source
    const stored = await blobs.blobGet(mod.ref);
    assert.equal(stored, 'export default 42;');
  });

  it('preserves binary module metadata', async () => {
    const blobs = createBlobStore();
    const modules = {
      'https://example.com/data.wasm': {
        source: 'base64wasmdata',
        cellId: 5,
        binary: true,
        compressed: true,
        type: 'application/wasm',
      },
    };
    const modulesEncoded = encodeModulesB64(modules);

    const html = `<!DOCTYPE html>
<html><head><title>Auditable</title></head>
<body>
<input id="docTitle" value="binary test">
<!--AUDITABLE-DATA
[]
AUDITABLE-DATA-->
<!--AUDITABLE-MODULES
${modulesEncoded}
AUDITABLE-MODULES-->
<!--AUDITABLE-SETTINGS
{}
AUDITABLE-SETTINGS-->
<script>/*rt*/</script>
</body></html>`;

    const result = await dehydrate(html, blobs);
    const parsed = JSON.parse(result);
    const mod = parsed.modules['https://example.com/data.wasm'];
    assert.ok(mod.ref);
    assert.equal(mod.binary, true);
    assert.equal(mod.compressed, true);
    assert.equal(mod.type, 'application/wasm');
    assert.equal(mod.cellId, 5);
  });

  it('returns null for packed notebooks', async () => {
    const blobs = createBlobStore();
    const html = `<!DOCTYPE html>
<html><head><meta name="auditable-packed"><title>Packed</title></head>
<body><script>/*packed*/</script></body></html>`;

    const result = await dehydrate(html, blobs);
    assert.equal(result, null);
  });

  it('handles HTML with no data blocks gracefully', async () => {
    const blobs = createBlobStore();
    const html = `<!DOCTYPE html>
<html><head><title>Empty</title></head>
<body><input id="docTitle" value="empty">
<script>/*rt*/</script></body></html>`;

    const result = await dehydrate(html, blobs);
    const parsed = JSON.parse(result);
    assert.equal(parsed.format, 'auditable-notebook');
    assert.equal(parsed.title, 'empty');
    assert.deepEqual(parsed.cells, []);
    assert.deepEqual(parsed.settings, {});
  });

  it('handles title with HTML entities', async () => {
    const blobs = createBlobStore();
    const html = `<!DOCTYPE html>
<html><head><title>Auditable</title></head>
<body><input id="docTitle" value="a &amp; b &lt; c">
<!--AUDITABLE-DATA
[]
AUDITABLE-DATA-->
<!--AUDITABLE-SETTINGS
{}
AUDITABLE-SETTINGS-->
<script>/*rt*/</script></body></html>`;

    const result = await dehydrate(html, blobs);
    const parsed = JSON.parse(result);
    assert.equal(parsed.title, 'a & b < c');
  });
});

describe('hydrate', () => {
  it('produces valid HTML with cells and settings', async () => {
    const blobs = createBlobStore();
    const notebook = {
      format: 'auditable-notebook',
      v: 1,
      title: 'test notebook',
      cells: [{ type: 'code', code: 'const x = 1' }, { type: 'md', code: '# Hi' }],
      settings: { theme: 'dark', fontSize: 14 },
    };

    const html = await hydrate(JSON.stringify(notebook), RUNTIME, blobs);

    // should contain the title
    assert.ok(html.includes('<title>Auditable \u2014 test notebook</title>'));
    assert.ok(html.includes('value="test notebook"'));

    // should contain data block
    assert.ok(html.includes('<!--AUDITABLE-DATA'));
    const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
    assert.ok(dataMatch);
    const cells = JSON.parse(dataMatch[1]);
    assert.equal(cells.length, 2);
    assert.equal(cells[0].code, 'const x = 1');

    // should contain settings block
    assert.ok(html.includes('<!--AUDITABLE-SETTINGS'));
    const setMatch = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
    const settings = JSON.parse(setMatch[1]);
    assert.equal(settings.fontSize, 14);

    // should NOT contain modules block
    assert.ok(!html.includes('AUDITABLE-MODULES'));

    // should contain the runtime script
    assert.ok(html.includes("console.log('runtime')"));
  });

  it('resolves module refs from blob store', async () => {
    const blobs = createBlobStore();
    const source = 'export const answer = 42;';
    const hash = await sha256hex(source);
    await blobs.blobPut(hash, source);

    const notebook = {
      format: 'auditable-notebook',
      v: 1,
      title: 'with mods',
      cells: [],
      settings: {},
      modules: {
        'https://cdn.example.com/lib.js': { ref: hash, cellId: 3 },
      },
    };

    const html = await hydrate(JSON.stringify(notebook), RUNTIME, blobs);

    // should contain modules block
    assert.ok(html.includes('AUDITABLE-MODULES'));
    const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
    assert.ok(modMatch);
    const decoded = decodeModulesB64(modMatch[1]);
    assert.equal(decoded['https://cdn.example.com/lib.js'].source, source);
    assert.equal(decoded['https://cdn.example.com/lib.js'].cellId, 3);
  });

  it('skips modules with missing blobs', async () => {
    const blobs = createBlobStore();
    const notebook = {
      format: 'auditable-notebook',
      v: 1,
      title: 'missing blobs',
      cells: [],
      settings: {},
      modules: {
        'https://cdn.example.com/missing.js': { ref: 'deadbeef'.repeat(8) },
      },
    };

    const html = await hydrate(JSON.stringify(notebook), RUNTIME, blobs);
    // should NOT contain modules block since the only module was missing
    assert.ok(!html.includes('AUDITABLE-MODULES'));
  });

  it('preserves binary module metadata through hydration', async () => {
    const blobs = createBlobStore();
    const source = 'binarydata';
    const hash = await sha256hex(source);
    await blobs.blobPut(hash, source);

    const notebook = {
      format: 'auditable-notebook',
      v: 1,
      title: 'binary',
      cells: [],
      settings: {},
      modules: {
        'data.wasm': { ref: hash, binary: true, compressed: true, type: 'application/wasm', cellId: 1 },
      },
    };

    const html = await hydrate(JSON.stringify(notebook), RUNTIME, blobs);
    const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
    const decoded = decodeModulesB64(modMatch[1]);
    const mod = decoded['data.wasm'];
    assert.equal(mod.source, 'binarydata');
    assert.equal(mod.binary, true);
    assert.equal(mod.compressed, true);
    assert.equal(mod.type, 'application/wasm');
    assert.equal(mod.cellId, 1);
  });

  it('handles empty cells and settings', async () => {
    const blobs = createBlobStore();
    const notebook = {
      format: 'auditable-notebook',
      v: 1,
      title: 'empty',
      cells: [],
      settings: {},
    };

    const html = await hydrate(JSON.stringify(notebook), RUNTIME, blobs);
    const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
    assert.deepEqual(JSON.parse(dataMatch[1]), []);
  });

  it('escapes title with special characters', async () => {
    const blobs = createBlobStore();
    const notebook = {
      format: 'auditable-notebook',
      v: 1,
      title: 'A & B <script>',
      cells: [],
      settings: {},
    };

    const html = await hydrate(JSON.stringify(notebook), RUNTIME, blobs);
    assert.ok(html.includes('A &amp; B &lt;script&gt;'));
    assert.ok(!html.includes('value="A & B <script>"'));
  });
});

describe('dehydrate → hydrate round-trip', () => {
  it('preserves cells, settings, and title through round-trip', async () => {
    const blobs = createBlobStore();
    const originalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Auditable \u2014 roundtrip test</title>
<style>body{}</style>
</head>
<body>
<input id="docTitle" value="roundtrip test">

<!-- cell data: JSON array of {type, code, collapsed?} -->
<!--AUDITABLE-DATA
[{"type":"code","code":"const x = 1"},{"type":"md","code":"# Title"},{"type":"css","code":"body { color: red; }"}]
AUDITABLE-DATA-->
<!-- notebook settings: JSON {theme, fontSize, width, ...} -->
<!--AUDITABLE-SETTINGS
{"theme":"light","fontSize":15,"width":"1200"}
AUDITABLE-SETTINGS-->

<script>
console.log('runtime');
</script>
</body>
</html>`;

    // dehydrate
    const lightweight = await dehydrate(originalHtml, blobs);
    assert.ok(isLightweight(lightweight));

    // hydrate back
    const restored = await hydrate(lightweight, RUNTIME, blobs);

    // verify data preserved
    const dataMatch = restored.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
    const cells = JSON.parse(dataMatch[1]);
    assert.equal(cells.length, 3);
    assert.equal(cells[0].code, 'const x = 1');
    assert.equal(cells[1].code, '# Title');
    assert.equal(cells[2].code, 'body { color: red; }');

    // verify settings preserved
    const setMatch = restored.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
    const settings = JSON.parse(setMatch[1]);
    assert.equal(settings.theme, 'light');
    assert.equal(settings.fontSize, 15);

    // verify title
    assert.ok(restored.includes('value="roundtrip test"'));
  });

  it('preserves modules through round-trip', async () => {
    const blobs = createBlobStore();
    const moduleSource = 'export function greet() { return "hello"; }';
    const modules = {
      'https://cdn.example.com/greet.js': { source: moduleSource, cellId: 1 },
    };
    const modulesEncoded = encodeModulesB64(modules);

    const originalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Auditable \u2014 mod test</title>
<style>body{}</style>
</head>
<body>
<input id="docTitle" value="mod test">

<!--AUDITABLE-DATA
[{"type":"code","code":"const g = greet()"}]
AUDITABLE-DATA-->
<!--AUDITABLE-MODULES
${modulesEncoded}
AUDITABLE-MODULES-->
<!--AUDITABLE-SETTINGS
{"theme":"dark"}
AUDITABLE-SETTINGS-->

<script>
console.log('runtime');
</script>
</body>
</html>`;

    const lightweight = await dehydrate(originalHtml, blobs);
    const parsed = JSON.parse(lightweight);
    assert.ok(parsed.modules);
    assert.ok(parsed.modules['https://cdn.example.com/greet.js'].ref);

    // hydrate back
    const restored = await hydrate(lightweight, RUNTIME, blobs);

    // verify module source restored
    const modMatch = restored.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
    assert.ok(modMatch);
    const decoded = decodeModulesB64(modMatch[1]);
    assert.equal(decoded['https://cdn.example.com/greet.js'].source, moduleSource);
    assert.equal(decoded['https://cdn.example.com/greet.js'].cellId, 1);
  });

  it('deduplicates shared modules across dehydrations', async () => {
    const blobs = createBlobStore();
    const sharedSource = 'export const shared = true;';
    const modules = {
      'https://cdn.example.com/shared.js': { source: sharedSource, cellId: 0 },
    };
    const modulesEncoded = encodeModulesB64(modules);

    const makeHtml = (title) => `<!DOCTYPE html>
<html><head><title>Auditable</title></head>
<body>
<input id="docTitle" value="${title}">
<!--AUDITABLE-DATA
[]
AUDITABLE-DATA-->
<!--AUDITABLE-MODULES
${modulesEncoded}
AUDITABLE-MODULES-->
<!--AUDITABLE-SETTINGS
{}
AUDITABLE-SETTINGS-->
<script>/*rt*/</script>
</body></html>`;

    // dehydrate two notebooks with the same module
    const lw1 = await dehydrate(makeHtml('notebook 1'), blobs);
    const lw2 = await dehydrate(makeHtml('notebook 2'), blobs);

    // both should reference the same blob hash
    const p1 = JSON.parse(lw1);
    const p2 = JSON.parse(lw2);
    assert.equal(
      p1.modules['https://cdn.example.com/shared.js'].ref,
      p2.modules['https://cdn.example.com/shared.js'].ref
    );

    // blob store should have exactly one entry
    assert.equal(blobs.store.size, 1);
  });
});

describe('lightweight format for new notebooks', () => {
  it('creates valid lightweight JSON', () => {
    const content = JSON.stringify({
      format: 'auditable-notebook',
      v: 1,
      title: 'untitled',
      cells: [],
      settings: { theme: 'dark', fontSize: 13, width: '860' },
    });

    assert.ok(isLightweight(content));
    const parsed = JSON.parse(content);
    assert.equal(parsed.format, 'auditable-notebook');
    assert.equal(parsed.v, 1);
    assert.deepEqual(parsed.cells, []);
  });

  it('hydrates empty notebook to valid HTML', async () => {
    const blobs = createBlobStore();
    const content = JSON.stringify({
      format: 'auditable-notebook',
      v: 1,
      title: 'new notebook',
      cells: [],
      settings: { theme: 'dark', fontSize: 13, width: '860' },
    });

    const html = await hydrate(content, RUNTIME, blobs);
    assert.ok(html.includes('<title>Auditable \u2014 new notebook</title>'));
    assert.ok(html.includes('AUDITABLE-DATA'));
    assert.ok(html.includes('AUDITABLE-SETTINGS'));
    assert.ok(html.includes("console.log('runtime')"));
  });
});
