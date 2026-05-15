# @gcu/yaml

A strict, auditable subset of YAML 1.2 for hand-authored configuration.

- **No implicit typing.** A string is a string because it is quoted. `yes`,
  `NO`, `1.0` mean the literal strings unless explicitly quoted.
- **No plain scalars.** All scalars are `"..."`, `'...'`, `|`, or `|-`.
- **No anchors, aliases, global tags, or folded scalars.** The features that
  enable billion-laughs and `!!python/object/apply`-style RCE are excluded
  by construction.
- **Local tags only.** `!secret`, `!include`, `!datetime` — opaque metadata
  the parser surfaces, never resolves.
- **Cross-parser invariant.** Tag-free conforming documents parse to the
  same data structure under vanilla `yaml.v3`, `ruamel.yaml` `YAML(typ='safe')`,
  and `js-yaml`. The conformance suite enforces this. (PyYAML 6's `safe_load`
  defaults to YAML 1.1 resolvers, which mis-parse octal `0o755` and unsigned
  float exponents — use ruamel.yaml for 1.2-conformant Python loading.)

See `SPEC.md` for the full specification.

## Usage

```js
import { parse, emit, check, format } from '@gcu/yaml';

const ast = parse(text);          // → AST, or throws YamlParseError
const out = emit(ast);            // → canonical-form bytes
const err = check(text);          // → null | YamlParseError (no throw)
const canonical = format(text);   // → parse + emit one-shot
```

`YamlParseError` carries `{ rule, line, column, message }`. `rule` is the
section of `SPEC.md` whose constraint was violated (e.g. `"6.5"`).

## CLI

```
gcu-yaml check FILES...           # parse each file; exit 1 if any fail
gcu-yaml fmt   FILES...           # rewrite in canonical form
gcu-yaml fmt --check FILES...     # exit non-zero if any file would change
gcu-yaml fmt --stdout FILES...    # write canonical form to stdout
```

## Layout

```
src/
  types.js   — AST node factories, YamlParseError
  lex.js     — line preprocessor + scalar/key/tag parsers
  parse.js   — recursive-descent parser
  emit.js    — canonical emitter (pure AST → bytes)
  api.js     — public surface
cli/
  gcu-yaml.js
test/fixtures/
  positive/  — tag-free positive: .yaml + .expected.json
  tagged/    — tagged positive:   .yaml + .expected.yaml (canonical)
  negative/  — negative:          .yaml + .expected.error.json
```

The fixture suite is the executable definition of the spec. The repo-root
test harnesses are `test/yaml.test.mjs` (strict-parser conformance) and
`test/yaml-cross.test.mjs` (cross-parser invariant via js-yaml).

## Build

```
node ext/yaml/build.js   # concatenate src/ → index.js
```

## Status

`v0.1` — JS reference parser + emitter + CLI + fixture-driven conformance
suite + js-yaml + ruamel.yaml cross-parser checks. All 14 tag-free positive
fixtures cross-parse identically under both vanilla parsers.
