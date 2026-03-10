// Bootstrap — init IIFE, file loading, boot sequence

;(function init() {
  const RAM_SIZE = 64 * 1024 * 1024; // 64 MB
  const RAM_BASE = 0x80000000;
  const REG_PAGES = 1; // 1 extra page for register file
  const STATE_SIZE = 192; // sizeof(MiniRV32IMAState): (32 + 16) * 4

  const termEl = $('#rv-terminal');
  const statusEl = $('#rv-status');
  const mipsEl = $('#rv-mips');
  const msgEl = $('#rv-statusbar-msg');
  const pcEl = $('#rv-statusbar-pc');
  const fileInput = $('#rv-file-input');
  const stopBtn = $('#rv-stop');

  function setMsg(text) { if (msgEl) msgEl.textContent = text; }
  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  stopBtn.addEventListener('click', () => {
    if (RV.host) { RV.host.stop(); setStatus('stopped'); setMsg('Stopped by user'); stopBtn.hidden = true; }
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
      await boot(buffer);
    } catch (e) {
      setStatus('error');
      setMsg('Boot failed: ' + e.message);
      console.error(e);
    }
  });

  async function boot(imageBuffer) {
    // 1. Create Wasm memory (64 MB RAM + register page)
    const totalPages = (RAM_SIZE / 65536) + REG_PAGES;
    RV.memory = new WebAssembly.Memory({ initial: totalPages, maximum: totalPages });

    // 2. Create console + UART
    RV.console = createConsole(termEl);
    RV.console.init();
    RV.uart = createUart(RV.console.onTx);

    // 3. Instantiate CPU
    setMsg('Compiling CPU...');
    const cpuMod = instantiate({
      memory: RV.memory,
      mmio_read: (addr) => RV.host.mmio_read(addr),
      mmio_write: (addr, val) => RV.host.mmio_write(addr, val),
    });
    RV.cpu = cpuMod;

    // 4. Create host (MMIO router, run loop)
    RV.host = createHost(RV.cpu, RV.memory, RV.uart, {
      onHalt(reason) {
        setStatus('halted (' + reason + ')');
        setMsg('System halted');
      },
      onStatus(mips) {
        mipsEl.textContent = mips + ' MIPS';
      }
    });

    // Wire UART RX from console input
    const origRead = RV.uart.read.bind(RV.uart);
    RV.uart.read = function(offset) {
      // Feed keyboard input into UART RX queue before read
      while (RV.console.inputQueue.length > 0) {
        RV.uart.pushRx(RV.console.inputQueue.shift());
      }
      return origRead(offset);
    };

    // 5. Load image into RAM
    setMsg('Loading image...');
    const mem8 = new Uint8Array(RV.memory.buffer);
    let entry;

    // Check if ELF
    const magic = new DataView(imageBuffer).getUint32(0, false);
    if (magic === 0x7f454c46) {
      entry = loadElf(imageBuffer, mem8);
    } else {
      // Raw binary — load at RAM base
      mem8.set(new Uint8Array(imageBuffer), 0);
      entry = RAM_BASE;
    }

    // 6. Generate DTB and write to RAM
    setMsg('Generating DTB...');
    // Two-pass: estimate DTB size, then place it like Lohr (RAM - DTB - STATE)
    const dtbEst = buildDtb({
      ramBase: RAM_BASE,
      ramSize: RAM_SIZE - 1024 - STATE_SIZE, // placeholder
      bootArgs: 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0'
    });
    const dtb_ptr = RAM_SIZE - dtbEst.length - STATE_SIZE;
    const dtb = buildDtb({
      ramBase: RAM_BASE,
      ramSize: dtb_ptr,
      bootArgs: 'earlycon=uart8250,mmio,0x10000000,1000000 console=ttyS0'
    });
    mem8.set(dtb, dtb_ptr);

    // 7. Set initial CPU state
    RV.cpu.set_ram_size(RAM_SIZE);
    RV.cpu.set_pc(entry);
    const regs = new Int32Array(RV.memory.buffer, RAM_SIZE, 32);
    regs[10] = 0;                       // a0 = hart ID
    regs[11] = RAM_BASE + dtb_ptr;      // a1 = DTB address (guest)
    RV.cpu.set_extraflags(3);           // M-mode

    // 8. Start
    setStatus('running');
    setMsg('');
    stopBtn.hidden = false;
    RV.console.clear();
    RV.host.start();
    RV.console.term.focus();
  }
})();
