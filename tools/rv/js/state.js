// Global state for rv emulator

const $ = (s, p) => (p || document).querySelector(s);

const RV = {
  cpu: null,
  memory: null,
  host: null,
  uart: null,
  console: null,
  running: false,
  halted: false,
};
