// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/example-quip/src/  Build: node ext/example-quip/build.js
// @example/quip — notebook-context entry (EXTENSION_SPEC §2.5).

// -- parse.js --

// The quip language — a key/template DSL.
//
// Grammar:
//   <line>    ::= <name> '=' <template>
//   <name>    ::= /[A-Za-z_][\w-]*/
//   <template>::= text + {var} interpolations
//
// Each line declares one named template. Blank lines and `#` comments
// are skipped. Multiple lines with the same name are an error (the
// language is small and explicit).

const NAME_RE = /^[A-Za-z_][\w-]*$/;

function parseQuip(source) {
  if (typeof source !== 'string') {
    throw new TypeError('parseQuip: source must be a string');
  }
  const templates = Object.create(null);
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) {
      throw new SyntaxError(`quip line ${i + 1}: missing '=' (expected '<name> = <template>')`);
    }
    const name = line.slice(0, eq).trim();
    const template = line.slice(eq + 1).trim();
    if (!NAME_RE.test(name)) {
      throw new SyntaxError(`quip line ${i + 1}: '${name}' is not a valid name`);
    }
    if (name in templates) {
      throw new SyntaxError(`quip line ${i + 1}: duplicate name '${name}'`);
    }
    templates[name] = template;
  }
  return templates;
}

// Render a single template against a vars object. {key} is substituted
// with vars.key.toString(); {{ and }} are literal { and }.
function renderQuip(template, vars) {
  if (typeof template !== 'string') return '';
  const v = vars || {};
  return template
    .replace(/\{\{/g, '\0OPEN\0')
    .replace(/\}\}/g, '\0CLOSE\0')
    .replace(/\{([A-Za-z_][\w-]*)\}/g, (_, name) =>
      name in v ? String(v[name]) : `{${name}}`)
    .replace(/\0OPEN\0/g, '{')
    .replace(/\0CLOSE\0/g, '}');
}

// Build a callable namespace from a parsed templates map. Each template
// becomes a function: callable with a vars object (or no args).
//   const phrases = makePhrases({ hi: "Hello, {name}!" });
//   phrases.hi({ name: "Ana" });   // "Hello, Ana!"
//   phrases.hi.template;           // "Hello, {name}!"
//   phrases.hi.vars;               // ["name"]
function makePhrases(templates) {
  const out = Object.create(null);
  for (const [name, template] of Object.entries(templates)) {
    const fn = (vars) => renderQuip(template, vars);
    fn.template = template;
    fn.vars = [...template.matchAll(/\{([A-Za-z_][\w-]*)\}/g)].map(m => m[1]);
    out[name] = fn;
  }
  return out;
}

// One-shot: parse + render. Convenience for tests and the tagged template.
function compileQuip(source) {
  return makePhrases(parseQuip(source));
}

// -- tokenize.js --

// quip tokenizer — returns CM6-shaped tokens that the editor (or any
// EXTENSION_SPEC §3.1 / §3.2 consumer) can use for highlighting.
//
// Token kinds emitted: `comment`, `name` (LHS of =), `operator` (=),
// `variable` (the `{var}` references), `string` (the template body),
// `escape` (literal {{ }} pairs).

function tokenizeQuip(code) {
  const tokens = [];
  const lines = String(code).split('\n');
  let offset = 0;
  for (const line of lines) {
    _tokenizeLine(line, offset, tokens);
    offset += line.length + 1;   // +1 for the consumed \n
  }
  return tokens;
}

