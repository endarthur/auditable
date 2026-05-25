// @gcu/licenses — third-party license attribution for the GCU stack
//
// Module manifest. Each file is a small piece of the pipeline:
//   spdx.js     — SPDX 3.0 expression parser + bundled corpus (id → kind)
//   classify.js — id|expression → 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown'
//   format.js   — formatTable + formatNoticesFile (text / html / spdx-bom outputs)
//   api.js      — public surface: validateSpdx, classify, formatTable, formatNoticesFile,
//                 SPDX_CORPUS, fetchLicense (later), aggregateLicenses (later)

export * from './spdx.js';
export * from './classify.js';
export * from './format.js';
export * from './api.js';
