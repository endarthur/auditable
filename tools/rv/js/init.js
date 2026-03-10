// Bootstrap — init IIFE, file loading, boot via Web Worker

;(function init() {
  const termEl = $('#rv-terminal');
  const statusEl = $('#rv-status');
  const mipsEl = $('#rv-mips');
  const msgEl = $('#rv-statusbar-msg');
  const pcEl = $('#rv-statusbar-pc');
  const fileInput = $('#rv-file-input');
  const stopBtn = $('#rv-stop');

  function setMsg(text) { if (msgEl) msgEl.textContent = text; }
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  RV.console = createConsole(termEl);

  stopBtn.addEventListener('click', () => {
    if (RV.worker) { RV.worker.postMessage({ type: 'stop' }); setStatus('stopped'); setMsg('Stopped by user'); stopBtn.hidden = true; }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    setStatus('loading...');
    setMsg('Loading ' + file.name);

    let buffer = await file.arrayBuffer();

    // Auto-decompress gzip
    if (new Uint8Array(buffer, 0, 2)[0] === 0x1f && new Uint8Array(buffer, 0, 2)[1] === 0x8b) {
      setMsg('Decompressing...');
      const ds = new DecompressionStream('gzip');
      const blob = new Blob([buffer]);
      const stream = blob.stream().pipeThrough(ds);
      buffer = await new Response(stream).arrayBuffer();
    }

    try {
      boot(buffer);
    } catch (e) {
      setStatus('error');
      setMsg('Boot failed: ' + e.message);
      console.error(e);
    }
  });

  function boot(imageBuffer) {
    // Init terminal
    RV.console.init();
    RV.console.clear();

    // Create worker (blob URL from inline source)
    if (RV.worker) { RV.worker.terminate(); }
    const workerSrc = document.getElementById('rv-worker-src').textContent;
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    RV.worker = worker;

    worker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'tx') {
        RV.console.term.write(msg.chars);
      } else if (msg.type === 'status') {
        mipsEl.textContent = msg.mips + ' MIPS';
      } else if (msg.type === 'halt') {
        setStatus('halted (' + msg.reason + ')');
        setMsg('System halted');
        stopBtn.hidden = true;
      } else if (msg.type === 'booted') {
        setStatus('running');
        setMsg('');
        stopBtn.hidden = false;
        RV.console.term.focus();
      }
    };

    // Forward keyboard input to worker (send all bytes at once for escape sequences)
    RV.console.term.onData(data => {
      const bytes = [];
      for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
      worker.postMessage({ type: 'keys', bytes });
    });
    RV.console.term.onBinary(data => {
      const bytes = [];
      for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
      worker.postMessage({ type: 'keys', bytes });
    });

    // Send image to worker (transfer ownership for zero-copy)
    setMsg('Booting...');
    worker.postMessage({ type: 'boot', image: imageBuffer }, [imageBuffer]);
  }
})();
