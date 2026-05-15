# SPEC-yaml

**Package:** `@gcu/yaml`
**Status:** Draft
**Purpose:** A strict, auditable subset of YAML 1.2 for hand-authored
configuration and manifest files within the GCU ecosystem.

## 1. Motivation

YAML's hand-writing ergonomics are genuinely good for the common case —
indentation as structure, no curly braces, comments that work, lists
and maps visually obvious. The footguns live in implicit typing,
anchors, flow style, the 1.1/1.2 schism, parser-specific defaults, and
the entanglement of object-graph serialization features with
configuration-file syntax. Most of the surface that goes wrong is
surface a sane document never uses.

### 1.1 Why not just JSON?

JSON has the same security guarantees as `@gcu/yaml`: no implicit
typing, no aliases, no tags, no parse-time RCE. The reason to choose
YAML's *shape* (which `@gcu/yaml` preserves) over JSON is human
authoring ergonomics:

- **Comments.** JSON has none; YAML's `#` is universally understood.
- **Multi-line strings.** JSON requires `"\n"` escapes for every
  paragraph break; YAML's `|` literal block scalars preserve formatting
  as written.
- **Less syntactic noise.** Indentation as structure costs fewer
  characters per line than braces and commas, and version control
  diffs read more cleanly.
- **Tags.** Local tags (`!secret`, `!include`) are an extensibility
  surface JSON has no equivalent for.

Where these don't matter — machine-to-machine APIs, generated artifacts,
embedded payloads — JSON is the right answer. `@gcu/yaml` is for
hand-authored configuration where humans read and edit the file.

### 1.2 Goals

`@gcu/yaml` defines the subset such that:

1. Every conforming **tag-free** document is also a valid YAML 1.2
   core schema document. Vanilla 1.2 parsers (`yaml.v3`,
   `ruamel.yaml`, `js-yaml`) read tag-free conforming documents to
   the same data structure as the strict parser, with no parser
   configuration required.
2. Every conforming document that uses tags is also valid YAML 1.2,
   readable by vanilla parsers configured for tag pass-through. Tag
   resolution is the consumer's responsibility, never the parser's.
3. The strict parser rejects everything outside the subset with
   line-numbered errors.
4. The canonical emitter produces conforming documents that
   round-trip under the strict parser and (for tag-free documents)
   under vanilla parsers.

The safety lives in the **document shape**, not in parser
configuration. Vanilla YAML remains the fallback reader; the strict
parser is the gate at authoring time and in CI.

## 2. Design Principles

- **No ambiguity, no madness.** Every byte sequence is either an
  unambiguous conforming document, or a parse error with a line and
  column. Where vanilla YAML offers multiple semantically distinct
  spellings of the same value, `@gcu/yaml` picks one.
- **No implicit typing.** A string is a string because it is quoted.
  `NO`, `yes`, `on`, `off`, `null`, `1.0` mean the literal strings
  unless explicitly written as the typed form.
- **Authoring is humane.** The cost of strictness is paid in quote
  characters and a few formatting rules, not in expressiveness.
  Where a rule would be merely fussy without removing real ambiguity,
  it is not in this spec.
- **One canonical form.** The canonical emitter defines the normal
  form. `parse → emit → parse` is identity for data, tags, and
  comments. The parser accepts a wider input than the emitter
  produces; the emitter narrows to the canonical form.
- **Strict reader, lenient world.** GCU tools use the strict parser.
  The wider world reads tag-free files with vanilla parsers and gets
  the same data. Consumers of tagged files configure their parsers
  accordingly.
- **Tags are opaque.** The parser surfaces tags; it never resolves
  them. No tag interpretation ever happens at parse time. The known
  YAML attack classes (`!!python/object/apply`-style RCE) are
  unreachable by construction.

## 3. Conformance and Compatibility

### 3.1 Conforming documents

A document is **conforming** if it parses without error under the
strict parser specified in this document.

### 3.2 Cross-parser invariant (tag-free documents)

For every tag-free conforming document `D`, the data structure
produced by the strict parser must equal the data structure produced
by:

- `yaml.v3` (Go) with default settings
- `ruamel.yaml` `YAML(typ='safe')` with default settings
- `js-yaml` `load` with the default `DEFAULT_SCHEMA`

Equality is structural: scalars compare by type and value; maps
compare as unordered key→value sets; sequences compare elementwise.

This invariant is **load-bearing** for the tag-free fragment of the
language. The conformance test suite (section 14) is the executable
definition.

**Why ruamel.yaml rather than PyYAML.** PyYAML 6's `safe_load` defaults
to YAML 1.1 implicit-type resolvers, which mis-parse two 1.2 numeric
forms: octal `0o755` is read as the string `"0o755"`, and unsigned
float exponents like `1.5e10` are read as the string `"1.5e10"` (1.1
requires `e+10`). ruamel.yaml targets YAML 1.2 properly under
`YAML(typ='safe')` and resolves both. PyYAML can be made to cross-parse
by registering 1.2 resolvers manually, but the spec's invariant is
about *default* settings — and ruamel is the Python YAML library with
1.2 defaults.

### 3.3 Cross-parser invariant (documents with tags)

