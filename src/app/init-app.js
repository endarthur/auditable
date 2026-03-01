import { S } from '../js/state.js';
import { loadFromEmbed } from './save-app.js';

// ── INIT (app runtime) ──

(function init() {
  loadFromEmbed();
  S.initialized = true;
})();
