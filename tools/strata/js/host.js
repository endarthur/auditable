// strata standalone host — the STANDALONE adapter for the strata host interface.
//
// The strata host interface (the small, strata-local proto-@gcu/surface contract):
//   open()              → { name, bytes } | null   — user picks a file
//   save(name, bytes)   → msg | null               — write to the current file
//   saveAs(name, bytes) → msg | null               — pick a destination
//   setDirty(bool)      / .dirty                    — unsaved-edits flag
//   setTitle(name)                                  — environment title (tab/window)
//   onFlush(cb)                                     — register a save-now handler
// bus / fs / theme are capability-OPTIONAL (absent in the standalone adapter;
// the Works adapter fills bus, a future project adapter fills fs). The app core
// (app.js) calls only this interface and never branches on environment — so the
// Works adapter is additive, and "strata + a chart" become the two examples that
// later get extracted into @gcu/surface.
//
// Standalone backing: the File System Access API when available (real
// open-in-place save), else <input type=file> + a download. Not a degraded
// mode — just the standalone backing for the same contract.

const FSAA = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

function download(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function openViaInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.tsv,.txt,.strata';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    };
    input.click();
  });
}

export function createStandaloneHost() {
  let handle = null;      // FSAA handle of the opened/saved file → enables save-in-place
  let flushCb = null;     // the app's save-now handler

  // Warn before navigating away with unsaved edits (the standalone analogue of
  // the Works Flush-before-close barrier).
  window.addEventListener('beforeunload', (e) => {
    if (host.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  const host = {
    name: null,
    dirty: false,

    // Open a file → { name, bytes } | null (user cancelled).
    async open() {
      if (FSAA) {
        let picked;
        try {
          [picked] = await window.showOpenFilePicker({
            types: [{ description: 'Tables', accept: { 'text/csv': ['.csv', '.tsv'], 'application/octet-stream': ['.strata'] } }],
          });
        } catch (e) { if (e.name === 'AbortError') return null; throw e; }
        handle = picked;
        const file = await picked.getFile();
        this.name = file.name;
        return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      }
      const r = await openViaInput();
      if (r) { handle = null; this.name = r.name; }
      return r;
    },

    // Save to the current file if we have a writable handle, else Save As.
    async save(name, bytes) {
      if (handle && FSAA) {
        const w = await handle.createWritable();
        await w.write(bytes); await w.close();
        this.name = name; this.dirty = false;
        return 'saved ' + name;
      }
      return this.saveAs(name, bytes);
    },

    // Pick a destination (FSAA) or download.
    async saveAs(name, bytes) {
      if (FSAA) {
        let h;
        try {
          h = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'strata document', accept: { 'application/octet-stream': ['.strata'] } }],
          });
        } catch (e) { if (e.name === 'AbortError') return null; throw e; }
        const w = await h.createWritable();
        await w.write(bytes); await w.close();
        handle = h; this.name = name; this.dirty = false;
        return 'saved ' + name;
      }
      download(name, bytes);
      this.dirty = false;
      return 'downloaded ' + name;
    },

    setDirty(b) { this.dirty = b; },

    // Environment title — the browser tab/window for the standalone host.
    setTitle(name) { document.title = (name || 'untitled') + ' — strata'; },

    // Register the app's save-now handler. Standalone doesn't auto-flush (the
    // Save button is explicit); the Works adapter wires this to Surface.Flush.
    onFlush(cb) { flushCb = cb; },

    // Invoke the registered flush handler (exposed for symmetry / future use).
    flush() { return flushCb ? flushCb() : undefined; },
  };
  return host;
}