function _tokenizeLine(line, base, out) {
  const trimmed = line.trim();
  // Comments
  if (trimmed.startsWith('#')) {
    const start = base + line.indexOf('#');
    out.push({ from: start, to: base + line.length, kind: 'comment' });
    return;
  }
  if (trimmed === '') return;

  const eq = line.indexOf('=');
  if (eq < 0) {
    // Malformed — treat the whole line as a parse error region.
    out.push({ from: base, to: base + line.length, kind: 'error' });
    return;
  }

  // Name: from first non-whitespace to the last non-whitespace before =.
  const lhs = line.slice(0, eq);
  const nameStart = lhs.search(/\S/);
  const nameEnd = lhs.replace(/\s+$/, '').length;
  if (nameStart >= 0 && nameEnd > nameStart) {
    out.push({ from: base + nameStart, to: base + nameEnd, kind: 'name' });
  }
  out.push({ from: base + eq, to: base + eq + 1, kind: 'operator' });

  // Template body — scan for {var} interpolations and literal {{ }}.
  const rhs = line.slice(eq + 1);
  const rhsBase = base + eq + 1;
  let i = 0;
  let runStart = 0;
  while (i < rhs.length) {
    const ch = rhs[i];
    if (ch === '{' && rhs[i + 1] === '{') {
      if (i > runStart) out.push({ from: rhsBase + runStart, to: rhsBase + i, kind: 'string' });
      out.push({ from: rhsBase + i, to: rhsBase + i + 2, kind: 'escape' });
      i += 2;
      runStart = i;
      continue;
    }
    if (ch === '}' && rhs[i + 1] === '}') {
      if (i > runStart) out.push({ from: rhsBase + runStart, to: rhsBase + i, kind: 'string' });
      out.push({ from: rhsBase + i, to: rhsBase + i + 2, kind: 'escape' });
      i += 2;
      runStart = i;
      continue;
    }
    if (ch === '{') {
      const end = rhs.indexOf('}', i + 1);
      if (end < 0) { i++; continue; }
      if (i > runStart) out.push({ from: rhsBase + runStart, to: rhsBase + i, kind: 'string' });
      out.push({ from: rhsBase + i, to: rhsBase + end + 1, kind: 'variable' });
      i = end + 1;
      runStart = i;
      continue;
    }
    i++;
  }
  if (runStart < rhs.length) {
    out.push({ from: rhsBase + runStart, to: rhsBase + rhs.length, kind: 'string' });
  }
}

// -- tag.js --

// Tagged template — EXTENSION_SPEC §3.2.
//
// Lets a JS code cell embed a quip block inline:
//
//   const phrases = quip`
//     hello = Hi, {name}!
//     bye   = See you, {name}.
//   `;
//   phrases.hello({ name: "Ana" });   // "Hi, Ana!"
//
// Same parse-then-compile flow as the cell handler.


function quipTag(strings, ...values) {
  // Standard tag interpolation: interleave strings + values into one
  // source string, then compile. Values are stringified via String().
  let src = '';
  for (let i = 0; i < strings.length; i++) {
    src += strings[i];
    if (i < values.length) src += String(values[i]);
  }
  return compileQuip(src);
}

// -- adapter.js --

// Python-shape adapter — EXTENSION_SPEC §4 (adder.js convention).
//
// Exposes the `quip` namespace to adder cells so:
//
//   /// adder
//   from quip import parse, render
//   p = parse("hello = Hi, {name}!")
//   print(p["hello"]({"name": "Ana"}))
//   print(render("Watch out for {x}!", {"x": "bears"}))
//
// resolves transparently through window._auditableExtensions.


const quipNamespace = {
  // Match Python conventions where it's natural — but quip is small
  // enough that the JS names are already idiomatic in either language.
  parse:   parseQuip,
  render:  renderQuip,
  compile: compileQuip,
  fromMap: makePhrases,
};

// -- cell.js --

// CellType handler for `/// quip` cells. Implements the §3.1 contract:
// parseNames / findUses / execute.
//
// Each `/// quip` cell defines ONE scope variable, named via the
// `// %cellName <var>` directive at the top of the cell (or `quip`
// as a default). Downstream cells reach the parsed phrases through
// that variable.


const CELL_NAME_RE = /^\s*\/\/\s*%cellName\s+([A-Za-z_]\w*)/m;