For every conforming document `D` that contains tags, the data
structure produced by the strict parser must equal the data structure
produced by:

- `yaml.v3` configured to preserve unknown tag nodes
- `ruamel.yaml` with `YAML(typ='rt')` (round-trip mode preserves tag
  nodes) or with constructors registered for every tag used in `D`
- `js-yaml` `load` with the `schema` option set to allow unknown
  tags

A tagged document parsed by a vanilla loader configured for
default-strict behavior (e.g. ruamel.yaml `YAML(typ='safe')` without
registered constructors) will throw or return a parser-specific marker.
This is the consumer's responsibility to configure, and the spec is
explicit about it: tagged documents trade the zero-configuration
property for extensibility, and the cost lives at the consumption
site.

### 3.4 Non-conforming inputs

The strict parser MUST reject every non-conforming input with a
diagnostic that names the rule violated, the line, and the column.
The strict parser MUST NOT silently coerce, repair, or guess.

## 4. Lexical Structure

### 4.1 Encoding

UTF-8 only. A UTF-8 BOM (`EF BB BF`) at the start of the file is a
parse error.

### 4.2 Line endings

The parser accepts both LF (`\n`) and CRLF (`\r\n`) on input and
normalizes them to LF in the AST. A bare CR (`\r`) not followed by
LF is a parse error. The canonical emitter emits LF only.

### 4.3 End of file

The parser accepts any number of trailing line breaks at end of file
(zero, one, or more); they carry no semantic content. The canonical
emitter emits exactly one trailing LF.

### 4.4 Whitespace

The only permitted whitespace character in **indentation and
structural positions** is SP (`U+0020`). Tab (`U+0009`) used for
indentation or as a separator between tokens is a parse error.

Inside `|` and `|-` block scalar bodies, tabs are permitted as
literal content (a tab in the body is part of the resulting string).

Trailing SP on any line outside a `"..."` or `'...'` string is
stripped silently by the parser and never emitted by the canonical
emitter. It does not affect the parsed value.

### 4.5 Comments

A comment begins with `#` and runs to the next line break.

Two placements are permitted:

- **Line comment:** `#` is the first non-whitespace character on the
  line. Indentation before `#` may be any multiple of two SP and is
  not significant.
- **Trailing comment:** `#` appears after a value or block scalar
  indicator, separated from the preceding token by at least one SP.

A `#` inside a `"..."` or `'...'` string is part of the string, not
a comment. A `#` inside a `|` or `|-` block scalar body is part of
the body, not a comment.

Comments are preserved by the canonical emitter (section 12.3).

## 5. Document Structure

### 5.1 Single document only

Exactly one document per file. The `---` document-start marker and
the `...` document-end marker are parse errors. Multi-document
streams are not supported.

### 5.2 Top-level shape

The top level of a document is either a block map or a block
sequence. A bare top-level scalar is a parse error. Empty files are
a parse error.

### 5.3 Indentation

Indentation is 2 SP per level, strictly. The first non-comment line
sits at column 0. Each nested block sits at exactly its parent depth
plus 2. Any other depth is a parse error.

Tabs are forbidden in indentation (section 4.4). Mixed-width
indentation is forbidden.

### 5.4 Maximum nesting depth

The maximum nesting depth is **64**. A 65th level of nesting is a
parse error. This bound is fixed by the spec, not parser-dependent,
and bounds adversarial inputs without restricting reasonable
documents (deeply nested condition trees, AST-shaped configs, and
recursive package manifests all fit comfortably).

## 6. Scalars

### 6.1 Null

Written as the literal token `null`. No other spelling is permitted.
`~`, the empty value, `Null`, and `NULL` are parse errors.

### 6.2 Booleans

`true` and `false` are the only spellings. `True`, `TRUE`, `yes`,
`Y`, `on`, etc. are parse errors when intended as booleans; they
may appear as quoted strings.

### 6.3 Integers

Four forms, all unambiguous due to their prefix:

- **Decimal:** optional `+` or `-`, then either `0` alone or a
  non-zero digit followed by decimal digits. Underscores may appear
  between digits as separators.
- **Hexadecimal:** optional `-`, then `0x` or `0X`, then one or more
  hex digits in either case. Underscores may appear between digits.
- **Octal:** optional `-`, then `0o` or `0O`, then one or more
  octal digits. Underscores may appear between digits.
- **Binary:** optional `-`, then `0b` or `0B`, then one or more
  binary digits. Underscores may appear between digits.

Examples: `42`, `-7`, `+1`, `1_000_000`, `0xff`, `0xFF`,
`-0xff_ff`, `0o755`, `0b1010_0101`.

A leading underscore, trailing underscore, or doubled underscore
(`1__0`) is a parse error. `01` (decimal with leading zero) is a
parse error. The value range is the signed 64-bit two's-complement
range (`-2^63 .. 2^63 - 1`). Values outside this range are parse
errors.

The canonical emitter emits decimal by default; integer AST nodes
may carry a `radix` hint (`hex`, `oct`, `bin`) instructing the
emitter to use the corresponding form. Emitted prefixes are
lowercase (`0x`, `0o`, `0b`). Emitted hex digits are lowercase.
Underscores are not emitted unless the AST node carries a
`separators: true` hint.

