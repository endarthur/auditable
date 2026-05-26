# quip

**A toy templating language — the reference example for EXTENSION_SPEC.md.**

A statement is `name = template`. Each template is a string with `{var}` interpolation placeholders. Parsing a quip source returns a JSON-shaped object; compiling it returns a namespace of callables, one per template, that render the template against a vars object.

```
hello   = Hi, {name}!
bye     = See you, {name}.
warning = Watch out for {what}!
```

This document is intentionally tiny. The language exists to demonstrate the wiring of an Auditable extension; the *spec is the extension*, not the language.

| Field | Value |
|---|---|
| Version | 0.1 |
| Status | Implemented (pre-1.0) |
| License | MIT |
| Owner | endarthur |

## Lineage

- Loosely after [Ruby's `gettext`](https://github.com/ruby-gettext/gettext) ID/template map shape.
- The `{var}` substitution is Python's `str.format`-lite.

## Grammar

```
quip-source ::= line*
line        ::= statement | comment | blank
statement   ::= name WS* '=' WS* template
name        ::= /[A-Za-z_][\w-]*/
template    ::= text-or-var*
text-or-var ::= text | '{' name '}' | '{{' | '}}'
comment     ::= '#' rest-of-line
```

- `{{` and `}}` are literal `{` and `}`.
- `{name}` substitutes `vars[name]` at render time; unknown names render as the original `{name}` placeholder (no error, no silent empty string — the literal helps you spot missed bindings).
- Names that appear twice in one source are a parse error.
- Whitespace around the `=` is stripped; the template body starts at the first non-space after `=` and ends at end-of-line.

## Semantics

`parseQuip(source) → templates: object`

Returns a plain object: `{ <name>: <template-string> }`. Throws `SyntaxError` on malformed lines or duplicate names.

`renderQuip(template, vars) → string`

Renders one template against a vars object. Unknown vars render as their literal placeholder.

`makePhrases(templates) → phrases: object`

Wraps a templates map in a namespace of callables. Each `phrases[name](vars)` returns the rendered string. Each function also has `.template` (the source) and `.vars` (the array of `{var}` names it references).

`compileQuip(source) → phrases: object`

Convenience: `makePhrases(parseQuip(source))`.

## Examples

Parse + render:

```js
import { parseQuip, makePhrases } from '@example/quip';

const t = parseQuip(`
hello = Hi, {name}!
oops  = Sorry, {name} — try again.
`);
const p = makePhrases(t);
p.hello({ name: 'Ada' });    // "Hi, Ada!"
p.oops({ name: 'Brennan' }); // "Sorry, Brennan — try again."
```

Inside a cell:

```
/// quip
// %cellName greetings
hello = Hi, {name}!
```

```js
greetings.hello({ name: 'Ada' });
```

Tagged template:

```js
const p = quip`
  hi = Hi, {name}!
`;
p.hi({ name: 'Ada' });
```

Python (adder cell):

```python
from quip import parse
p = parse("hello = Hi, {name}!")
print(p["hello"]({"name": "Ada"}))
```

## What's NOT supported

- Multi-line templates. One template per line; use literal `{{` `}}` for braces.
- Filters, conditionals, loops. `{name|upper}` parses as the literal `{name|upper}` placeholder, which then either renders as itself or with vars including the key `name|upper`.
- Localization, escaping, or template inheritance. If your needs grow past "named string with var holes," you've outgrown quip — use Mustache or `gettext` or a real template engine.

## Versioning

`0.x` while the EXTENSION_SPEC reference shape is still settling. `1.x` if the example extension's surface area locks in alongside the spec's 1.0.
