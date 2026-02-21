import { loadFromEmbed } from './save.js';
import { addCell } from './cell-ops.js';

// ── INIT ──

(function init() {
  if (!loadFromEmbed()) {
    addCell('md', '');
    addCell('code', '');
  }
})();