function _exportName(code) {
  const m = CELL_NAME_RE.exec(code);
  return m ? m[1] : 'quip';
}

// EXTENSION_SPEC §3.1: declared by `capabilities.definesScope: true`.
// Return value drives the DAG — names listed here are what downstream
// cells can reference. One symbol per quip cell.
function quipParseNames(code) {
  return new Set([_exportName(code)]);
}

// quip cells don't read upstream scope (there's nowhere in the syntax
// to reference an outer variable). Returning an empty set keeps the
// DAG honest: no false edges, no spurious re-runs.
function quipFindUses(_code, _allDefined, _selfDefined) {
  return new Set();
}

// EXTENSION_SPEC §3.1: declared by `capabilities.executable: true`.
// `code` is the cell source, `upstream` the upstream scope (unused
// for quip), `cell` the live cell (use cell._ctx for builtins like
// ui.display when you want to surface output to the user).
async function quipExecute(code, _upstream, cell) {
  const exportName = _exportName(code);
  // Strip the cell-name directive line before parsing so it doesn't
  // appear as a malformed quip statement.
  const stripped = code.replace(CELL_NAME_RE, '').trim();
  let templates;
  try {
    templates = parseQuip(stripped);
  } catch (e) {
    // SPEC §3.1 convention: throw with a meaningful message; the host
    // catches + renders in the cell's output area.
    throw e;
  }
  const phrases = makePhrases(templates);

  // Surface a one-line summary in the cell output area — same way
  // adder / soft / md cells display their result.
  const ctx = cell?._ctx;
  if (ctx && typeof ctx.display === 'function') {
    const names = Object.keys(templates);
    const summary = names.length === 0
      ? '(empty quip block)'
      : `${exportName}: ${names.length} phrase${names.length === 1 ? '' : 's'} — ${names.join(', ')}`;
    ctx.display(summary);
  }

  return { defines: { [exportName]: phrases } };
}

// -- register.js --

// Notebook-context registration — EXTENSION_SPEC §2.5.
//
// This file runs inside the notebook iframe (or the page in standalone
// auditable). It calls the notebook-side window.auditable.registerExtension,
// which handles cellType / taggedLanguage / exports / globals.
//
// Surfaces + contextMenu are SHELL-context concerns and live in
// works.js (sibling file). The two contexts never coordinate at the
// registration layer — each runs where its capabilities take effect.





const QUIP_VERSION = '0.1.0';

// EXTENSION_SPEC §2.3 guard: only register once per page. Same idiom
// as ext/adder and ext/soft so multiple loads (during dev hot-reload
// or repeated install/load cycles) don't throw the "already registered"
// warning.
if (typeof window !== 'undefined' && !window._cellTypes?.['quip']) {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@example/quip',
      version: QUIP_VERSION,
      description: 'A toy templating language — the EXTENSION_SPEC reference example.',
      pluginUrl: '@example/quip',

      // §3.1 — cell type
      cellType: {
        name: 'quip',
        label: 'quip',
        color: '#9b7eaf',
        shortcut: 'q',
        editDebounce: 250,
        capabilities: {
          executable:   true,
          definesScope: true,
          hasOutput:    true,
          hasEditor:    true,
          builtin:      false,
        },
        parseNames: quipParseNames,
        findUses:   quipFindUses,
        execute:    quipExecute,
        tokenize:   tokenizeQuip,
      },

      // §3.2 — tagged language
      taggedLanguage: {
        name: 'quip',
        tokenize: tokenizeQuip,
      },

      // §3.5 — cross-language adapter (Python-shape namespace)
      exports: { quip: quipNamespace },

      // §3.6 — global (the tagged-template binding so JS cells can
      // write quip`…` without an explicit load)
      globals: { quip: quipTag },
    });
  }
}

// Plain export form so non-auditable consumers (Node tests, raw npm
// imports) get the API too.

export { parseQuip, renderQuip, compileQuip, makePhrases, tokenizeQuip, quipTag, quipNamespace };
