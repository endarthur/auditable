// @gcu/patchbay — built-in module stdlib. Registered at import (idempotent).
//
// "Punk SCADA": the modules wear the Eurorack panel aesthetic (rack, HP, jacks,
// knobs) but the kit is industrial process-control — setpoints, gains, gauges,
// alarms, PID loops, field tags — not synth voices. Type ids are stable
// (persisted identity); titles/colors are cosmetic and free to evolve.
//
// Three execution shapes:
//   • pure `process(inp, knobs, state)` — reactive value compute (math, logic,
//     clamp, hysteresis alarm). Runs whenever a read input/knob changes.
//   • `setup(ctx, inst) → teardown` with a clock — time-aware blocks (signal
//     gen, PID, timer) drive their outputs from a setInterval/effect.
//   • I/O `setup` — bridge to A-Bus tags + the VFS (field I/O, file, historian).

import { defineModule } from './sdk.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const truthy = (v) => (v || 0) > 0.5;

// topic string "Interface.Member" → { iface, member }
function parseTopic(s) {
  const m = String(s || '').split(/[.\/]/);
  return { iface: m[0] || '', member: m[1] || 'Value' };
}

export const STDLIB_MODULES = [
  { type: 'src.const',   label: 'Setpoint', category: 'source' },
  { type: 'src.lfo',     label: 'Signal',   category: 'source' },
  { type: 'math.add',    label: 'Sum',      category: 'math' },
  { type: 'math.mul',    label: 'Product',  category: 'math' },
  { type: 'math.scale',  label: 'Gain',     category: 'math' },
  { type: 'math.limit',  label: 'Limit',    category: 'math' },
  { type: 'logic.compare', label: 'Compare', category: 'logic' },
  { type: 'logic.and',   label: 'And',      category: 'logic' },
  { type: 'logic.or',    label: 'Or',       category: 'logic' },
  { type: 'logic.not',   label: 'Not',      category: 'logic' },
  { type: 'logic.xor',   label: 'Xor',      category: 'logic' },
  { type: 'ctrl.alarm',  label: 'Alarm',    category: 'control' },
  { type: 'ctrl.pid',    label: 'PID',      category: 'control' },
  { type: 'ctrl.timer',  label: 'Timer',    category: 'control' },
  { type: 'disp.number', label: 'Readout',  category: 'display' },
  { type: 'disp.scope',  label: 'Trend',    category: 'display' },
  { type: 'disp.gauge',  label: 'Gauge',    category: 'display' },
  { type: 'io.abus-in',  label: 'Tag In',   category: 'io' },
  { type: 'io.abus-out', label: 'Tag Out',  category: 'io' },
  { type: 'io.vfs-read', label: 'File',     category: 'io' },
  { type: 'io.vfs-write', label: 'Log',     category: 'io' },
];

let _registered = false;

