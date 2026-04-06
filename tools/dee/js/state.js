// dee tool — global state

const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

const D3 = {
  // scene
  scene: null,           // dee scene object
  container: null,       // viewport DOM element

  // data
  gridDef: null,         // { origin, size, count }
  columns: {},           // { name: { values, indices } }
  columnNames: [],       // ordered column names
  activeColumn: null,    // current column name
  drillholes: [],        // array of hole objects
  surfaces: [],          // array of { name, vertices, triangles }

  // display
  prepared: null,        // voxmesh prepared result
  breaks: null,
  binCount: 10,
  palette: 'viridis',
  cutoff: null,          // null = show all

  // layers
  blockLayer: null,
  holeLayer: null,

  // section
  sectionMode: false,
  sectionClip: null,
  sectionLayer: null,

  // UI
  dirty: false,
  fileName: null,
  projectId: null,
  sidebarOpen: false,

  // perf
  perf: {
    meshTime: 0,
    triangles: 0,
    blocks: 0,
    fps: 0,
  },
};

const PALETTES = ['viridis', 'inferno', 'turbo', 'coolwarm'];
const PRESETS = {
  small:  { label: 'Small (4K)',    nx: 20,  ny: 20,  nz: 10 },
  medium: { label: 'Medium (50K)',  nx: 50,  ny: 50,  nz: 20 },
  large:  { label: 'Large (300K)', nx: 100, ny: 100, nz: 30 },
  stress: { label: 'Stress (2M)',  nx: 200, ny: 200, nz: 50 },
};
