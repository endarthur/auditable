#!/usr/bin/env node
// Bundle ext/drillhole/src/ into ext/drillhole/index.js via @gcu/build. Zero-dep leaf
// (pure functions, no DOM). gsjs's compositing path + a notebook `load("@gcu/drillhole")`
// consume the bundle; BMA + dee re-vendor the src modules from here.
import { bundle } from '../build/src/main.js';

const r = await bundle({ at: import.meta.url, sourcemap: false, meta: false });
console.log(`Built ext/drillhole/index.js (${(r.code.length / 1024).toFixed(1)} KB, ${r.meta.exports.length} exports)`);
