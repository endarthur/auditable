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

// ── Replicate txt format functions for Node.js testing ──

function isAuditableTxt(content) {
  if (typeof content !== 'string') return false;
  return content.startsWith('/// auditable\n') || content.startsWith('/// auditable\r\n');
}

function parseTxt(content) {
  const lines = content.split('\n');
  let title = 'untitled';
  let settings = { theme: 'dark', fontSize: 13, width: '860' };
  const modules = {};
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l.startsWith('/// ')) {
      if (currentCell) {
        currentCell.code = trimCellTxt(currentCell.code);
        cells.push(currentCell);
        currentCell = null;
      }
      const directive = l.slice(4);
      if (directive === 'auditable') {
        continue;
      } else if (directive.startsWith('title: ')) {
        title = directive.slice(7);
      } else if (directive.startsWith('settings: ')) {
        try { settings = JSON.parse(directive.slice(10)); } catch {}
      } else if (directive.startsWith('module: ')) {
        const parts = directive.slice(8).split(' ');
        const url = parts[0];
        const ref = parts.length > 1 ? parts.slice(1).join(' ') : null;
        modules[url] = { ref };
      } else {
        const parts = directive.split(' ');
        const type = parts[0];
        const collapsed = parts.includes('collapsed');
        currentCell = { type };
        if (collapsed) currentCell.collapsed = true;
        currentCell.code = '';
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + l;
    }
  }
  if (currentCell) {
    currentCell.code = trimCellTxt(currentCell.code);
    cells.push(currentCell);
  }
  const notebook = { title, cells, settings };
  if (Object.keys(modules).length > 0) {
    notebook.modules = {};
    for (const [url, entry] of Object.entries(modules)) {
      notebook.modules[url] = { ref: entry.ref };
    }
  }
  return notebook;
}

function trimCellTxt(code) {
  return code.replace(/^\n/, '').replace(/\n$/, '');
}

function toTxt(notebook) {
  const lines = ['/// auditable'];
  if (notebook.title && notebook.title !== 'untitled') {
    lines.push('/// title: ' + notebook.title);
  }
  const defaultSettings = { theme: 'dark', fontSize: 13, width: '860' };
  if (notebook.settings && JSON.stringify(notebook.settings) !== JSON.stringify(defaultSettings)) {
    lines.push('/// settings: ' + JSON.stringify(notebook.settings));
  }
  if (notebook.modules) {
    for (const [url, entry] of Object.entries(notebook.modules)) {
      if (entry.ref) {
        lines.push('/// module: ' + url + ' ' + entry.ref);
      } else {
        lines.push('/// module: ' + url);
      }
    }
  }
  for (const cell of (notebook.cells || [])) {
    lines.push('');
    const flags = cell.collapsed ? ' collapsed' : '';
    lines.push('/// ' + cell.type + flags);
    lines.push(cell.code || '');
  }
  return lines.join('\n') + '\n';
}

function extractNotebook(html) {
  if (/<meta\s+name="auditable-packed"/i.test(html)) return null;
  const titleMatch = html.match(/id="docTitle"\s+value="([^"]*)"/);
  const title = titleMatch ? titleMatch[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'untitled';
  const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  let cells = [];
  if (dataMatch) { try { cells = JSON.parse(dataMatch[1]); } catch {} }
  const setMatch = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  let settings = {};
  if (setMatch) { try { settings = JSON.parse(setMatch[1]); } catch {} }
  const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  let modules = null;
  if (modMatch) {
    try {
      const decoded = decodeModulesB64(modMatch[1]);
      modules = {};
      for (const [url, entry] of Object.entries(decoded)) {
        modules[url] = { ...entry };
      }
    } catch {}
  }
  const notebook = { title, cells, settings };
  if (modules && Object.keys(modules).length > 0) notebook.modules = modules;
  return notebook;
}

// ── Txt format tests ──

describe('isAuditableTxt', () => {
  it('detects valid txt format with LF', () => {
    assert.ok(isAuditableTxt('/// auditable\n/// title: test\n'));
  });

  it('detects valid txt format with CRLF', () => {
    assert.ok(isAuditableTxt('/// auditable\r\n/// title: test\r\n'));
  });

  it('rejects non-string input', () => {
    assert.ok(!isAuditableTxt(null));
    assert.ok(!isAuditableTxt(42));
    assert.ok(!isAuditableTxt(undefined));
  });

  it('rejects HTML content', () => {
    assert.ok(!isAuditableTxt('<!DOCTYPE html>'));
  });

  it('rejects JSON content', () => {
    assert.ok(!isAuditableTxt('{"format":"auditable-notebook"}'));
  });

  it('rejects plain text without magic line', () => {
    assert.ok(!isAuditableTxt('/// title: test\n'));
  });

  it('rejects partial match', () => {
    assert.ok(!isAuditableTxt('/// auditablefoo\n'));
  });
});

