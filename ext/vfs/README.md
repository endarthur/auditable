# @gcu/vfs

Virtual filesystem abstraction with pluggable backends. One `VFS` class, many backends: in-memory, File System Access API, OPFS, IndexedDB, HTML-comment embedded (for single-file notebooks), fetch, REST, and overlay. Glob matching, event emitter, permission checks.

Part of [Auditable](https://github.com/endarthur/auditable).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/vfs
```

## Usage

```js
import { VFS, MemoryBackend, path } from '@gcu/vfs';

const vfs = new VFS({ backend: new MemoryBackend() });
await vfs.writeFile('/hello.txt', new TextEncoder().encode('hi'));
const buf = await vfs.readFile('/hello.txt');
```

Sub-path backend imports for finer control: `@gcu/vfs/memory`, `@gcu/vfs/fsaa`, `@gcu/vfs/opfs`, `@gcu/vfs/idb`, `@gcu/vfs/overlay`, `@gcu/vfs/fetch`, `@gcu/vfs/rest`, `@gcu/vfs/comment`.

## License

MIT.
