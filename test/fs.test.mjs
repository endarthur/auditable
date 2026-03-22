import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// shim DOM
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

// shim window
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

// mock notifyDirty (from editor.js)
globalThis.notifyDirty = () => {};

// import VFS classes for test setup
const { VFS } = await import('../ext/vfs/src/vfs.js');
const { CommentBackend } = await import('../ext/vfs/src/comment.js');
const { MemoryBackend } = await import('../ext/vfs/src/memory.js');

// import fs module functions
const { mimeFromExt, isTextType, validatePath, globMatch, uint8ToBase64, base64ToUint8, createNotebookFs } = await import('../src/js/fs.js');

describe('mimeFromExt', () => {
  it('csv', () => assert.equal(mimeFromExt('data/file.csv'), 'text/csv'));
  it('json', () => assert.equal(mimeFromExt('config.json'), 'application/json'));
  it('txt', () => assert.equal(mimeFromExt('readme.txt'), 'text/plain'));
  it('md', () => assert.equal(mimeFromExt('notes.md'), 'text/markdown'));
  it('html', () => assert.equal(mimeFromExt('page.html'), 'text/html'));
  it('js', () => assert.equal(mimeFromExt('lib/helper.js'), 'text/javascript'));
  it('png', () => assert.equal(mimeFromExt('img.png'), 'image/png'));
  it('jpg', () => assert.equal(mimeFromExt('photo.jpg'), 'image/jpeg'));
  it('jpeg', () => assert.equal(mimeFromExt('photo.jpeg'), 'image/jpeg'));
  it('webp', () => assert.equal(mimeFromExt('photo.webp'), 'image/webp'));
  it('gif', () => assert.equal(mimeFromExt('anim.gif'), 'image/gif'));
  it('svg', () => assert.equal(mimeFromExt('icon.svg'), 'image/svg+xml'));
  it('pdf', () => assert.equal(mimeFromExt('doc.pdf'), 'application/pdf'));
  it('zip', () => assert.equal(mimeFromExt('archive.zip'), 'application/zip'));
  it('gz', () => assert.equal(mimeFromExt('data.gz'), 'application/gzip'));
  it('wasm', () => assert.equal(mimeFromExt('module.wasm'), 'application/wasm'));
  it('bin', () => assert.equal(mimeFromExt('data.bin'), 'application/octet-stream'));
  it('unknown ext', () => assert.equal(mimeFromExt('file.xyz'), 'application/octet-stream'));
});

describe('isTextType', () => {
  it('text/csv is text', () => assert.equal(isTextType('text/csv'), true));
  it('text/plain is text', () => assert.equal(isTextType('text/plain'), true));
  it('application/json is text', () => assert.equal(isTextType('application/json'), true));
  it('application/javascript is text', () => assert.equal(isTextType('application/javascript'), true));
  it('image/svg+xml is text', () => assert.equal(isTextType('image/svg+xml'), true));
  it('image/png is not text', () => assert.equal(isTextType('image/png'), false));
  it('application/octet-stream is not text', () => assert.equal(isTextType('application/octet-stream'), false));
  it('application/wasm is not text', () => assert.equal(isTextType('application/wasm'), false));
});

describe('validatePath', () => {
  it('valid simple path', () => assert.equal(validatePath('file.txt'), 'file.txt'));
  it('valid nested path', () => assert.equal(validatePath('data/input.csv'), 'data/input.csv'));
  it('reject leading /', () => assert.throws(() => validatePath('/file.txt'), /must not start with/));
  it('reject ..', () => assert.throws(() => validatePath('data/../file.txt'), /must not contain \.\./));
  it('reject empty', () => assert.throws(() => validatePath(''), /non-empty/));
  it('reject null', () => assert.throws(() => validatePath(null), /non-empty/));
  it('reject empty segment', () => assert.throws(() => validatePath('data//file.txt'), /empty segments/));
});

