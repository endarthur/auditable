// soft — tree-walking evaluator
// Executes a Soft AST. No external dependencies except the parser.

import { softParse } from './parse.js';

// ── scope (lexical, with prototype chain) ──

function createScope(parent) {
  const scope = Object.create(parent || null);
  scope._parent = parent || null;
  return scope;
}

function scopeSet(scope, name, value) {
  // walk up to find owning scope; if none, create in current
  let s = scope;
  while (s) {
    if (Object.prototype.hasOwnProperty.call(s, name) && name !== '_parent') {
      s[name] = value; return;
    }
    if (!s._parent) break;
    s = s._parent;
  }
  scope[name] = value;
}

// ── return/stop/skip signals ──

class ReturnSignal { constructor(value) { this.value = value; } }
class StopSignal {}
class SkipSignal {}

// ── stringify (§12) ──

export function softString(value) {
  if (value === null || value === undefined) return 'nothing';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (typeof value[0] === 'object' && value[0] !== null) return formatTable(value);
    return value.map(softString).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${softString(v)}`).join(', ');
  }
  return String(value);
}

function formatTable(rows) {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k => Math.max(k.length, ...rows.map(r => softString(r[k]).length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('──');
  const body = rows.map(r => keys.map((k, i) => softString(r[k]).padEnd(widths[i])).join('  ')).join('\n');
  return header + '\n' + sep + '\n' + body;
}

// ── truthiness (§8) ──

function isTruthy(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

// ── builtins (§10) ──

const BUILTINS = {
  abs: (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  sqrt: (x) => Math.sqrt(x),
  random: () => Math.random(),
  number: (x) => Number(x),
  text: (x) => softString(x),
};

// ── glob matching ──

function globMatch(str, pattern) {
  // convert glob to regex
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      let cls = '[';
      i++;
      if (i < pattern.length && pattern[i] === '!') { cls += '^'; i++; }
      while (i < pattern.length && pattern[i] !== ']') { cls += pattern[i]; i++; }
      cls += ']';
      re += cls;
    }
    else re += c.replace(/[.*+?^${}()|\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re, 'i').test(str);
}

// ── main evaluator ──

export function softEval(code, options) {
  const ast = typeof code === 'string' ? softParse(code) : code;
  const output = [];
  const globals = (options && options.globals) || {};
  const scope = createScope(null);

  // inject builtins into scope
  for (const [name, fn] of Object.entries(BUILTINS)) scope[name] = fn;

  // default host globals
  const defaultGlobals = {
    Math: typeof Math !== 'undefined' ? Math : {},
    Text: {
      upper: (s) => String(s).toUpperCase(),
      lower: (s) => String(s).toLowerCase(),
      trim: (s) => String(s).trim(),
      split: (s, sep) => String(s).split(sep),
      replace: (s, a, b) => String(s).replaceAll(a, b),
      starts: (s, p) => String(s).startsWith(p),
      ends: (s, p) => String(s).endsWith(p),
      slice: (s, a, b) => String(s).slice(a, b),
    },
    List: {
      range: (a, b, step) => { const r = []; if (b === undefined) { b = a; a = 0; } step = step || 1; for (let i = a; step > 0 ? i < b : i > b; i += step) r.push(i); return r; },
      reverse: (arr) => [...arr].reverse(),
      flat: (arr) => arr.flat(),
      unique: (arr) => [...new Set(arr)],
      join: (arr, sep) => arr.join(sep ?? ', '),
    },
  };

  // inject defaults, then user-provided globals override
  for (const [name, val] of Object.entries(defaultGlobals)) scope[name] = val;
  for (const [name, val] of Object.entries(globals)) scope[name] = val;

  // inject upstream scope (from Auditable DAG)
  const scopeInit = (options && options.scopeInit) || {};
  for (const [name, val] of Object.entries(scopeInit)) scope[name] = val;

  // host functions (file I/O, DOM, events — injected by cell handler)
  const host = (options && options.host) || {};

  // it — implicit result variable
  scope.it = null;

  let steps = 0;
  const maxSteps = (options && options.maxSteps) || 50000;
  let callDepth = 0;
  const maxCallDepth = (options && options.maxCallDepth) || 1000;

  function step() {
    if (++steps > maxSteps) throw new Error('Step limit exceeded (possible infinite loop)');
  }

  // ── eval node ──

  function lineError(node, e) {
    if (e._softLine) throw e; // already tagged
    const msg = e.message || String(e);
    const err = new Error(node.line ? `${msg} (line ${node.line})` : msg);
    err._softLine = true;
    throw err;
  }

  function evalNode(node, sc) {
    step();
    switch (node.type) {
      case 'Program': return evalProgram(node, sc);
      case 'Say': return evalSay(node, sc);
      case 'Set': return evalSet(node, sc);
      case 'SetOf': return evalSetOf(node, sc);
      case 'SetChunk': return evalSetChunk(node, sc);
      case 'If': return evalIf(node, sc);
      case 'While': return evalWhile(node, sc);
      case 'Repeat': return evalRepeat(node, sc);
      case 'ForEach': return evalForEach(node, sc);
      case 'RangeLoop': return evalRangeLoop(node, sc);
      case 'Define': return evalDefine(node, sc);
      case 'Return': return evalReturn(node, sc);
      case 'ExprStmt': return evalExprStmt(node, sc);
      case 'Capture': return evalCapture(node, sc);
      case 'Stop': throw new StopSignal();
      case 'Skip': throw new SkipSignal();
      case 'Add': return evalAdd(node, sc);
      case 'Remove': return evalRemove(node, sc);
      case 'Try': return evalTry(node, sc);
      case 'Assume': return evalAssume(node, sc);
      case 'Suppose': return evalSuppose(node, sc);
      case 'Use': return evalUse(node, sc);
      case 'On': return evalOn(node, sc);
      case 'Load': return evalLoad(node, sc);
      case 'Save': return evalSave(node, sc);
      case 'Make': return evalMake(node, sc);
      case 'Explain': return null; // TODO
      // pipeline transforms
      case 'Take': return evalTake(node, sc);
      case 'Filter': return evalFilter(node, sc);
      case 'Sort': return evalSort(node, sc);
      case 'Aggregate': return evalAggregate(node, sc);
      case 'Count': return evalCount(node, sc);
      case 'Limit': return evalLimit(node, sc);
      case 'Group': return evalGroup(node, sc);
      case 'Pick': return evalPick(node, sc);
      case 'Round': return evalRound(node, sc);
      case 'With': return evalWith(node, sc);
      case 'PipeCalled': return evalPipeCalled(node, sc);
      case 'Pipeline': return evalPipeline(node, sc);
      case 'PipeCall': return evalPipeCall(node, sc);
      default: throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  function evalExpr(node, sc) {
    step();
    try { return evalExprInner(node, sc); } catch (e) {
      if (e instanceof ReturnSignal || e instanceof StopSignal || e instanceof SkipSignal) throw e;
      if (e._softLine) throw e;
      lineError(node, e);
    }
  }
  function evalExprInner(node, sc) {
    switch (node.type) {
      case 'Num': return node.value;
      case 'Str': return node.value;
      case 'Regex': {
        // value is "pattern" or "pattern/flags"
        const v = node.value;
        const slashIdx = v.lastIndexOf('/');
        if (slashIdx > 0) return new RegExp(v.slice(0, slashIdx), v.slice(slashIdx + 1));
        return new RegExp(v);
      }
      case 'Bool': return node.value;
      case 'Nothing': return null;
      case 'Ref': return evalRef(node, sc);
      case 'Group': return evalExpr(node.expr, sc);
      case 'BinOp': return evalBinOp(node, sc);
      case 'Unary': return evalUnary(node, sc);
      case 'Compare': return evalCompare(node, sc);
      case 'Logic': return evalLogic(node, sc);
      case 'Of': return evalOf(node, sc);
      case 'LengthOf': return evalLengthOf(node, sc);
      case 'Call': return evalCall(node, sc);
      case 'List': return node.items.map(i => evalExpr(i, sc));
      case 'Record': return evalRecord(node, sc);
      case 'RecordWith': return evalRecordWith(node, sc);
      case 'Ternary': return evalTernary(node, sc);
      case 'Between': return evalBetween(node, sc);
      case 'TypeCheck': return evalTypeCheck(node, sc);
      case 'Invoke': return evalInvoke(node, sc);
      case 'RoundExpr': {
        const val = evalExpr(node.value, sc);
        const f = Math.pow(10, node.places);
        return Math.round(val * f) / f;
      }
      case 'Juxtapose': return node.parts.map(p => softString(evalExpr(p, sc))).join('');
      case 'Chunk': return evalChunk(node, sc);
      case 'ChunkRange': return evalChunkRange(node, sc);
      case 'CountChunks': return evalCountChunks(node, sc);
      case 'ThereIs': return sc[node.name] !== undefined && sc[node.name] !== null;
      case 'ThereIsNo': return sc[node.name] === undefined || sc[node.name] === null;
      default: throw new Error(`Unknown expr type: ${node.type}`);
    }
  }

  // ── statement evaluators ──

  function evalProgram(node, sc) {
    let result = null;
    for (const stmt of node.body) {
      result = evalNode(stmt, sc);
      if (result instanceof ReturnSignal) return result.value;
    }
    return result;
  }

  function evalBlock(body, sc) {
    let result = null;
    for (const stmt of body) {
      result = evalNode(stmt, sc);
      if (result instanceof ReturnSignal) return result;
    }
    return result;
  }

  function evalSay(node, sc) {
    const val = evalExpr(node.value, sc);
    output.push(val); // push raw value — cell handler decides rendering
    return null;
  }

  function evalSet(node, sc) {
    const val = evalExpr(node.value, sc);
    scopeSet(sc, node.name, val);
    return null;
  }

  // set grade of row to 60 → path = ['grade', 'row'], value = 60
  // resolves right to left: row.grade = 60
  function evalSetOf(node, sc) {
    const val = evalExpr(node.value, sc);
    const path = node.path; // ['grade', 'row'] or ['name', 'author', 'book']
    // rightmost name is the root object
    const root = sc[path[path.length - 1]];
    if (root == null) throw new Error(`"${path[path.length - 1]}" is not defined`);
    if (path.length === 2) {
      root[path[0]] = val;
    } else {
      // walk from right to left: book.author.name = val
      let obj = root;
      for (let i = path.length - 2; i > 0; i--) obj = obj[path[i]];
      obj[path[0]] = val;
    }
    return null;
  }

  // set word 2 of text to "big"
  function evalSetChunk(node, sc) {
    const val = evalExpr(node.value, sc);
    const idx = evalExpr(node.index, sc);
    const str = String(sc[node.target]);
    let result;
    switch (node.kind) {
      case 'character': {
        const chars = [...str];
        chars[idx] = String(val);
        result = chars.join('');
        break;
      }
      case 'word': {
        const words = str.split(/(\s+)/); // preserve whitespace
        let wordIdx = 0;
        for (let i = 0; i < words.length; i++) {
          if (!/^\s+$/.test(words[i])) {
            if (wordIdx === idx) { words[i] = String(val); break; }
            wordIdx++;
          }
        }
        result = words.join('');
        break;
      }
      case 'line': {
        const lines = str.split('\n');
        lines[idx] = String(val);
        result = lines.join('\n');
        break;
      }
      case 'item': {
        const items = str.split(',').map(s => s.trim());
        items[idx] = String(val);
        result = items.join(', ');
        break;
      }
      default: throw new Error(`Unknown chunk kind: ${node.kind}`);
    }
    scopeSet(sc, node.target, result);
    return null;
  }

  function evalIf(node, sc) {
    const cond = evalExpr(node.cond, sc);
    if (isTruthy(cond)) {
      return evalBlock(node.body, sc);
    } else if (node.elseBody) {
      return evalBlock(node.elseBody, sc);
    }
    return null;
  }

  function evalWhile(node, sc) {
    while (isTruthy(evalExpr(node.cond, sc))) {
      try {
        const r = evalBlock(node.body, sc);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalRepeat(node, sc) {
    const n = evalExpr(node.count, sc);
    for (let i = 0; i < n; i++) {
      try {
        const r = evalBlock(node.body, sc);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalForEach(node, sc) {
    const iter = evalExpr(node.iter, sc);
    if (!Array.isArray(iter)) throw new Error(`Cannot iterate over ${typeof iter}`);
    const loopScope = createScope(sc);
    for (const item of iter) {
      loopScope[node.varName] = item;
      try {
        const r = evalBlock(node.body, loopScope);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalRangeLoop(node, sc) {
    const from = evalExpr(node.from, sc);
    const to = evalExpr(node.to, sc);
    let stepVal = node.step ? evalExpr(node.step, sc) : (from <= to ? 1 : -1);
    const loopScope = createScope(sc);
    if (stepVal > 0) {
      for (let i = from; i <= to; i += stepVal) {
        loopScope[node.varName] = i;
        try {
          const r = evalBlock(node.body, loopScope);
          if (r instanceof ReturnSignal) return r;
        } catch (e) {
          if (e instanceof StopSignal) break;
          if (e instanceof SkipSignal) continue;
          throw e;
        }
      }
    } else {
      for (let i = from; i >= to; i += stepVal) {
        loopScope[node.varName] = i;
        try {
          const r = evalBlock(node.body, loopScope);
          if (r instanceof ReturnSignal) return r;
        } catch (e) {
          if (e instanceof StopSignal) break;
          if (e instanceof SkipSignal) continue;
          throw e;
        }
      }
    }
    return null;
  }

  function evalDefine(node, sc) {
    const fn = makeSoftFunction(node.name, node.sig, node.body, sc);
    sc[node.name] = fn;
    return null;
  }

  function makeSoftFunction(name, sig, body, defScope) {
    const fn = function (...args) {
      const callScope = createScope(defScope);
      // bind params from args
      let argIdx = 0;
      for (const p of sig) {
        if (p.variadic) {
          callScope[p.param] = args.slice(argIdx);
          break;
        }
        if (argIdx < args.length) {
          callScope[p.param] = args[argIdx++];
        } else if (p.default !== undefined) {
          // default may be an AST node (from parser) — evaluate it
          callScope[p.param] = (typeof p.default === 'object' && p.default && p.default.type)
            ? evalExpr(p.default, defScope) : p.default;
        } else {
          callScope[p.param] = null;
        }
      }
      const result = evalBlock(body, callScope);
      if (result instanceof ReturnSignal) return result.value;
      return null;
    };
    fn._softName = name;
    fn._softSig = sig;
    return fn;
  }

  function evalReturn(node, sc) {
    const val = node.value ? evalExpr(node.value, sc) : null;
    return new ReturnSignal(val);
  }

  function evalExprStmt(node, sc) {
    const val = evalExpr(node.expr, sc);
    sc.it = val;
    return val;
  }

  const STMT_TYPES = new Set(['Pipeline', 'Take', 'Filter', 'Sort', 'Aggregate', 'Count',
    'Limit', 'Group', 'Pick', 'Round', 'With', 'PipeCalled', 'ExprStmt']);
  function evalCapture(node, sc) {
    // Pipeline and transform nodes are statements, not expressions
    const val = STMT_TYPES.has(node.expr.type) ? evalNode(node.expr, sc) : evalExpr(node.expr, sc);
    sc.it = val;
    scopeSet(sc, node.name, sc.it); // use sc.it because pipeline transforms set it
    return null;
  }

  function evalAdd(node, sc) {
    const val = evalExpr(node.value, sc);
    const arr = sc[node.target];
    if (!Array.isArray(arr)) throw new Error(`Cannot add to non-list "${node.target}"`);
    arr.push(val);
    return null;
  }

  function evalRemove(node, sc) {
    const val = evalExpr(node.value, sc);
    const arr = sc[node.target];
    if (!Array.isArray(arr)) throw new Error(`Cannot remove from non-list "${node.target}"`);
    const idx = arr.indexOf(val);
    if (idx !== -1) arr.splice(idx, 1);
    return null;
  }

  function evalTry(node, sc) {
    try {
      return evalBlock(node.body, sc);
    } catch (e) {
      if (e instanceof ReturnSignal || e instanceof StopSignal || e instanceof SkipSignal) throw e;
      const handlerScope = createScope(sc);
      handlerScope['the error'] = e.message || String(e);
      return evalBlock(node.handler, handlerScope);
    }
  }

  function evalAssume(node, sc) {
    const cond = evalExpr(node.cond, sc);
    if (!isTruthy(cond)) {
      const msg = node.message ? evalExpr(node.message, sc) : 'Assumption failed';
      throw new Error(softString(msg));
    }
    return null;
  }

  function evalSuppose(node, sc) {
    const oldVal = sc[node.name];
    const val = evalExpr(node.value, sc);
    sc[node.name] = val;
    const result = evalBlock(node.body, sc);
    sc[node.name] = oldVal;
    if (result instanceof ReturnSignal) return result;
    return null;
  }

  function evalUse(node, sc) {
    // resolve dot-path from globals
    const parts = node.path.split('.');
    let val = globals;
    for (const p of parts) {
      if (val == null) throw new Error(`Cannot resolve "${node.path}"`);
      val = val[p];
    }
    const name = node.alias || parts[parts.length - 1];
    sc[name] = val;
    return null;
  }

  // ── host-dependent evaluators (file I/O, DOM, events) ──

  function evalLoad(node, sc) {
    const path = evalExpr(node.path, sc);
    if (!host.load) throw new Error('load is not available in this environment');
    const data = host.load(path);
    sc.it = data;
    if (node.name) scopeSet(sc, node.name, data);
    return data;
  }

  function evalSave(node, sc) {
    const value = evalExpr(node.value, sc);
    const path = evalExpr(node.path, sc);
    if (!host.save) throw new Error('save is not available in this environment');
    host.save(path, value);
    return null;
  }

  function evalMake(node, sc) {
    const tag = evalExpr(node.tag, sc);
    const parent = node.parent ? evalExpr(node.parent, sc) : null;
    if (!host.make) throw new Error('make is not available in this environment');
    const el = host.make(tag, parent);
    sc.it = el;
    if (node.name) scopeSet(sc, node.name, el);
    return el;
  }

  function evalOn(node, sc) {
    const event = node.event;
    const target = node.target ? sc[node.target] : null;
    if (!host.on) return null; // silently skip in headless
    const handler = (e) => {
      const handlerScope = createScope(sc);
      // inject event object properties into handler scope
      if (e) {
        if (node.target) handlerScope[node.target] = e.target || e;
        handlerScope['the event'] = e;
        // common event properties as bare names
        if (e.key !== undefined) handlerScope.key = e.key;
        if (e.target) handlerScope.target = e.target;
        if (e.value !== undefined) handlerScope.value = e.value;
        else if (e.target?.value !== undefined) handlerScope.value = e.target.value;
      }
      try { evalBlock(node.body, handlerScope); } catch (err) {
        if (err instanceof StopSignal) return;
        if (!(err instanceof ReturnSignal)) throw err;
      }
    };
    host.on(event, target, handler);
    return null;
  }

  // ── pipeline evaluators ──

  // helper: evaluate an expression in row context (bare identifiers resolve against row first)
  function evalInRowContext(node, row, sc) {
    const rowScope = createScope(sc);
    for (const [k, v] of Object.entries(row)) rowScope[k] = v;
    return evalExpr(node, rowScope);
  }

  function evalCondInRowContext(node, row, sc) {
    const rowScope = createScope(sc);
    for (const [k, v] of Object.entries(row)) rowScope[k] = v;
    return isTruthy(evalExpr(node, rowScope));
  }

  function pipeSet(sc, val) { sc.it = val; return val; }

  function evalTake(node, sc) {
    const val = sc[node.name];
    if (val === undefined) throw new Error(`"${node.name}" is not defined`);
    return pipeSet(sc, val);
  }

  function evalFilter(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot filter: not a list`);
    const keep = node.op === 'keep';
    const result = data.filter(row => {
      const match = evalCondInRowContext(node.cond, row, sc);
      return keep ? match : !match;
    });
    return pipeSet(sc, result);
  }

  function evalSort(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot sort: not a list`);
    const field = node.field;
    const desc = node.order === 'descending';
    const sorted = [...data].sort((a, b) => {
      const va = a[field], vb = b[field];
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
      return 0;
    });
    return pipeSet(sc, sorted);
  }

  function evalAggregate(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot aggregate: not a list`);
    const vals = data.map(r => r[node.field]);
    let result;
    switch (node.op) {
      case 'average': result = vals.reduce((s, v) => s + v, 0) / vals.length; break;
      case 'total': result = vals.reduce((s, v) => s + v, 0); break;
      case 'smallest': result = Math.min(...vals); break;
      case 'largest': result = Math.max(...vals); break;
      default: throw new Error(`Unknown aggregate: ${node.op}`);
    }
    return pipeSet(sc, result);
  }

  function evalCount(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot count: not a list`);
    return pipeSet(sc, data.length);
  }

  function evalLimit(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot limit: not a list`);
    const n = node.n ? evalExpr(node.n, sc) : 1;
    const result = node.op === 'first' ? data.slice(0, n) : data.slice(-n);
    return pipeSet(sc, result);
  }

  function evalGroup(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot group: not a list`);
    const field = node.field;
    const groups = new Map();
    for (const row of data) {
      const key = row[field];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const result = [];
    for (const [key, rows] of groups) {
      result.push({ [field]: key, rows, count: rows.length });
    }
    return pipeSet(sc, result);
  }

  function evalPick(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot pick: not a list`);
    if (node.fields.length === 1) {
      // single field → flat array of values
      const f = node.fields[0];
      return pipeSet(sc, data.map(r => r[f]));
    }
    // multiple fields → array of objects
    const result = data.map(r => {
      const obj = {};
      for (const f of node.fields) obj[f] = r[f];
      return obj;
    });
    return pipeSet(sc, result);
  }

  function evalRound(node, sc) {
    const val = node.value ? evalExpr(node.value, sc) : sc.it;
    if (typeof val !== 'number') throw new Error(`Cannot round: not a number`);
    const factor = Math.pow(10, node.places);
    return pipeSet(sc, Math.round(val * factor) / factor);
  }

  function evalWith(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot compute column: not a list`);
    const result = data.map(row => {
      const val = evalInRowContext(node.expr, row, sc);
      return { ...row, [node.field]: val };
    });
    return pipeSet(sc, result);
  }

  function evalPipeCalled(node, sc) {
    const val = evalNode(node.step, sc);
    scopeSet(sc, node.name, sc.it);
    return val;
  }

  function evalPipeline(node, sc) {
    for (const step of node.steps) evalNode(step, sc);
    return sc.it;
  }

  // function piping: "value then func" → func(value)
  function evalPipeCall(node, sc) {
    const val = sc.it;
    const expr = node.expr;
    // Call node: prepend piped value as first arg
    if (expr.type === 'Call') {
      const fn = expr.name.includes('.') ? evalDotPath(expr.name, sc) : sc[expr.name];
      if (typeof fn !== 'function') throw new Error(`"${expr.name}" is not a function`);
      const args = [val, ...expr.args.map(a => evalExpr(a, sc))];
      return pipeSet(sc, fn(...args));
    }
    // Ref node: call with piped value as only arg
    if (expr.type === 'Ref') {
      const fn = expr.name.includes('.') ? evalDotPath(expr.name, sc) : sc[expr.name];
      if (typeof fn !== 'function') throw new Error(`"${expr.name}" is not a function`);
      return pipeSet(sc, fn(val));
    }
    // fallback: just evaluate and set it
    const result = evalExpr(expr, sc);
    return pipeSet(sc, result);
  }

  function evalDotPath(name, sc) {
    const parts = name.split('.');
    let obj = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (obj == null) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }

  // ── expression evaluators ──

  function evalRef(node, sc) {
    const name = node.name;
    // check scope chain — return raw value, no auto-call
    if (name in sc) {
      return sc[name];
    }
    // check dot-path: scope first, then globals
    if (name.includes('.')) {
      const parts = name.split('.');
      let val = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
      for (let i = 1; i < parts.length; i++) {
        if (val == null) return null;
        val = val[parts[i]];
      }
      return val;
    }
    return undefined;
  }

  function evalBinOp(node, sc) {
    if (node.op === '&') {
      return softString(evalExpr(node.left, sc)) + softString(evalExpr(node.right, sc));
    }
    const left = evalExpr(node.left, sc);
    const right = evalExpr(node.right, sc);
    switch (node.op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right; // IEEE 754
      case '%': return left % right;
      case '**': return left ** right;
      case '<<': return left << right;
      case '>>': return left >> right;
      case 'bitand': return left & right;
      case 'bitor': return left | right;
      case 'bitxor': return left ^ right;
      default: throw new Error(`Unknown binop: ${node.op}`);
    }
  }

  function evalUnary(node, sc) {
    const val = evalExpr(node.expr, sc);
    switch (node.op) {
      case 'not': return !isTruthy(val);
      case 'neg': return -val;
      case 'bitnot': return ~val;
      default: throw new Error(`Unknown unary: ${node.op}`);
    }
  }

  function evalCompare(node, sc) {
    const left = evalExpr(node.left, sc);
    const right = evalExpr(node.right, sc);
    switch (node.op) {
      case '>': return left > right;
      case '<': return left < right;
      case '==':
        if (typeof left === 'string' && typeof right === 'string')
          return left.toLowerCase() === right.toLowerCase();
        return left === right;
      case '!=':
        if (typeof left === 'string' && typeof right === 'string')
          return left.toLowerCase() !== right.toLowerCase();
        return left !== right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      case 'contains':
        return String(left).toLowerCase().includes(String(right).toLowerCase());
      case 'matches':
        if (right instanceof RegExp) return right.test(String(left));
        return globMatch(String(left), String(right));
      default: throw new Error(`Unknown comparison: ${node.op}`);
    }
  }

  function evalLogic(node, sc) {
    const left = evalExpr(node.left, sc);
    if (node.op === 'and') return isTruthy(left) ? evalExpr(node.right, sc) : left;
    if (node.op === 'or') return isTruthy(left) ? left : evalExpr(node.right, sc);
    throw new Error(`Unknown logic op: ${node.op}`);
  }

  function evalOf(node, sc) {
    // flatten of-chain: name of author of book → [name, author, book]
    // Of nodes nest left: Of(Of(name, author), book)
    // Flatten props left-recursively, then obj is the root
    const chain = [];
    let n = node;
    while (n.type === 'Of') { chain.unshift(n.obj); n = n.prop; }
    chain.unshift(n); // leftmost prop (e.g. 'name')
    // chain is now [name, author, book] — leftmost prop first, root last
    // root is last, properties read right-to-left: book → .author → .name

    // evaluate root (last element)
    let obj = evalExpr(chain[chain.length - 1], sc);
    // walk properties right-to-left (from second-to-last down to first)
    for (let i = chain.length - 2; i >= 0; i--) {
      const prop = chain[i];
      let key;
      if (prop.type === 'Ref' && !prop.name.includes('.')) {
        key = prop.name;
      } else if (prop.type === 'Group') {
        key = evalExpr(prop, sc);
      } else {
        key = evalExpr(prop, sc);
      }
      // array mapping
      if (Array.isArray(obj)) { obj = obj.map(item => item?.[key]); continue; }
      if (obj == null) throw new Error('Cannot access property of nothing');
      obj = obj[key];
    }
    return obj;
  }

  function evalInvoke(node, sc) {
    const val = evalExpr(node.expr, sc);
    if (typeof val !== 'function') return val;
    const args = (node.args || []).map(a => evalExpr(a, sc));
    return val(...args);
  }

  function evalChunk(node, sc) {
    const target = evalExpr(node.target, sc);
    const idx = evalExpr(node.index, sc);
    const str = String(target);
    switch (node.kind) {
      case 'character': return str[idx] || '';
      case 'word': return (str.split(/\s+/)[idx]) || '';
      case 'line': return (str.split('\n')[idx]) || '';
      case 'item': return (str.split(',').map(s => s.trim())[idx]) || '';
      default: throw new Error(`Unknown chunk kind: ${node.kind}`);
    }
  }

  function evalChunkRange(node, sc) {
    const target = evalExpr(node.target, sc);
    const from = evalExpr(node.from, sc);
    const to = evalExpr(node.to, sc);
    const str = String(target);
    switch (node.kind) {
      case 'characters': return str.slice(from, to + 1);
      case 'words': return str.split(/\s+/).slice(from, to + 1).join(' ');
      case 'lines': return str.split('\n').slice(from, to + 1).join('\n');
      case 'items': return str.split(',').map(s => s.trim()).slice(from, to + 1).join(', ');
      default: throw new Error(`Unknown chunk range kind: ${node.kind}`);
    }
  }

  function evalCountChunks(node, sc) {
    const val = evalExpr(node.expr, sc);
    const str = String(val);
    switch (node.kind) {
      case 'characters': return str.length;
      case 'words': return str.split(/\s+/).filter(Boolean).length;
      case 'lines': return str.split('\n').length;
      case 'items': return str.split(',').length;
      default: throw new Error(`Unknown chunk count kind: ${node.kind}`);
    }
  }

  function evalLengthOf(node, sc) {
    const val = evalExpr(node.expr, sc);
    if (Array.isArray(val)) return val.length;
    if (typeof val === 'string') return val.length;
    return 0;
  }

  function evalCall(node, sc) {
    step();
    if (++callDepth > maxCallDepth) { callDepth--; throw new Error('Call depth exceeded (possible infinite recursion)'); }
    try {
    // resolve function
    let fn;
    if (node.name.includes('.')) {
      const parts = node.name.split('.');
      // resolve root: check scope first, then globals
      let obj = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
      for (let i = 1; i < parts.length - 1; i++) {
        if (obj == null) throw new Error(`Cannot resolve "${node.name}"`);
        obj = obj[parts[i]];
      }
      fn = obj?.[parts[parts.length - 1]];
      if (typeof fn === 'function') fn = fn.bind(obj);
    } else {
      fn = sc[node.name];
    }
    if (typeof fn !== 'function') {
      // if it's not a function but we have 0 args, just return the value
      if (node.args.length === 0) return fn;
      throw new Error(`"${node.name}" is not a function`);
    }
    const args = node.args.map(a => evalExpr(a, sc));
    return fn(...args);
    } finally { callDepth--; }
  }

  function evalRecord(node, sc) {
    const obj = {};
    for (const f of node.fields) obj[f.name] = evalExpr(f.value, sc);
    return obj;
  }

  function evalRecordWith(node, sc) {
    const obj = {};
    for (const f of node.fields) {
      obj[f.name] = f.ref ? sc[f.name] : evalExpr(f.value, sc);
    }
    return obj;
  }

  function evalTernary(node, sc) {
    return isTruthy(evalExpr(node.cond, sc))
      ? evalExpr(node.ifTrue, sc)
      : evalExpr(node.ifFalse, sc);
  }

  function evalBetween(node, sc) {
    const val = evalExpr(node.value, sc);
    const lo = evalExpr(node.lo, sc);
    const hi = evalExpr(node.hi, sc);
    return val >= lo && val <= hi;
  }

  function evalTypeCheck(node, sc) {
    const val = evalExpr(node.expr, sc);
    switch (node.typeName) {
      case 'number': case 'numbers': return typeof val === 'number';
      case 'text': return typeof val === 'string';
      case 'boolean': return typeof val === 'boolean';
      case 'list': return Array.isArray(val);
      case 'record': return typeof val === 'object' && val !== null && !Array.isArray(val);
      case 'nothing': return val === null || val === undefined;
      default: return false;
    }
  }

  // ── run ──
  evalNode(ast, scope);
  return { output, scope };
}
