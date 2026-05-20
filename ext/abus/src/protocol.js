// @gcu/abus — wire protocol constants, validation, shared helpers.
//
// Pure module: zero imports, safe in any JS environment (browser, worker,
// Node). Both the broker and the client build on this.

export const PROTOCOL_VERSION = '1.0';

// The broker's reserved well-known name. Calls addressed here are executed
// by the broker itself rather than forwarded.
export const BUS_NAME = 'bus';

// Standard error codes (spec §13). Peer-specific codes use a peer-prefixed
// namespace (e.g. "dee.Error.SceneNotFound") — a convention, not enforced.
export const ERR = {
  NameHasNoOwner:      'Error.NameHasNoOwner',
  NameInUse:           'Error.NameInUse',
  OwnerDisappeared:    'Error.OwnerDisappeared',
  UnknownInterface:    'Error.UnknownInterface',
  UnknownMember:       'Error.UnknownMember',
  InvalidArgs:         'Error.InvalidArgs',
  AccessDenied:        'Error.AccessDenied',
  Internal:            'Error.Internal',
  Timeout:             'Error.Timeout',
  UnsupportedProtocol: 'Error.UnsupportedProtocol',
};

// A well-known name a peer may claim: lowercase, starts with a letter, no
// dots. NAME_RE already excludes ':'- and '_'-prefixed names (reserved); the
// explicit BUS_NAME check rejects the one syntactically-valid reserved name.
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

// An object path: '/'-rooted, segments of [A-Za-z0-9_-]. '/' alone is valid.
const PATH_RE = /^\/([A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*)?$/;

// True if `name` is a well-known name a peer is allowed to claim.
export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name !== BUS_NAME;
}

// True if `path` is a well-formed object path.
export function isValidPath(path) {
  return typeof path === 'string' && PATH_RE.test(path);
}

// An Error carrying a structured A-Bus error `.code` (one of ERR.*, or a
// peer-specific code) plus optional `.data`. Thrown by the client when a
// call fails; the broker and exposed methods produce the matching wire form.
export class AbusError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.name = 'AbusError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// Does signal message `msg` satisfy subscription `filter`? Every filter
// field is optional — an omitted field is a wildcard, and an empty filter
// `{}` matches every signal (spec §5.3).
export function matchesFilter(filter, msg) {
  if (!filter) return true;
  if (filter.from != null && filter.from !== msg.from) return false;
  if (filter.path != null && filter.path !== msg.path) return false;
  if (filter.interface != null && filter.interface !== msg.interface) return false;
  if (filter.member != null && filter.member !== msg.member) return false;
  return true;
}

// A monotonic id generator, starting at 1. `id` is sender-local (spec §5.5):
// each connection has its own sequence, correlation is by (from, id).
export function makeIdGen() {
  let n = 0;
  return () => ++n;
}
