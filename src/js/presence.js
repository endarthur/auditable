// presence.js — benign collaborative presence, riding @gcu/sync's roomPresence.
//
// "Open to read, gated to act" taken to its limit: there is nothing to gate. Peers
// broadcast only their OWN ephemeral state (a name + which cell they're on); we
// DISPLAY it and never apply it to our notebook or execute anything. The worst a
// malicious peer can do is show a fake ghost in the roster. So the entire hardening
// surface is "sanitize a few display values" (done below), not "sandbox an adversary".
//
// The carrier (Trystero — cross-device, works on file://, ~134 KB) is lazy-imported
// only when the user opts in to collaborating; nothing networks on load. Air-gapped
// collaboration would ship Trystero as a .gcupkg instead (future).

import { roomPresence } from './sync.js';
import * as hooks from './hooks.js';
import { S } from './state.js';

const TRYSTERO_URL = 'https://esm.sh/trystero/nostr';
const APP_ID = 'gentropic-auditable';
const NAME_CAP = 24;

let _pres = null;        // the roomPresence handle while collaborating
let _unsub = null;       // cell:selected subscription

// A stable-per-session display name; the user can override via collaborate(id, name).
function myName(override) {
  if (override) localStorage.setItem('au-collab-name', String(override).slice(0, NAME_CAP));
  let n = localStorage.getItem('au-collab-name');
  if (!n) { n = 'you-' + Math.floor(Math.random() * 1e4).toString().padStart(4, '0'); localStorage.setItem('au-collab-name', n); }
  return n;
}

// Our own broadcast state: name + the INDEX of the cell we're on (shared identity
// across peers viewing the same notebook). No color — receivers derive it locally
// from the peer id, so a peer can't inject styling.
function selfState() {
  const idx = S.cells.findIndex((c) => c.id === S.selectedId);
  return { name: myName(), cell: idx };
}

// Deterministic color from a peer id — local, un-spoofable.
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${((h % 360) + 360) % 360} 70% 55%)`;
}

// ── chip UI (self-contained; lives in the toolbar badges) ──

function chipEl() {
  let el = document.getElementById('presenceChip');
  if (!el) {
    el = document.createElement('span');
    el.id = 'presenceChip';
    el.className = 'presence-chip';
    el.style.cssText = 'cursor:pointer;margin-left:6px;font-size:11px;opacity:.85';
    (document.getElementById('toolbarBadges') || document.body).appendChild(el);
  }
  return el;
}

function renderIdle() {
  const el = chipEl();
  el.textContent = '⚭ collaborate';
  el.title = 'Start a collaboration room (shares presence over the network)';
  el.onclick = () => {
    const id = prompt('Collaboration room id (share it with whoever should join):',
      'au-' + Math.random().toString(36).slice(2, 8));
    if (id) startPresence(id.trim());
  };
}

function renderActive(peers) {
  const el = chipEl();
  const n = peers.size;
  el.textContent = `● ${n + 1} here`;   // +1 = you
  // Roster as a plain-text title — names + cell, both sanitized.
  const lines = [`${myName()} (you)`];
  for (const [id, st] of peers) {
    const name = String(st && st.name || 'anon').slice(0, NAME_CAP);
    const cell = Number.isInteger(st && st.cell) && st.cell >= 0 && st.cell < S.cells.length ? `cell ${st.cell}` : '—';
    lines.push(`${name} · ${cell}`);
    void colorFor(id); // (reserved for in-editor ghost cursors — v2)
  }
  el.title = lines.join('\n') + '\n(click to leave)';
  el.onclick = stopPresence;
}

// ── lifecycle ──

export async function startPresence(roomId, name) {
  if (_pres) stopPresence();
  if (name) myName(name);
  let joinRoom;
  try {
    ({ joinRoom } = await import(/* @vite-ignore */ TRYSTERO_URL));
  } catch (e) {
    const el = chipEl();
    el.textContent = '⚭ offline';
    el.title = 'Could not load the collaboration carrier (needs the network, or a Trystero .gcupkg).';
    setTimeout(renderIdle, 2500);
    return;
  }
  const room = joinRoom({ appId: APP_ID }, String(roomId));
  _pres = roomPresence(room);
  _pres.set(selfState());
  _unsub = hooks.on('cell:selected', () => { if (_pres) _pres.set(selfState()); });
  _pres.onChange((peers) => renderActive(peers));
  renderActive(_pres.peers());
}

export function stopPresence() {
  if (_unsub) { _unsub(); _unsub = null; }
  if (_pres) { _pres.leave(); _pres = null; }
  renderIdle();
}

// Programmatic entry + the discoverable chip.
if (typeof window !== 'undefined') {
  window.auditableCollaborate = startPresence;
  // inject the idle chip once the toolbar exists (deferred past module-eval).
  setTimeout(() => { try { renderIdle(); } catch { /* no toolbar — headless/runtime */ } }, 0);
}