describe('parseTxt', () => {
  it('parses minimal txt with only magic line', () => {
    const nb = parseTxt('/// auditable\n');
    assert.equal(nb.title, 'untitled');
    assert.deepEqual(nb.cells, []);
  });

  it('parses title and cells', () => {
    const txt = '/// auditable\n/// title: my notebook\n\n/// code\nconst x = 1;\n\n/// md\n# Hello\n';
    const nb = parseTxt(txt);
    assert.equal(nb.title, 'my notebook');
    assert.equal(nb.cells.length, 2);
    assert.equal(nb.cells[0].type, 'code');
    assert.equal(nb.cells[0].code, 'const x = 1;');
    assert.equal(nb.cells[1].type, 'md');
    assert.equal(nb.cells[1].code, '# Hello');
  });

  it('parses settings', () => {
    const txt = '/// auditable\n/// settings: {"theme":"light","fontSize":15}\n';
    const nb = parseTxt(txt);
    assert.equal(nb.settings.theme, 'light');
    assert.equal(nb.settings.fontSize, 15);
  });

  it('parses modules with hash ref', () => {
    const txt = '/// auditable\n/// module: https://esm.sh/lib abc123\n';
    const nb = parseTxt(txt);
    assert.ok(nb.modules);
    assert.equal(nb.modules['https://esm.sh/lib'].ref, 'abc123');
  });

  it('parses modules without hash ref', () => {
    const txt = '/// auditable\n/// module: https://esm.sh/lib\n';
    const nb = parseTxt(txt);
    assert.ok(nb.modules);
    assert.equal(nb.modules['https://esm.sh/lib'].ref, null);
  });

  it('parses collapsed cells', () => {
    const txt = '/// auditable\n\n/// code collapsed\nconst x = 1;\n';
    const nb = parseTxt(txt);
    assert.equal(nb.cells[0].collapsed, true);
  });

  it('handles CRLF line endings', () => {
    const txt = '/// auditable\r\n/// title: crlf test\r\n\r\n/// code\r\nconst x = 1;\r\n';
    const nb = parseTxt(txt);
    assert.equal(nb.title, 'crlf test');
    assert.equal(nb.cells[0].code, 'const x = 1;');
  });

  it('handles all cell types', () => {
    const txt = '/// auditable\n\n/// code\nconst x = 1;\n\n/// md\n# Hi\n\n/// css\nbody{}\n\n/// html\n<div></div>\n';
    const nb = parseTxt(txt);
    assert.equal(nb.cells.length, 4);
    assert.equal(nb.cells[0].type, 'code');
    assert.equal(nb.cells[1].type, 'md');
    assert.equal(nb.cells[2].type, 'css');
    assert.equal(nb.cells[3].type, 'html');
  });

  it('preserves multiline cell content', () => {
    const txt = '/// auditable\n\n/// code\nconst x = 1;\nconst y = 2;\nconst z = x + y;\n';
    const nb = parseTxt(txt);
    assert.equal(nb.cells[0].code, 'const x = 1;\nconst y = 2;\nconst z = x + y;');
  });
});

describe('toTxt', () => {
  it('produces valid txt with magic line', () => {
    const nb = { title: 'test', cells: [], settings: { theme: 'dark', fontSize: 13, width: '860' } };
    const txt = toTxt(nb);
    assert.ok(txt.startsWith('/// auditable\n'));
    assert.ok(isAuditableTxt(txt));
  });

  it('includes title', () => {
    const nb = { title: 'my notebook', cells: [], settings: { theme: 'dark', fontSize: 13, width: '860' } };
    const txt = toTxt(nb);
    assert.ok(txt.includes('/// title: my notebook'));
  });

  it('omits default settings', () => {
    const nb = { title: 'test', cells: [], settings: { theme: 'dark', fontSize: 13, width: '860' } };
    const txt = toTxt(nb);
    assert.ok(!txt.includes('/// settings:'));
  });

  it('includes non-default settings', () => {
    const nb = { title: 'test', cells: [], settings: { theme: 'light', fontSize: 15 } };
    const txt = toTxt(nb);
    assert.ok(txt.includes('/// settings:'));
    assert.ok(txt.includes('"light"'));
  });

  it('includes cells', () => {
    const nb = { title: 'test', cells: [{ type: 'code', code: 'const x = 1;' }, { type: 'md', code: '# Hello' }], settings: {} };
    const txt = toTxt(nb);
    assert.ok(txt.includes('/// code\nconst x = 1;'));
    assert.ok(txt.includes('/// md\n# Hello'));
  });

  it('includes collapsed flag', () => {
    const nb = { title: 'test', cells: [{ type: 'code', code: 'x', collapsed: true }], settings: {} };
    const txt = toTxt(nb);
    assert.ok(txt.includes('/// code collapsed'));
  });

  it('includes modules with refs', () => {
    const nb = { title: 'test', cells: [], settings: {}, modules: { 'https://esm.sh/lib': { ref: 'abc123' } } };
    const txt = toTxt(nb);
    assert.ok(txt.includes('/// module: https://esm.sh/lib abc123'));
  });

  it('includes modules without refs', () => {
    const nb = { title: 'test', cells: [], settings: {}, modules: { 'https://esm.sh/lib': { ref: null } } };
    const txt = toTxt(nb);
    assert.ok(txt.includes('/// module: https://esm.sh/lib\n'));
  });
});

