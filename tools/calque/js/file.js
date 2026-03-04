// File operations — open/save .calque, import/export .xlsx

async function newFile() {
  if (CQ.dirty && !confirm('Discard unsaved changes?')) return;
  CQ.source = 'Sheet1 {\n  \n}';
  CQ.fileHandle = null;
  CQ.fileName = null;
  CQ.dirty = false;
  CQ.importData = null;
  projectCreate(CQ.source);
  setEditorSource(CQ.source);
  cqEvaluate(CQ.source);
  updateTitle();
}

async function openFile() {
  try {
    let file, handle;
    if (window.showOpenFilePicker) {
      [handle] = await window.showOpenFilePicker({
        types: [
          { description: 'Calque / Excel files', accept: { 'text/plain': ['.calque', '.cq'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } },
        ],
      });
      file = await handle.getFile();
    } else {
      // Fallback
      file = await pickFile('.calque,.cq,.xlsx,.txt');
      if (!file) return;
      handle = null;
    }

    if (file.name.endsWith('.xlsx')) {
      const buf = await file.arrayBuffer();
      const data = await sheet.read(new Uint8Array(buf));
      const source = xlsxToCalqueSource(data);
      CQ.source = source;
      CQ.fileHandle = null;
      CQ.fileName = file.name.replace(/\.xlsx$/i, '.calque');
      CQ.dirty = true;
      CQ.importData = null;
      const pname = file.name.replace(/\.\w+$/, '');
      projectCreate(CQ.source, pname);
      setEditorSource(CQ.source);
      cqEvaluate(CQ.source);
      updateTitle();
      setStatus('msg', 'opened ' + file.name);
    } else {
      CQ.source = await file.text();
      CQ.fileHandle = handle;
      CQ.fileName = file.name;
      CQ.dirty = false;
      CQ.importData = null;
      const pname = (CQ.fileName || 'untitled').replace(/\.\w+$/, '');
      projectCreate(CQ.source, pname);
      setEditorSource(CQ.source);
      cqEvaluate(CQ.source);
      updateTitle();
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'open failed: ' + e.message);
  }
}

async function saveFile() {
  if (CQ.fileHandle) {
    try {
      const writable = await CQ.fileHandle.createWritable();
      await writable.write(CQ.source);
      await writable.close();
      CQ.dirty = false;
      projectSave();
      updateTitle();
      setStatus('msg', 'saved');
      return;
    } catch (e) {
      // Fall through
    }
  }
  // No file handle — persisted to localStorage
  if (isProjectUntitled()) {
    // First save of untitled project — ask for a name
    showRenamePrompt('untitled', name => {
      projectUpdateName(name);
      CQ.fileName = name;
      CQ.dirty = false;
      projectSave();
      updateTitle();
      setStatus('msg', 'saved as ' + name);
    });
    return;
  }
  CQ.dirty = false;
  projectSave();
  updateTitle();
  setStatus('msg', 'saved');
}

async function saveFileAs() {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: CQ.fileName || 'untitled.calque',
        types: [{ description: 'Calque files', accept: { 'text/plain': ['.calque'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(CQ.source);
      await writable.close();
      CQ.fileHandle = handle;
      CQ.fileName = handle.name;
      CQ.dirty = false;
      projectUpdateName(handle.name.replace(/\.\w+$/, ''));
      projectSave();
      updateTitle();
      setStatus('msg', 'saved');
    } else {
      downloadBlob(CQ.source, CQ.fileName || 'untitled.calque', 'text/plain');
      CQ.dirty = false;
      updateTitle();
      setStatus('msg', 'downloaded');
    }
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'save failed: ' + e.message);
  }
}

async function importXlsx() {
  try {
    let file;
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Excel files', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
      });
      file = await handle.getFile();
    } else {
      file = await pickFile('.xlsx');
      if (!file) return;
    }
    const buf = await file.arrayBuffer();
    const data = await sheet.read(new Uint8Array(buf));
    CQ.importData = {};
    for (const s of data.sheets) {
      CQ.importData[s.name] = s;
    }
    setStatus('msg', 'imported ' + file.name + ' (' + data.sheets.length + ' sheets)');
    forceEval();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('msg', 'import failed: ' + e.message);
  }
}


