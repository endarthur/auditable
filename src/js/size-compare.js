import { $ } from './state.js';
import { updateStatus } from './ui.js';

// ── SIZE COMPARISON ── @optional

const SIZE_MEDIA = [
  [4096, 'an Atari 2600 cartridge'],
  [49152, 'a ZX Spectrum tape'],
  [73728, 'Apollo AGC rope memory'],
  [81920, 'an 8\u2033 floppy (SS/SD)'],
  [262144, 'an NES cartridge'],
  [368640, 'a 5.25\u2033 floppy (DS/DD)'],
  [737280, 'a 3.5\u2033 floppy (DS/DD)'],
  [1228800, 'a 5.25\u2033 floppy (DS/HD)'],
  [1474560, 'a 3.5\u2033 floppy (DS/HD)'],
];

function sizeCompare(bytes) {
  if (!window._sizeCompare) return '';
  for (const [size, name] of SIZE_MEDIA) {
    if (bytes <= size) return 'fits on ' + name;
  }
  const n = Math.ceil(bytes / 1474560);
  return n + '\u00d7 3.5\u2033 floppies';
}

function applySizeCompare(val) {
  const on = val === true || val === 'true' || val === 'on';
  window._sizeCompare = on;
  const el = $('#setSizeCompare');
  if (el) el.value = on ? 'on' : 'off';
  updateStatus();
}

function applySizeCompareRef(val) {
  window._sizeCompareRef = val === 'content' ? 'content' : 'total';
  const el = $('#setSizeCompareRef');
  if (el) el.value = window._sizeCompareRef;
  updateStatus();
}

// inject settings rows before modules section
(function() {
  const panel = $('#settingsPanel');
  if (!panel) return;
  const headings = panel.querySelectorAll('h2');
  const modulesH2 = headings[headings.length - 1];
  if (!modulesH2) return;

  const refRow = document.createElement('div');
  refRow.className = 'settings-row';
  refRow.innerHTML = '<label>size reference</label>' +
    '<select id="setSizeCompareRef" onchange="applySizeCompareRef(this.value)">' +
    '<option value="total" selected>total file</option>' +
    '<option value="content">content only</option></select>';
  modulesH2.before(refRow);

  const row = document.createElement('div');
  row.className = 'settings-row';
  row.innerHTML = '<label>size comparison</label>' +
    '<select id="setSizeCompare" onchange="applySizeCompare(this.value)">' +
    '<option value="off">off</option><option value="on" selected>on</option></select>';
  modulesH2.before(row);

  window._sizeCompare = true;
  window._sizeCompareRef = 'total';
})();