describe('parseTxt → toTxt round-trip', () => {
  it('preserves notebook through round-trip', () => {
    const original = '/// auditable\n/// title: round trip\n/// settings: {"theme":"light","fontSize":15}\n/// module: https://esm.sh/lib abc123\n\n/// code\nconst x = 1;\n\n/// md\n# Hello\n\n/// css\nbody { color: red; }\n\n/// html\n<div>${x}</div>\n';
    const nb = parseTxt(original);
    assert.equal(nb.title, 'round trip');
    assert.equal(nb.cells.length, 4);

    const roundTripped = toTxt(nb);
    const nb2 = parseTxt(roundTripped);
    assert.equal(nb2.title, nb.title);
    assert.equal(nb2.cells.length, nb.cells.length);
    for (let i = 0; i < nb.cells.length; i++) {
      assert.equal(nb2.cells[i].type, nb.cells[i].type);
      assert.equal(nb2.cells[i].code, nb.cells[i].code);
    }
    assert.deepEqual(nb2.settings, nb.settings);
    assert.deepEqual(nb2.modules, nb.modules);
  });
});

describe('extractNotebook', () => {
  it('extracts notebook from HTML', () => {
    const html = `<!DOCTYPE html>
<html><head><title>Auditable</title></head>
<body>
<input id="docTitle" value="extracted">
<!--AUDITABLE-DATA
[{"type":"code","code":"const x = 1"},{"type":"md","code":"# Hi"}]
AUDITABLE-DATA-->
<!--AUDITABLE-SETTINGS
{"theme":"dark","fontSize":13}
AUDITABLE-SETTINGS-->
<script>/*rt*/</script>
</body></html>`;

    const nb = extractNotebook(html);
    assert.equal(nb.title, 'extracted');
    assert.equal(nb.cells.length, 2);
    assert.equal(nb.cells[0].type, 'code');
    assert.equal(nb.cells[0].code, 'const x = 1');
    assert.deepEqual(nb.settings, { theme: 'dark', fontSize: 13 });
    assert.equal(nb.modules, undefined);
  });

  it('returns null for packed notebooks', () => {
    const html = `<!DOCTYPE html><html><head><meta name="auditable-packed"></head><body></body></html>`;
    assert.equal(extractNotebook(html), null);
  });

  it('extracts modules with sources', () => {
    const modules = { 'lib.js': { source: 'code', cellId: 1 } };
    const encoded = encodeModulesB64(modules);
    const html = `<!DOCTYPE html><html><head></head><body>
<input id="docTitle" value="test">
<!--AUDITABLE-DATA
[]
AUDITABLE-DATA-->
<!--AUDITABLE-MODULES
${encoded}
AUDITABLE-MODULES-->
<!--AUDITABLE-SETTINGS
{}
AUDITABLE-SETTINGS-->
<script></script></body></html>`;

    const nb = extractNotebook(html);
    assert.ok(nb.modules);
    assert.equal(nb.modules['lib.js'].source, 'code');
    assert.equal(nb.modules['lib.js'].cellId, 1);
  });
});

describe('extractNotebook → toTxt', () => {
  it('converts HTML to txt format', () => {
    const html = `<!DOCTYPE html>
<html><head><title>Auditable</title></head>
<body>
<input id="docTitle" value="from html">
<!--AUDITABLE-DATA
[{"type":"code","code":"const x = 1"},{"type":"md","code":"# Title"}]
AUDITABLE-DATA-->
<!--AUDITABLE-SETTINGS
{"theme":"dark","fontSize":13,"width":"860"}
AUDITABLE-SETTINGS-->
<script>/*rt*/</script>
</body></html>`;

    const nb = extractNotebook(html);
    const txt = toTxt(nb);
    assert.ok(isAuditableTxt(txt));
    assert.ok(txt.includes('/// title: from html'));
    assert.ok(txt.includes('/// code\nconst x = 1'));
    assert.ok(txt.includes('/// md\n# Title'));
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