function xlsxToCalqueSource(data) {
  const lines = [];
  for (const s of data.sheets) {
    const name = sanitizeCalqueName(s.name);
    // Build column letter → sanitized name map for formula decompilation
    const colMap = {};
    if (s.colLetterMap) {
      for (const [letter, hdr] of Object.entries(s.colLetterMap)) {
        colMap[letter] = sanitizeCalqueName(hdr);
      }
    }

    lines.push(name + ' {');
    for (const hdr of s.headers) {
      const formulas = s.formulas?.[hdr];
      const uniqueFormula = formulas ? getRepresentativeFormula(formulas) : null;
      const safeName = sanitizeCalqueName(hdr);
      const vals = s.columns[hdr];

      if (uniqueFormula) {
        // Try to decompile to native calque expression
        const calqueExpr = decompileFormula(uniqueFormula, colMap);
        if (calqueExpr) {
          lines.push('  ' + safeName + ' = ' + calqueExpr);
        } else {
          // Can't decompile — fall back to @formula + baked values
          lines.push('  @formula("' + escapeCalqueString(uniqueFormula) + '")');
          lines.push('  ' + safeName + ' = ' + formatCalqueValue(vals));
        }
      } else {
        lines.push('  ' + safeName + ' = ' + formatCalqueValue(vals));
      }
    }
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function getRepresentativeFormula(formulas) {
  for (const f of formulas) {
    if (f) return f;
  }
  return null;
}

function escapeCalqueString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sanitizeCalqueName(name) {
  let safe = name.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(safe)) safe = '_' + safe;
  if (!safe) safe = '_col';
  return safe;
}

function formatCalqueValue(vals) {
  if (!vals || vals.length === 0) return '[]';
  if (vals.length === 1) {
    return formatScalar(vals[0]);
  }
  const items = [];
  for (let i = 0; i < vals.length; i++) {
    items.push(formatScalar(vals[i]));
  }
  return '[' + items.join(', ') + ']';
}

function formatScalar(v) {
  if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return '"' + escapeCalqueString(v) + '"';
  return String(v);
}

// ── Excel formula decompiler ──

const REVERSE_FUNC = {
  SUM: 'sum', AVERAGE: 'mean', COUNTA: 'count', MIN: 'min', MAX: 'max',
  LEFT: 'left', RIGHT: 'right', MID: 'mid', LEN: 'len', TRIM: 'trim',
  TEXT: 'text', DATE: 'date', YEAR: 'year', MONTH: 'month',
  DAY: 'day', TODAY: 'today', IFERROR: 'iferror', IFNA: 'ifna',
  ROUND: 'round', ABS: 'abs', 'FLOOR.MATH': 'floor', 'CEILING.MATH': 'ceil',
  SQRT: 'sqrt', LOG: 'log', EXP: 'exp', MOD: 'mod',
  SORT: 'sort', UNIQUE: 'unique', XLOOKUP: 'lookup',
};
const REVERSE_OP = { '=': '==', '<>': '/=' };

function lexFormula(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === ' ') { i++; continue; }
    // String
    if (str[i] === '"') {
      let j = i + 1, val = '';
      while (j < str.length) {
        if (str[j] === '"') {
          if (str[j + 1] === '"') { val += '"'; j += 2; } else break;
        } else { val += str[j]; j++; }
      }
      tokens.push({ type: 'str', value: val });
      i = j + 1; continue;
    }
    // Number
    if (/\d/.test(str[i]) || (str[i] === '.' && /\d/.test(str[i + 1] || ''))) {
      let j = i;
      while (j < str.length && /[\d.]/.test(str[j])) j++;
      if (j < str.length && /[eE]/.test(str[j])) {
        j++;
        if (j < str.length && /[+-]/.test(str[j])) j++;
        while (j < str.length && /\d/.test(str[j])) j++;
      }
      tokens.push({ type: 'num', value: parseFloat(str.slice(i, j)) });
      i = j; continue;
    }
    // Word-like: function, boolean, cell ref, or identifier
    if (/[A-Za-z_]/.test(str[i])) {
      const rest = str.slice(i);
      // Function name (including FLOOR.MATH style)
      const fm = rest.match(/^([A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9]*)?)(?=\()/i);
      if (fm) {
        const name = fm[1].toUpperCase();
        tokens.push({ type: 'func', value: name });
        i += fm[1].length; continue;
      }
      // TRUE/FALSE
      const bm = rest.match(/^(TRUE|FALSE)\b/i);
      if (bm) {
        tokens.push({ type: 'bool', value: bm[1].toUpperCase() === 'TRUE' });
        i += bm[1].length; continue;
      }
      // Cell ref: $?COL$?ROW possibly :$?COL$?ROW
      const rm = rest.match(/^(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?/i);
      if (rm) {
        tokens.push({ type: 'ref', value: rm[0].toUpperCase() });
        i += rm[0].length; continue;
      }
      // Plain identifier (LAMBDA params)
      const im = rest.match(/^[A-Za-z_]\w*/);
      if (im) {
        tokens.push({ type: 'id', value: im[0] });
        i += im[0].length; continue;
      }
    }
    // $ at start of cell ref
    if (str[i] === '$') {
      const rest = str.slice(i);
      const rm = rest.match(/^(\$[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?/i);
      if (rm) {
        tokens.push({ type: 'ref', value: rm[0].toUpperCase() });
        i += rm[0].length; continue;
      }
    }
    // Two-char operators
    if (i + 1 < str.length) {
      const two = str[i] + str[i + 1];
      if (two === '<>' || two === '<=' || two === '>=') {
        tokens.push({ type: 'op', value: two });
        i += 2; continue;
      }
    }
    // Single-char
    if ('+-*/^&=<>'.includes(str[i])) {
      tokens.push({ type: 'op', value: str[i] }); i++; continue;
    }
    if ('(),'.includes(str[i])) {
      tokens.push({ type: 'punc', value: str[i] }); i++; continue;
    }
    i++; // skip unknown
  }
  return tokens;
}

function decompileFormula(formula, colMap) {
  // colMap: column letter → sanitized binding name
  // Returns calque expression string, or null if can't decompile
  try {
    const tokens = lexFormula(formula);
    let pos = 0;
    const peek = () => tokens[pos] || null;
    const next = () => tokens[pos++];
    const eat = (type, val) => {
      const t = next();
      if (!t || t.type !== type || (val !== undefined && t.value !== val)) throw 0;
      return t;
    };

    function resolveRef(ref) {
      // Range: A$2:A$7 → column name
      const rng = ref.match(/^\$?([A-Z]+)\$?\d+:\$?([A-Z]+)\$?\d+$/);
      if (rng) {
        const name = colMap[rng[1]];
        if (!name) throw 0;
        return name;
      }
      // Single cell: $D$2 or A2 → column name
      const cell = ref.match(/^\$?([A-Z]+)\$?\d+$/);
      if (cell) {
        const name = colMap[cell[1]];
        if (!name) throw 0;
        return name;
      }
      throw 0;
    }

    function expr() { return compare(); }

    function compare() {
      let r = concat();
      while (peek() && peek().type === 'op' && /^(=|<>|<|>|<=|>=)$/.test(peek().value)) {
        const op = next().value;
        r = r + ' ' + (REVERSE_OP[op] || op) + ' ' + concat();
      }
      return r;
    }

    function concat() {
      let r = add();
      while (peek() && peek().type === 'op' && peek().value === '&') {
        next(); r = r + ' & ' + add();
      }
      return r;
    }

    function add() {
      let r = mul();
      while (peek() && peek().type === 'op' && /^[+-]$/.test(peek().value)) {
        r = r + ' ' + next().value + ' ' + mul();
      }
      return r;
    }

    function mul() {
      let r = power();
      while (peek() && peek().type === 'op' && /^[*/]$/.test(peek().value)) {
        r = r + ' ' + next().value + ' ' + power();
      }
      return r;
    }

    function power() {
      let r = unary();
      while (peek() && peek().type === 'op' && peek().value === '^') {
        next(); r = r + ' ^ ' + unary();
      }
      return r;
    }

    function unary() {
      if (peek() && peek().type === 'op' && peek().value === '-') {
        next(); return '-' + primary();
      }
      return primary();
    }

    function primary() {
      const t = peek();
      if (!t) throw 0;
      if (t.type === 'num') { next(); return String(t.value); }
      if (t.type === 'str') { next(); return '"' + escapeCalqueString(t.value) + '"'; }
      if (t.type === 'bool') { next(); return t.value ? 'true' : 'false'; }
      if (t.type === 'ref') { next(); return resolveRef(t.value); }
      if (t.type === 'id') { next(); return t.value; }
      if (t.type === 'punc' && t.value === '(') {
        next(); const e = expr(); eat('punc', ')');
        return '(' + e + ')';
      }
      if (t.type === 'func') return funcCall();
      throw 0;
    }

    function funcCall() {
      const fn = next().value;
      eat('punc', '(');

      // IF → if/then/else
      if (fn === 'IF') {
        const c = expr(); eat('punc', ',');
        const t = expr(); eat('punc', ',');
        const e = expr(); eat('punc', ')');
        return 'if ' + c + ' then ' + t + ' else ' + e;
      }
      // AND/OR → infix
      if (fn === 'AND') {
        const a = expr(); eat('punc', ','); const b = expr(); eat('punc', ')');
        return a + ' and ' + b;
      }
      if (fn === 'OR') {
        const a = expr(); eat('punc', ','); const b = expr(); eat('punc', ')');
        return a + ' or ' + b;
      }
      if (fn === 'NOT') {
        const a = expr(); eat('punc', ')');
        return 'not ' + a;
      }
      // LAMBDA → arrow function
      if (fn === 'LAMBDA') {
        const args = [expr()];
        while (peek() && peek().type === 'punc' && peek().value === ',') {
          next(); args.push(expr());
        }
        eat('punc', ')');
        if (args.length < 2) throw 0;
        const body = args.pop();
        return '(' + args.join(', ') + ') -> ' + body;
      }
      // SCAN → reorder: Excel SCAN(init, range, lambda) → calque scan(range, init, lambda)
      if (fn === 'SCAN') {
        const init = expr(); eat('punc', ',');
        const range = expr(); eat('punc', ',');
        const lambda = expr(); eat('punc', ')');
        return 'scan(' + range + ', ' + init + ', ' + lambda + ')';
      }
      // FILTER → subscript
      if (fn === 'FILTER') {
        const range = expr(); eat('punc', ',');
        const cond = expr(); eat('punc', ')');
        return range + '[' + cond + ']';
      }

      // Regular function
      const calqueName = REVERSE_FUNC[fn];
      if (!calqueName) throw 0;
      const args = [];
      if (!(peek() && peek().type === 'punc' && peek().value === ')')) {
        args.push(expr());
        while (peek() && peek().type === 'punc' && peek().value === ',') {
          next(); args.push(expr());
        }
      }
      eat('punc', ')');
      return calqueName + '(' + args.join(', ') + ')';
    }

    const result = expr();
    if (pos < tokens.length) return null;
    return result;
  } catch {
    return null;
  }
}

async function exportXlsx() {
  if (!CQ.result) {
    setStatus('msg', 'nothing to export');
    return;
  }
  try {
    const { workbook, warnings } = CQ.result.compile();
    const bytes = await sheet.write(workbook);
    const name = (CQ.fileName || 'untitled').replace(/\.\w+$/, '') + '.xlsx';
    downloadBlob(bytes, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (warnings.length) setStatus('msg', 'exported with ' + warnings.length + ' warning(s)');
    else setStatus('msg', 'exported ' + name);
  } catch (e) {
    setStatus('msg', 'export failed: ' + e.message);
  }
}

// Helpers

function downloadBlob(data, filename, type) {
  const blob = data instanceof Blob ? data :
    data instanceof Uint8Array ? new Blob([data], { type }) :
    new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFileText(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      resolve({ text: await file.text(), name: file.name });
    };
    input.click();
  });
}

function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

function updateTitle() {
  const name = CQ.fileName || 'untitled';
  document.title = (CQ.dirty ? '\u2022 ' : '') + name + ' \u2014 Calque';
}

// Drag-drop xlsx on grid
function initDragDrop() {
  const grid = $('#cq-grid');
  grid.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  grid.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.name.endsWith('.xlsx')) {
      try {
        const buf = await file.arrayBuffer();
        const data = await sheet.read(new Uint8Array(buf));
        const source = xlsxToCalqueSource(data);
        CQ.source = source;
        CQ.fileHandle = null;
        CQ.fileName = file.name.replace(/\.xlsx$/i, '.calque');
        CQ.dirty = true;
        CQ.importData = null;
        const pname = file.name.replace(/\.\w+$/, '');
        projectCreate(CQ.source, pname);
        setEditorSource(CQ.source);
        cqEvaluate(CQ.source);
        updateTitle();
        setStatus('msg', 'imported ' + file.name);
      } catch (err) {
        setStatus('msg', 'import failed: ' + err.message);
      }
    } else if (file.name.endsWith('.calque') || file.name.endsWith('.cq')) {
      const text = await file.text();
      CQ.source = text;
      CQ.fileName = file.name;
      CQ.fileHandle = null;
      CQ.dirty = false;
      const pname = file.name.replace(/\.\w+$/, '');
      projectCreate(CQ.source, pname);
      setEditorSource(CQ.source);
      cqEvaluate(CQ.source);
      updateTitle();
    }
  });
}