### 6.4 Floats

A float matches:

```
float = ["+" / "-"] significand [exponent]
significand = digits-sep "." [digits-sep]
            / "." digits-sep
            / digits-sep              ; only when an exponent is present
digits-sep = DIGIT *(DIGIT / "_" DIGIT)
exponent = ("e" / "E") ["+" / "-"] digits-sep
```

`NaN`, `Infinity`, `+Inf`, `-Inf`, `.inf`, etc. are parse errors.
All floats are finite IEEE 754 binary64. A token that fits both the
integer and the float grammar parses as an integer; explicit float
intent requires the `.` or the exponent.

### 6.5 Quoted strings

Two quote styles are permitted.

**Double-quoted (`"..."`).** Supports the JSON escape set:

| Sequence | Meaning |
|----------|---------|
| `\"`     | `U+0022` |
| `\\`     | `U+005C` |
| `\/`     | `U+002F` (permitted but not required) |
| `\b`     | `U+0008` |
| `\f`     | `U+000C` |
| `\n`     | `U+000A` |
| `\r`     | `U+000D` |
| `\t`     | `U+0009` |
| `\uXXXX` | the Unicode codepoint `U+XXXX` (4 hex digits) |

Any other backslash sequence is a parse error. A raw line break
inside a `"..."` string is a parse error; use `\n`. For codepoints
above `U+FFFF`, use a surrogate pair of `\uXXXX` sequences, as in
JSON.

**Single-quoted (`'...'`).** No escape processing except for a
literal apostrophe, written as `''` (two single quotes). All other
characters between the delimiters are taken literally, including
backslashes and double quotes. A raw line break inside a `'...'`
string is a parse error. Raw C0 control bytes (`U+0000`–`U+001F`,
excluding none) and `U+007F` (DEL) inside a `'...'` string are
parse errors; use a `"..."` string with explicit `\n` / `\t` /
`\uXXXX` escapes when control characters are needed.

The same C0/DEL prohibition applies to the literal portion of
`"..."` strings — only the explicit escape sequences in the table
above introduce control characters.

Single-quoted strings are useful when the content contains many
double quotes or backslashes (embedded JSON, regex patterns).
Double-quoted strings are useful when the content needs explicit
control characters via `\n`, `\t`, or Unicode escapes.

Plain (unquoted) scalars are parse errors. This is the primary
defense against the Norway problem and the rest of YAML's implicit
typing surface.

The canonical emitter emits `"..."` by default. An AST string node
may carry a `style: 'single'` hint, in which case `'...'` is emitted.

String scalars carry a `style` field on the AST node with one of:
`'double'` (default), `'single'`, `'block-clip'`, or `'block-strip'`.
The four values cover the four scalar shapes the spec admits — two
quoted forms and two block-scalar chomping modes. The emitter chooses
the output form from this field; the parser sets it from the source
form. A future revision MAY add `style: 'plain'` if the subset is ever
relaxed to admit plain scalars, but v1 rejects them.

### 6.6 Block scalars

Two chomping modes of the literal block scalar (`|`) are permitted:

- `|` — **clip**: the body ends with exactly one trailing newline.
- `|-` — **strip**: the body has no trailing newline.

`|+` (keep all trailing newlines) is a parse error. The folded
block scalar (`>` and its variants) is a parse error. Explicit
indentation indicators (`|2`, `|-2`, etc.) are parse errors; the
parser determines indentation from the body's first non-empty line.

The body's **base indent** is its parent depth plus 2. The base
indent is the prefix stripped from each body line; characters
beyond the base indent are preserved as content. A line at column
`base + n` contributes `n` leading spaces to the resulting string,
followed by the rest of the line's content.

Newlines in the body are preserved literally. The block ends at the
first line whose indentation is less than the body's base indent,
or at EOF. Inside the body, tabs are permitted as literal content
and no escape processing is performed.

Example:

```yaml
description: |
  First paragraph of prose.

  Second paragraph, with a blank line above.
summary: |-
  Short one-paragraph summary with no trailing newline.
```

The value of `description` ends with `\n`. The value of `summary`
does not.

## 7. Keys

### 7.1 Character class

Keys are either **bare ASCII identifiers** or **quoted strings**.

**Bare keys:**

```
bare-key = (LETTER / "_") *(LETTER / DIGIT / "_" / "-" / ".")
LETTER   = %x41-5A / %x61-7A   ; A-Z and a-z
```

Bare keys begin with a letter (either case) or an underscore, and
continue with letters, digits, underscores, hyphens, and dots. The
leading-character restriction is what keeps numeric-shaped tokens
out of the bare-key space — `1.2` cannot be a bare key (would
collide with the float grammar), but `app.db.host`, `foo-bar`, and
`_private.field` are fine. There is no length limit beyond
implementation-defined practical bounds.

This permits `kebab-case`, `snake_case`, `camelCase`, `PascalCase`,
`SCREAMING_SNAKE_CASE`, and `dotted.path.style` keys. The author
chooses the convention; the spec does not.

**Quoted keys:**

A `"..."` or `'...'` string (using the same syntax as §6.5) may be
used as a key. Quoted keys are necessary when the key contains
characters bare keys can't express (spaces, leading dots, leading
digits, slashes, colons, etc.):