export function registerStdlib() {
  if (_registered) return STDLIB_MODULES;
  _registered = true;

  // ── sources ──────────────────────────────────────────────────────────
  defineModule({
    type: 'src.const', title: 'SETPT', subtitle: 'sp · target', hp: 8, color: 'indigo',
    knobs: { value: { label: 'SP', default: 0.5, min: 0, max: 1 } },
    ports: { out: { v: { type: 'number', cable: 'trs' } } },
    process: (_i, k) => ({ v: k.value }),
    display: (pb, out) => pb.numeric(out.v, { digits: 4, decimals: 2 }),
  });

  defineModule({
    type: 'src.lfo', title: 'SIGNAL', subtitle: 'function gen', hp: 10, color: 'teal',
    knobs: { rate: { label: 'RATE', default: 0.3, min: 0, max: 1 } },
    ports: { out: { sin: { type: 'number', cable: 'banana' }, tri: { type: 'number', cable: 'banana' } } },
    setup(ctx, inst) {
      const t0 = now();
      const id = setInterval(() => {
        const rate = inst.knobs.rate.read();           // 0..1 → ~0.1..4 Hz
        const ph = ((now() - t0) / 1000) * (0.1 + rate * 4) * Math.PI * 2;
        inst.outputs.sin.write((Math.sin(ph) + 1) / 2);
        inst.outputs.tri.write(Math.abs(((ph / Math.PI) % 2) - 1));
      }, 33);
      return () => clearInterval(id);
    },
    display: (pb, out, st) => {
      st.buf = st.buf || [];
      st.buf.push(out.sin); if (st.buf.length > 64) st.buf.shift();
      pb.scope(st.buf, { min: 0, max: 1 });
    },
  });

  // ── math / signal conditioning ────────────────────────────────────────
  defineModule({
    type: 'math.add', title: 'SUM', subtitle: 'a + b', hp: 8, color: 'teal',
    ports: { in: { a: 'number', b: 'number' }, out: { sum: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ sum: (i.a || 0) + (i.b || 0) }),
    display: (pb, out) => pb.numeric(out.sum, { digits: 5, decimals: 2 }),
  });
  defineModule({
    type: 'math.mul', title: 'MULT', subtitle: 'a × b', hp: 8, color: 'teal',
    ports: { in: { a: 'number', b: 'number' }, out: { product: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ product: (i.a || 0) * (i.b || 0) }),
    display: (pb, out) => pb.numeric(out.product, { digits: 5, decimals: 2 }),
  });
  defineModule({
    type: 'math.scale', title: 'GAIN', subtitle: 'K · x', hp: 8, color: 'amber',
    knobs: { gain: { label: 'K', default: 1, min: 0, max: 4 } },
    ports: { in: { x: 'number' }, out: { y: { type: 'number', cable: 'trs' } } },
    process: (i, k) => ({ y: (i.x || 0) * k.gain }),
    display: (pb, out) => pb.bargraph(out.y, { steps: 10, min: 0, max: 4 }),
  });
  defineModule({
    type: 'math.limit', title: 'LIMIT', subtitle: 'clamp', hp: 8, color: 'amber',
    knobs: { lo: { label: 'LO', default: 0, min: 0, max: 1 }, hi: { label: 'HI', default: 1, min: 0, max: 1 } },
    ports: { in: { x: 'number' }, out: { y: { type: 'number', cable: 'trs' } } },
    process: (i, k, st) => {
      const lo = Math.min(k.lo, k.hi), hi = Math.max(k.lo, k.hi);
      const y = Math.max(lo, Math.min(hi, i.x || 0));
      st.clipped = (i.x || 0) < lo || (i.x || 0) > hi;
      return { y };
    },
    display: (pb, out, st) => pb.led(st.clipped ? 1 : 0, { label: 'CLIP', color: st.clipped ? 'amber' : 'textSoft' }),
  });

  // ── logic ────────────────────────────────────────────────────────────
  defineModule({
    type: 'logic.compare', title: 'COMP', subtitle: 'a ≷ b', hp: 8, color: 'green',
    ports: { in: { a: 'number', b: 'number' }, out: { gt: { type: 'number', cable: 'coax' } } },
    process: (i, _k, st) => { const gt = (i.a || 0) > (i.b || 0); st.gt = gt; return { gt: gt ? 1 : 0 }; },
    display: (pb, out) => pb.led(out.gt, { label: 'A>B', color: 'green' }),
  });
  const gate = (type, title, sub, fn, unary) => defineModule({
    type, title, subtitle: sub, hp: 6, color: 'green',
    ports: { in: unary ? { a: 'number' } : { a: 'number', b: 'number' }, out: { q: { type: 'number', cable: 'coax' } } },
    process: (i) => ({ q: fn(truthy(i.a), truthy(i.b)) ? 1 : 0 }),
    display: (pb, out) => pb.led(out.q, { label: 'Q', color: 'green' }),
  });
  gate('logic.and', 'AND', '∧', (a, b) => a && b);
  gate('logic.or',  'OR',  '∨', (a, b) => a || b);
  gate('logic.not', 'NOT', '¬', (a) => !a, true);
  gate('logic.xor', 'XOR', '⊕', (a, b) => a !== b);

  // ── control ──────────────────────────────────────────────────────────
  // Alarm: edge-armed threshold with hysteresis (a Schmitt trigger). Trips
  // when x ≥ level, re-arms when x < level − hyst. Pure/reactive: state holds
  // the armed flag + last input for the lamp.
  defineModule({
    type: 'ctrl.alarm', title: 'ALARM', subtitle: 'threshold', hp: 10, color: 'red',
    knobs: { level: { label: 'SET', default: 0.7, min: 0, max: 1 }, hyst: { label: 'HYST', default: 0.05, min: 0, max: 0.5 } },
    ports: { in: { x: 'number' }, out: { trip: { type: 'number', cable: 'coax' } } },
    process: (i, k, st) => {
      const x = i.x || 0;
      let armed = !!st.armed;
      if (!armed && x >= k.level) armed = true;
      else if (armed && x < k.level - k.hyst) armed = false;
      st.armed = armed; st.x = x; st.level = k.level;
      return { trip: armed ? 1 : 0 };
    },
    display: (pb, out, st) => {
      pb.led(out.trip, { label: 'TRIP', color: out.trip ? 'red' : 'textSoft' });
      pb.bargraph(st.x || 0, { steps: 10, min: 0, max: 1 });
    },
  });

  // PID: clocked controller. cv = Kp·e + Ki·∫e + Kd·de/dt, clamped 0..1 with
  // integral anti-windup. Setup-interval (50 ms) so the integral/derivative
  // see real dt; reads pv/sp inputs + gain knobs each tick.
  defineModule({
    type: 'ctrl.pid', title: 'PID', subtitle: 'controller', hp: 12, color: 'orange',
    knobs: {
      kp: { label: 'Kp', default: 1, min: 0, max: 4 },
      ki: { label: 'Ki', default: 0.3, min: 0, max: 2 },
      kd: { label: 'Kd', default: 0, min: 0, max: 2 },
    },
    ports: { in: { pv: 'number', sp: 'number' }, out: { cv: { type: 'number', cable: 'trs' } } },
    setup(ctx, inst) {
      let integ = 0, lastErr = 0, lastT = now();
      inst.state.cv = 0; inst.state.err = 0;
      const id = setInterval(() => {
        const pv = inst.inputs.pv.value() || 0, sp = inst.inputs.sp.value() || 0;
        const t = now(), dt = Math.max(0.001, (t - lastT) / 1000); lastT = t;
        const err = sp - pv;
        integ = Math.max(-10, Math.min(10, integ + err * dt));   // anti-windup
        const deriv = (err - lastErr) / dt; lastErr = err;
        const kp = inst.knobs.kp.read(), ki = inst.knobs.ki.read(), kd = inst.knobs.kd.read();
        const cv = Math.max(0, Math.min(1, kp * err + ki * integ + kd * deriv));
        inst.state.cv = cv; inst.state.err = err;
        inst.outputs.cv.write(cv);
      }, 50);
      return () => clearInterval(id);
    },
    display: (pb, out, st) => {
      pb.numeric(st.cv || 0, { digits: 4, decimals: 2 });
      pb.bargraph(st.cv || 0, { steps: 10, min: 0, max: 1 });
    },
  });

  // Timer: TON (on-delay) / TOF (off-delay), PLC-style. Output q follows trig
  // through a configurable delay. Effect re-arms on trig edges; a pending
  // setTimeout fires the delayed transition.
  defineModule({
    type: 'ctrl.timer', title: 'TIMER', subtitle: 'on/off delay', hp: 10, color: 'amber',
    params: {
      mode: { label: 'mode', kind: 'select', options: ['TON', 'TOF'], default: 'TON' },
      delay: { label: 'delay (ms)', kind: 'number', default: 1000 },
    },
    ports: { in: { trig: 'number' }, out: { q: { type: 'number', cable: 'coax' } } },
    setup(ctx, inst) {
      let pending = null, q = false;
      const apply = (v) => { if (v !== q) { q = v; inst.state.q = v; inst.outputs.q.write(v ? 1 : 0); } };
      const eff = ctx.sr.effect(() => {
        const trig = truthy(inst.inputs.trig.value());
        const mode = inst.params.mode || 'TON';
        const delay = Math.max(0, parseFloat(inst.params.delay) || 0);
        inst.state.mode = mode;
        if (pending) { clearTimeout(pending); pending = null; }
        if (mode === 'TON') {
          if (trig) pending = setTimeout(() => apply(true), delay);
          else apply(false);
        } else {                                  // TOF
          if (trig) apply(true);
          else pending = setTimeout(() => apply(false), delay);
        }
      });
      return () => { if (pending) clearTimeout(pending); eff(); };
    },
    display: (pb, out, st) => pb.led(out.q, { label: st.mode || 'TON', color: out.q ? 'green' : 'textSoft' }),
  });

  // ── displays (pass-through monitors) ───────────────────────────────────
  defineModule({
    type: 'disp.number', title: 'READOUT', subtitle: 'DRO', hp: 8, color: 'amber', style: 'lab',
    ports: { in: { x: 'number' }, out: { x: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ x: i.x }),
    display: (pb, out) => pb.numeric(out.x, { digits: 6, decimals: 3 }),
  });
  // TREND: a two-pen strip chart. `x` is the primary trace; `b` is an optional
  // second pen (shown only once it carries a nonzero signal, so an unwired b
  // doesn't draw a flat zero line). Fills the panel; autoscales; grid + min/max.
  defineModule({
    type: 'disp.scope', title: 'TREND', subtitle: 'strip chart', hp: 16, color: 'orange', style: 'analog',
    ports: { in: { x: 'number', b: 'number' }, out: { x: { type: 'number', cable: 'trs' } } },
    process: (i, _k, st) => {
      st.a = st.a || []; st.b = st.b || [];
      st.a.push(i.x || 0); if (st.a.length > 160) st.a.shift();
      st.b.push(i.b || 0); if (st.b.length > 160) st.b.shift();
      return { x: i.x };
    },
    display: (pb, _out, st) => {
      const series = [{ data: st.a || [], color: 'orange' }];
      if ((st.b || []).some((v) => v !== 0)) series.push({ data: st.b, color: 'teal' });
      pb.scope([], { series, h: 999, grid: true, fill: true });
    },
  });
  defineModule({
    type: 'disp.gauge', title: 'GAUGE', subtitle: 'dial', hp: 10, color: 'teal', style: 'analog',
    ports: { in: { x: 'number' }, out: { x: { type: 'number', cable: 'trs' } } },
    process: (i) => ({ x: i.x }),
    display: (pb, out) => pb.gauge(out.x || 0, { min: 0, max: 1, color: 'teal', maxH: 150 }),
  });

  // ── I/O (the field boundary) ───────────────────────────────────────────
  defineModule({
    type: 'io.abus-in', title: 'TAG IN', subtitle: 'field · AI', hp: 10, color: 'indigo',
    params: { topic: { label: 'tag (Iface.Member)', kind: 'text', default: '' } },
    ports: { out: { value: { type: 'number', cable: 'banana' } } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.topic) return null;
      const { iface, member } = parseTopic(inst.params.topic);
      const unsub = ctx.bus.subscribe({ interface: iface, member }, (msg) => {
        inst.outputs.value.write(msg && msg.args ? msg.args[0] : undefined);
      });
      return () => { try { unsub(); } catch { /* ignore */ } };
    },
    display: (pb, out) => pb.numeric(out.value, { digits: 5, decimals: 2 }),
  });

  defineModule({
    type: 'io.abus-out', title: 'TAG OUT', subtitle: 'field · AO', hp: 10, color: 'orange',
    params: { topic: { label: 'tag (Iface.Member)', kind: 'text', default: '' } },
    ports: { in: { value: 'number' } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.topic) return null;
      const { iface, member } = parseTopic(inst.params.topic);
      return ctx.sr.effect(() => {
        const v = inst.inputs.value.value();
        ctx.bus.signal({ path: '/', interface: iface, member }, [v]);
      });
    },
  });

  defineModule({
    type: 'io.vfs-read', title: 'FILE', subtitle: 'source', hp: 12, color: 'teal',
    params: { path: { label: 'path', kind: 'text', default: '' } },
    ports: { out: { content: { type: 'string', cable: 'ribbon' } } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.path) return null;
      let alive = true;
      const read = async () => {
        try {
          const t = await ctx.bus.call(
            { to: 'works', path: '/', interface: 'VFS', member: 'Read' }, [inst.params.path, 'utf8']);
          if (alive) inst.outputs.content.write(t);
        } catch { /* missing file → leave prior value */ }
      };
      read();
      const unsub = ctx.bus.subscribe({ interface: 'VFS', member: 'Changed' }, (msg) => {
        if (msg && msg.args && msg.args[0] === inst.params.path) read();
      });
      return () => { alive = false; try { unsub(); } catch { /* ignore */ } };
    },
    display: (pb, out) => pb.lcd(out.content == null ? '—' : String(out.content).slice(0, 12)),
  });

  defineModule({
    type: 'io.vfs-write', title: 'LOG', subtitle: 'historian', hp: 12, color: 'red',
    params: { path: { label: 'path', kind: 'text', default: '' } },
    ports: { in: { content: 'string' } },
    setup(ctx, inst) {
      if (!ctx.bus || !inst.params.path) return null;
      let first = true;
      return ctx.sr.effect(() => {
        const c = inst.inputs.content.value();   // track the input
        if (first) { first = false; return; }    // skip the initial run — don't clobber the file
        ctx.bus.call(
          { to: 'works', path: '/', interface: 'VFS', member: 'Write' },
          [inst.params.path, c == null ? '' : String(c)]).catch(() => {});
      });
    },
  });

  return STDLIB_MODULES;
}

// Register at import so the bundle (and the surface) has the stdlib available.
registerStdlib();
