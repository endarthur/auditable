import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// serialize.js has ZERO DOM dependencies — no document shim needed
import {
  serializeCells, encodeModules, decodeModules, esc,
  parseNotebookHtml, buildTxtExport, PERSISTENT_MOUNTS, commentSafeJson
} from '../src/js/serialize.js';

// Guard: /var must stay persistent so std.data packs (installed to /var/data)
// survive a standalone save/load. Removing it silently breaks data persistence.
describe('serialize: persistent mounts', () => {
  it('includes /projects/self, /lib and /var', () => {
    assert.ok(PERSISTENT_MOUNTS.includes('/projects/self'));
    assert.ok(PERSISTENT_MOUNTS.includes('/lib'));
    assert.ok(PERSISTENT_MOUNTS.includes('/var'));
  });
});

describe('serialize: serializeCells', () => {
  it('extracts type, code, and collapsed', () => {
    const cells = [
      { id: 0, type: 'code', code: 'const x = 1', collapsed: false },
      { id: 1, type: 'md', code: '# Hello', collapsed: true },
    ];
    const result = serializeCells(cells);
    assert.deepEqual(result, [
      { type: 'code', code: 'const x = 1', collapsed: undefined },
      { type: 'md', code: '# Hello', collapsed: true },
    ]);
  });

  it('omits collapsed when false', () => {
    const cells = [{ id: 0, type: 'code', code: '', collapsed: false }];
    const result = serializeCells(cells);
    assert.equal(result[0].collapsed, undefined);
  });
});

describe('serialize: encodeModules / decodeModules', () => {
  it('round-trips simple object', () => {
    const obj = { foo: 'bar', num: 42 };
    const encoded = encodeModules(obj);
    const decoded = decodeModules(encoded);
    assert.deepEqual(decoded, obj);
  });

  it('handles special characters in source code', () => {
    const obj = { 'https://example.com': { source: "x --> y; $' replaced", cellId: 0 } };
    const encoded = encodeModules(obj);
    const decoded = decodeModules(encoded);
    assert.deepEqual(decoded, obj);
  });

  it('handles unicode', () => {
    const obj = { key: 'atra — fortran · wasm' };
    const encoded = encodeModules(obj);
    const decoded = decodeModules(encoded);
    assert.deepEqual(decoded, obj);
  });

  it('decodes legacy raw JSON format', () => {
    const obj = { foo: 'bar' };
    const raw = JSON.stringify(obj);
    const decoded = decodeModules(raw);
    assert.deepEqual(decoded, obj);
  });
});

describe('serialize: esc', () => {
  it('escapes HTML entities', () => {
    assert.equal(esc('a & b'), 'a &amp; b');
    assert.equal(esc('<script>'), '&lt;script&gt;');
    assert.equal(esc('"hello"'), '&quot;hello&quot;');
  });

  it('handles clean strings', () => {
    assert.equal(esc('hello world'), 'hello world');
  });
});

describe('serialize: parseNotebookHtml', () => {
  it('extracts title', () => {
    const html = '<title>Auditable \u2014 My Notebook</title>';
    const result = parseNotebookHtml(html);
    assert.equal(result.title, 'My Notebook');
  });

  it('extracts cells from DATA block', () => {
    const cells = [{ type: 'code', code: 'const x = 1' }];
    const html = `<!--AUDITABLE-DATA\n${JSON.stringify(cells)}\nAUDITABLE-DATA-->`;
    const result = parseNotebookHtml(html);
    assert.deepEqual(result.cells, cells);
  });

  it('extracts settings from SETTINGS block', () => {
    const settings = { theme: 'light', fontSize: 14 };
    const html = `<!--AUDITABLE-SETTINGS\n${JSON.stringify(settings)}\nAUDITABLE-SETTINGS-->`;
    const result = parseNotebookHtml(html);
    assert.deepEqual(result.settings, settings);
  });

  it('extracts modules from MODULES block', () => {
    const mods = { 'https://example.com/mod.js': { source: 'abc', cellId: 0 } };
    const encoded = encodeModules(mods);
    const html = `<!--AUDITABLE-MODULES\n${encoded}\nAUDITABLE-MODULES-->`;
    const result = parseNotebookHtml(html);
    assert.deepEqual(result.modules, mods);
  });

  it('returns null for missing blocks', () => {
    const result = parseNotebookHtml('<html></html>');
    assert.equal(result.cells, null);
    assert.equal(result.settings, null);
    assert.equal(result.modules, null);
    assert.equal(result.title, 'untitled');
  });

  it('round-trips with serializeCells', () => {
    const cells = [
      { id: 0, type: 'code', code: 'const x = 1', collapsed: false },
      { id: 1, type: 'md', code: '# Hi', collapsed: true },
    ];
    const serialized = serializeCells(cells);
    const html = `<!--AUDITABLE-DATA\n${JSON.stringify(serialized)}\nAUDITABLE-DATA-->`;
    const parsed = parseNotebookHtml(html);
    assert.equal(parsed.cells.length, 2);
    assert.equal(parsed.cells[0].type, 'code');
    assert.equal(parsed.cells[0].code, 'const x = 1');
    assert.equal(parsed.cells[1].collapsed, true);
  });
});