describe('globMatch', () => {
  it('*.csv matches .csv files', () => {
    assert.equal(globMatch('*.csv', 'data.csv'), true);
    assert.equal(globMatch('*.csv', 'data.json'), false);
    assert.equal(globMatch('*.csv', 'dir/data.csv'), false); // * doesn't cross /
  });
  it('data/* matches files in data/', () => {
    assert.equal(globMatch('data/*', 'data/file.csv'), true);
    assert.equal(globMatch('data/*', 'data/sub/file.csv'), false);
    assert.equal(globMatch('data/*', 'other/file.csv'), false);
  });
  it('**/*.csv matches nested CSVs', () => {
    assert.equal(globMatch('**/*.csv', 'data.csv'), true);
    assert.equal(globMatch('**/*.csv', 'data/input.csv'), true);
    assert.equal(globMatch('**/*.csv', 'a/b/c.csv'), true);
    assert.equal(globMatch('**/*.csv', 'data/input.json'), false);
  });
  it('**/*.json matches nested JSONs', () => {
    assert.equal(globMatch('**/*.json', 'config.json'), true);
    assert.equal(globMatch('**/*.json', 'data/config.json'), true);
  });
  it('? matches single char', () => {
    assert.equal(globMatch('file?.txt', 'file1.txt'), true);
    assert.equal(globMatch('file?.txt', 'file12.txt'), false);
  });
});

describe('base64 roundtrip', () => {
  it('encode/decode', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const b64 = uint8ToBase64(bytes);
    const decoded = base64ToUint8(b64);
    assert.deepEqual(decoded, bytes);
  });
});

describe('notebook.fs core', () => {
  let fs;

  beforeEach(() => {
    window._notebookFS = new Map();
    // set up shared VFS instance for tests
    const testVfs = new VFS();
    const backend = new CommentBackend({});
    Object.defineProperty(backend, '_map', { get: () => window._notebookFS, configurable: true });
    backend._syncComment = () => {};
    testVfs._mounts.set('/home/nb', backend);
    testVfs._mounts.set('/tmp', new MemoryBackend());
    window._notebookVFS = testVfs;
    fs = createNotebookFs();
  });

  describe('write/read string roundtrip', () => {
    it('text file', async () => {
      await fs.write('test.txt', 'hello world');
      const text = await fs.read('test.txt');
      assert.equal(text, 'hello world');
    });
  });

  describe('write/read binary roundtrip', () => {
    it('Uint8Array', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await fs.write('data.bin', data);
      const result = await fs.read('data.bin', 'binary');
      assert.deepEqual(result, data);
    });
  });

  describe('write/read JSON roundtrip', () => {
    it('object', async () => {
      const obj = { name: 'test', values: [1, 2, 3] };
      await fs.write('config.json', obj);
      const result = await fs.read('config.json', 'json');
      assert.deepEqual(result, obj);
    });
  });

  describe('auto-compress', () => {
    it('text files are compressed', async () => {
      const longText = 'a'.repeat(1000);
      await fs.write('big.txt', longText);
      const entry = window._notebookFS.get('big.txt');
      assert.equal(entry.compressed, true);
    });
  });

  describe('skip compress for PNG', () => {
    it('png type is not compressed', async () => {
      const data = new Uint8Array([137, 80, 78, 71]); // PNG header bytes
      await fs.write('image.png', data);
      const entry = window._notebookFS.get('image.png');
      assert.equal(entry.compressed, false);
    });
  });

  describe('list', () => {
    it('all files', async () => {
      await fs.write('a.txt', 'a');
      await fs.write('b.txt', 'b');
      await fs.write('c.txt', 'c');
      const files = fs.list();
      assert.equal(files.length, 3);
    });

    it('prefix match', async () => {
      await fs.write('data/a.csv', 'a');
      await fs.write('data/b.csv', 'b');
      await fs.write('other/c.csv', 'c');
      const files = fs.list('data/');
      assert.equal(files.length, 2);
      assert.ok(files.every(f => f.path.startsWith('data/')));
    });

    it('glob match', async () => {
      await fs.write('data/a.csv', 'a');
      await fs.write('data/b.json', 'b');
      await fs.write('other/c.csv', 'c');
      const files = fs.list('**/*.csv');
      assert.equal(files.length, 2);
    });
  });

  describe('delete', () => {
    it('single file', async () => {
      await fs.write('file.txt', 'content');
      assert.equal(fs.exists('file.txt'), true);
      await fs.delete('file.txt');
      assert.equal(fs.exists('file.txt'), false);
    });

    it('recursive folder', async () => {
      await fs.write('data/a.csv', 'a');
      await fs.write('data/b.csv', 'b');
      const count = await fs.delete('data', { recursive: true });
      assert.equal(count, 2);
      assert.equal(fs.exists('data/a.csv'), false);
      assert.equal(fs.exists('data/b.csv'), false);
    });

    it('folder without recursive rejects', async () => {
      await fs.write('data/a.csv', 'a');
      await assert.rejects(() => fs.delete('data/'), /recursive/);
    });
  });

  describe('rename', () => {
    it('file rename', async () => {
      await fs.write('old.txt', 'content');
      await fs.rename('old.txt', 'new.txt');
      assert.equal(fs.exists('old.txt'), false);
      assert.equal(fs.exists('new.txt'), true);
      const text = await fs.read('new.txt');
      assert.equal(text, 'content');
    });

    it('folder rename', async () => {
      await fs.write('data/a.csv', 'a');
      await fs.write('data/b.csv', 'b');
      await fs.rename('data', 'archive');
      assert.equal(fs.exists('data/a.csv'), false);
      assert.equal(fs.exists('archive/a.csv'), true);
      assert.equal(fs.exists('archive/b.csv'), true);
    });
  });

  describe('copy', () => {
    it('file copy', async () => {
      await fs.write('src.txt', 'content');
      await fs.copy('src.txt', 'dest.txt');
      assert.equal(fs.exists('src.txt'), true);
      assert.equal(fs.exists('dest.txt'), true);
      const text = await fs.read('dest.txt');
      assert.equal(text, 'content');
    });
  });

  describe('stat', () => {
    it('returns metadata', async () => {
      await fs.write('test.txt', 'hello');
      const s = fs.stat('test.txt');
      assert.equal(s.path, 'test.txt');
      assert.equal(s.type, 'text/plain');
      assert.equal(s.size, 5);
      assert.ok(s.compressedSize > 0);
    });

    it('returns null for missing', () => {
      assert.equal(fs.stat('missing.txt'), null);
    });
  });

  describe('size getter', () => {
    it('sum of all file sizes', async () => {
      await fs.write('a.txt', 'hello'); // 5 bytes
      await fs.write('b.txt', 'world'); // 5 bytes
      assert.equal(fs.size, 10);
    });
  });

  describe('clear', () => {
    it('removes all files', async () => {
      await fs.write('a.txt', 'a');
      await fs.write('b.txt', 'b');
      const count = fs.clear();
      assert.equal(count, 2);
      assert.equal(fs.list().length, 0);
    });
  });

  describe('exists', () => {
    it('true for existing', async () => {
      await fs.write('file.txt', 'x');
      assert.equal(fs.exists('file.txt'), true);
    });
    it('false for missing', () => {
      assert.equal(fs.exists('nope.txt'), false);
    });
  });
});

