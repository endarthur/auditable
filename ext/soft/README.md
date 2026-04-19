# @gcu/soft

English keyword programming language for [Auditable](https://github.com/endarthur/auditable). Every keyword is a common English word. Data query pipelines, reactive cells, closures, first-class functions, i18n.

## quick start

```js
// in an Auditable JS cell:
await load("@gcu/soft")
```

Then create Soft cells from the insert bar (amber, shortcut `f`).

```
set intervals to list
  record hole "DDH001" grade 62.1 lithology "itabirite",
  record hole "DDH002" grade 55.0 lithology "itabirite",
  record hole "DDH003" grade 31.2 lithology "phyllite"

take intervals
keep rows where grade above 50
average grade
round to 1
say "mean ore grade: " it
```

## features

**core language:** set/put, say (with juxtaposition), if/else/unless (block + inline + suffix), repeat/each/while/until/range, define/return, closures, call/run/result-of invocation, try/catch, assume, suppose.

**pipeline DSL:** take, keep/drop (with if/rows where filler), sort, average/total/smallest/largest, count, first/last, group by, pick, with (computed columns), round, then/and-then chaining, called (mid-pipeline naming), into/as (result capture).

**data types:** numbers (hex/bin/oct), strings (with escapes), booleans, nothing, records, multi-line lists, chunk expressions (character/word/line/item — read + write + ranges + counting).

**property access:** `grade of row` (of-chains, right-to-left resolution, array mapping), `(field) of row` (dynamic), of-path writes.

**pattern matching:** globs with character classes, regex literals.

**auditable integration:** reactive DAG, ui.table for arrays-of-objects, syntax highlighting with auto-indent, completions, tagged template (`soft\`...\``), load/save via notebook.fs, make (DOM creation), on (event handlers with cleanup).

**i18n:** locale system with keyword table swap. pt-BR locale included. Locales register as separate cell types (e.g. `soft-ptbr`).

## portuguese

```js
const { soft } = await load("@gcu/soft")
await soft.loadLocale("pt-BR")
```

Then create `soft-ptbr` cells:

```
pegue intervalos
mantenha linhas onde teor é acima de 50
média de teor
arredonde para 1
diga "teor médio: " o resultado
```

## architecture

```
ext/soft/
  src/
    tokenize.js   — lexer (keywords, locale lookup, regex literals)
    parse.js      — two-pass recursive descent (prescan + parse)
    eval.js       — synchronous tree-walking evaluator
    highlight.js  — CM6 syntax highlighting, auto-indent, completions
    cell.js       — DAG integration (parseNames, findUses, execute)
    tag.js        — soft`` tagged template
    register.js   — self-registering cell type + locale cell type factory
    main.js       — ES module entry point
  build.js        — concatenates src/ into index.js
  index.js        — build output (111 KB)
  locales/
    pt-BR.json    — Brazilian Portuguese keyword mappings
  SPEC.md         — language specification (0.9-draft)
```

**two-pass parser:** pass 1 (prescan) scans all tokens for `define`/`use` statements to register function signatures. pass 2 builds the AST. this enables forward references — call functions before they're defined.

**locale system:** `softSetLocale(locale)` installs an inverted word→canonical lookup in the tokenizer. Portuguese words resolve to English tokens before parsing — zero parser changes for the core language. seven small parser tweaks handle word order differences (não é, acima de, para cada, etc.).

**cell type per locale:** `soft.loadLocale("pt-BR")` registers `soft-ptbr` as a separate cell type. Each locale type wraps the base handler with locale-aware parseNames/findUses/tokenize/execute. No global mutable state — the locale is always active for its cell type.

## tests

```
npm test               # runs full Auditable suite (includes 225 Soft tests)
node --test test/soft.test.mjs   # Soft tests only
```

## spec

See [SPEC.md](SPEC.md) for the full language specification, grammar, and test cases.

## license

Implementation: MIT — see [LICENSE](./LICENSE).
Language specification (grammar, keywords, semantics as documented in SPEC.md): CC0-1.0 — reimplement freely.
