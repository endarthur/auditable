// notebook.tag / notebook.call / notebook.requestBus — A-Bus access for cells.
//
// Works-only: a notebook running standalone has no bus, so every entry throws
// a clear error rather than silently no-op. The surface's A-Bus client is
// stashed on window._worksBus by createWorksHost (host.js).
//
// Three tiers (see spec_inbox/notebook-abus-access-spec.md):
//   tier 1  notebook.tag       — topic publish/subscribe/latest, always on
//   tier 2  notebook.call      — call a surface's declared-public interface
//   tier 3  notebook.requestBus — the raw client, behind a consent prompt
//
// This file ships tier 1 (tag). call / requestBus arrive with their tiers.
//
// Framing: this is hygiene, not a sandbox — a cell already has direct VFS via
// notebook.fs. tag pub/sub is advisory (signals can't damage), so it's
// unrestricted; only the raw client (tier 3) is consent-gated.

const WORKS_ONLY = 'A-Bus is only available in Auditable Works (not in a standalone notebook).';

// "Interface.Member" → { iface, member }. Also tolerates "Interface/Member".
function parseTopic(s) {
  const m = String(s == null ? '' : s).split(/[.\/]/);
  return { iface: m[0] || '', member: m.slice(1).join('.') || 'Value' };
}

// Session-lifetime cache for tag.latest(): one standing subscription per
// distinct topic, shared across cells, kept warm for the surface's life.
const _latest = new Map();
const _latestSubscribed = new Set();

export function makeAbus(cell, ctx) {
  const { invalidation } = ctx;
  const getBus = () => window._worksBus || null;

  const tag = {
    // Publish a value on a topic (fire-and-forget A-Bus signal).
    publish(topic, value) {
      const bus = getBus(); if (!bus) throw new Error(WORKS_ONLY);
      const { iface, member } = parseTopic(topic);
      bus.signal({ path: '/', interface: iface, member }, [value]);
    },
    // Subscribe to a topic; fn(value, msg) per signal. Auto-unsubscribed when
    // the cell re-runs (via the invalidation promise). Returns the unsub fn.
    subscribe(topic, fn) {
      const bus = getBus(); if (!bus) throw new Error(WORKS_ONLY);
      const { iface, member } = parseTopic(topic);
      const unsub = bus.subscribe({ interface: iface, member }, (msg) => {
        try { fn(msg && msg.args ? msg.args[0] : undefined, msg); }
        catch (e) { console.error('notebook.tag subscriber threw:', e); }
      });
      invalidation.then(() => { try { unsub(); } catch { /* ignore */ } });
      return unsub;
    },
    // The last value seen on a topic (or undefined). Installs a session-
    // lifetime subscription on first use, so the first read is undefined.
    latest(topic) {
      const bus = getBus(); if (!bus) throw new Error(WORKS_ONLY);
      const { iface, member } = parseTopic(topic);
      const key = iface + '.' + member;
      if (!_latestSubscribed.has(key)) {
        _latestSubscribed.add(key);
        bus.subscribe({ interface: iface, member }, (msg) => {
          _latest.set(key, msg && msg.args ? msg.args[0] : undefined);
        });
      }
      return _latest.get(key);
    },
  };

  return { tag };
}
