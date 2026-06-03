// strata standalone host — the host seam, cribbed from src/js/host.js.
//
// host.js (the notebook) isolates the one difference between standalone and
// Works behind two methods (provideVFS + persist) so the core never branches on
// environment. For a file-shaped tool the operations are open() + save(); this
// is the STANDALONE host. The Works host (a later, additive bite) will implement
// the SAME interface over A-Bus — so app.js calls host.open/save and never knows
// which environment it's in. That parity is the @gcu/surface forcing function
// (strata-spec §7).
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
  let handle = null; // FSAA handle of the opened/saved file → enables save-in-place

  return {
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
  };
}
