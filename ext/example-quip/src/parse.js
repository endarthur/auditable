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

export function parseQuip(source) {
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
export function renderQuip(template, vars) {
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
export function makePhrases(templates) {
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
export function compileQuip(source) {
  return makePhrases(parseQuip(source));
}