describe('serialize: buildTxtExport', () => {
  it('builds basic /// format', () => {
    const txt = buildTxtExport({
      title: 'test',
      cells: [{ type: 'code', code: 'const x = 1' }],
    });
    assert.ok(txt.startsWith('/// auditable\n'));
    assert.ok(txt.includes('/// title: test'));
    assert.ok(txt.includes('/// code'));
    assert.ok(txt.includes('const x = 1'));
  });

  it('omits title when untitled', () => {
    const txt = buildTxtExport({
      title: 'untitled',
      cells: [{ type: 'md', code: '# Hello' }],
    });
    assert.ok(!txt.includes('/// title:'));
  });

  it('includes module directives', () => {
    const txt = buildTxtExport({
      title: 'test',
      cells: [{ type: 'code', code: '' }],
      moduleUrls: ['https://example.com/mod.js'],
    });
    assert.ok(txt.includes('/// module: https://example.com/mod.js'));
  });

  it('includes collapsed flag', () => {
    const txt = buildTxtExport({
      title: 'test',
      cells: [{ type: 'code', code: 'x', collapsed: true }],
    });
    assert.ok(txt.includes('/// code collapsed'));
  });

  it('includes settings when non-default', () => {
    const txt = buildTxtExport({
      title: 'test',
      cells: [{ type: 'code', code: '' }],
      settings: { theme: 'light', fontSize: 14, width: '860' },
    });
    assert.ok(txt.includes('/// settings:'));
  });

  it('omits settings when default', () => {
    const txt = buildTxtExport({
      title: 'test',
      cells: [{ type: 'code', code: '' }],
      settings: { theme: 'dark', fontSize: 13, width: '860' },
    });
    assert.ok(!txt.includes('/// settings:'));
  });
});

describe('commentSafeJson — comment-block-safe VFS dumps', () => {
  it('a payload containing --> cannot close the HTML comment early', () => {
    const dump = {
      '/var/notebook.txt': { type: 'file', kind: 'text', content: '/// code\nlet i = 5; while (i --> 0) print(i);' },
      '/var/modules/x/source': { type: 'file', kind: 'text', content: 'lines.push(a + " --> " + b); // mermaid arrow' },
    };
    const json = commentSafeJson(dump);
    assert.ok(!json.includes('-->'), 'no comment terminator survives in the payload');
    assert.deepEqual(JSON.parse(json), dump);              // parses IDENTICALLY — readers unchanged
    const block = '<!--AUDITABLE-VFS\n' + json + '\nAUDITABLE-VFS-->';
    const m = block.match(/<!--AUDITABLE-VFS\n([\s\S]*?)\nAUDITABLE-VFS-->/);
    assert.deepEqual(JSON.parse(m[1]), dump);              // the block round-trips whole
    assert.equal(block.indexOf('-->'), block.length - 3);  // the ONLY --> is the real terminator
  });
  it('longer arrows and nested comment markers survive byte-exactly', () => {
    const v = { a: 'x ---> y', b: '<!-- inner -->', c: 'a->b -->> c' };
    assert.deepEqual(JSON.parse(commentSafeJson(v)), v);
    assert.ok(!commentSafeJson(v).includes('-->'));
  });
});
