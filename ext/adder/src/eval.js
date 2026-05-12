// adder v2 — tree-walking evaluator
// Evaluates AST nodes produced by the parser. All values are native JS values.

import { adderParse, _adderParseExpr } from './parse.js';
import {
  AdderError, AdderRange, Complex, adderBuiltins, adderModules, adderGetAttr,
  pyBool, pyTypeName, pyStr, pyRepr, pyIter, pyCollect, pyFormatValue,
  _excParents, getAdderVFS, _getVfsPath,
  _builtinEval, _builtinExec, _builtinSuper,
} from './builtins.js';

// ── scope ──

export class AdderScope {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
    this.globals = new Set();
    this.nonlocals = new Set();
  }
  get(name) {
    if (this.globals.has(name)) return this._getGlobal(name);
    if (this.nonlocals.has(name)) return this._getEnclosing(name);
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
  set(name, value) {
    if (this.globals.has(name)) { this._setGlobal(name, value); return; }
    if (this.nonlocals.has(name)) { this._setEnclosing(name, value); return; }
    this.vars.set(name, value);
  }
  has(name) {
    if (this.vars.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }
  delete(name) { this.vars.delete(name); }
  _getGlobal(name) {
    let s = this; while (s.parent) s = s.parent;
    if (s.vars.has(name)) return s.vars.get(name);
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
  _setGlobal(name, value) { let s = this; while (s.parent) s = s.parent; s.vars.set(name, value); }
  _getEnclosing(name) {
    let s = this.parent;
    while (s) { if (s.vars.has(name)) return s.vars.get(name); s = s.parent; }
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
  _setEnclosing(name, value) {
    let s = this.parent;
    while (s) { if (s.vars.has(name)) { s.vars.set(name, value); return; } s = s.parent; }
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
}

// ── control flow signals ──

class _BreakSignal { }
class _ContinueSignal { }
class _ReturnSignal { constructor(value) { this.value = value; } }

// ── evaluator ──

export async function adderEval(node, scope) {
  if (!node) return null;
  switch (node.type) {
    case 'Module': return _evalModule(node, scope);
    case 'Expr': return adderEval(node.value, scope);
    case 'Constant': {
      const v = node.value;
      if (v && typeof v === 'object' && v._complex) return new Complex(0, v.imag);
      return v;
    }
    case 'Name': return scope.get(node.id);
    case 'Pass': return null;
    case 'Break': throw new _BreakSignal();
    case 'Continue': throw new _ContinueSignal();
    case 'Return': throw new _ReturnSignal(node.value ? await adderEval(node.value, scope) : null);

    // ── assignments ──
    case 'Assign': {
      const value = await adderEval(node.value, scope);
      for (const target of node.targets) await _assignTarget(target, value, scope);
      return null;
    }
    case 'AugAssign': {
      const current = await _evalTarget(node.target, scope);
      const value = await adderEval(node.value, scope);
      const iDunder = _iDunders[node.op];
      let result;
      if (iDunder && current !== null && typeof current === 'object' && typeof current[iDunder] === 'function') {
        result = current[iDunder](value);
      } else {
        result = _binOp(node.op, current, value, node.line);
      }
      await _assignTarget(node.target, result, scope);
      return null;
    }
    case 'AnnAssign': {
      if (node.value) {
        const value = await adderEval(node.value, scope);
        await _assignTarget(node.target, value, scope);
      }
      return null;
    }

    // ── control flow ──
    case 'If': {
      const test = await adderEval(node.test, scope);
      if (pyBool(test)) { for (const s of node.body) await adderEval(s, scope); }
      else { for (const s of node.orelse) await adderEval(s, scope); }
      return null;
    }
    case 'For': return _evalFor(node, scope);
    case 'While': return _evalWhile(node, scope);
    case 'With': return _evalWith(node, scope);

    // ── functions / classes ──
    case 'FunctionDef': case 'AsyncFunctionDef': {
      let fn = _makeFunction(node, scope);
      for (let i = node.decorators.length - 1; i >= 0; i--) {
        const dec = await adderEval(node.decorators[i], scope);
        fn = await _callValue(dec, [fn], [], node.line);
      }
      fn._pyName = node.name;
      scope.set(node.name, fn);
      return null;
    }
    case 'ClassDef': return _evalClass(node, scope);
    case 'Lambda': return _makeLambda(node, scope);

    // ── exceptions ──
    case 'Try': return _evalTry(node, scope);
    case 'Raise': {
      const exc = node.exc ? await adderEval(node.exc, scope) : null;
      if (exc instanceof AdderError) throw exc;
      if (exc instanceof Error) throw exc;
      if (typeof exc === 'function') throw await _callValue(exc, [], [], node.line);
      throw new AdderError('RuntimeError', exc ? pyStr(exc) : 're-raise outside except', node.line);
    }
    case 'Assert': {
      const test = await adderEval(node.test, scope);
      if (!pyBool(test)) {
        const msg = node.msg ? await adderEval(node.msg, scope) : 'assertion failed';
        throw new AdderError('AssertionError', pyStr(msg), node.line);
      }
      return null;
    }

    // ── scope declarations ──
    case 'Global': { for (const n of node.names) scope.globals.add(n); return null; }
    case 'Nonlocal': { for (const n of node.names) scope.nonlocals.add(n); return null; }
    case 'Delete': { for (const t of node.targets) await _deleteTarget(t, scope); return null; }

    // ── imports ──
    case 'Import': return _evalImport(node, scope);
    case 'ImportFrom': return _evalImportFrom(node, scope);

    // ── expressions ──
    case 'BinOp': {
      const left = await adderEval(node.left, scope);
      const right = await adderEval(node.right, scope);
      return _binOp(node.op, left, right, node.line);
    }
    case 'UnaryOp': {
      const operand = await adderEval(node.operand, scope);
      if (node.op === '-') return typeof operand === 'number' ? -operand : (typeof operand?.__neg__ === 'function' ? operand.__neg__() : -operand);
      if (node.op === '+') return +operand;
      if (node.op === '~') return typeof operand?.__invert__ === 'function' ? operand.__invert__() : ~operand;
      if (node.op === 'not') return !pyBool(operand);
      throw new AdderError('TypeError', `unsupported unary op: ${node.op}`, node.line);
    }
    case 'BoolOp': {
      if (node.op === 'or') {
        let result;
        for (const v of node.values) { result = await adderEval(v, scope); if (pyBool(result)) return result; }
        return result;
      }
      let result;
      for (const v of node.values) { result = await adderEval(v, scope); if (!pyBool(result)) return result; }
      return result;
    }
    case 'Compare': {
      let left = await adderEval(node.left, scope);
      // single comparison: return dunder result directly (e.g. BooleanMask from Series.__gt__)
      if (node.ops.length === 1) {
        const right = await adderEval(node.comparators[0], scope);
        return _compareOp(node.ops[0], left, right);
      }
      // chained comparisons: coerce to boolean (a < b < c → a < b and b < c)
      for (let i = 0; i < node.ops.length; i++) {
        const right = await adderEval(node.comparators[i], scope);
        if (!_compareOp(node.ops[i], left, right)) return false;
        left = right;
      }
      return true;
    }
    case 'IfExp': {
      const test = await adderEval(node.test, scope);
      return pyBool(test) ? adderEval(node.body, scope) : adderEval(node.orelse, scope);
    }

    // ── calls ──
    case 'Call': return _evalCall(node, scope);

    // ── attribute / subscript ──
    case 'Attribute': {
      const obj = await adderEval(node.value, scope);
      return adderGetAttr(obj, node.attr);
    }
    case 'Subscript': return _evalSubscript(node, scope);

    // ── collections ──
    case 'List': { const elts = []; for (const e of node.elts) { if (e.type === 'Starred') { for (const v of pyIter(await adderEval(e.value, scope))) elts.push(v); } else elts.push(await adderEval(e, scope)); } return elts; }
    case 'Tuple': { const elts = []; for (const e of node.elts) { if (e.type === 'Starred') { for (const v of pyIter(await adderEval(e.value, scope))) elts.push(v); } else elts.push(await adderEval(e, scope)); } return elts; }
    case 'Dict': {
      const allStringKeys = node.keys.every(k => k && (k.type === 'Constant' && typeof k.value === 'string') || k === null);
      if (allStringKeys) {
        const obj = {};
        for (let i = 0; i < node.keys.length; i++) {
          if (node.keys[i] === null) { // **unpack
            const src = await adderEval(node.values[i], scope);
            if (src instanceof Map) { for (const [k, v] of src) obj[k] = v; }
            else { Object.assign(obj, src); }
          } else {
            obj[await adderEval(node.keys[i], scope)] = await adderEval(node.values[i], scope);
          }
        }
        return obj;
      }
      const map = new Map();
      for (let i = 0; i < node.keys.length; i++) {
        if (node.keys[i] === null) {
          const src = await adderEval(node.values[i], scope);
          if (src instanceof Map) { for (const [k, v] of src) map.set(k, v); }
          else { for (const k of Object.keys(src)) map.set(k, src[k]); }
        } else {
          map.set(await adderEval(node.keys[i], scope), await adderEval(node.values[i], scope));
        }
      }
      return map;
    }
    case 'Set': {
      const s = new Set();
      for (const e of node.elts) s.add(await adderEval(e, scope));
      return s;
    }

    // ── comprehensions ──
    case 'ListComp': return _evalComp(node, scope, 'list');
    case 'SetComp': return _evalComp(node, scope, 'set');
    case 'DictComp': return _evalComp(node, scope, 'dict');
    case 'GeneratorExp': return _evalGenExpr(node, scope);

    // ── f-strings ──
    case 'JoinedStr': {
      let result = '';
      for (const v of node.values) result += await adderEval(v, scope);
      return result;
    }
    case 'FormattedValue': {
      let val = await adderEval(node.value, scope);
      if (node.conversion === 'r') val = pyRepr(val);
      else if (node.conversion === 's') val = pyStr(val);
      return node.formatSpec ? pyFormatValue(val, node.formatSpec) : pyStr(val);
    }

    // ── await ──
    case 'Await': return await (await adderEval(node.value, scope));
    case 'Yield': throw new AdderError('SyntaxError', 'yield outside function', node.line);
    case 'YieldFrom': throw new AdderError('SyntaxError', 'yield outside function', node.line);
    case 'NamedExpr': { const value = await adderEval(node.value, scope); scope.set(node.target.id, value); return value; }

    // ── starred (in expression context) ──
    case 'Starred': return await adderEval(node.value, scope);

    // ── slice (standalone) ──
    case 'Slice': return { _slice: true, lower: node.lower ? await adderEval(node.lower, scope) : null, upper: node.upper ? await adderEval(node.upper, scope) : null, step: node.step ? await adderEval(node.step, scope) : null };

    default:
      throw new AdderError('RuntimeError', `Unknown AST node type: ${node.type}`, node.line);
  }
}

// ── module execution ──

async function _evalModule(node, scope) {
  let lastExpr = undefined;
  for (let i = 0; i < node.body.length; i++) {
    const stmt = node.body[i];
    if (i === node.body.length - 1 && stmt.type === 'Expr') {
      lastExpr = await adderEval(stmt.value, scope);
    } else {
      await adderEval(stmt, scope);
    }
  }
  return lastExpr;
}

// ── assignment / target helpers ──

async function _assignTarget(target, value, scope) {
  switch (target.type) {
    case 'Name': scope.set(target.id, value); break;
    case 'Attribute': {
      const obj = await adderEval(target.value, scope);
      // check for @property setter on prototype chain (async — can't use JS setter directly)
      for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, target.attr);
        if (d?.set?._pyFset) { await d.set._pyFset(obj, value); return null; }
        if (d) break;
      }
      obj[target.attr] = value;
      break;
    }
    case 'Subscript': {
      const obj = await adderEval(target.value, scope);
      if (target.slice.type === 'Slice') {
        const lower = target.slice.lower ? await adderEval(target.slice.lower, scope) : null;
        const upper = target.slice.upper ? await adderEval(target.slice.upper, scope) : null;
        const step = target.slice.step ? await adderEval(target.slice.step, scope) : null;
        if (typeof obj?.__setitem__ === 'function') {
          await obj.__setitem__({ _slice: true, lower, upper, step }, value);
        } else {
          _applySliceAssign(obj, lower, upper, step, value, target.line);
        }
        break;
      }
      const key = await adderEval(target.slice, scope);
      if (obj instanceof Map) obj.set(key, value);
      else if (typeof obj?.__setitem__ === 'function') obj.__setitem__(key, value);
      else obj[key] = value;
      break;
    }
    case 'Tuple': case 'List': {
      const items = [...pyIter(value)];
      const starIdx = target.elts.findIndex(e => e.type === 'Starred');
      if (starIdx >= 0) {
        // starred unpacking
        const before = target.elts.slice(0, starIdx);
        const after = target.elts.slice(starIdx + 1);
        for (let i = 0; i < before.length; i++) await _assignTarget(before[i], items[i], scope);
        const starItems = items.slice(before.length, items.length - after.length);
        await _assignTarget(target.elts[starIdx].value, starItems, scope);
        for (let i = 0; i < after.length; i++) await _assignTarget(after[i], items[items.length - after.length + i], scope);
      } else {
        for (let i = 0; i < target.elts.length; i++) await _assignTarget(target.elts[i], items[i], scope);
      }
      break;
    }
    case 'Starred': await _assignTarget(target.value, value, scope); break;
    default: throw new AdderError('RuntimeError', `Cannot assign to ${target.type}`);
  }
}

async function _evalTarget(target, scope) {
  if (target.type === 'Name') return scope.get(target.id);
  if (target.type === 'Attribute') { const obj = await adderEval(target.value, scope); return obj[target.attr]; }
  if (target.type === 'Subscript') { return _evalSubscript(target, scope); }
  throw new AdderError('RuntimeError', `Cannot read target ${target.type}`);
}

async function _deleteTarget(target, scope) {
  if (target.type === 'Name') { scope.delete(target.id); return; }
  if (target.type === 'Attribute') { const obj = await adderEval(target.value, scope); delete obj[target.attr]; return; }
  if (target.type === 'Subscript') {
    const obj = await adderEval(target.value, scope);
    if (target.slice.type === 'Slice') {
      const lower = target.slice.lower ? await adderEval(target.slice.lower, scope) : null;
      const upper = target.slice.upper ? await adderEval(target.slice.upper, scope) : null;
      const step = target.slice.step ? await adderEval(target.slice.step, scope) : null;
      if (typeof obj?.__delitem__ === 'function') {
        await obj.__delitem__({ _slice: true, lower, upper, step });
      } else {
        _applySliceDelete(obj, lower, upper, step, target.line);
      }
      return;
    }
    const key = await adderEval(target.slice, scope);
    if (obj instanceof Map) obj.delete(key);
    else if (Array.isArray(obj)) obj.splice(key, 1);
    else delete obj[key];
    return;
  }
}

// ── binary operations ──

function _binOp(op, left, right, line) {
  // check dunder methods (left operand first, then reflected on right)
  if (left !== null && typeof left === 'object') {
    const dunder = _dunders[op];
    if (dunder && typeof left[dunder] === 'function') return left[dunder](right);
  }
  if (right !== null && typeof right === 'object') {
    const rdunder = _rdunders[op];
    if (rdunder && typeof right[rdunder] === 'function') return right[rdunder](left);
  }
  switch (op) {
    case '+':
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      if (typeof left === 'string' && typeof right === 'string') return left + right;
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
      throw new AdderError('TypeError', `unsupported operand type(s) for +: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '-':
      if (typeof left === 'number' && typeof right === 'number') return left - right;
      throw new AdderError('TypeError', `unsupported operand type(s) for -: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '*':
      if (typeof left === 'number' && typeof right === 'number') return left * right;
      if (typeof left === 'string' && typeof right === 'number') return left.repeat(right);
      if (typeof left === 'number' && typeof right === 'string') return right.repeat(left);
      if (Array.isArray(left) && typeof right === 'number') { const r = []; for (let i = 0; i < right; i++) r.push(...left); return r; }
      throw new AdderError('TypeError', `unsupported operand type(s) for *: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '/':
      if (right === 0) throw new AdderError('ZeroDivisionError', 'division by zero', line);
      if (typeof left === 'number' && typeof right === 'number') return left / right;
      throw new AdderError('TypeError', `unsupported operand type(s) for /: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '//':
      if (right === 0) throw new AdderError('ZeroDivisionError', 'integer division or modulo by zero', line);
      if (typeof left === 'number' && typeof right === 'number') return Math.floor(left / right);
      throw new AdderError('TypeError', `unsupported operand type(s) for //: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '%': if (right === 0) throw new AdderError('ZeroDivisionError', 'integer division or modulo by zero', line);
      if (typeof left === 'string') return _strPercentFormat(left, Array.isArray(right) ? right : [right]);
      if (typeof left === 'number' && typeof right === 'number') return ((left % right) + right) % right;
      throw new AdderError('TypeError', `unsupported operand type(s) for %: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '**':
      if (typeof left === 'number' && typeof right === 'number') return Math.pow(left, right);
      throw new AdderError('TypeError', `unsupported operand type(s) for **: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '&': return left & right;
    case '|': return left | right;
    case '^': return left ^ right;
    case '<<': return left << right;
    case '>>': return left >> right;
    case '@': throw new AdderError('TypeError', `unsupported operand type(s) for @: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    default: throw new AdderError('TypeError', `unsupported operator: ${op}`, line);
  }
}

function _strPercentFormat(fmt, args) {
  // Python % formatting: "%s %d" % (arg1, arg2)
  let i = 0;
  return fmt.replace(/%([sd%fegx])/g, (_, code) => {
    if (code === '%') return '%';
    return pyStr(args[i++]);
  });
}

const _dunders = {
  '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__truediv__',
  '//': '__floordiv__', '%': '__mod__', '**': '__pow__',
  '&': '__and__', '|': '__or__', '^': '__xor__',
  '<<': '__lshift__', '>>': '__rshift__', '@': '__matmul__',
};

const _rdunders = {
  '+': '__radd__', '-': '__rsub__', '*': '__rmul__', '/': '__rtruediv__',
  '//': '__rfloordiv__', '%': '__rmod__', '**': '__rpow__', '@': '__rmatmul__',
};

const _iDunders = {
  '+': '__iadd__', '-': '__isub__', '*': '__imul__', '/': '__itruediv__',
  '//': '__ifloordiv__', '%': '__imod__', '**': '__ipow__',
  '&': '__iand__', '|': '__ior__', '^': '__ixor__',
  '<<': '__ilshift__', '>>': '__irshift__', '@': '__imatmul__',
};

// ── comparison ──

function _compareOp(op, left, right) {
  switch (op) {
    case '==': return _pyEq(left, right);
    case '!=': return typeof left?.__ne__ === 'function' ? left.__ne__(right) : !_pyEq(left, right);
    case '<': return typeof left?.__lt__ === 'function' ? left.__lt__(right) : left < right;
    case '<=': return typeof left?.__le__ === 'function' ? left.__le__(right) : left <= right;
    case '>': return typeof left?.__gt__ === 'function' ? left.__gt__(right) : left > right;
    case '>=': return typeof left?.__ge__ === 'function' ? left.__ge__(right) : left >= right;
    case 'in': return _pyIn(right, left);
    case 'not in': return !_pyIn(right, left);
    case 'is': return left === right;
    case 'is not': return left !== right;
    default: throw new AdderError('TypeError', `unsupported comparison: ${op}`);
  }
}

function _pyEq(a, b) {
  if (a === b) return true;
  if (typeof a?.__eq__ === 'function') return a.__eq__(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_pyEq(a[i], b[i])) return false;
    return true;
  }
  return false;
}

function _pyIn(container, value) {
  if (typeof container === 'string') return container.includes(String(value));
  if (Array.isArray(container)) return container.some(v => _pyEq(v, value));
  if (container instanceof Map) return container.has(value);
  if (container instanceof Set) return container.has(value);
  if (container instanceof AdderRange) return container.includes(value);
  if (typeof container === 'object' && container !== null) {
    if (typeof container.__contains__ === 'function') return container.__contains__(value);
    return value in container;
  }
  throw new AdderError('TypeError', `argument of type '${pyTypeName(container)}' is not iterable`);
}

// ── subscript ──

async function _evalSubscript(node, scope) {
  const obj = await adderEval(node.value, scope);
  if (node.slice.type === 'Slice') {
    const lower = node.slice.lower ? await adderEval(node.slice.lower, scope) : null;
    const upper = node.slice.upper ? await adderEval(node.slice.upper, scope) : null;
    const step = node.slice.step ? await adderEval(node.slice.step, scope) : null;
    if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array)
      return _applySlice(obj, lower, upper, step);
    if (typeof obj?.__getitem__ === 'function')
      return obj.__getitem__({ _slice: true, lower, upper, step });
    return _applySlice(obj, lower, upper, step);
  }
  const key = await adderEval(node.slice, scope);
  if (obj instanceof Map) {
    if (!obj.has(key)) throw new AdderError('KeyError', pyRepr(key), node.line);
    return obj.get(key);
  }
  if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) {
    const idx = key < 0 ? obj.length + key : key;
    if (idx < 0 || idx >= obj.length) throw new AdderError('IndexError', `${pyTypeName(obj)} index out of range`, node.line);
    return obj[idx];
  }
  if (typeof obj === 'object' && obj !== null) {
    if (typeof obj.__getitem__ === 'function') return obj.__getitem__(key);
    if (key in obj) return obj[key];
    throw new AdderError('KeyError', pyRepr(key), node.line);
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not subscriptable`, node.line);
}

function _applySlice(obj, lower, upper, step) {
  if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) {
    const len = obj.length;
    step = step ?? 1;
    if (step === 0) throw new AdderError('ValueError', 'slice step cannot be zero');
    if (step === 1) {
      const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
      const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
      return typeof obj === 'string' ? obj.slice(l, u) : obj.slice(l, u);
    }
    // general step
    let start, stop;
    if (step > 0) {
      start = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
      stop = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
    } else {
      start = lower == null ? len - 1 : lower < 0 ? Math.max(-1, len + lower) : Math.min(lower, len - 1);
      stop = upper == null ? -1 : upper < 0 ? Math.max(-1, len + upper) : upper;
    }
    const result = [];
    if (step > 0) { for (let i = start; i < stop; i += step) result.push(obj[i]); }
    else { for (let i = start; i > stop; i += step) result.push(obj[i]); }
    return typeof obj === 'string' ? result.join('') : result;
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support slicing`);
}

// Compute the index positions a slice covers, in iteration order. Mirrors
// _applySlice's clamping. Returns [] when the slice is empty.
function _sliceIndices(len, lower, upper, step) {
  step = step ?? 1;
  if (step === 0) throw new AdderError('ValueError', 'slice step cannot be zero');
  let start, stop;
  if (step > 0) {
    start = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
    stop = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
  } else {
    start = lower == null ? len - 1 : lower < 0 ? Math.max(-1, len + lower) : Math.min(lower, len - 1);
    stop = upper == null ? -1 : upper < 0 ? Math.max(-1, len + upper) : upper;
  }
  const out = [];
  if (step > 0) { for (let i = start; i < stop; i += step) out.push(i); }
  else { for (let i = start; i > stop; i += step) out.push(i); }
  return out;
}

function _applySliceAssign(obj, lower, upper, step, value, line) {
  if (typeof obj === 'string') {
    throw new AdderError('TypeError', "'str' object does not support item assignment", line);
  }
  if (obj instanceof Uint8Array) {
    throw new AdderError('TypeError', "'bytes' object does not support item assignment", line);
  }
  if (!Array.isArray(obj)) {
    throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support slice assignment`, line);
  }
  const rhs = [...pyIter(value)];
  const effectiveStep = step ?? 1;
  if (effectiveStep === 1) {
    // Simple slice — splice handles length changes (shrink / grow / insert).
    const len = obj.length;
    const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
    const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
    const removeCount = Math.max(0, u - l);
    obj.splice(l, removeCount, ...rhs);
    return;
  }
  // Extended slice — same-length requirement.
  const indices = _sliceIndices(obj.length, lower, upper, step);
  if (rhs.length !== indices.length) {
    throw new AdderError(
      'ValueError',
      `attempt to assign sequence of size ${rhs.length} to extended slice of size ${indices.length}`,
      line,
    );
  }
  for (let k = 0; k < indices.length; k++) obj[indices[k]] = rhs[k];
}

function _applySliceDelete(obj, lower, upper, step, line) {
  if (typeof obj === 'string') {
    throw new AdderError('TypeError', "'str' object doesn't support item deletion", line);
  }
  if (obj instanceof Uint8Array) {
    throw new AdderError('TypeError', "'bytes' object doesn't support item deletion", line);
  }
  if (!Array.isArray(obj)) {
    throw new AdderError('TypeError', `'${pyTypeName(obj)}' object doesn't support slice deletion`, line);
  }
  const effectiveStep = step ?? 1;
  if (effectiveStep === 1) {
    const len = obj.length;
    const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
    const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
    if (u > l) obj.splice(l, u - l);
    return;
  }
  const indices = _sliceIndices(obj.length, lower, upper, step);
  // Sort descending so each splice doesn't shift the remaining indices.
  indices.sort((a, b) => b - a);
  for (const i of indices) obj.splice(i, 1);
}

// ── function call ──

async function _evalCall(node, scope) {
  const func = await adderEval(node.func, scope);
  const args = [];
  for (const a of node.args) {
    if (a.type === 'Starred') { for (const v of pyIter(await adderEval(a.value, scope))) args.push(v); }
    else args.push(await adderEval(a, scope));
  }
  const kwArgs = [];
  for (const kw of node.keywords) {
    if (kw.name === null) {
      const obj = await adderEval(kw.value, scope);
      if (obj instanceof Map) { for (const [k, v] of obj) kwArgs.push([k, v]); }
      else { for (const k of Object.keys(obj)) kwArgs.push([k, obj[k]]); }
    } else {
      kwArgs.push([kw.name, await adderEval(kw.value, scope)]);
    }
  }
  // special builtins that need caller's scope
  if (func._sentinel === 'super') return _evalSuperCall(args, scope, node.line);
  if (func._sentinel === 'eval') return _evalBuiltinEval(args, scope, node.line);
  if (func._sentinel === 'exec') return _evalBuiltinExec(args, scope, node.line);
  return _callValue(func, args, kwArgs, node.line);
}

// ── call stack for tracebacks ──

const _callStack = [];

async function _callValue(func, args, kwArgs, line) {
  if (typeof func !== 'function') {
    if (typeof func === 'object' && func !== null && typeof func.__call__ === 'function') {
      return _callValue(func.__call__.bind(func), args, kwArgs, line);
    }
    throw new AdderError('TypeError', `'${pyTypeName(func)}' object is not callable`, line);
  }
  const name = func._pyName || func.name || '<anonymous>';
  _callStack.push({ name, line });
  try {
    if (kwArgs.length > 0) {
      if (func._pyFunc) {
        return await func(...args, ...kwArgs.map(([_, v]) => v), { _kw: true, ...Object.fromEntries(kwArgs) });
      }
      const kw = { _kw: true };
      for (const [k, v] of kwArgs) kw[k] = v;
      try {
        return await func(...args, kw);
      } catch (e) {
        if (e instanceof TypeError && /\bnew\b/.test(e.message)) return new func(...args, kw);
        if (e instanceof AdderError || e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
        throw new AdderError('RuntimeError', e.message || String(e), line);
      }
    }
    return await func(...args);
  } catch (e) {
    if (e instanceof TypeError && /\bnew\b/.test(e.message)) {
      try { return new func(...args); } catch (e2) {
        if (e2 instanceof AdderError) throw e2;
        throw new AdderError('RuntimeError', e2.message || String(e2), line);
      }
    }
    if (e instanceof AdderError) {
      if (!e._tracebackSet) { e._traceback = _callStack.map(f => ({ ...f })); e._tracebackSet = true; }
      throw e;
    }
    if (e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
    const ae = new AdderError('RuntimeError', e.message || String(e), line);
    ae._traceback = _callStack.map(f => ({ ...f }));
    ae._tracebackSet = true;
    throw ae;
  } finally {
    _callStack.pop();
  }
}

// ── function creation ──

function _hasYield(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Yield' || node.type === 'YieldFrom') return true;
  // don't descend into nested function/class defs
  if (node.type === 'FunctionDef' || node.type === 'AsyncFunctionDef' || node.type === 'ClassDef' || node.type === 'Lambda') return false;
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) { for (const item of val) { if (_hasYield(item)) return true; } }
    else if (val && typeof val === 'object' && val.type) { if (_hasYield(val)) return true; }
  }
  return false;
}

function _makeFunction(node, scope) {
  const isAsync = node.type === 'AsyncFunctionDef';
  const isGenerator = node.body.some(s => _hasYield(s));

  if (isGenerator) return _makeGeneratorFunction(node, scope);

  const fn = async function (...callArgs) {
    const localScope = new AdderScope(scope);
    // bind parameters
    await _bindParams(node, callArgs, localScope);
    // execute body
    try {
      for (let i = 0; i < node.body.length; i++) {
        const stmt = node.body[i];
        // docstring — skip first string expression
        if (i === 0 && stmt.type === 'Expr' && stmt.value.type === 'Constant' && typeof stmt.value.value === 'string') {
          fn.__doc__ = stmt.value.value;
          continue;
        }
        await adderEval(stmt, localScope);
      }
      return null;
    } catch (e) {
      if (e instanceof _ReturnSignal) return e.value;
      throw e;
    }
  };
  fn._pyFunc = true;
  fn._pyName = node.name;
  return fn;
}

function _makeGeneratorFunction(node, scope) {
  // Generator functions use a _YieldSignal to communicate yield values
  // back to the async-generator wrapper.
  const fn = function (...callArgs) {
    // Return an object that implements both sync and async iteration.
    // We use an async generator internally, exposed via Symbol.asyncIterator.
    // For sync consumers (for..of), we also provide Symbol.iterator
    // that collects eagerly — but the primary path is for-await.
    const genObj = {
      [Symbol.asyncIterator]() {
        return _runGenerator(node, scope, callArgs);
      },
      // sync iterator: collect all values eagerly (used by list(), sorted(), etc.)
      [Symbol.iterator]() {
        throw new AdderError('TypeError', 'Use "for await" or list() with generators');
      },
    };
    return genObj;
  };
  fn._pyFunc = true;
  fn._pyName = node.name;
  fn._isGenerator = true;
  return fn;
}

async function* _runGenerator(node, scope, callArgs) {
  const localScope = new AdderScope(scope);
  await _bindParams(node, callArgs, localScope);
  try {
    for (let i = 0; i < node.body.length; i++) {
      const stmt = node.body[i];
      if (i === 0 && stmt.type === 'Expr' && stmt.value.type === 'Constant' && typeof stmt.value.value === 'string') continue;
      yield* await _evalGenStmt(stmt, localScope);
    }
  } catch (e) {
    if (e instanceof _ReturnSignal) return;
    throw e;
  }
}

async function* _evalGenStmt(node, scope) {
  // Like adderEval but yields instead of throwing for Yield nodes
  switch (node.type) {
    case 'Expr':
      if (node.value.type === 'Yield') {
        yield node.value.value ? await adderEval(node.value.value, scope) : null;
        return;
      }
      if (node.value.type === 'YieldFrom') {
        const iterable = await adderEval(node.value.value, scope);
        if (iterable[Symbol.asyncIterator]) { for await (const v of iterable) yield v; }
        else { for (const v of pyIter(iterable)) yield v; }
        return;
      }
      await adderEval(node, scope);
      return;
    case 'For': {
      const iterable = await adderEval(node.iter, scope);
      let broke = false;
      const iter = iterable[Symbol.asyncIterator] ? iterable : pyIter(iterable);
      for await (const value of iter) {
        await _assignTarget(node.target, value, scope);
        try {
          for (const stmt of node.body) yield* await _evalGenStmt(stmt, scope);
        } catch (e) {
          if (e instanceof _BreakSignal) { broke = true; break; }
          if (e instanceof _ContinueSignal) continue;
          throw e;
        }
      }
      if (!broke) for (const stmt of node.orelse) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    case 'While': {
      let broke = false, iterations = 0;
      while (pyBool(await adderEval(node.test, scope))) {
        if (++iterations > 1000000) throw new AdderError('RuntimeError', 'maximum loop iterations exceeded');
        try {
          for (const stmt of node.body) yield* await _evalGenStmt(stmt, scope);
        } catch (e) {
          if (e instanceof _BreakSignal) { broke = true; break; }
          if (e instanceof _ContinueSignal) continue;
          throw e;
        }
      }
      if (!broke) for (const stmt of node.orelse) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    case 'If': {
      const test = await adderEval(node.test, scope);
      const branch = pyBool(test) ? node.body : node.orelse;
      for (const stmt of branch) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    case 'Try': {
      try {
        for (const stmt of node.body) yield* await _evalGenStmt(stmt, scope);
      } catch (e) {
        if (e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
        let handled = false;
        for (const handler of node.handlers) {
          let excTypeVal = null;
          if (handler.excType) try { excTypeVal = await adderEval(handler.excType, scope); } catch {}
          if (!handler.excType || _matchException(e, excTypeVal)) {
            if (handler.name) scope.set(handler.name, e);
            handled = true;
            for (const stmt of handler.body) yield* await _evalGenStmt(stmt, scope);
            break;
          }
        }
        if (!handled) { for (const stmt of node.finalbody) yield* await _evalGenStmt(stmt, scope); throw e; }
      }
      for (const stmt of node.finalbody) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    default:
      // non-yielding statements — just eval normally
      await adderEval(node, scope);
  }
}

async function _bindParams(node, callArgs, localScope) {
  const { params, vararg, kwonly, kwarg } = node;
  let positionalIdx = 0;
  let kwObj = null;

  // check if last arg is keyword bag
  if (callArgs.length > 0 && callArgs[callArgs.length - 1]?._kw) {
    kwObj = callArgs.pop();
  }

  // bind positional params
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (positionalIdx < callArgs.length) {
      localScope.set(p.name, callArgs[positionalIdx++]);
    } else if (kwObj && p.name in kwObj) {
      localScope.set(p.name, kwObj[p.name]);
    } else if (p.default) {
      localScope.set(p.name, await adderEval(p.default, localScope));
    } else {
      throw new AdderError('TypeError', `${node.name}() missing required argument: '${p.name}'`);
    }
  }

  // vararg
  if (vararg) {
    localScope.set(vararg, callArgs.slice(positionalIdx));
    positionalIdx = callArgs.length;
  }

  // keyword-only params
  for (const p of kwonly) {
    if (kwObj && p.name in kwObj) {
      localScope.set(p.name, kwObj[p.name]);
    } else if (p.default) {
      localScope.set(p.name, await adderEval(p.default, localScope));
    } else {
      throw new AdderError('TypeError', `${node.name}() missing keyword argument: '${p.name}'`);
    }
  }

  // **kwargs
  if (kwarg) {
    const extra = {};
    if (kwObj) {
      const usedNames = new Set([...params.map(p => p.name), ...kwonly.map(p => p.name), '_kw']);
      for (const k of Object.keys(kwObj)) {
        if (!usedNames.has(k)) extra[k] = kwObj[k];
      }
    }
    localScope.set(kwarg, extra);
  }
}

function _makeLambda(node, scope) {
  const fn = async function (...callArgs) {
    const localScope = new AdderScope(scope);
    let positionalIdx = 0;
    let kwObj = null;
    if (callArgs.length > 0 && callArgs[callArgs.length - 1]?._kw) kwObj = callArgs.pop();
    for (let i = 0; i < node.params.length; i++) {
      const p = node.params[i];
      if (positionalIdx < callArgs.length) localScope.set(p.name, callArgs[positionalIdx++]);
      else if (kwObj && p.name in kwObj) localScope.set(p.name, kwObj[p.name]);
      else if (p.default) localScope.set(p.name, await adderEval(p.default, localScope));
    }
    if (node.vararg) localScope.set(node.vararg, callArgs.slice(positionalIdx));
    if (node.kwarg) {
      const extra = {};
      if (kwObj) { const used = new Set([...node.params.map(p => p.name), '_kw']); for (const k of Object.keys(kwObj)) if (!used.has(k)) extra[k] = kwObj[k]; }
      localScope.set(node.kwarg, extra);
    }
    return adderEval(node.body, localScope);
  };
  fn._pyFunc = true;
  fn._pyName = '<lambda>';
  return fn;
}

// ── class ──

// ── C3 linearization (MRO) ──

function _computeMRO(cls) {
  if (!cls._pyBases || cls._pyBases.length === 0) return [cls];
  const baseMROs = cls._pyBases.map(b => [..._computeMRO(b)]);
  const result = [cls];
  const lists = [...baseMROs, [...cls._pyBases]];
  while (lists.some(l => l.length > 0)) {
    let head = null;
    for (const list of lists) {
      if (list.length === 0) continue;
      const candidate = list[0];
      if (lists.every(l => { const idx = l.indexOf(candidate); return idx <= 0; })) { head = candidate; break; }
    }
    if (!head) throw new AdderError('TypeError', 'Cannot create a consistent method resolution order');
    result.push(head);
    for (const list of lists) { const idx = list.indexOf(head); if (idx !== -1) list.splice(idx, 1); }
  }
  return result;
}

async function _evalClass(node, scope) {
  const bases = [];
  for (const b of node.bases) bases.push(await adderEval(b, scope));

  // evaluate class body in a class scope
  const classScope = new AdderScope(scope);
  for (const stmt of node.body) await adderEval(stmt, classScope);

  // build class
  const classVars = Object.fromEntries(classScope.vars);

  // constructor function
  const cls = function (...args) {
    const instance = Object.create(cls.prototype);
    instance.__adderClass__ = node.name;
    instance.__adderType__ = cls;
    // copy class variables (non-function, non-property)
    for (const [k, v] of Object.entries(classVars)) {
      if (typeof v !== 'function' && !(v && (v.__property__ || v.__staticmethod__ || v.__classmethod__))) instance[k] = v;
    }
    // call __init__ if present
    if (typeof cls.prototype.__init__ === 'function') {
      const result = cls.prototype.__init__.call(instance, ...args);
      if (result instanceof Promise) return result.then(() => instance);
    }
    return instance;
  };

  cls.prototype = {};
  cls._pyName = node.name;
  cls._pyClass = true;
  cls._pyBases = bases.filter(b => b?._pyClass);

  // MRO: compute and apply
  const mro = _computeMRO(cls);
  cls._pyMRO = mro;

  // copy ONLY own methods from bases in MRO order (reverse = most base first, overridden by closer)
  for (let i = mro.length - 1; i >= 1; i--) {
    const base = mro[i];
    if (!base.prototype || !base._pyOwnMembers) continue;
    for (const key of base._pyOwnMembers) {
      const desc = Object.getOwnPropertyDescriptor(base.prototype, key);
      if (desc) Object.defineProperty(cls.prototype, key, desc);
    }
  }

  // track own members for this class
  for (const [name, value] of Object.entries(classVars)) {
    if (value && value.__property__) {
      const fget = value.fget;
      const fset = value.fset;
      const desc = { get() { return fget(this); }, configurable: true, enumerable: true };
      if (fset) {
        const setFn = function(v) { fset(this, v); };
        setFn._pyFset = fset;
        desc.set = setFn;
      }
      Object.defineProperty(cls.prototype, name, desc);
    } else if (value && value.__staticmethod__) {
      // @staticmethod — no self injection; wrap to strip _pyFunc flag
      const rawFn = value.fn;
      const sm = (...args) => rawFn(...args);
      sm._pyName = `${node.name}.${name}`;
      cls.prototype[name] = sm;
      cls[name] = sm; // accessible as ClassName.method()
    } else if (value && value.__classmethod__) {
      // @classmethod — inject cls as first arg instead of self
      const originalFn = value.fn;
      const cm = function (...args) { return originalFn(cls, ...args); };
      cm._pyName = `${node.name}.${name}`;
      cls.prototype[name] = cm;
      cls[name] = cm; // accessible as ClassName.method()
    } else if (typeof value === 'function') {
      const originalFn = value;
      cls.prototype[name] = function (...args) { return originalFn(this, ...args); };
      cls.prototype[name]._pyName = `${node.name}.${name}`;
    }
  }

  // copy class variables to constructor (for @classmethod access via cls.attr)
  for (const [k, v] of Object.entries(classVars)) {
    if (typeof v !== 'function' && !(v && (v.__property__ || v.__staticmethod__ || v.__classmethod__))) {
      cls[k] = v;
    }
  }

  // inherit static/class methods from base constructors
  for (let i = mro.length - 1; i >= 1; i--) {
    const base = mro[i];
    if (!base._pyOwnMembers) continue;
    for (const key of base._pyOwnMembers) {
      if (key in base && typeof base[key] === 'function') cls[key] = base[key];
    }
  }
  // own static/class methods override inherited (already set above, but re-apply to be safe)
  for (const [name, value] of Object.entries(classVars)) {
    if (value && (value.__staticmethod__ || value.__classmethod__) && cls[name]) { /* already set */ }
  }

  cls._pyOwnMembers = new Set();
  for (const [name, value] of Object.entries(classVars)) {
    if (typeof value === 'function' || (value && (value.__property__ || value.__staticmethod__ || value.__classmethod__))) cls._pyOwnMembers.add(name);
  }

  // set __class__ in class scope so super() works inside methods
  classScope.set('__class__', cls);

  // handle decorators
  let result = cls;
  for (let i = node.decorators.length - 1; i >= 0; i--) {
    const dec = await adderEval(node.decorators[i], scope);
    result = await _callValue(dec, [result], [], node.line);
  }

  scope.set(node.name, result);
  return null;
}

// ── for loop ──

async function _evalFor(node, scope) {
  const iterable = await adderEval(node.iter, scope);
  let broke = false;
  // for-await handles both sync iterables and async generators
  const iter = iterable[Symbol.asyncIterator] ? iterable : pyIter(iterable);
  let _loopCount = 0;
  for await (const value of iter) {
    // yield to event loop periodically to prevent page lockup
    if (++_loopCount % 1000 === 0) await new Promise(r => setTimeout(r, 0));
    await _assignTarget(node.target, value, scope);
    try {
      for (const stmt of node.body) await adderEval(stmt, scope);
    } catch (e) {
      if (e instanceof _BreakSignal) { broke = true; break; }
      if (e instanceof _ContinueSignal) continue;
      throw e;
    }
  }
  if (!broke) {
    for (const stmt of node.orelse) await adderEval(stmt, scope);
  }
  return null;
}

// ── while loop ──

async function _evalWhile(node, scope) {
  let broke = false;
  let iterations = 0;
  const limit = scope.has('__loop_limit__') ? scope.get('__loop_limit__') : 1000000;
  while (pyBool(await adderEval(node.test, scope))) {
    if (limit > 0 && ++iterations > limit) throw new AdderError('RuntimeError', `maximum loop iterations exceeded (${limit})`);
    if (iterations % 1000 === 0) await new Promise(r => setTimeout(r, 0));
    try {
      for (const stmt of node.body) await adderEval(stmt, scope);
    } catch (e) {
      if (e instanceof _BreakSignal) { broke = true; break; }
      if (e instanceof _ContinueSignal) continue;
      throw e;
    }
  }
  if (!broke) {
    for (const stmt of node.orelse) await adderEval(stmt, scope);
  }
  return null;
}

// ── with statement ──

async function _evalWith(node, scope) {
  const managers = [];
  for (const item of node.items) {
    const mgr = await adderEval(item.contextExpr, scope);
    const enter = mgr.__enter__ || mgr.enter;
    const exit = mgr.__exit__ || mgr.exit;
    if (typeof enter !== 'function' || typeof exit !== 'function') {
      throw new AdderError('AttributeError', `'${pyTypeName(mgr)}' does not support the context manager protocol`);
    }
    const value = await enter.call(mgr);
    if (item.optionalVar) await _assignTarget(item.optionalVar, value, scope);
    managers.push({ mgr, exit });
  }
  try {
    for (const stmt of node.body) await adderEval(stmt, scope);
    for (const { mgr, exit } of managers.reverse()) await exit.call(mgr, null, null, null);
  } catch (e) {
    for (const { mgr, exit } of managers.reverse()) {
      const suppress = await exit.call(mgr, e.pyType || 'Exception', e, null);
      if (!suppress) throw e;
    }
  }
  return null;
}

// ── try/except ──

async function _evalTry(node, scope) {
  let caught = false;
  try {
    for (const stmt of node.body) await adderEval(stmt, scope);
  } catch (e) {
    if (e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
    caught = true;
    let handled = false;
    for (const handler of node.handlers) {
      let excTypeVal = null;
      if (handler.excType) try { excTypeVal = await adderEval(handler.excType, scope); } catch {}
      if (!handler.excType || _matchException(e, excTypeVal)) {
        if (handler.name) scope.set(handler.name, e);
        handled = true;
        try {
          for (const stmt of handler.body) await adderEval(stmt, scope);
        } catch (e2) {
          if (e2 instanceof _BreakSignal || e2 instanceof _ContinueSignal || e2 instanceof _ReturnSignal) throw e2;
          throw e2;
        }
        break;
      }
    }
    if (!handled) {
      // execute finally before re-throwing
      for (const stmt of node.finalbody) await adderEval(stmt, scope);
      throw e;
    }
  }
  if (!caught) {
    // else clause runs if no exception
    for (const stmt of node.orelse) await adderEval(stmt, scope);
  }
  // finally always runs
  for (const stmt of node.finalbody) await adderEval(stmt, scope);
  return null;
}

function _matchException(error, excTypeVal) {
  if (!excTypeVal) return true;
  if (Array.isArray(excTypeVal)) return excTypeVal.some(t => _matchException(error, t));
  if (error instanceof AdderError) {
    const targetName = typeof excTypeVal === 'function' ? (excTypeVal._pyName || excTypeVal.name) :
                       (typeof excTypeVal === 'string' ? excTypeVal : null);
    if (targetName) {
      if (error.pyType === targetName) return true;
      let pt = _excParents[error.pyType];
      while (pt) { if (pt === targetName) return true; pt = _excParents[pt]; }
    }
  }
  // custom class exceptions — walk prototype chain
  if (typeof excTypeVal === 'function' && excTypeVal._pyClass && error !== null && typeof error === 'object') {
    let proto = error;
    while (proto) {
      if (proto.__adderClass__ === (excTypeVal._pyName || excTypeVal.name)) return true;
      proto = Object.getPrototypeOf(proto);
    }
  }
  if (typeof excTypeVal === 'function' && !excTypeVal._pyClass) {
    try { return error instanceof excTypeVal; } catch { /* arrow fn without prototype */ }
  }
  return false;
}

// ── super() / eval() / exec() builtins ──

function _evalSuperCall(args, scope, line) {
  let cls;
  try { cls = scope.get('__class__'); } catch { throw new AdderError('RuntimeError', 'super(): __class__ not found', line); }
  let self;
  try { self = scope.get('self'); } catch { throw new AdderError('RuntimeError', 'super(): self not found', line); }
  const mro = cls._pyMRO || [cls];
  const idx = mro.indexOf(cls);
  if (idx < 0 || idx + 1 >= mro.length) return {};
  // create proxy that delegates to next class in MRO
  return new Proxy({}, {
    get(_, name) {
      // search MRO starting from the class after current
      for (let i = idx + 1; i < mro.length; i++) {
        const base = mro[i];
        if (!base.prototype) continue;
        const desc = Object.getOwnPropertyDescriptor(base.prototype, name);
        if (desc) {
          if (desc.get) return desc.get.call(self);
          if (typeof desc.value === 'function') return (...a) => desc.value.call(self, ...a);
          return desc.value;
        }
      }
      return undefined;
    }
  });
}

async function _evalBuiltinEval(args, scope, line) {
  const code = String(args[0]);
  try {
    const exprAst = _adderParseExpr(code);
    return await adderEval(exprAst, scope);
  } catch (e) {
    if (e instanceof AdderError) throw e;
    throw new AdderError('SyntaxError', e.message || String(e), line);
  }
}

async function _evalBuiltinExec(args, scope, line) {
  const code = String(args[0]);
  try {
    const ast = adderParse(code);
    await adderEval(ast, scope);
  } catch (e) {
    if (e instanceof AdderError) throw e;
    throw new AdderError('SyntaxError', e.message || String(e), line);
  }
  return null;
}

// ── comprehensions ──

function _evalGenExpr(node, scope) {
  // Return an object with async iteration — lazy, not materialized
  return {
    [Symbol.asyncIterator]() {
      return _genExprIter(node, new AdderScope(scope), 0);
    },
  };
}

async function* _genExprIter(node, scope, genIdx) {
  const gen = node.generators[genIdx];
  const iterable = await adderEval(gen.iter, scope);
  const iter = iterable[Symbol.asyncIterator] ? iterable : pyIter(iterable);
  for await (const value of iter) {
    await _assignTarget(gen.target, value, scope);
    let pass = true;
    for (const ifNode of gen.ifs) {
      if (!pyBool(await adderEval(ifNode, scope))) { pass = false; break; }
    }
    if (!pass) continue;
    if (genIdx + 1 < node.generators.length) {
      yield* _genExprIter(node, scope, genIdx + 1);
    } else {
      yield await adderEval(node.elt, scope);
    }
  }
}

async function _evalComp(node, scope, kind) {
  const result = kind === 'list' ? [] : kind === 'set' ? new Set() : {};
  const compScope = new AdderScope(scope);
  await _evalCompIter(node, compScope, result, kind, 0);
  return result;
}

async function _evalCompIter(node, scope, result, kind, genIdx) {
  const gen = node.generators[genIdx];
  const iterable = await adderEval(gen.iter, scope);
  for (const value of pyIter(iterable)) {
    await _assignTarget(gen.target, value, scope);
    // check if filters
    let pass = true;
    for (const ifNode of gen.ifs) {
      if (!pyBool(await adderEval(ifNode, scope))) { pass = false; break; }
    }
    if (!pass) continue;
    if (genIdx + 1 < node.generators.length) {
      await _evalCompIter(node, scope, result, kind, genIdx + 1);
    } else {
      if (kind === 'list') {
        result.push(await adderEval(node.elt, scope));
      } else if (kind === 'set') {
        result.add(await adderEval(node.elt, scope));
      } else {
        const k = await adderEval(node.key, scope);
        const v = await adderEval(node.value, scope);
        result[k] = v;
      }
    }
  }
}

// ── imports ──

export function _resolveModule(name) {
  if (adderModules[name]) return adderModules[name];
  if (typeof window !== 'undefined' && window._auditableExtensions?.[name]) return window._auditableExtensions[name];
  return null;
}

// Parse + evaluate source as a fresh module, cache it under cacheKey.
// Shared by _loadVfsModule, _loadHttpModule, _loadDirectModule.
async function _instantiateModule(cacheKey, displayName, source, filePath) {
  const cache = adderModules.sys.modules;
  const ast = adderParse(source);
  const modScope = new AdderScope();
  const builtins = adderBuiltins(() => {});
  const builtinNames = new Set(Object.keys(builtins));
  for (const [k, v] of Object.entries(builtins)) modScope.set(k, v);
  modScope.set('__name__', displayName);
  modScope.set('__file__', filePath);

  // placeholder in cache (handles circular imports)
  const mod = { __adderModule__: true };
  cache[cacheKey] = mod;

  await adderEval(ast, modScope);

  for (const [k, v] of modScope.vars) {
    if (!builtinNames.has(k) && k !== '__name__' && k !== '__file__') mod[k] = v;
  }
  mod.__name__ = displayName;
  mod.__file__ = filePath;

  return mod;
}

export async function _loadVfsModule(name) {
  const cache = adderModules.sys.modules;
  if (cache[name]) return cache[name];

  const vfs = getAdderVFS();
  if (!vfs) return null;
  const pth = _getVfsPath();
  if (!pth) return null;

  // search sys.path for name.py or name/__init__.py
  let source = null, filePath = null;
  const cwd = adderModules.os?.getcwd?.() || '/';
  for (let dir of adderModules.sys.path) {
    if (typeof dir !== 'string') continue;
    // skip URL-like entries — those are for _loadHttpModule
    if (/^https?:\/\//.test(dir)) continue;
    // resolve relative entries (e.g. '.') against os.getcwd()
    if (!pth.isAbsolute(dir)) dir = pth.join(cwd, dir);
    const fp = pth.join(dir, name + '.py');
    try { source = await vfs.readFile(fp); filePath = fp; break; } catch {}
    const ip = pth.join(dir, name, '__init__.py');
    try { source = await vfs.readFile(ip); filePath = ip; break; } catch {}
  }
  if (source === null) return null;

  return _instantiateModule(name, name, source, filePath);
}

// Join a base URL with a relative path component. Ensures exactly one '/' between.
function _urlJoin(base, rel) {
  if (!base.endsWith('/')) base += '/';
  return base + rel;
}

export async function _loadHttpModule(name) {
  if (typeof fetch !== 'function') return null;
  const cache = adderModules.sys.modules;
  if (cache[name]) return cache[name];

  // Iterate sys.path entries suitable as URL bases:
  //   - absolute URLs ("https://cdn.example.com/")
  //   - relative URL bases ("./", "../lib/") resolved against document.baseURI when available
  let source = null, fetchedUrl = null;
  for (const entry of adderModules.sys.path) {
    if (typeof entry !== 'string') continue;
    let base;
    if (/^https?:\/\//.test(entry)) {
      base = entry;
    } else if (entry.startsWith('./') || entry.startsWith('../') || entry === '.' || entry === '..') {
      base = (typeof document !== 'undefined' && document.baseURI)
        ? new URL(entry === '.' ? './' : (entry === '..' ? '../' : entry), document.baseURI).href
        : null;
    } else {
      // absolute filesystem paths ("/", "/srv/lib/") are VFS territory, skip
      continue;
    }
    if (!base) continue;

    for (const candidate of [_urlJoin(base, name + '.py'), _urlJoin(base, name + '/__init__.py')]) {
      try {
        const resp = await fetch(candidate);
        if (resp.ok) { source = await resp.text(); fetchedUrl = candidate; break; }
      } catch {}
    }
    if (source !== null) break;
  }
  if (source === null) return null;

  return _instantiateModule(name, name, source, fetchedUrl);
}

// Direct import from an explicit path/URL: `import "./foo.py" as foo`.
// Accepts absolute URLs, page-relative URLs, and VFS paths (if VFS is available).
export async function _loadDirectModule(path) {
  const cache = adderModules.sys.modules;
  if (cache[path]) return cache[path];

  // Derive a display name from the last path segment (stripped of .py).
  const base = path.split(/[/\\]/).pop() || path;
  const displayName = base.replace(/\.py$/, '') || path;

  let source = null, resolvedPath = path;

  // Absolute or page-relative URL → fetch
  if (/^https?:\/\//.test(path) || path.startsWith('./') || path.startsWith('../') || path.startsWith('/')) {
    if (typeof fetch === 'function') {
      try {
        const url = /^https?:\/\//.test(path)
          ? path
          : (typeof document !== 'undefined' && document.baseURI)
            ? new URL(path, document.baseURI).href
            : path;
        const resp = await fetch(url);
        if (resp.ok) { source = await resp.text(); resolvedPath = url; }
      } catch {}
    }
    // VFS fallback for absolute paths when fetch failed or unavailable
    if (source === null && path.startsWith('/')) {
      const vfs = getAdderVFS();
      if (vfs) {
        try { source = await vfs.readFile(path); resolvedPath = path; } catch {}
      }
    }
  } else {
    // Bare relative form (no ./ prefix) — try VFS only; HTTP loading is opt-in via ./
    const vfs = getAdderVFS();
    if (vfs) {
      try { source = await vfs.readFile(path); resolvedPath = path; } catch {}
    }
  }

  if (source === null) return null;
  return _instantiateModule(path, displayName, source, resolvedPath);
}

async function _evalImport(node, scope) {
  for (const { module, alias, path } of node.names) {
    if (path) {
      const mod = await _loadDirectModule(path);
      if (!mod) throw new AdderError('ModuleNotFoundError', `cannot load module from '${path}'`, node.line);
      scope.set(alias, mod);
      continue;
    }
    let mod = _resolveModule(module);
    if (mod) {
      scope.set(alias || module, mod);
      // import this — print the zen (side effect, like CPython)
      if (module === 'this' && mod.s) { const printFn = scope.has('print') ? scope.get('print') : null; if (printFn) await printFn(mod.s); }
      continue;
    }
    mod = await _loadVfsModule(module);
    if (mod) { scope.set(alias || module, mod); continue; }
    mod = await _loadHttpModule(module);
    if (mod) { scope.set(alias || module, mod); continue; }
    throw new AdderError('ModuleNotFoundError', `No module named '${module}'`, node.line);
  }
  return null;
}

async function _evalImportFrom(node, scope) {
  let mod;
  let displayModule;
  if (node.path) {
    mod = await _loadDirectModule(node.path);
    displayModule = node.path;
  } else {
    mod = _resolveModule(node.module);
    if (!mod) mod = await _loadVfsModule(node.module);
    if (!mod) mod = await _loadHttpModule(node.module);
    displayModule = node.module;
  }
  if (!mod) throw new AdderError('ModuleNotFoundError', `No module named '${displayModule}'`, node.line);
  for (const { name, alias } of node.names) {
    if (name === '*') { for (const k of Object.keys(mod)) scope.set(k, mod[k]); }
    else {
      if (!(name in mod)) throw new AdderError('ImportError', `cannot import name '${name}' from '${displayModule}'`, node.line);
      scope.set(alias || name, mod[name]);
    }
  }
  return null;
}

// re-export for cell.js
export { AdderError, adderParse };
