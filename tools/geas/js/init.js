// Bootstrap. Wires the four ESM bundles (geas / @gcu/term / @gcu/vfs /
// @gcu/proc) the build embedded as source strings into a running shell:
//
//   - term + vfs + proc are dynamic-imported on the main thread
//   - geas is dynamic-imported on the main thread (for the client API)
//     AND inlined into a proc module-service worker (for the executor side)
//   - the VFS lives on the main thread; the worker reaches it over the
//     RPC proxy that createGeasClient sets up
//   - proc owns the worker's process lifecycle (PID, signals, kill); the
//     geas client talks to it through procToWorker's Worker-shaped adapter
//
// GEAS_BUNDLE_SOURCE / TERM_BUNDLE_SOURCE / VFS_BUNDLE_SOURCE /
// PROC_BUNDLE_SOURCE are injected by build.js (target=geas).

function _setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function _blobUrl(src) {
  return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}

async function boot() {
  try {
    _setStatus('loading…');
    // @gcu/term measures cell metrics from the live font — wait for it
    // so the grid isn't sized against the fallback face.
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    // Dynamic-import the four bundles off blob URLs.
    const termMod = await import(_blobUrl(TERM_BUNDLE_SOURCE));
    const vfsMod  = await import(_blobUrl(VFS_BUNDLE_SOURCE));
    const procMod = await import(_blobUrl(PROC_BUNDLE_SOURCE));
    const geas    = await import(_blobUrl(GEAS_BUNDLE_SOURCE));

    // The worker module: the geas bundle inlined verbatim, then a default
    // export that runs setupGeasWorker over a proc-ctx-derived target. No
    // cross-blob import — the worker is fully self-contained.
    _setStatus('spawning worker…');
    const workerSource =
      GEAS_BUNDLE_SOURCE +
      '\nexport default geasProcEntry({ createShell, isTyped, setupGeasWorker });\n';
    const workerUrl = _blobUrl(workerSource);

    const pm = new procMod.ProcessManager();
    const proc = await pm.spawn({ module: workerUrl, mode: 'service' });
    const worker = geas.procToWorker(proc);

    // Filesystem (IndexedDB), seeded on first run.
    _setStatus('mounting filesystem…');
    const vfs = await setupVfs(vfsMod);

    // Terminal grid.
    const terminal = setupTerminal(termMod);

    // geas client — bridges the worker to the terminal. The line editor
    // wired as onWantInput handles the interactive `read` builtin;
    // the REPL builds its own editor instance for command lines.
    _setStatus('starting shell…');
    const adapter = geas.createTermAdapter({ terminal });
    const writeOut = (t) => terminal.write(String(t).replace(/\r?\n/g, '\r\n'));
    const client = geas.createGeasClient({
      worker,
      vfs,
      env: { HOME: '/home', PWD: '/home', USER: 'guest', TERM: 'geas' },
      cwd: '/home',
      onStdout: writeOut,
      onStderr: (t) => terminal.write('\x1b[2m' + String(t).replace(/\r?\n/g, '\r\n') + '\x1b[0m'),
      onBlock:  (b) => writeOut(b && b.text ? b.text : ''),
      onWantInput: geas.makeLineEditor(adapter),
    });
    GS.client = client;
    GS.proc = proc;
    GS.pm = pm;
    await client.ready();

    _setStatus('ready');
    startRepl(geas, client, adapter, terminal);
  } catch (err) {
    _setStatus('error');
    const screen = document.getElementById('screen');
    if (screen) {
      screen.textContent = 'geas failed to start:\n\n' + (err && err.stack || String(err));
    }
    // eslint-disable-next-line no-console
    console.error('geas boot failed:', err);
  }
}

// Register the service worker (offline support) — best-effort.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* ignore */ });
  });
}

boot();
