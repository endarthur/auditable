// Lazy interpreter initialization, stdout buffering, WASM resolution

import { BRIDGE_PY } from './bridge.js';

let _mp = null;
let _initPromise = null;
let _stdoutBuffer = [];
let _stderrBuffer = [];

export async function initInterpreter() {
  if (_mp) return _mp;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // resolve micropython.mjs source
    let loadMicroPython;
    if (window._installedModules?.['@gcu/adder/micropython.mjs']) {
      const entry = window._installedModules['@gcu/adder/micropython.mjs'];
      const src = typeof entry === 'string' ? entry : entry.source;
      const blob = new Blob([src], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      loadMicroPython = mod.loadMicroPython;
    } else {
      // dev-mode: relative import
      const mod = await import('./micropython.mjs');
      loadMicroPython = mod.loadMicroPython;
    }

    // resolve WASM URL
    let wasmUrl;
    if (window._installedModules?.['@gcu/adder/micropython.wasm']) {
      const entry = window._installedModules['@gcu/adder/micropython.wasm'];
      const type = entry.type || 'application/wasm';
      const bytes = Uint8Array.from(atob(entry.source), c => c.charCodeAt(0));
      if (entry.compressed) {
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
        wasmUrl = URL.createObjectURL(new Blob([decompressed], { type }));
      } else {
        wasmUrl = URL.createObjectURL(new Blob([bytes], { type }));
      }
    }

    const opts = {
      stdout: (text) => _stdoutBuffer.push(text),
      stderr: (text) => _stderrBuffer.push(text),
    };
    if (wasmUrl) opts.url = wasmUrl;

    _mp = await loadMicroPython(opts);

    // register Auditable extensions as importable JS modules
    const exts = window._auditableExtensions;
    if (exts) {
      for (const name of Object.keys(exts)) {
        _mp.registerJsModule(name, exts[name]);
      }
    }

    // bootstrap _exec_cell helper
    _mp.runPython(BRIDGE_PY);

    return _mp;
  })();

  return _initPromise;
}

export function flushStdout() {
  const lines = _stdoutBuffer;
  _stdoutBuffer = [];
  return lines;
}

export function flushStderr() {
  const lines = _stderrBuffer;
  _stderrBuffer = [];
  return lines;
}

export function getInterpreter() { return _mp; }
