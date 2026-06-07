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

let _roomId = null;
let _panelOpen = false;

// The chip just reflects state and toggles the panel — clicking it never networks.
function refreshChip() {
  const el = chipEl();
  el.textContent = _pres ? `● ${_pres.peers().size + 1} here` : '⚭ collaborate';
  el.title = _pres ? 'Collaboration active — click for the panel'
    : 'Collaborate — opens a panel; nothing connects until you press Start';
  el.onclick = togglePanel;
}

// ── panel: the setup + roster UI. Opening it does NOT touch the network; only
//    "Start collaborating" loads the carrier and joins. ──

function panelEl() {
  let el = document.getElementById('presencePanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'presencePanel';
    el.style.cssText = 'position:fixed;top:44px;right:10px;z-index:9999;display:none;min-width:240px;max-width:300px;'
      + 'background:var(--au-bg-raised,#1b1f26);color:var(--au-fg,#e6e6e6);border:1px solid var(--au-border,#333);'
      + 'border-radius:8px;padding:12px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.4)';
    document.body.appendChild(el);
  }
  return el;
}

function togglePanel() { _panelOpen = !_panelOpen; renderPanel(); }

function renderPanel() {
  const el = panelEl();
  el.style.display = _panelOpen ? 'block' : 'none';
  if (!_panelOpen) return;
  el.textContent = '';
  (_pres ? renderActivePanel : renderIdlePanel)(el);
}

function field(label, value) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:block;margin:6px 0';
  wrap.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.style.cssText = 'width:100%;margin-top:2px;box-sizing:border-box;background:var(--au-bg,#11141a);color:inherit;border:1px solid var(--au-border,#333);border-radius:4px;padding:4px 6px;font:inherit';
  wrap.appendChild(input);
  return { wrap, input };
}

function btn(label, primary) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin-top:8px;padding:5px 10px;font:inherit;cursor:pointer;border:1px solid var(--au-border,#444);border-radius:4px;'
    + (primary ? 'background:var(--au-accent,#c66a2e);color:#fff' : 'background:transparent;color:inherit');
  return b;
}

function renderIdlePanel(el) {
  const title = document.createElement('div');
  title.textContent = 'Collaborate';
  title.style.cssText = 'font-weight:600;margin-bottom:4px';
  el.appendChild(title);

  const name = field('Your name', myName());
  const room = field('Room id (share with collaborators)', 'au-' + Math.random().toString(36).slice(2, 8));
  el.append(name.wrap, room.wrap);

  const hint = document.createElement('p');
  hint.textContent = 'Start connects to peers over the network (Trystero, loaded on demand). The room id is the shared secret — anyone with it can join and see presence.';
  hint.style.cssText = 'margin:6px 0;opacity:.7;line-height:1.4';
  el.appendChild(hint);

  const start = btn('Start collaborating', true);
  start.onclick = async () => {
    const r = room.input.value.trim();
    if (!r) { room.input.focus(); return; }
    myName(name.input.value);
    start.disabled = true; start.textContent = 'Connecting…';
    await startPresence(r);
  };
  el.appendChild(start);
}

function renderActivePanel(el) {
  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;margin-bottom:6px';
  head.textContent = '● Connected';
  el.appendChild(head);

  const roomRow = document.createElement('div');
  roomRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:8px';
  const code = document.createElement('code');
  code.textContent = _roomId || '';
  code.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;background:var(--au-bg,#11141a);padding:3px 6px;border-radius:4px';
  const copy = btn('copy'); copy.style.marginTop = '0'; copy.style.padding = '3px 8px';
  copy.onclick = () => { try { navigator.clipboard.writeText(_roomId || ''); copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy'; }, 1200); } catch { /* no clipboard */ } };
  roomRow.append(code, copy);
  el.appendChild(roomRow);

  // Roster. Peer data is untrusted → textContent only, name capped, cell clamped,
  // color derived locally from the peer id (un-spoofable).
  const you = document.createElement('div');
  you.textContent = `● ${myName()} (you)`;
  you.style.cssText = 'margin:2px 0';
  el.appendChild(you);
  for (const [id, st] of _pres.peers()) {
    const row = document.createElement('div');
    row.style.cssText = 'margin:2px 0;display:flex;gap:6px;align-items:center';
    const dot = document.createElement('span'); dot.textContent = '●'; dot.style.color = colorFor(id);
    const nm = String((st && st.name) || 'anon').slice(0, NAME_CAP);
    const cell = Number.isInteger(st && st.cell) && st.cell >= 0 && st.cell < S.cells.length ? `cell ${st.cell}` : '—';
    const label = document.createElement('span'); label.textContent = `${nm} · ${cell}`;
    row.append(dot, label);
    el.appendChild(row);
  }

  const leave = btn('Leave');
  leave.onclick = stopPresence;
  el.appendChild(leave);
}

// ── lifecycle ──

export async function startPresence(roomId, name) {
  if (_pres) stopPresence();
  if (name) myName(name);
  _roomId = String(roomId);
  let joinRoom;
  try {
    ({ joinRoom } = await import(/* @vite-ignore */ TRYSTERO_URL));
  } catch (e) {
    _roomId = null;
    const el = panelEl();
    el.textContent = 'Could not load the collaboration carrier — needs the network (or a Trystero .gcupkg).';
    return;
  }
  const room = joinRoom({ appId: APP_ID }, _roomId);
  _pres = roomPresence(room);
  _pres.set(selfState());
  _unsub = hooks.on('cell:selected', () => { if (_pres) _pres.set(selfState()); });
  _pres.onChange(() => { refreshChip(); if (_panelOpen) renderPanel(); });
  _panelOpen = true;
  refreshChip(); renderPanel();
}

export function stopPresence() {
  if (_unsub) { _unsub(); _unsub = null; }
  if (_pres) { _pres.leave(); _pres = null; }
  _roomId = null;
  refreshChip(); renderPanel();
}

// Programmatic entry + the discoverable chip.
if (typeof window !== 'undefined') {
  window.auditableCollaborate = startPresence;
  // show the idle chip once the toolbar exists (deferred past module-eval).
  setTimeout(() => { try { refreshChip(); } catch { /* no toolbar — headless/runtime */ } }, 0);
}
