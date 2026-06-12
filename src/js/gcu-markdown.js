// Re-export stub for @gcu/markdown (the vfs.js pattern). At dev/test time this
// resolves the engine via relative import; at build time the registry adds
// ext/markdown/index.js as the 'gcu-markdown' entry and markdown.js's import
// of './gcu-markdown.js' rewrites to '#gcu-markdown' — this file itself is NOT
// in main.js and never ships. The app-export runtime takes a third path:
// build.js prepends an IIFE-wrapped engine exposing _mdRender/_mdPresets/
// _mdSlugify (the exported app's stubs.js has a top-level `render` stub —
// sideact's — so the engine must not land in that shared scope unprefixed).

export * from '../../ext/markdown/index.js';
