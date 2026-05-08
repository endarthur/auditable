// @gcu/sideact — concat build manifest + Auditable cell-hook registration.
// Import order below doubles as concat order for build.js.

import './signals.js';
import './dom.js';
import './render.js';

import { signal } from './signals.js';

// ── notebook integration hook ──
// Self-registers sr.state() when running inside Auditable cells.
// sr.state(initial) persists signals across cell re-executions.
// Pure sideact (signal/computed/effect/h/each/render) is unaffected.

if (typeof window !== 'undefined') {
  const _srHook = {
    setup(cell, ctx) {
      if (!ctx.sr) return;
      if (!cell._srState) cell._srState = [];
      // reset persisted state when cell code changes
      if (cell._srStateCode !== cell.code) {
        cell._srState = [];
        cell._srStateCode = cell.code;
      }
      let hookIdx = 0;
      ctx.sr.state = function state(initial) {
        const idx = hookIdx++;
        if (idx < cell._srState.length) return cell._srState[idx];
        const s = signal(initial);
        cell._srState[idx] = s;
        return s;
      };
    },
  };

  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/sideact',
      version: '0.1.0',
      description: 'Signals + DOM binding — sr.state() persistence across cell re-executions',
      contextHook: _srHook,
    });
  } else {
    (window._cellContextHooks = window._cellContextHooks || []).push(_srHook);
  }
}