// Test serialization roundtrip using inline encode/decode (same as save.js)
describe('serialization roundtrip', () => {
  function encodeModules(obj) {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
  }
  function decodeModules(raw) {
    const b64 = raw.replace(/\s/g, '');
    if (b64.startsWith('{') || b64.startsWith('%7B')) return JSON.parse(raw);
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  }

  it('Map data roundtrips through encode/decode', async () => {
    const fs = createNotebookFs();
    window._notebookFS = new Map();
    await fs.write('test.csv', 'x,y\n1,2');
    await fs.write('data.bin', new Uint8Array([1, 2, 3]));

    const obj = Object.fromEntries(window._notebookFS);
    const encoded = encodeModules(obj);
    const decoded = decodeModules(encoded);

    assert.deepEqual(Object.keys(decoded).sort(), ['data.bin', 'test.csv']);
    assert.equal(decoded['test.csv'].type, 'text/csv');
    assert.equal(decoded['data.bin'].type, 'application/octet-stream');
  });
});

// Test std.zip/std.unzip roundtrip
import { zip, unzip } from '../ext/sheet/src/zip.js';

describe('std.zip/unzip', () => {
  it('roundtrip', async () => {
    const entries = new Map();
    entries.set('hello.txt', new TextEncoder().encode('hello world'));
    entries.set('data.bin', new Uint8Array([1, 2, 3, 4, 5]));

    const zipBytes = await zip(entries);
    assert.ok(zipBytes instanceof Uint8Array);
    assert.ok(zipBytes.length > 0);

    const result = await unzip(zipBytes);
    assert.ok(result instanceof Map);
    assert.equal(result.size, 2);

    const hello = new TextDecoder().decode(result.get('hello.txt'));
    assert.equal(hello, 'hello world');

    assert.deepEqual(result.get('data.bin'), new Uint8Array([1, 2, 3, 4, 5]));
  });
});
