// ── WORKS SURFACE ADAPTER ──
// When the notebook runs inside Auditable Works it is an iframe surface — an
// A-Bus peer that implements the §5.2 Surface contract. This module is the
// A-Bus side of that: adopting the shell's welcome port, connecting the bus,
// and exposing Surface to the shell. The Works boot proper (VFS, cells) is
// init.js's worksBoot(); this module knows nothing of cells or the DAG.

import { connect } from './abus.js';
import * as hooks from './hooks.js';
import {
  worksBridgeListCells, worksBridgeGetSource, worksBridgeGetOutput, worksBridgeGetDAG,
  worksBridgeSetSource, worksBridgeAddCell, worksBridgeRunCell, worksBridgeDeleteCell,
} from './mcp-adapter.js';

const _title = () => document.getElementById('docTitle')?.value || 'untitled';

// Tree's outline pseudo-folder calls Notebook.JumpToCell(cellId) to focus
// a cell. Two effects: scroll it into view and pulse a brief highlight
// class so the user sees where they landed. Null cellId scrolls to the
// top (used for the docTitle entry).
function jumpToCell(cellId) {
  if (!cellId) {
    document.getElementById('notebook')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  // dataset.id is the stable c-N string after the parseInt fix earlier
  // in this session — no coercion needed.
  const el = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.add('outline-jump');
  setTimeout(() => el.classList.remove('outline-jump'), 1200);
}

/**
 * Connect A-Bus from the shell's abus:welcome. The welcome is captured by the
 * synchronous data-abus-catch script in the page head (it has to be — the
 * shell posts the welcome on the iframe's load event, long before this async
 * module loads); this just consumes the buffered event or registers to be
 * called when it lands.
 *
 * Resolves with { bus, tab } once connected, or null if no welcome arrives
 * within timeoutMs (the notebook is iframed by something that isn't Works —
 * the caller falls back to the standalone boot).
 */
export function connectSurface(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    async function handle(ev) {
      // §7.1 — adopt the welcome only from our own parent.
      if (!ev || ev.source !== window.parent || !ev.data) { finish(null); return; }
      const { port, tab, home } = ev.data;
      try {
        const bus = await connect(port, { client: 'auditable-notebook' });
        finish({ bus, tab, home });
      } catch (e) {
        console.error('[surface] A-Bus connect failed:', e);
        finish(null);
      }
    }

    if (window.__abusWelcome) handle(window.__abusWelcome);
    else window.__abusWelcomeCb = handle;
  });
}

/**
 * Wire the §5.2 Surface contract once the Works boot has completed: expose
 * the methods the shell calls, emit the signals it watches, and run the
 * self-flush cadence. Emits Ready last.
 *
 * @param {object} bus  - the connected A-Bus client.
 * @param {object} host - the Works Host (persist() / relocate()).
 */
export function installSurfaceContract({ bus, host }) {
  const emit = (member, args) =>
    bus.signal({ path: '/', interface: 'Surface', member }, args);

  let dirty = false;
  let flushP = null;
  let flushTimer = null;

  // syncToVfs (inside host.persist) writes notebook.txt into the local copy,
  // which re-pulses notebook:dirty — the flushP guard makes the dirty handler
  // ignore writes the flush itself caused, so this doesn't self-trigger.
  function flush() {
    if (flushP) return flushP;
    clearTimeout(flushTimer);
    flushTimer = null;
    if (window._outputsDebug) console.log('[surface] flush firing');
    flushP = (async () => {
      try {
        await host.persist();
        if (window._outputsDebug) console.log('[surface] flush done');
        if (dirty) { dirty = false; emit('DirtyChanged', [false]); }
      } catch (e) {
        console.error('[surface] flush failed:', e);
      } finally {
        flushP = null;
      }
    })();
    return flushP;
  }

  // Self-flush on a cadence (spec §5.2): edits pulse notebook:dirty; debounce
  // a write-through to the workspace.
  hooks.on('notebook:dirty', () => {
    if (flushP) return;
    if (!dirty) { dirty = true; emit('DirtyChanged', [true]); }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 1500);
  });

  // Tab title tracks the docTitle input.
  document.getElementById('docTitle')
    ?.addEventListener('input', () => emit('TitleChanged', [_title()]));

  bus.expose('/', {
    Surface: {
      methods: {
        Flush:     () => flush(),               // the shell's save-time barrier
        CanClose:  () => true,                  // close flushes first — no veto
        Relocated: (p) => { host.relocate?.(p); },
      },
      signals: ['DirtyChanged', 'TitleChanged', 'Ready'],
    },
    Notebook: {
      methods: {
        // Called by the Works tree when the user clicks an outline entry.
        // headerIdx is currently unused (a cell only scrolls as a unit);
        // it's reserved for future per-header anchor scrolling.
        JumpToCell: (cellId /* , headerIdx */) => jumpToCell(cellId),

        // Document-level cell ops the SHELL drives for the active notebook
        // (the slim cell toolbar keeps the transport; the shell menubar can
        // also reach these). Thin wrappers over the same globals the toolbar
        // buttons / keyboard use, so behaviour is identical to acting in-frame.
        RunAll:         () => { window.runAll?.(); },
        RunSelected:    () => { window.runSelectedCell?.(); },
        ToggleReactive: () => { window.toggleAutorun?.(); },
        ClearOutputs:   () => { window.clearAllOutputs?.(); },

        // The Works agent bridge (numen-for-Works). The shell relays an external
        // agent's notebook ops to these — they reuse the notebook's own %mcp
        // access checks (read-only/private cells stay protected) but skip the
        // per-cell confirm (the shell already obtained a scoped, consented
        // capability). Cells are addressed by 0-based index.
        ListCells:  () => worksBridgeListCells(),
        GetSource:  (index) => worksBridgeGetSource({ index }),
        GetOutput:  (index, opts) => worksBridgeGetOutput({ index, ...(opts || {}) }),
        GetDAG:     () => worksBridgeGetDAG(),
        SetSource:  (index, code, patches) => worksBridgeSetSource(patches ? { index, patches } : { index, code }),
        AddCell:    (type, code, position) => worksBridgeAddCell({ type, code, position }),
        RunCell:    (index) => worksBridgeRunCell({ index }),
        DeleteCell: (index) => worksBridgeDeleteCell({ index }),
      },
      signals: [],
    },
  });

  emit('TitleChanged', [_title()]);
  emit('Ready', []);
}