```yaml
"Content-Type": "application/json"
".gitignore": "node_modules/\n*.log\n"
"100": "ok"
"path/with/slashes": "..."
```

The strict parser stores both bare and quoted keys as the same
string type in the AST; the canonical emitter uses bare form when
the key matches the bare-key grammar and double-quoted form
otherwise. AST key nodes may carry a `style: 'single'` hint to force
single-quoted emission for keys that need quoting.

**Note on dotted keys.** Dotted bare keys are stored as the literal
string they appear as. `app.db.host: "..."` produces a single
top-level entry with key `"app.db.host"` and value `"..."`. There
is **no TOML-style splitting** into nested maps; this is YAML, not
TOML, and the dot is part of the key. To express nested maps, use
indentation:

```yaml
app:
  db:
    host: "..."
```

The cross-parser invariant in §3.2 holds for dotted bare keys
because YAML 1.2 core schema parses any dotted plain scalar that
doesn't match the float pattern as a string — and the leading-letter
requirement keeps dotted keys safely outside the float pattern.

### 7.2 Duplicate keys

Two entries in the same map with byte-equal keys is a parse error.
Vanilla parser behavior varies on duplicates (some take last-wins
silently); the strict parser MUST error.

### 7.3 Empty values

A map entry with no value (`name:` at end of line, with no following
nested block) is a parse error. To express the null value, write
`name: null` explicitly. To express the empty string, write
`name: ""`.

### 7.4 Key ordering in source

Keys appear in the order the author wrote them. The strict parser
preserves source order in the parsed map. The canonical emitter
emits in source order (section 12.4).

Schemas MAY require keys in a specific order; schema validation is
a layer above this spec.

## 8. Collections

### 8.1 Block sequences

A block sequence is a sequence of lines beginning with `- ` (hyphen,
SP), all at the same indent. The value following `- ` is either a
scalar, a `|` or `|-` block scalar, an empty collection (`[]` or
`{}`), or a nested block (map or sequence) on the following lines
indented two further spaces.

```yaml
flags:
  - name: "--input"
    type: "path"
  - name: "--format"
    type: "string"
```

### 8.2 Block maps

A block map is a sequence of lines of the form `key: value` or
`key:` followed by a nested block, all at the same indent.

### 8.3 Empty collections

`[]` and `{}` are permitted **only** to denote empty sequences and
empty maps respectively, as the entire value of a key or sequence
entry:

```yaml
flags: []
env: {}
```

This is the sole concession to YAML flow style. Any other use of
`[`, `]`, `{`, `}`, including non-empty flow collections, is a
parse error.

### 8.4 No mixed content

A line may carry either a scalar value or a nested-block opening,
not both. `foo: bar` followed by indented children is a parse
error; the parent's value is the scalar `bar`.

### 8.5 Blank lines

A blank line (a line containing only LF, or only SP followed by LF)
is permitted between entries of a block map or block sequence, and
between top-level entries, for visual grouping. The parser silently
discards such lines; they have no semantic effect.

The canonical emitter never produces blank lines except inside
`|` or `|-` block scalar bodies, where they are part of the body
content.

A blank line inside a block scalar body is part of the body
(section 6.6). A blank line outside a block scalar body that would
otherwise sit inside a value (e.g. between the `|` indicator and
its body, or between a tag and its tagged block value) is a parse
error.

## 9. Tags

### 9.1 Purpose

Tags are **opaque metadata markers** attached to values. The strict
parser surfaces tags in the AST; it never resolves them, never
dispatches on them, and never executes anything based on them. The
consumer decides what `!secret`, `!include`, `!path`, `!datetime`,
`!commit-hash`, or any other tag means.

This is the same pattern Home Assistant has used in production for
over a decade: `!secret`, `!include`, `!include_dir_named`, `!input`
are all consumer-side conventions interpreted by HA's loader, not
features of the YAML spec. `@gcu/yaml` generalizes the pattern.

The known YAML attack classes — `!!python/object/apply:os.system`
and its cousins — are unreachable by construction: there is no
parse-time tag resolution to attack.

### 9.2 Tag syntax

A tag is `!name` where `name` matches:

```
tag-name = (LETTER / "_") *(LETTER / DIGIT / "_" / "-")
```

(The same shape as bare keys, section 7.1.)

The following are parse errors:

- The bare `!` with no name
- `!!`-prefixed tags (the YAML stdlib namespace; this is where
  `!!python/object/apply` lived)
- URI-style verbatim tags `!<...>`
- Chained tags `!a !b value`
- Tags on keys (tags attach only to values)

### 9.3 What tags can attach to

A tag may immediately precede:

- A scalar value (`!color "#ff0000"`)
- A quoted string of either flavor
- A `|` or `|-` block scalar (inline on the same line as the tag)
- An empty collection `[]` or `{}` (inline on the same line as the
  tag, separated by a single SP — `flags: !sorted []` is valid;
  `flags: !sorted\n  []` is a parse error). The inline-only
  restriction follows from §8.3: empty collections appear only as
  inline `[]` / `{}`, so a tag on an empty collection is necessarily
  inline too.
