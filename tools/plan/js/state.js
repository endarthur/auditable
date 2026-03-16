// Global state for Plan

const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

const PP = {
  tasks: [],
  calendar: { weekends: [0, 6], holidays: [], blocked: [] },
  calendarPreset: null,
  projectStart: new Date().toISOString().slice(0, 10),
  deadlines: [],
  scheduleResult: null,
  mcResult: null,
  mcIterations: 5000,
  evmResult: null,
  baseline: null,
  dirty: false,
  fileHandle: null,
  fileName: null,
  menuOpen: null,
  projectId: null,
  undoStack: [],
  redoStack: [],
  ui: {
    selectedRow: -1,
    sidebarPanel: null,
    showFloat: true,
    showProgress: true,
  },
};

const COLUMNS = [
  { key: '#',        label: '#',       width: 32,  type: 'rownum' },
  { key: 'id',       label: 'ID',      width: 80,  type: 'text',   editable: true },
  { key: 'name',     label: 'Name',    width: 200, type: 'text',   editable: true },
  { key: 'group',    label: 'Group',   width: 120, type: 'text',   editable: true },
  { key: 'o',        label: 'O',       width: 50,  type: 'number', editable: true },
  { key: 'm',        label: 'M',       width: 50,  type: 'number', editable: true },
  { key: 'p',        label: 'P',       width: 50,  type: 'number', editable: true },
  { key: 'depends',  label: 'Depends', width: 120, type: 'text',   editable: true },
  { key: 'resource', label: 'Resource',width: 100, type: 'text',   editable: true },
  { key: 'progress', label: '%',       width: 50,  type: 'number', editable: true },
  { key: 'start',    label: 'Start',   width: 90,  type: 'date',   computed: true },
  { key: 'finish',   label: 'Finish',  width: 90,  type: 'date',   computed: true },
  { key: 'float',    label: 'Float',   width: 50,  type: 'number', computed: true },
  { key: 'critical', label: '\u25c6',  width: 30,  type: 'icon',   computed: true },
];

function createTask(overrides) {
  return {
    id: '',
    name: '',
    group: '',
    o: '',
    m: '',
    p: '',
    depends: '',
    resource: '',
    progress: '',
    ...overrides,
  };
}

const STARTER_TASKS = [
  createTask({ id: 'design',  name: 'Design Phase',      group: 'Phase 1', o: '3', m: '5', p: '8' }),
  createTask({ id: 'dev',     name: 'Development',        group: 'Phase 1', o: '5', m: '10', p: '18', depends: 'design' }),
  createTask({ id: 'test',    name: 'Testing',            group: 'Phase 2', o: '2', m: '4', p: '7', depends: 'dev' }),
  createTask({ id: 'deploy',  name: 'Deployment',         group: 'Phase 2', o: '1', m: '2', p: '3', depends: 'test' }),
];
