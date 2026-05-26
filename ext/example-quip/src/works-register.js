// Shell-context registration — EXTENSION_SPEC §2.5 + §3.8.
//
// This file is the source for ext/example-quip/works.js. The Works
// shell evaluates it at install time AND on every Works boot. It runs
// in the shell window (not a notebook iframe), so the filter +
// action callbacks below execute in shell context with access to
// WKS-side bus / dialog / spawnSurface helpers via the ctx argument.

const QUIP_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@example/quip',
      version: QUIP_VERSION,
      description: 'Quip Viewer surface + right-click "Export as JSON" action.',

      // §3.8.1 — Works surface.
      surfaces: [
        {
          kind:        'example-quip-viewer',
          label:       'Quip Viewer',
          icon:        '◐',
          file:        'surface.html',
          extensions:  ['.quip'],
          openAction:  true,
          requires:    ['abus'],
        },
      ],

      // §3.8.2 — tree right-click action. filter + action both run in
      // shell context; ctx exposes vfs / setStatus / dialog / etc.
      contextMenu: [
        {
          label:  'Export as JSON',
          scope:  'file',
          filter: (path) => path.toLowerCase().endsWith('.quip'),
          action: async (path, ctx) => {
            const src = await ctx.vfs.readFile(path, 'utf8');
            // Tiny inline parser — the gcupkg ships the full parser in
            // index.js for notebook use, but works.js doesn't reach
            // across to notebook-loaded modules. For a contextMenu
            // action that only needs a one-shot parse, repeating the
            // logic here keeps the shell self-contained.
            const templates = {};
            for (const rawLine of src.split('\n')) {
              const line = rawLine.trim();
              if (line === '' || line.startsWith('#')) continue;
              const eq = line.indexOf('=');
              if (eq < 0) continue;
              const name = line.slice(0, eq).trim();
              const template = line.slice(eq + 1).trim();
              if (/^[A-Za-z_][\w-]*$/.test(name)) templates[name] = template;
            }
            const jsonPath = path.replace(/\.quip$/i, '.json');
            await ctx.vfs.writeFile(jsonPath, JSON.stringify(templates, null, 2));
            ctx.setStatus(`wrote ${jsonPath}`);
          },
        },
      ],
    });
  }
}
