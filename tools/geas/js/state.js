// Shared mutable state for the geas standalone tool. The build
// concatenates every module into one classic-script scope, so this
// object is the single place cross-module state lives.

const GS = {
  client:   null,   // GeasClient — the main-thread facade over the worker
  terminal: null,   // @gcu/term Terminal instance
  renderer: null,   // @gcu/term DomRenderer
  input:    null,   // @gcu/term Input
  history:  [],     // command history ring (REPL up/down recall)
};
