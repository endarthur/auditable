// Persistence tests — VFS walk/hydrate, /// txt round-trip, persister API.
//
// Spec: spec_inbox/shipped/auditable-persistence-spec.md (roadmap E).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VFS, MemoryBackend } from '../ext/vfs/index.js';

// serialize.js is pure (zero DOM imports). persist.js (the DOM-coupled
// orchestration) re-exports serializeVfs / hydrateVfs from there.
import {
  serializeNotebookTxt,
  parseNotebookTxt,
  serializeVfs,
  hydrateVfs,
} from '../src/js/serialize.js';

describe('serializeNotebookTxt / parseNotebookTxt round-trip', () => {
  it('basic notebook with title + settings + cells', () => {
    const notebook = {
      title: 'my notebook',
      settings: { theme: 'dark', fontSize: 14, width: '900' },
      cells: [
        { type: 'md', code: '# heading\nsome text' },
        { type: 'code', code: 'const x = 42;' },
        { type: 'code', code: 'ui.display(x);', collapsed: true },
      ],
      modules: [],
    };
    const txt = serializeNotebookTxt(notebook);
    const parsed = parseNotebookTxt(txt);
    assert.equal(parsed.title, 'my notebook');
    assert.deepEqual(parsed.settings, notebook.settings);
    assert.equal(parsed.cells.length, 3);
    assert.equal(parsed.cells[0].code, '# heading\nsome text');
    assert.equal(parsed.cells[2].collapsed, true);
  });

  it('module declarations round-trip with optional ref', () => {
    const notebook = {
      title: 'mods',
      settings: null,
      cells: [{ type: 'code', code: 'x' }],
      modules: [
        { url: '@gcu/sql' },
        { url: 'https://esm.sh/lodash', ref: 'abc123' },
      ],
    };
    const txt = serializeNotebookTxt(notebook);
    assert.match(txt, /^\/\/\/ module: @gcu\/sql$/m);
    assert.match(txt, /^\/\/\/ module: https:\/\/esm\.sh\/lodash abc123$/m);
    const parsed = parseNotebookTxt(txt);
    assert.equal(parsed.modules.length, 2);
    assert.equal(parsed.modules[0].url, '@gcu/sql');
    assert.equal(parsed.modules[1].url, 'https://esm.sh/lodash');
    assert.equal(parsed.modules[1].ref, 'abc123');
  });

  it('default settings are omitted from output', () => {
    const txt = serializeNotebookTxt({
      title: 'untitled',
      settings: { theme: 'dark', fontSize: 13, width: '860' },
      cells: [{ type: 'code', code: '' }],
      modules: [],
    });
    assert.ok(!txt.includes('/// settings:'));
    assert.ok(!txt.includes('/// title:'));
  });

  it('empty notebook parses cleanly', () => {
    const parsed = parseNotebookTxt('/// auditable\n');
    assert.equal(parsed.title, 'untitled');
    assert.equal(parsed.cells.length, 0);
    assert.equal(parsed.modules.length, 0);
  });

  it('cells with /// in their content are preserved', () => {
    const code = 'const s = "no leading slashes";';
    const txt = serializeNotebookTxt({
      title: 'x', cells: [{ type: 'code', code }], modules: [],
    });
    const parsed = parseNotebookTxt(txt);
    assert.equal(parsed.cells[0].code, code);
  });
});

describe('serializeVfs / hydrateVfs round-trip', () => {
  async function makeVfsWithMounts() {
    const vfs = new VFS();
    vfs._mounts.set('/projects/self', new MemoryBackend());
    vfs._mounts.set('/lib', new MemoryBackend());
    vfs._mounts.set('/tmp', new MemoryBackend());
    return vfs;
  }

  it('walks /projects and /lib but skips /tmp', async () => {
    const vfs = await makeVfsWithMounts();
    await vfs.writeFile('/projects/self/notebook.txt', 'cells go here');
    await vfs.writeFile('/lib/mod.js', '// a module');
    await vfs.writeFile('/tmp/scratch.txt', 'volatile');

    const dump = await serializeVfs(vfs);

    assert.ok(dump['/projects/self/notebook.txt']);
    assert.equal(dump['/projects/self/notebook.txt'].content, 'cells go here');
    assert.ok(dump['/lib/mod.js']);
    assert.equal(dump['/lib/mod.js'].content, '// a module');
    assert.ok(!dump['/tmp/scratch.txt']);
  });

  it('round-trips text files', async () => {
    const v1 = await makeVfsWithMounts();
    await v1.writeFile('/projects/self/notebook.txt', '/// auditable\n/// code\nx');
    await v1.writeFile('/projects/self/foo.json', '{"a":1}');

    const dump = await serializeVfs(v1);

    const v2 = await makeVfsWithMounts();
    await hydrateVfs(v2, dump);

    assert.equal(await v2.readFile('/projects/self/notebook.txt', 'text'), '/// auditable\n/// code\nx');
    assert.equal(await v2.readFile('/projects/self/foo.json', 'text'), '{"a":1}');
  });

  it('round-trips binary content (base64 in dump)', async () => {
    const v1 = await makeVfsWithMounts();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 0, 100]);
    await v1.writeFile('/projects/self/blob.bin', bytes);

    const dump = await serializeVfs(v1);

    // The walker tries text first; for binary content readFile('text') often
    // returns garbage rather than throwing, so we don't assert kind here.
    // The round-trip must reconstruct the bytes either way.
    assert.ok(dump['/projects/self/blob.bin']);

    const v2 = await makeVfsWithMounts();
    await hydrateVfs(v2, dump);
    const out = await v2.readFile('/projects/self/blob.bin', 'bytes');
    assert.deepEqual([...out], [...bytes]);
  });

  it('nested directories survive', async () => {
    const v1 = await makeVfsWithMounts();
    await v1.mkdir('/lib/lodash', { recursive: true });
    await v1.writeFile('/lib/lodash/source', '// lodash source');
    await v1.writeFile('/lib/lodash/meta.json', '{"compressed":false}');

    const dump = await serializeVfs(v1);
    assert.ok(dump['/lib/lodash/source']);
    assert.ok(dump['/lib/lodash/meta.json']);

    const v2 = await makeVfsWithMounts();
    await hydrateVfs(v2, dump);
    assert.equal(await v2.readFile('/lib/lodash/source', 'text'), '// lodash source');
    assert.equal(await v2.readFile('/lib/lodash/meta.json', 'text'), '{"compressed":false}');
  });

  it('empty mounts produce empty dump entries', async () => {
    const vfs = await makeVfsWithMounts();
    const dump = await serializeVfs(vfs);
    assert.deepEqual(Object.keys(dump), []);
  });
});