- A block sequence (the tag is on the line above, ending with a
  line break, and the block sequence follows on indented lines)
- A block map (same pattern)

Examples:

```yaml
api_key: !secret "vault-key-prod"
config: !include "./config.gcuyaml"
allowed_hosts: !sorted
  - "alpha.example"
  - "beta.example"
ports: !range {}
description: !markdown |
  Multi-paragraph prose with
  *consumer-interpreted* formatting.
```

### 9.4 AST representation

Every value node in the AST carries an optional `tag` field of type
`string | null`. The strict parser sets it to the tag name (without
the leading `!`) when a tag is present in source, and to `null`
otherwise.

The parser MUST NOT resolve tags. It MUST NOT register handlers,
dispatch tables, or constructor functions. Tag resolution belongs
entirely to the consumer that calls into the parsed AST.

### 9.5 Canonical emission

The canonical emitter writes `!name` immediately before the value
it tags. For inline values (scalars, quoted strings, empty
collections), a single SP separates the tag from the value. For
block values (block scalars, block maps, block sequences), the tag
appears on the line that introduces the block, followed by a line
break, with the block body following at the appropriate indent.

### 9.6 Round-trip

`parse → emit → parse` preserves tags. The `tag` field on every
node is identical before and after the round-trip.

## 10. Dates and Other Types

YAML 1.2 core schema does not implicitly recognize timestamps; this
subset does not either. Dates are strings:

```yaml
created_at: "2026-05-13T14:30:00Z"
```

The strict parser does not interpret the contents of a quoted string
beyond the escape sequences in section 6.5. Schemas validate date
strings.

If a consumer wishes typed dates, the natural pattern is a tag:

```yaml
created_at: !datetime "2026-05-13T14:30:00Z"
```

The parser surfaces the tag; the consumer parses the string into
its preferred date type. `@gcu/yaml` does not define `!datetime` or
any other tag; tag vocabularies are consumer-side concerns.

`!!binary`, `!!set`, and all other YAML stdlib tags are parse errors
(section 9.2). Embedded binary data is a base64 string, optionally
tagged with a consumer-defined `!base64` or `!binary` tag.

## 11. Parser Behavior

### 11.1 One mode

The strict parser has no configuration. There is no "lenient mode."

### 11.2 Diagnostics

Every error reports:

