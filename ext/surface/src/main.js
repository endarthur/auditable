// @gcu/surface — the Auditable Works surface contract, extracted from the two
// real consumers (strata + plate) per the two-examples discipline. v0.1 ships the
// genuinely-shared pieces: the boot handshake and the Works host adapter
// (lifecycle + selection/linking). The standalone host stays in tools/strata
// until a second standalone tool needs it; the notebook's VFS-project host
// (src/js/host.js, provideVFS/persist) is a different, heavier shape folded in
// later. Contract + rationale: tools/strata/HOST.md.
//
// Module manifest (build concat order):
//   boot.js       — bootSurface: welcome→connect→claim→expose→Ready handshake
//   works-host.js — createWorksHost: §5.2 lifecycle + selection channel over A-Bus

export * from './boot.js';
export * from './works-host.js';
