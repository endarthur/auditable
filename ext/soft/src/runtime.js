// soft transpile runtime — Soft semantics helpers called from AIR-emitted JS.
// Soft is simpler than Python: direct JS arithmetic, no dunder methods.
// Helpers only needed for: truthiness, string coercion, polymorphic length,
// case-insensitive string equality, chunks, type checks.

import { softString } from './eval.js';

function _truthy(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function _eq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function _neq(a, b) { return !_eq(a, b); }

function _contains(haystack, needle) {
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function _matches(str, pattern) {
  if (pattern instanceof RegExp) return pattern.test(String(str));
  // glob match
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re, 'i').test(String(str));
}

function _between(v, lo, hi) { return v >= lo && v <= hi; }

function _lengthOf(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

function _of(obj, prop) {
  if (obj == null) return null;
  return obj[prop];
}

function _isType(v, typeName) {
  switch (typeName) {
    case 'number': return typeof v === 'number';
    case 'text': case 'string': return typeof v === 'string';
    case 'list': return Array.isArray(v);
    case 'record': case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'boolean': case 'bool': return typeof v === 'boolean';
    case 'nothing': case 'null': return v === null || v === undefined;
    default: return false;
  }
}

// Chunks: character, word, line, item
function _chunk(kind, index, target) {
  const str = String(target);
  switch (kind) {
    case 'character': return str[index] || '';
    case 'word': return (str.split(/\s+/)[index]) || '';
    case 'line': return (str.split('\n')[index]) || '';
    case 'item': return (str.split(',').map(s => s.trim())[index]) || '';
    default: return '';
  }
}

function _chunkRange(kind, from, to, target) {
  const str = String(target);
  switch (kind) {
    case 'characters': return str.slice(from, to + 1);
    case 'words': return str.split(/\s+/).slice(from, to + 1).join(' ');
    case 'lines': return str.split('\n').slice(from, to + 1).join('\n');
    case 'items': return str.split(',').map(s => s.trim()).slice(from, to + 1).join(', ');
    default: return '';
  }
}

function _countChunks(kind, v) {
  const str = String(v);
  switch (kind) {
    case 'characters': return str.length;
    case 'words': return str.split(/\s+/).filter(Boolean).length;
    case 'lines': return str.split('\n').length;
    case 'items': return str.split(',').length;
    default: return 0;
  }
}

function _add(value, target) {
  // `add X to Y` — mutate Y
  if (Array.isArray(target)) { target.push(value); return null; }
  if (target && typeof target === 'object') {
    // record: merge fields if value is a record
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(target, value);
    }
    return null;
  }
  throw new Error(`Cannot add to ${typeof target}`);
}

// Invoke: if val is already a non-function (e.g. inner Call resolved), return it.
// Otherwise call it with args. Mirrors evalInvoke in eval.js.
async function _invoke(val, args) {
  if (typeof val !== 'function') return val;
  return val(...(args || []));
}

function _remove(value, target) {
  if (Array.isArray(target)) {
    const idx = target.indexOf(value);
    if (idx !== -1) target.splice(idx, 1);
    return null;
  }
  throw new Error(`Cannot remove from ${typeof target}`);
}

// Scope helper: set a name walking up for existing binding, or create in current scope.
// For transpile, we emulate this by passing a scope object and emitting scope access.
// But it's cleaner to translate Set to native JS assignment (which uses closure chain naturally).

export const _soft = {
  truthy: _truthy,
  str: softString,
  eq: _eq,
  neq: _neq,
  contains: _contains,
  matches: _matches,
  between: _between,
  lengthOf: _lengthOf,
  of: _of,
  isType: _isType,
  chunk: _chunk,
  chunkRange: _chunkRange,
  countChunks: _countChunks,
  add: _add,
  remove: _remove,
  invoke: _invoke,
};