- Line number (1-based).
- Column number (1-based, in bytes from line start).
- The rule violated, named (e.g. "rule 6.5: raw line break in
  double-quoted string").
- The offending byte range when applicable.

### 11.3 No recovery

On the first error, parsing stops and the error is returned. There
is no error recovery and no partial parse result.

### 11.4 Determinism

For a given byte sequence, every conforming implementation of this
spec version MUST produce the same parsed AST (data, tags, and
comment attachments) and the same diagnostics on the same input,
on every platform.

Future versions of this spec may extend the accepted input set;
forward compatibility is not implied by this determinism clause.

## 12. Canonical Emitter

### 12.1 Purpose

The canonical emitter produces a normal form for any data value the
parser can produce. It enables version-control-friendly diffs and is
the basis for the round-trip property.

### 12.2 Round-trip property

For every conforming document `D`:

- `parse(D) → V`
- `emit(V) → D'`
- `parse(D') → V'`
- `V == V'` structurally, including tags on every node
- `emit(V') == D'` byte-for-byte

For documents authored by hand, `D` and `D'` may differ in
whitespace and number/string spelling if the author did not write
the canonical form. After one round-trip, the document is canonical
and stable.

### 12.3 Comment preservation

Comments are attached to AST nodes during parsing:

- A line comment immediately preceding an entry is attached to that
  entry as a **leading comment**.
- A trailing comment on the same line as an entry is attached as a
  **trailing comment**.
- Line comments inside otherwise empty regions are attached to the
  nearest preceding node as a **block-trailing comment**.

The canonical emitter writes these back at the same positions
relative to their attached nodes. A `parse → emit → parse`
round-trip preserves data, tags, and comments.

A consumer that does not care about comments may discard them
before emit; this is a lossy operation and is not the canonical
form.

**Comment positions are best-effort, not byte-exact.** A free-floating
comment block at the end of a section that the author intended as a
"section summary" attaches to the nearest preceding node by the
attachment rules above, which may not match authorial intent in
pathological layouts. The round-trip property guarantees that the
*set* of comments and their *attachment node* are preserved, not that
the visual layout of pre/post-section comments is reproduced
character-for-character. Authors who need precise comment positioning
should write trailing comments on the entries they intend to annotate.

### 12.4 Key ordering

The canonical emitter emits map entries in the order they appear in
the AST. Parsed documents carry source order; programmatically
constructed maps carry insertion order.

### 12.5 Formatting rules

- 2 SP per indent level.
- LF line endings only.
- One LF between entries; no blank lines except inside `|` or `|-`
  block scalar bodies.
- Strings emit as `"..."` by default. AST nodes with
  `style: 'single'` emit as `'...'`; `style: 'block-clip'` emits a
  `|` block scalar; `style: 'block-strip'` emits a `|-` block scalar.
- Integers emit in decimal unless the AST node carries a `radix`
  hint; emitted prefixes and hex digits are lowercase. Underscores
  are not emitted unless `separators: true` is set.
- Floats emit in the shortest form that round-trips to the same
  binary64 value, with a decimal point always present, no leading
  `+`, no underscored separators unless hinted.
- Empty collections emit as `[]` and `{}`.
- Tags emit as `!name` immediately before the tagged value.
- Exactly one LF at end of file. No trailing SP on any line.

## 13. Tooling

### 13.1 `gcu-yaml check`

The CLI bundled with `@gcu/yaml` runs the strict parser over one or
more files and reports diagnostics. Exit codes:

- `0` — all files conform.
- `1` — at least one file failed parsing.
- `2` — usage error (no files, unreadable file).

### 13.2 `gcu-yaml fmt`

Runs the canonical emitter over conforming files. By default,
rewrites in place; on non-conforming input, exits with the parse
error and makes no change.

Flags:

- `--check` — exit non-zero if reformatting would change any of
  the input files. No file is written. Idempotent CI gate: pair
  with `gcu-yaml check` (parse-correctness) to catch
  formatting drift in pull requests.
- `--stdout` — write the canonical form to stdout instead of
  rewriting in place. Useful for shell pipelines and editor
  integrations.

### 13.3 CI gate

GCU repositories SHOULD run `gcu-yaml check` on every `*.yaml` and
`*.yml` file in the tree as a CI gate. This closes the
silent-mis-parse hole that vanilla YAML readers leave open
downstream.

## 14. Conformance Test Suite

The conformance test suite is the executable definition of this
spec. It uses two fixture formats — JSON for tag-free expectations,
canonical-emitted YAML for tagged expectations — to keep each
format pure to its purpose. JSON has no tag concept, so encoding
tags as JSON would require a sentinel that risks collision; instead
tagged-document tests use the canonical emitter's own output as the
comparison target, where tags render naturally as `!name` markers.

The suite consists of:

- **Tag-free positive fixtures:** conforming documents paired with
  the expected data structure as a JSON file. Untagged values
  encode directly as their JSON-natural form (`null`, `true`,
  `false`, number, string, array, object).
- **Tagged positive fixtures:** conforming documents paired with
  the expected canonical-form YAML as a `.expected.yaml` sibling
  file. Equality is byte-for-byte against the canonical emitter's
  output. Tags appear as `!name` in the expected output.
- **Negative fixtures:** non-conforming documents paired with the
  expected rule violation and line/column as a JSON file.
- **Cross-parser fixtures (tag-free):** every tag-free positive
  fixture is also parsed by `yaml.v3`, `ruamel.yaml`
  `YAML(typ='safe')`, and `js-yaml` `load` with defaults, and the
  resulting data structure is compared to the JSON expected data.
  A divergence is a spec bug.
- **Cross-parser fixtures (tagged):** every tagged positive fixture
  is parsed by `yaml.v3`, `ruamel.yaml` `YAML(typ='rt')`, and
  `js-yaml` with unknown-tag pass-through. The resulting structure
  is compared to the strict parser's parse of the same document.
  A divergence is a spec bug.
- **Round-trip fixtures:** every positive fixture is
  `parse → emit → parse`-ed; the second parse must produce the same
  AST as the first, and the second emit must be byte-identical to
  the first.

The test suite ships in `@gcu/yaml/test/` and is language-agnostic
(JSON + canonical YAML expectations, raw YAML inputs).

### 14.1 Fixture file conventions

Per fixture, the test directory contains:

```
fixture-name.yaml              ; the input document
fixture-name.expected.json     ; tag-free positive: expected data
fixture-name.expected.yaml     ; tagged positive: expected canonical form
fixture-name.expected.error.json ; negative: expected rule + line + column
```

A given fixture has exactly one expectation file; the test runner
dispatches by suffix.

JSON expectations use the natural JSON encoding of YAML's data model:
`null`, `true`/`false`, integers as JSON numbers (subject to JSON
number-precision limits — 64-bit integers above 2^53 SHOULD be
expressed as a separate canonical-YAML expected file rather than
JSON), floats as JSON numbers, strings as JSON strings, sequences
as JSON arrays, maps as JSON objects (compared as unordered
key→value sets, per §3.2). Source-order preservation is verified
separately by the round-trip fixtures, which compare the canonical
emitter's byte output against the expected canonical YAML.

Negative-fixture expectations are encoded as:

```json
{ "rule": "6.5", "line": 7, "column": 12 }
```

with `rule` referencing the section of this spec whose constraint
was violated.

## 15. Reference Implementations

### 15.1 Implementation plan

1. **JavaScript** (`@gcu/yaml`, zero-dependency, browser-native):
   the reference implementation. ~500 LOC parser, ~250 LOC emitter,
   ~150 LOC AST and types.
2. **Go** (`gcu-yaml-go`): for atra-adjacent tooling.
3. **Python** (`gcu_yaml`): for Auditable's Python-side users via
   `adder`, after the JS implementation has stabilized.

All three ports MUST pass the conformance test suite.

### 15.2 Parser architecture

Recursive descent on an indent-tokenized stream. The lexer emits
`INDENT`, `DEDENT`, `KEY`, `SCALAR`, `BLOCK_SCALAR`, `DASH`, `TAG`,
`COMMENT`, `EMPTY_SEQ`, `EMPTY_MAP`, and `EOF` tokens. The parser
constructs the AST in source order. Tags are attached to the
following value node. Comments are interleaved tokens attached
during AST construction.

### 15.3 Emitter architecture

A pure function from AST to byte sequence. No I/O, no
configuration. Single pass, no rewriting.

## 16. Versioning

This is `@gcu/yaml` version `1`. The version is implied by the
spec file in the package; documents do not declare a version.
Future revisions may relax or extend the subset; relaxations MUST
preserve the cross-parser invariants in sections 3.2 and 3.3.

## 17. Examples

### 17.1 A bearing manifest (tag-free)

```yaml
name: "bearing"
version: "0.4.2"
summary: "Structural geology orientation analysis"
description: |
  Bearing computes orientation statistics from structural
  geology field measurements: strike/dip, plunge/trend, and
  related conventions.

  See https://gcu.example/bearing for full docs.
exit_codes:
  ok: 0
  usage_error: 2
  input_not_found: 3
  auth_failure: 4
flags:
  - name: "--input"
    type: "path"
    required: true
  - name: "--format"
    type: "string"
    enum:
      - "json"
      - "csv"
      - "stereonet"
env:
  BEARING_DATA: "/var/lib/bearing"
  BEARING_LOG_LEVEL: "info"
limits:
  max_input_size: 64_000_000
  default_mode: 0o644
http_headers:
  # Quoted keys for content with characters bare keys can't express:
  "Content-Type": "application/json"
  "X-Bearing-Version": "0.4.2"
locale_overrides:
  # Dotted bare keys for namespaced settings — note: NOT TOML splitting,
  # the literal string "stereonet.colors.fault" is the key.
  stereonet.colors.fault: "#c0533d"
  stereonet.colors.fold: "#4a8fb8"
keywords: []
```

This document is read identically by the strict parser and by
`yaml.v3`, `ruamel.yaml` `YAML(typ='safe')`, and `js-yaml` `load`
with default settings.

### 17.2 A Home Assistant-style automation (with tags)

```yaml
homeassistant:
  name: "Home"
  latitude: -19.916
  longitude: -43.934
  unit_system: "metric"
  time_zone: "America/Sao_Paulo"

api_key: !secret "ha_api_key"

includes:
  scripts: !include "./scripts.yaml"
  scenes: !include_dir_named "./scenes/"

automation:
  - alias: "Sunset lights"
    trigger:
      platform: "sun"
      event: "sunset"
    action:
      service: "light.turn_on"
      target:
        entity_id: "light.living_room"
```

The strict parser surfaces `!secret`, `!include`, and
`!include_dir_named` as tags on string values. The HA loader (or
any consumer) interprets them. The parser never resolves them.

### 17.3 Minimal manifest

```yaml
name: "minimal"
version: "0.0.1"
summary: "Minimal example"
flags: []
env: {}
```

## 18. Appendix A: ABNF Grammar (lexical level)

```abnf
; ---- character classes ----
LF            = %x0A
CR            = %x0D
SP            = %x20
DIGIT         = %x30-39
HEXDIGIT      = DIGIT / %x41-46 / %x61-66    ; 0-9 A-F a-f
OCTDIGIT      = %x30-37                      ; 0-7
BINDIGIT      = %x30-31                      ; 0-1
LETTER        = %x41-5A / %x61-7A            ; A-Z a-z

; ---- line breaks (accepted by parser, normalized to LF) ----
line-break    = LF / (CR LF)

; ---- scalars ----
null          = %s"null"
bool          = %s"true" / %s"false"

integer       = decimal-int / hex-int / oct-int / bin-int
decimal-int   = ["+" / "-"] (("0") / (%x31-39 *(DIGIT / "_" DIGIT)))
hex-int       = ["-"] ("0x" / "0X") HEXDIGIT *(HEXDIGIT / "_" HEXDIGIT)
oct-int       = ["-"] ("0o" / "0O") OCTDIGIT *(OCTDIGIT / "_" OCTDIGIT)
bin-int       = ["-"] ("0b" / "0B") BINDIGIT *(BINDIGIT / "_" BINDIGIT)

float         = ["+" / "-"] significand [exponent]
significand   = digits-sep "." [digits-sep]
              / "." digits-sep
              / digits-sep              ; with exponent only
digits-sep    = DIGIT *(DIGIT / "_" DIGIT)
exponent      = ("e" / "E") ["+" / "-"] digits-sep

dquoted       = DQUOTE *dchar DQUOTE
DQUOTE        = %x22
dchar         = d-unescaped / d-escape
d-unescaped   = %x20-21 / %x23-5B / %x5D-7E / %x80-10FFFF   ; printable ASCII + non-ASCII; excludes ", \, C0, DEL
d-escape      = "\" ( DQUOTE / "\" / "/" / %s"b" / %s"f" / %s"n"
                    / %s"r" / %s"t" / %s"u" 4HEXDIGIT )

squoted       = SQUOTE *schar SQUOTE
SQUOTE        = %x27
schar         = s-literal / s-escaped-quote
s-literal     = %x20-26 / %x28-7E / %x80-10FFFF              ; printable ASCII + non-ASCII; excludes ', C0, DEL
s-escaped-quote = SQUOTE SQUOTE                              ; '' literal apostrophe

; ---- keys ----
bare-key      = (LETTER / "_") *(LETTER / DIGIT / "_" / "-" / ".")
quoted-key    = dquoted / squoted
key           = bare-key / quoted-key

; ---- tags ----
tag           = "!" tag-name
tag-name      = (LETTER / "_") *(LETTER / DIGIT / "_" / "-")

; ---- empty flow ----
empty-seq     = "[]"
empty-map     = "{}"

; ---- block scalar opener ----
block-scalar-open = "|" / "|-"
```

The indentation-sensitive grammar (block maps, block sequences,
nested blocks, block scalar bodies) is defined by sections 5, 6.6,
and 8 and the reference parser; it is not expressible in pure ABNF.

## 19. Appendix B: Decisions Not in This Spec

The following are deliberately out of scope for version 1:

- **`>` folded block scalars.** Folding rules confuse readers and
  writers. Permanent.
- **`|+` chomping (keep all trailing newlines).** Never useful in
  configs. Permanent.
- **Block scalar indent indicators (`|2`, `|-2`).** Auto-detect
  covers every realistic case. Permanent.
- **Anchors `&` and aliases `*`.** Object-graph serialization
  features that have no place in a configuration format. The
  expansion behavior also enables the **billion-laughs** DoS
  attack: a small document with nested aliases expands to gigabytes
  at parse time. Excluded by construction. Permanent.
- **`!!`-prefixed global tags.** The attack surface. `!!python/`,
  `!!java/`, and friends are how parse-time tag resolution turns
  into RCE. Local tags (§9) provide the legitimate extensibility
  without the global-namespace footgun. Permanent.
- **URI-style verbatim tags `!<...>`.** Unused in practice;
  encourages centralized vocabularies that contradict the
  consumer-side philosophy. Permanent.
- **Tag chaining `!a !b value`.** YAML 1.2 permits at most one tag
  per node (spec §6.9, node properties); chaining would break the
  cross-parser invariant (§3.3) since vanilla parsers reject or
  misparse multi-tag nodes. Compose by encoding the chain in the
  tag name (`!encrypted-base64`) or by tagging a container that
  names its components. Permanent.
- **Tags on keys.** Keys are bare identifiers; tag metadata belongs
  on values. Permanent.
- **Plain (unquoted) scalars.** The actual Norway problem.
  Permanent.
- **Multi-document streams (`---`/`...`).** Configuration files
  are single documents. Permanent.
- **Implicit typing.** The root of the Norway problem and the
  source of most parser-divergence bugs between PyYAML 1.1
  defaults, ruamel.yaml 1.2 defaults, yaml.v3, and js-yaml.
  Excluded by requiring quoted scalars (§6.5); without unquoted
  strings, no implicit-typing rule has anything to fire on.
  Permanent.
- **Schema definition language.** A separate `@gcu/yaml-schema`
  spec may define one; this document is parser/emitter only.
- **Comments inside `|`/`|-` block scalar bodies and inside
  strings.** A `#` in those contexts is data, by design.
- **Streaming parse.** The reference parser reads the whole
  document. Out of scope for v1.
- **Editor integrations.** Tree-sitter grammar, LSP, syntax
  highlighting — all separate packages.

## 20. Appendix C: Relationship to YAML 1.2

Every conforming `@gcu/yaml` document is a valid YAML 1.2 document.
The relationship to YAML 1.2 features is:

| YAML 1.2 feature                 | Used by `@gcu/yaml`?    |
|----------------------------------|-------------------------|
| Block maps, block sequences      | Yes                     |
| `\|` literal block scalar (clip) | Yes                     |
| `\|-` literal block scalar (strip)| Yes                    |
| `\|+` literal block scalar (keep)| No                      |
| `>` folded block scalar          | No                      |
| Flow maps `{ }`                  | Empty only              |
| Flow sequences `[ ]`             | Empty only              |
| Plain scalars (values)           | No                      |
| Plain scalars (keys, restricted) | Yes (bare-key grammar)  |
| Single-quoted scalars `'...'`    | Yes (values + keys)     |
| Double-quoted scalars `"..."`    | Yes (values + keys)     |
| Local tags `!name`               | Yes (opaque, see §9)    |
| Global tags `!!name`             | No                      |
| Verbatim tags `!<URI>`           | No                      |
| Anchors `&` and aliases `*`      | No                      |
| Directives `%YAML`, `%TAG`       | No                      |
| Document markers `---`/`...`     | No                      |
| Implicit typing                  | No                      |
| Core schema null/bool/int/float  | Yes (explicit only)     |
| Comments `#`                     | Yes                     |
| Multi-document streams           | No                      |

A vanilla YAML 1.2 parser reading a tag-free conforming document
produces the same data structure as the strict parser. For tagged
documents, the vanilla parser needs configuration to pass tags
through as metadata (e.g. `YAML(typ='rt')` in ruamel.yaml); without
this, the document may fail to parse on the vanilla side.

The conformance test suite enforces both invariants.

---

**End of SPEC-yaml.**
