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
// Framing: this is hygiene, not a sandbox — a cell already has direct VFS via
// notebook.fs. tag pub/sub is advisory (signals can't damage), so it's
// unrestricted; declared-public calls (tier 2) need no prompt; only the raw
// client (tier 3) is consent-gated, and gated again on a // %abus directive
// in the calling cell (source-visible intent, mirroring %mcp).

const WORKS_ONLY = 'A-Bus is only available in Auditable Works (not in a standalone notebook).';

// // %abus (JS) or # %abus (adder/soft) anywhere in the calling cell's source.
const ABUS_DIRECTIVE = /^[ \t]*(?:\/\/|#)[ \t]*%abus\b/m;

// Tier-2 public-interface set, fetched from the shell once and refreshed live
// on Shell.NotebookPublicChanged. Module-scoped: one cache per notebook iframe.
let _publicSet = null;
let _publicWired = false;
async function ensurePublicSet(bus) {
  if (!_publicWired) {
    _publicWired = true;
    try {
      bus.subscribe({ interface: 'Shell', member: 'NotebookPublicChanged' }, async () => {
        try { _publicSet = await bus.call({ to: 'works', path: '/', interface: 'Shell', member: 'NotebookPublicSet' }, []) || {}; }
        catch { /* leave the stale set in place */ }
      });
    } catch { /* no subscribe → fall back to per-call fetch below */ }
  }
  if (_publicSet == null) {
    _publicSet = await bus.call({ to: 'works', path: '/', interface: 'Shell', member: 'NotebookPublicSet' }, []) || {};
  }
  return _publicSet;
}

// Tier 3: once a notebook is granted raw bus, every cell in the session has it.
let _busGranted = false;

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

  // Tier 2: call a surface interface the surface declared notebook-public.
  // No prompt — but refuses interfaces that aren't declared, with a hint to
  // requestBus(). `to` is a well-known A-Bus name (e.g. 'dee'); args an array.
  async function call(to, iface, member, args = []) {
    const bus = getBus(); if (!bus) throw new Error(WORKS_ONLY);
    const pub = await ensurePublicSet(bus);
    const ifaces = pub[to] || [];
    if (!ifaces.includes(iface)) {
      throw new Error(
        `notebook.call: "${to}.${iface}" is not declared notebook-public. ` +
        `The surface must expose it with notebookPublic, or use ` +
        `notebook.requestBus() for raw access.`);
    }
    return bus.call({ to, path: '/', interface: iface, member }, Array.isArray(args) ? args : [args]);
  }

  // Tier 3: the raw A-Bus client, behind a // %abus directive (source-visible
  // intent) + a one-time consent prompt. Async (a modal can't gate a getter).
  // Returns the full client (call/signal/subscribe/claim/…); subscriptions on
  // it are the caller's to manage (ctx.invalidation is available via tag).
  async function requestBus() {
    const bus = getBus(); if (!bus) throw new Error(WORKS_ONLY);
    if (_busGranted) return bus;
    if (!ABUS_DIRECTIVE.test((cell && cell.code) || '')) {
      throw new Error(
        'notebook.requestBus() requires a // %abus directive in the calling ' +
        'cell — a source-visible declaration that this notebook drives the bus.');
    }
    const title = (typeof document !== 'undefined' &&
      document.getElementById('docTitle') && document.getElementById('docTitle').value) || 'This notebook';
    const id = (typeof window !== 'undefined' && window._worksProjectPath) || title;
    const ok = await bus.call(
      { to: 'works', path: '/', interface: 'Shell', member: 'RequestBusAccess' },
      [title, id, true]);
    if (!ok) throw new Error('A-Bus access denied for this notebook.');
    _busGranted = true;
    return bus;
  }

  return { tag, call, requestBus };
}
