// Public API — tagged template, .compile, .parse, .dump, .run, self-registration
//
// Pipeline: source → lex → parse → codegen → bytes → WebAssembly.Module → exports

import { lex } from './lex.js';
import { parse } from './parse.js';
import { codegen, flattenImports } from './codegen.js';
import { tokenizeAtra, atraCompletions } from './highlight.js';

function compileSource(source, interpValues, userImports) {
  const tokens = lex(source);
  const ast = parse(tokens);
  return codegen(ast, interpValues, userImports);
}

function instantiate(bytes, userImports, interpValues) {
  const importObj = {
    math: { sin: Math.sin, cos: Math.cos, ln: Math.log, exp: Math.exp, pow: Math.pow, atan2: Math.atan2 },
    host: {},
  };
  if (userImports) {
    const flat = flattenImports(userImports);
    for (const [k, v] of Object.entries(flat)) importObj.host[k] = v;
  }

  // Interpolated imports
  if (interpValues) {
    for (let i = 0; i < interpValues.length; i++) {
      const v = interpValues[i];
      if (typeof v === 'function') {
        importObj.host['__INTERP_' + i + '__'] = v;
      }
    }
  }

  // Memory
  if (userImports && userImports.__memory) {
    if (!importObj.env) importObj.env = {};
    importObj.env.memory = userImports.__memory;
  }

  const mod = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(mod, importObj);
  return instance;
}

function wrapExports(instance, table) {
  const exports = Object.create(instance.exports);
  if (table) exports.__table = table;
  // Nest dotted export names: "physics.gravity" → exports.physics.gravity
  for (const key of Object.keys(instance.exports)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let obj = exports;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = instance.exports[key];
    }
  }
  return exports;
}

function normalizeMemoryImport(userImports) {
  if (userImports && userImports.memory && !userImports.__memory) {
    return Object.assign({}, userImports, { __memory: userImports.memory });
  }
  return userImports;
}

function compileAndInstantiate(strings, values, userImports) {
  userImports = normalizeMemoryImport(userImports);
  // Join template strings with interpolation markers
  let source = strings[0];
  for (let i = 0; i < values.length; i++) {
    // Numbers and strings inline directly into source text.
    // Strings act as source inclusion (like #include).
    // Functions become __INTERP_N__ markers, resolved as host imports by codegen.
    if (typeof values[i] === 'number') {
      source += String(values[i]);
    } else if (typeof values[i] === 'string') {
      source += values[i];
    } else {
      source += '__INTERP_' + i + '__';
    }
    source += strings[i + 1];
  }

  const { bytes, table } = compileSource(source, values, userImports);
  const instance = instantiate(bytes, userImports, values);
  return wrapExports(instance, table);
}

export function atra(stringsOrOpts, ...values) {
  // Curried form detection: atra({imports})`...` vs atra`...`
  // Tagged templates pass a strings array with a .raw property; a plain object won't have it.
  if (stringsOrOpts && !Array.isArray(stringsOrOpts) && typeof stringsOrOpts === 'object' && !stringsOrOpts.raw) {
    const opts = stringsOrOpts;
    return function(strings, ...vals) {
      return compileAndInstantiate(strings, vals, opts);
    };
  }
  // Direct form: atra`...`
  return compileAndInstantiate(stringsOrOpts, values, null);
}

// Direct compiler access
atra.compile = function(source) {
  return compileSource(source, null, null).bytes;
};

atra.parse = function(source) {
  const tokens = lex(source);
  return parse(tokens);
};

atra.dump = function(source) {
  const { bytes } = compileSource(source, null, null);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
};

atra.run = function(source, userImports) {
  userImports = normalizeMemoryImport(userImports);
  const { bytes, table } = compileSource(source, null, userImports);
  const instance = instantiate(bytes, userImports, null);
  return wrapExports(instance, table);
};

// ── Self-registration ──

if (typeof window !== 'undefined') {
  if (!window._taggedLanguages) window._taggedLanguages = {};
  window._taggedLanguages.atra = { tokenize: tokenizeAtra, completions: atraCompletions };
}

// Attach internals for testing / advanced use
atra._lex = lex;
atra._parse = parse;
atra._tokenize = tokenizeAtra;
