// Shell-context registration — EXTENSION_SPEC §2.5 + §3.8.
//
// Source for ext/workbench/works.js. The Works shell evaluates it at
// install time AND on every boot (evaluateAllWorksScripts). It runs in
// the shell window, registering the Data Workbench surface so the
// menubar's Tools → Data workbench (spawnSurface('workbench')) and the
// surface registry can find it.
//
// The `pipeline` A-Bus service the surface talks to is NOT registered
// here — it's declared as DATA in this package's package.json
// (gcu.services) and activated cold→hot by the shell's service scan
// (extension-services.js). Surfaces need code; services don't. That
// split is the whole safety point of the contribution registry.

const WORKBENCH_VERSION = '0.1.0';

if (typeof window !== 'undefined') {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/workbench',
      version: WORKBENCH_VERSION,
      description: 'Geoscience/tabular Data Workbench — schema · summary · grade-tonnage · swath · categories over CSV / OMF, computed shell-side by the pipeline service.',

      // §3.8.1 — the Data Workbench surface. Path-less / spawned from the
      // Tools menu (no `extensions`/`openAction`); a workbench *project*
      // (project.json kind:'workbench') routes here via its kind, and the
      // surface itself handles loose .csv/.omf paths once open.
      surfaces: [
        {
          kind:     'workbench',
          label:    'Data Workbench',
          icon:     '▤',
          file:     'surface.html',
          requires: ['abus'],
        },
      ],
    });
  }
}
