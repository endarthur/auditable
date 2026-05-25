// @gcu/licenses — third-party license attribution for the GCU stack
//
// Module manifest. Each file is a small piece of the pipeline:
//   spdx.js      — SPDX 3.0 expression parser + bundled corpus (id → kind)
//   classify.js  — id|expression → 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown'
//   format.js    — formatTable + formatNoticesFile (text / html / spdx-bom outputs)
//   fetch.js     — parseUrlToSource + fetchLicense (per-registry handlers)
//   infer.js     — inferLicense (fingerprint fallback for license-text → SPDX id)
//   aggregate.js — aggregateLicenses (VFS view function over /var/modules + /lib + /sys/licenses)
//   api.js       — public surface

export * from './spdx.js';
export * from './classify.js';
export * from './format.js';
export * from './fetch.js';
export * from './infer.js';
export * from './aggregate.js';
export * from './api.js';
