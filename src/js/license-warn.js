// Saved-notebook copyleft warning banner. Runs once after _installedModules
// hydrates on notebook load. If any installed module carries a copyleft
// SPDX (weak or strong) the user gets a dismissible banner explaining the
// redistribution obligations they're inheriting; permissive + unknown
// licenses pass silently (the Licenses settings tab is the place for full
// inventory). One element on document.body; idempotent — repeat calls
// reuse the same node.

import { aggregateFromInstalledModules } from '#licenses';

const COPYLEFT = new Set(['weak-copyleft', 'strong-copyleft']);

export function checkAndWarnCopyleft() {
  const mods = window._installedModules;
  if (!mods || Object.keys(mods).length === 0) return;

  let table;
  try { table = aggregateFromInstalledModules(mods); }
  catch (e) { console.warn('[licenses] aggregation failed:', e); return; }

  const hits = (table || []).filter((row) => COPYLEFT.has(row.classification));
  if (hits.length === 0) return;

  // Console line is permanent — devtools history outlives the banner dismiss.
  const lines = hits.map((r) => `  ${r.pkg}${r.version ? '@' + r.version : ''} — ${r.spdx} (${r.classification})`);
  console.warn(
    `[licenses] ${hits.length} copyleft-licensed component(s) bundled in this notebook:\n`
    + lines.join('\n')
    + '\n  Redistributing this HTML carries the source-availability + attribution obligations of these licenses.'
    + '\n  See Settings → Licenses for the full inventory.'
  );

  _showBanner(hits);
}

function _showBanner(hits) {
  // Re-entrancy guard — if we already painted, leave the existing node alone.
  if (document.getElementById('copyleftBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'copyleftBanner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const strong = hits.filter((h) => h.classification === 'strong-copyleft').length;
  const weak = hits.length - strong;
  const parts = [];
  if (strong) parts.push(`${strong} strong-copyleft`);
  if (weak) parts.push(`${weak} weak-copyleft`);
  const summary = parts.join(' + ');

  const msg = document.createElement('span');
  msg.className = 'cb-msg';
  msg.textContent = `${summary} component${hits.length === 1 ? '' : 's'} bundled — see console / Settings → Licenses.`;
  banner.appendChild(msg);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'cb-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.onclick = () => banner.remove();
  banner.appendChild(dismiss);

  document.body.appendChild(banner);
}
