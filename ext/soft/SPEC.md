# Soft Language Specification

**Version:** 0.9-draft
**Status:** Reference specification (implemented in `ext/soft/`)
**License:** CC0

---

## Implementation

Reference implementation: `ext/soft/` (208 tests, 103 KB bundled). Runs as an Auditable plugin via `load("@gcu/soft")`. Source: 7 ES modules in `ext/soft/src/` — tokenize.js, parse.js (two-pass recursive descent), eval.js (tree-walking), highlight.js (CM6 syntax + indent + completions), cell.js (DAG integration), tag.js (tagged template), register.js (self-registering plugin).

**Implemented:** core language, pipeline DSL, closures, first-class functions (`call`/`run`/`result of`), `say` juxtaposition, chunk expressions, `of`-path read/write, `then` function piping, `matches` with globs + regex, `load`/`save` file I/O, `make` DOM creation, `on` event handlers, multi-line lists, `round X to N` as expression, auto-indent, CM6 completions.

**Not yet implemented:** `explain` tree walker, `ask`/`wait` (need async evaluator), handle-based streaming I/O, ordinals, i18n locale tables, Soft-to-atra transpiler.

---

## 1. Design Principles

Soft is a general-purpose programming language designed for soft keyboard input. Every keyword is a common English word predictable by phone autocomplete. The language can be written entirely without symbols, but also accepts conventional operators for convenience. Indentation is cosmetic — block structure is keyword-delimited.

**Core axioms:**

1. Choosing is fast, typing is slow. Minimize free-text input.
2. Every keyword is a real English word. Symbols are optional shorthand.
3. The grammar is *canonical* — there is one preferred form per operation, but common synonyms and noise words are accepted. The parser is forgiving; the AST is always canonical.
4. Newlines carry meaning (implicit piping) but whitespace/indentation does not.
5. `end` closes all blocks. No significant indentation.

---

## 2. Lexical Grammar

### 2.1 Token Types

| Type | Examples | Notes |
|------|----------|-------|
| `NUM` | `42`, `3.14`, `-7`, `0xFF`, `0b1010`, `0o77` | Decimal floats, hex (`0x`), binary (`0b`), and octal (`0o`) integers. Leading `-` is part of the token. |
| `ORDINAL` | `1st`, `2nd`, `3rd`, `4th`, `15th` | Number followed by `st`/`nd`/`rd`/`th`. Parsed as 1-based, internally mapped to 0-based index. |
| `STR` | `"hello world"`, `"she said \"hi\""` | Double-quoted. Standard backslash escapes: `\"`, `\\`, `\n`, `\t`, `\r`. |
| `ID` | `myVar`, `Math.round`, `cutoff_2`, `品位` | Follows JavaScript identifier rules (UAX #31): starts with a Unicode letter or `_`; continues with Unicode letters, digits, or `_`. May contain `.` for JS paths. Unicode letters include CJK, Cyrillic, Arabic, etc. — enabling i18n identifiers. Emoji are not valid (they're Unicode symbols, not letters). |
| `KW` | `say`, `if`, `keep` | Reserved words (see §2.2). Only classified as KW if no `.` present. |
| `OP` | `+`, `-`, `*`, `/`, `%`, `**` | Arithmetic operators. Synonyms for English keywords. |
| `BITOP` | `~`, `<<`, `>>` | Bitwise operators. Synonyms for English keywords. |
| `CONCAT` | `&` | String concatenation operator. |
| `REGEX` | `/pattern/`, `/pattern/i` | Regular expression literal. Flags: `i` (case-insensitive), `g` (global), `m` (multiline). |
| `CMP` | `>`, `<`, `==`, `!=`, `>=`, `<=` | Comparison operators. Synonyms for English keywords. `=` is not used (avoids assignment ambiguity). |
| `BANG` | `!` | Logical not (prefix). Synonym for `not`. |
| `LPAREN` | `(` | Open grouping. |
| `RPAREN` | `)` | Close grouping. |
| `COMMA` | `,` | Separator in variadic calls and list literals. |
| `NL` | (newline) | Line boundary. Significant for implicit piping (§6). |

### 2.2 Keywords

All keywords are lowercase. An identifier that matches a keyword is tokenized as `KW` unless it contains a dot.

**Data query:** `take`, `from`, `keep`, `drop`, `only`, `where`, `pick`, `get`, `average`, `total`, `count`, `smallest`, `largest`, `mean`, `sum`, `min`, `max`, `group`, `by`, `each`, `in`, `sort`, `ascending`, `descending`, `first`, `last`, `top`, `append`, `push`

**General:** `set`, `to`, `of`, `the`, `a`, `an`, `that`, `this`, `say`, `show`, `put`, `into`, `being`, `record`, `load`, `save`, `open`, `close`, `write`, `read`, `ask`, `wait`, `there`, `do`, `explain`, `assume`, `suppose`, `try`, `fails`, `called`

**Control flow:** `if`, `unless`, `otherwise`, `else`, `end`, `repeat`, `times`, `while`, `until`, `with`, `for`, `stop`, `skip`, `by`

**Functions/events:** `define`, `return`, `takes`, `use`, `as`, `many`, `all`, `on`, `call`, `run`, `result`

**Comparison/logic:** `above`, `below`, `is`, `not`, `and`, `or`, `between`, `contains`, `matches`, `greater`, `less`, `more`, `under`, `equals`, `equal`, `than`, `does`, `least`, `most`

**Arithmetic:** `plus`, `minus`, `over`, `mod`, `raised`, `negative`, `bitwise`, `bit`, `shift`, `left`, `right`, `xor`
Note: `times` is both a keyword (in `repeat N times`) and an arithmetic operator. Context disambiguates. The symbol `*` is unambiguous and may be preferred when adjacent to `repeat`.

**Pipe:** `then`, `into`

**Other:** `round`, `rows`, `true`, `false`, `nothing`, `empty`, `length`, `item`, `at`, `add`, `remove`, `list`, `yes`, `no`, `character`, `characters`, `word`, `words`, `line`, `lines`, `number`, `second`, `seconds`, `millisecond`, `milliseconds`, `reading`, `writing`, `appending`, `boolean`

### 2.3 Comments

Lines beginning with `#` (after optional whitespace) are comments and produce no tokens other than `NL`.

### 2.4 Dot-Path Identifiers

Identifiers may contain `.` characters for JS foreign function paths (e.g., `Math.round`, `Text.upper`). A dot-path identifier is always tokenized as `ID`, never `KW`, even if a segment matches a keyword.

---

## 3. Statements

A program is a sequence of statements separated by newlines.

### 3.1 Assignment

```
set <name> to <expr>
set <of-path> to <expr>
set <chunk> of <target> to <expr>
put <expr> into <name>
put <expr> into <of-path>
put <expr> into <chunk> of <target>
```

The simple forms assign to a variable. The `of`-path and chunk forms write into properties, list items, or string chunks. See §4.4 for details on writable paths.

```
set x to 5                         variable
set grade of row to 60             property
set item 2 of scores to 100        list item (0-based, third element)
set word 2 of sentence to "big"    string chunk (0-based, third word)
put "Banks" into name of book      put-form equivalent
```

### 3.2 Output

```
say <expr> [<expr>]*
```

Evaluates expressions and displays them. Multiple values after `say` are automatically concatenated (juxtaposition). The `&` operator also works for explicit concatenation in any expression context:

```
say "hello " name "!"
say "there are " count " intervals"
say grade " grade at " depth "m"
say "result: " (x + 5) " done"

# & still works and is needed in non-say expressions:
set msg to "hello " & name
return greeting & " " & name
```

`show` is an alias for `say`.

### 3.3 Conditional

```
if <condition>
  <body>
[otherwise
  <body>]
end
```

Evaluates condition. If truthy, executes body. If falsy and `otherwise` is present, executes else-body. Nesting is permitted. `end` always closes the nearest open block.

**`unless` — inverted if:**

```
unless <condition>
  <body>
end
```

Equivalent to `if not <condition>`. Also works as a statement suffix:

```
say "warning: low grade" unless grade above 50
skip unless ready
set default to 100 unless default
```

The suffix form executes the statement only if the condition is false. It cannot have an `otherwise` clause.

**Inline conditional (ternary):**

```
<expr> if <condition> otherwise <expr>
```

Expression-level conditional. Returns the first expression if true, the second if false:

```
set label to "ore" if grade above 50 otherwise "waste"
say "pass" if score above 70 otherwise "fail"
set sign to 1 if x above 0 otherwise -1
```

### 3.4 Loops

**Counted:**
```
repeat <expr> times
  <body>
end
```

**For-each:**
```
repeat [for] each <name> in <expr>
  <body>
end
```
The `for` is optional filler.

**While:**
```
repeat while <condition>
  <body>
end
```

`while` at statement start implies `repeat`:

```
while running
  check_status
end
```

**Until:**
```
repeat until <condition>
  <body>
end
```

`until` at statement start implies `repeat`:

```
until done
  check_status
end
```

`repeat` is the canonical form for all loops. `for`, `while`, and `until` as standalone alternatives are accepted but produce the same AST.

### 3.5 Function Definition

```
define <name> [takes|with] <signature>
  <body>
end
```

See §5 for signature syntax.

### 3.6 Return

```
return [<expr>]
```

Returns a value from the enclosing function. If no expression, returns `nothing`. `return` does not invoke closures — it returns the raw function value.

### 3.7 Explicit Invocation

```
call <expr> [<args>]
run <expr> [<args>]
result of <expr> [<args>]
```

Invokes a function stored in a variable or expression. Three synonyms — use whichever reads best:

```
set counter to make_counter
say call counter
say run counter
say result of counter

set greeter to make_greeter "hello"
say call greeter "Arthur"
```

Functions defined via `define` or `use` are called automatically through sig-aware parsing (`double 5`, `send "hi" to "Bob"`). `call`/`run`/`result of` is only needed for closures and functions stored in variables.

**Functions are first-class values.** Bare references return the function itself, not its result. This enables passing functions as arguments, storing them in lists, and returning them from other functions.

### 3.8 JS Import

```
use <dot-path> [as <name>] [<signature>]
```

Imports a JavaScript function or value from the host globals object. If `as` is provided, the imported binding uses that name. If a signature is provided, it defines the call syntax (see §5). If no signature, the function accepts any arguments.

The `as` target may be a keyword (e.g., `use Math.round as round`).

### 3.8 List Mutation

```
add <expr> to <name>
remove <expr> from <name>
```

Appends to or removes the first matching value from a list variable.

### 3.9 Event Handlers

```
on <event> [<target>] [<params>]
  <body>
end
```

Registers an event handler. Syntactically identical to `define`, but the block is invoked by the runtime rather than by the programmer. The handler receives its own scope, like a function.

**Examples:**

```
on click submitButton
  say "submitted!"
end

on change target
  say name of target & " changed to " & value of target
end

on load
  say "ready"
end

on keypress key
  if key is "enter"
    say "go!"
  end
end
```

The set of available events is defined by the host environment, not by the language. In an Auditable cell, events might include `change`, `load`, `click`. In a browser DOM context, any standard DOM event name is valid.

**Event dispatch:** The runtime maintains a handler table mapping `(event, target?)` to handler blocks. When an event fires, the runtime looks up matching handlers and calls them with event-specific parameters. If no target is specified, the handler matches all targets for that event.

### 3.10 Input

```
ask <expr> [with <default>]
```

Prompts the user for input. The result is stored in `it`. The optional `with` provides a default value pre-filled in the input. The prompt mechanism is host-defined -- in browser context it's a dialog/modal, in Auditable it's an input cell, in CLI it's stdin.

```
ask "What is the cutoff grade?"
set cutoff to it

ask "Your name?" with "Arthur"
say "hello " & it

ask "Save as?" with "output.csv" as filename
```

`ask` also supports `into`/`as` for direct capture.

### 3.11 Wait

```
wait <n> seconds|milliseconds
wait until <condition>
wait while <condition>
```

Pauses execution. The timed form delays for a duration. The conditional forms poll until the condition is met.

```
say "loading..."
wait 1 second
say "done"

wait until value of ready is true
wait while loading
```

`second` and `seconds` are interchangeable, as are `millisecond` and `milliseconds`.

Note: `wait` is inherently async. Implementations may need to handle this via coroutines, async/await, or a stepping evaluator. The language semantics are synchronous -- `wait` blocks the current execution flow.

### 3.12 Existence Check

```
there is a <n>
there is no <n>
```

Returns a boolean indicating whether a name is defined. Works as a condition in `if`, `while`, etc.

```
if there is a saveButton
  show saveButton
end

if there is no output
  make "div" in body as output
end

repeat while there is no response
  wait 100 milliseconds
end
```

In browser/DOM context, checks element existence by ID. In general Soft, checks whether a variable is defined in the current environment. `a` and `an` are interchangeable filler words.

### 3.13 Expression Statements

Any expression at statement level is evaluated and its result is assigned to the implicit variable `it`. Results are never auto-displayed — use `say` for output. If the statement ends with `into <n>` or `as <n>`, the result is also stored in the named variable.

In Auditable cells, the value of the last expression in the cell is the cell's reactive output (no `say` needed — the cell output area displays it automatically).

### 3.14 Explain

```
explain <statement or expression>
```

Walks the AST and emits a plain English description of what the code does, without executing it:

```
explain take intervals keep grade above 50 average grade
→ Start with the data called "intervals".
→ Keep only rows where "grade" is greater than 50.
→ Compute the average of the "grade" field.

explain define send message to person
→ Define a function called "send" that takes
→   "message" (first argument)
→   "person" (after "to")
```

The implementation is a second tree walker that outputs prose instead of computing values. Same switch over node types, same AST, different output. Useful for teaching, debugging, and documentation.

`explain` can be applied to any statement or expression. The output is sent to `say` output.

### 3.15 Assume

```
assume <condition>
assume <condition> otherwise <message>
```

Asserts that a condition is true. If it fails, halts with an error. The optional `otherwise` provides a custom error message:

```
assume grade above 0 and grade below 100
assume length of intervals above 0 otherwise "no data loaded"
assume cutoff is a number otherwise "cutoff must be numeric"
```

Unlike `if`, which branches, `assume` is a contract -- "this must be true or something is wrong with the data/state." It is not a control flow mechanism; it is a correctness check.

**Dual use as type annotations:**

`assume X is a <type>` statements serve four purposes simultaneously:

1. **Documentation** -- a human reads them and knows what the function expects.
2. **Runtime validation** -- the interpreter checks them and fails early with a clear message.
3. **Static analysis** -- a Soft IDE/linter uses them to power autocomplete (offer field names after `of` when the type is `record`), catch errors before execution (arithmetic on a `text`), and enrich the grammar-colored highlighting with type information.
4. **Compilation hints** -- the Soft-to-atra transpiler uses `is a` assumes to infer typed variable declarations for WASM compilation.

```
define weighted_average takes rows by field weighted_by weight_field
  assume rows is a list of records with grade as a number, length as a number
  assume field is a text
  assume weight_field is a text
  
  # transpiler now knows: rows → array of typed records, field → string
  ...
end
```

Compound type specs (`list of numbers`, `record with ... as a ...`) provide richer type information for static analysis, IDE autocomplete, and transpilation. See §4.6 for the full type spec syntax.

When transpiling to a typed target (atra, TypeScript), the transpiler extracts `assume X is a <type>` statements and emits declarations. If a variable lacks a type assume, the transpiler can infer from usage or refuse with a clear error: "Cannot compile: `grade` has no type. Add `assume grade is a number`."

### 3.16 Suppose (Scoped Override)

```
suppose <n> is <expr>
  <body>
end
```

Temporarily overrides a variable for the duration of the block, then restores its original value:

```
set cutoff to 50

suppose cutoff is 40
  take intervals
  keep grade above cutoff
  count
  say "at 40%: " & it
end

suppose cutoff is 60
  take intervals
  keep grade above cutoff
  count
  say "at 60%: " & it
end

# cutoff is still 50 here
say "actual cutoff: " & cutoff
```

Perfect for what-if analysis and sensitivity studies. Multiple `suppose` blocks can run sequentially without interfering. The variable is saved before the block and restored after.

### 3.17 Error Handling

```
try
  <body>
if it fails
  <handler>
end
```

Executes the body. If any error occurs, execution jumps to the handler. Inside the handler, `the error` contains the error message:

```
try
  load "data.csv" as data
if it fails
  say "could not load: " & the error
  set data to list
end

try
  set result to x over y
if it fails
  say "division failed"
  set result to 0
end
```

`if it fails` is the catch clause. There is no `finally` -- use a statement after `end` for cleanup.

`the error` is an implicit variable (like `it`) that holds the error message string. It is only defined inside the handler block.

### 3.18 Pipeline Naming (`called`)

```
<pipeline step> called <n>
```

Names the intermediate result of a pipeline step without breaking the flow. The value continues downstream AND is stored in the named variable:

```
take intervals
keep grade above 50 called high_grade
average grade called avg
round to 1

say high_grade & " intervals averaging " & avg
```

Unlike `into`/`as` which terminates the pipeline, `called` is mid-pipeline -- the data keeps flowing to the next step. It is syntactic sugar for "snapshot this value, then continue."

`called` works on any pipeline step:

```
take intervals
with tonnage being length * density called enriched
sort by tonnage descending called ranked
first 10 called top_ten

say length of enriched & " rows, top 10 average: "
take top_ten
average tonnage
say it
```

### 3.19 Loop Control

```
stop
skip
```

`stop` exits the nearest enclosing loop immediately. `skip` jumps to the next iteration of the nearest enclosing loop.

```
repeat each row in intervals
  skip if grade of row is nothing
  skip if grade of row below 0
  say grade of row
end

repeat each name in candidates
  if name is "done"
    stop
  end
  say name
end
```

Both work with suffix conditionals (§3.3):

```
stop if count above 1000
skip unless ready
```

`stop` inside an event handler exits the handler (equivalent to `return` with no value). `skip` is only valid inside loops.

---

## 4. Expressions

### 4.1 Precedence (highest to lowest)

| Level | Form | Notes |
|-------|------|-------|
| 1 | Atoms, `(` expr `)` | Literals, refs, list, function calls, grouping |
| 2 | `<x> of <y>` | Property access (postfix, left-to-right) |
| 3 | `not`/`!`, `negative`, `bitwise not`/`~`, `length of`, chunks, `number of` | Unary prefix |
| 4 | `raised to` / `**` | Exponentiation (right-associative) |
| 5 | `times`/`*`, `over`/`/`, `mod`/`%` | Multiplicative |
| 6 | `plus`/`+`, `minus`/`-` | Additive |
| 7 | `shift left`/`<<`, `shift right`/`>>` | Bit shifting |
| 8 | `bit and`, `bit or`, `bit xor`/`xor` | Bitwise |
| 9 | `&` | String concatenation |
| 10 | `above`/`>`, `below`/`<`, `is`/`==`, `is not`/`!=`, `at least`/`>=`, `at most`/`<=`, `between`, `contains`, `matches` | Comparison |
| 11 | `and`/`or` | Logic |

### 4.2 Atoms

- **Number literal:** `42`, `3.14`, `-7`
- **String literal:** `"hello"`
- **Boolean:** `true`, `false`, `yes`, `no`
- **Null:** `nothing`, `empty`
- **Reference:** `myVar` — resolved against current scope, then environment
- **List literal:** `list 1 2 3` or `list 1, 2, 3` — commas optional. A comma at the end of a line continues the list on the next line (multi-line mode). `list` followed immediately by a newline also enters multi-line mode:
```
set data to list
  record name "Alice" age 30,
  record name "Bob" age 25,
  record name "Carol" age 35
```
- **The:** `the` is a noise word that is consumed and ignored (e.g., `the length of x`)

### 4.3 Property Access and Chunk Expressions: `of`

The word `of` is the universal access operator. It reads properties, indexes lists, and extracts string chunks. All forms chain left-to-right.

**Property access:**

```
grade of row                       row.grade
name of author of book             book.author.name
```

If the object is an array, maps over it: `grade of intervals` returns an array of grades.

**Precedence with prefix operators:** `length of X` and `number of chunks in X` are parsed as unary prefixes (level 3), not as `of`-chains (level 2). So `length of intervals` returns the array length (a number), not a per-row mapping of the word "length." The rule: specific prefix keywords at level 3 bind first; remaining `name of expr` chains at level 2 do property access with array mapping.

**Dynamic property access:**

When the left side of `of` is a parenthesized expression, it is evaluated and the result is used as the property name:

```
set field to "grade"
say (field) of row                 row["grade"] — dynamic lookup

set fields to list "grade" "density"
repeat each f in fields
  say f & ": " & (f) of row
end
```

Without parentheses, `field of row` means `row.field` (the literal property named "field"). With parentheses, `(field) of row` means `row[value_of_field]` (the property whose name is stored in the variable).

This works with chunks too:

```
set which to "word"
set n to 3
# (dynamic chunk access is not supported — use if/otherwise to dispatch)
```

**List access:**

```
item 0 of scores                   scores[0] (first element)
item 3 of scores                   scores[3] (fourth element)
first of scores                    scores[0]
last of scores                     scores[length-1]
```

**String chunk expressions:**

```
character 0 of "hello"             → "h" (first character)
character 2 of "hello"             → "l" (third character)
word 0 of "the quick brown fox"    → "the"
word 1 of "the quick brown fox"    → "quick"
line 1 of text                     → second line (split on newlines)
```

`item N of string` splits on commas: `item 1 of "red,green,blue"` → `"green"`.

**All numeric indexing is 0-based.** Lists, characters, words, lines, items -- always. This matches JS and Python and eliminates off-by-one errors during transpilation.

**Ordinals are 1-based sugar.** Placing an ordinal (1st, 2nd, 3rd, etc.) before the noun signals human-style counting and maps to 0-based internally:

```
1st item of scores     = item 0 of scores      → first element
3rd word of text       = word 2 of text         → third word
2nd character of name  = character 1 of name    → second character
```

The word order is the signal: ordinal before noun → 1-based (English thinking). Number after noun → 0-based (programmer thinking). One rule, no exceptions.

`first` and `last` are named ordinals:

```
first item of scores   = 1st item of scores   = item 0 of scores
first word of text     = 1st word of text      = word 0 of text
last item of scores    = item (length - 1) of scores
```

**Chunk nesting:**

```
character 0 of word 2 of sentence  → first char of third word
word 1 of line 0 of document       → second word of first line
1st character of 3rd word of sentence  → same as above, ordinal form
```

**Ranges (read-only):**

```
characters 2 to 4 of "hello"      → "ell"
words 1 to 3 of text               → first three words joined
lines 2 to 5 of document           → lines 2–5 joined with newlines
```

**Counting:**

```
number of characters in text       → string length
number of words in text            → word count
number of lines in text            → line count
number of items in text            → comma-separated item count
```

`length of` continues to work for both arrays and strings.

### 4.4 Writable Of-Paths

`set` accepts `of`-chains and chunk expressions as write targets:

**Property writes:**

```
set grade of row to 60
set name of author of book to "Banks"
```

The evaluator resolves the chain in reverse: look up `book`, then `author of book`, then assign its `name`.

**List writes:**

```
set item 3 of scores to 100
```

**Chunk writes (string surgery):**

```
set character 0 of name to "A"
set word 2 of sentence to "big"
set line 2 of document to "revised"
```

The evaluator reads the target string, performs the replacement, and writes the full string back. For example, `set word 2 of sentence to "big"` splits `sentence` into words, replaces the third word (0-based), joins them back, and assigns the result to `sentence`.

**Nested chunk writes:**

```
set word 0 of line 1 of doc to "hello"
```

Resolves from the outside in: get `doc`, get line 1, replace word 0, write line 1 back, write `doc` back.

**`put` syntax:**

```
put "Banks" into name of author of book
put "big" into word 1 of sentence
```

Equivalent to the `set` forms.

**Dynamic property writes:**

Parenthesized left-side of `of` works for writes too:

```
set field to "grade"
set (field) of row to 60           # row["grade"] = 60
```

### 4.5 Arithmetic

Every English operator has a symbol equivalent. Both forms are interchangeable and can be freely mixed:

| English | Symbol | Operation |
|---------|--------|-----------|
| `plus` | `+` | Addition |
| `minus` | `-` | Subtraction |
| `times` | `*` | Multiplication |
| `over` | `/` | Division (IEEE 754: `1/0` → `Infinity`, `0/0` → `NaN`) |
| `mod` | `%` | Remainder |
| `raised to` | `**` | Exponentiation (right-associative) |
| `negative` | (prefix) | Unary negation |

**Bitwise operations:**

| English | Symbol | Operation |
|---------|--------|-----------|
| `bitwise and` or `bit and` | — | Bitwise AND |
| `bitwise or` or `bit or` | — | Bitwise OR |
| `bitwise xor`, `bit xor`, or `xor` | — | Bitwise XOR |
| `bitwise not` or `bit not` | `~` | Bitwise NOT (prefix) |
| `shift left` | `<<` | Left shift |
| `shift right` | `>>` | Right shift |

The three binary bitwise ops use English keywords only. `&` is string concatenation (§4.8); `|` and `^` are not used. Prefix `~` and shifts `<<`/`>>` keep their symbols — they are unambiguous. `xor` is a standalone shorthand for `bit xor`.

```
set flags to 0xFF00
set mask to 0x00F0
say flags bitwise and mask
say flags bit and mask
say 1 shift left 8
say 1 << 8
say bit not 0
```

**Grouping with parentheses:**

```
(a + b) * c
(a plus b) times c
```

Parentheses override precedence as in any conventional language. They are optional — Soft programs can always decompose into steps instead:

```
set temp to a plus b
set result to temp times c
```

**Mixing freely:** Use whatever is fastest on the keyboard at the moment:

```
set tonnage to length * density
set metal to tonnage * grade / 100
set ratio to (grade - cutoff) / (max_grade - cutoff)
set area to (width + margin) * 2
set volume to length times width times height
```

### 4.6 Comparison

Every comparison operator has English and symbol forms:

| English | Symbol | Operation |
|---------|--------|-----------|
| `above` / `is above` | `>` | Greater than |
| `below` / `is below` | `<` | Less than |
| `is` | `==` | Equality (case-insensitive for strings) |
| `is not` | `!=` | Inequality |
| `at least` | `>=` | Greater than or equal |
| `at most` | `<=` | Less than or equal |
| `not` | `!` (prefix) | Logical negation |

Additional English-only comparisons (no symbol form):

```
<a> between <lo> and <hi>    range check (lo <= a <= hi)
<a> contains <b>             substring check (case-insensitive)
<a> matches <pattern>        glob pattern match (* and ?)
<a> is a <type>              type check
<a> is an <type>             same (a/an interchangeable)
```

**Pattern matching with `matches`:**

Accepts both glob patterns (string) and regular expressions (regex literal):

```
# glob patterns (string argument)
if hole matches "DDH*"
  say "diamond drillhole"
end

keep hole matches "RC*"
keep name matches "?ohn"
keep file matches "*.csv"
keep code matches "[A-Z][0-9][0-9]"

# regex patterns (regex literal argument)
keep hole matches /^DDH\d{3}$/
keep name matches /^(alice|bob)$/i
if line matches /grade:\s+\d+/
  say "found grade"
end
```

**Glob syntax** (when the pattern is a string):
- `*` — any characters (zero or more)
- `?` — single character
- `[abc]` — character class (matches a, b, or c)
- `[a-z]` — character range
- `[!abc]` — negated class (matches anything except a, b, c)

**Regex syntax** (when the pattern is a regex literal):
- Standard JavaScript regular expressions
- Flags after the closing `/`: `i` (case-insensitive), `g` (global), `m` (multiline)

Glob is the default for simplicity. Regex is the escape hatch for complex patterns.

**Type checking with `is a`:**

Checks the runtime type of a value. Base type names: `number`, `text`, `list`, `record`, `nothing`, `boolean`.

```
if x is a number
  say x times 2
end

if data is a list
  say length of data & " items"
end

if result is nothing
  say "no result"
end

unless value is a number
  say "expected a number"
end
```

`is not a` works as the negated form: `if x is not a number`.

**Compound type specs:**

Types can be qualified with `of` for parameterized types:

```
assume values is a list of numbers
assume matrix is a list of lists
assume names is a list of text
```

Plural tolerance applies: `list of numbers` and `list of number` are equivalent.

**Typed records:**

Record shapes can be described with `with` and `as a` / `as an` field annotations:

```
assume row is a record with grade as a number, depth as a number, hole as a text
assume point is a record with x as a number, y as a number, label as a text
```

`being a` / `being an` are synonyms for `as a` / `as an` in field type annotations:

```
assume row is a record with grade being a number, depth being a number
```

The `as a` / `as an` syntax is unambiguous because the parser peeks after `as` — if followed by `a` or `an` (which are keywords, not valid variable names), it's a type annotation, not result capture.

**Transpilation mapping:**

| Soft type | JS | atra |
|-----------|-----|------|
| `number` | `number` | `f64` |
| `text` | `string` | (not transpilable) |
| `boolean` | `boolean` | `i32` |
| `list of numbers` | `number[]` | `array f64` |
| `list of lists of numbers` | `number[][]` | `array(n,m) f64` |
| `record with ...` | `object` | `record ... end` |

Symbol forms work everywhere English forms do:

```
keep grade > 50
keep grade >= 50 and density > 3
if x != nothing
if !(ready)
```

### 4.7 Logic

```
<cond> and <cond>     logical AND
<cond> or <cond>      logical OR
not <cond>            logical NOT
```

`and` always means logical AND. There is no expression-context overloading.

### 4.8 String Concatenation

```
<expr> & <expr>       string concatenation
```

The `&` operator coerces both sides to text and concatenates them. It works in any expression context:

```
set greeting to "hello " & name
say "result: " & x + y
set msg to "found " & count & " intervals"
return prefix & "-" & suffix
```

`&` binds looser than arithmetic but tighter than comparison, so `"total: " & a + b` is `"total: " & (a + b)`.

### 4.9 Function Calls

**Statement level** (via `identStmt`): full sig-aware parsing with labeled params, variadic collection.

```
greet "Arthur" with "hello"
send "memo" to "Jessica"
biggest of 3, 7, 2, 9
```

**Expression level** (inside `say`, `set`, etc.): the parser resolves calls in `atom()`:

- Known sig with params: parsed according to signature, including seps and variadic
- Known sig, empty (no declared params): consumes any values that follow
- Bare dot-path: consumes comma-separated args
- Unknown name + no dot: treated as a variable reference

### 4.10 Bare JS Calls

Dot-path identifiers without a `use` declaration resolve directly against the JS globals:

```
say Math.round 3.7        single arg
say Math.pow 2, 10        comma-separated args
say Math.PI               value access (no args)
```

---

## 5. Function Signatures

A signature declares the parameters and call syntax of a function.

### 5.1 Syntax

```
<param> [<sep> <param>]* 
```

Where `<param>` is an identifier and `<sep>` is a keyword that becomes part of the call syntax.

**Noise words** at the start of a signature are skipped: `takes`, `with`. After the first parameter, these are treated as separators.

**`and`** between parameters is always skipped (param separator, not a labeled keyword).

### 5.2 Examples

| Definition | Signature | Call syntax |
|-----------|-----------|-------------|
| `define double takes n` | `[{param:"n"}]` | `double 5` |
| `define send message to person` | `[{param:"message"}, {sep:"to", param:"person"}]` | `send "hi" to "Bob"` |
| `define log message with level` | `[{param:"message"}, {sep:"with", param:"level"}]` | `log "err" with "warn"` |
| `define clamp value between low and high` | `[{param:"value"}, {sep:"between", param:"low"}, {param:"high"}]` | `clamp 5 between 0 and 10` |

### 5.3 Default Parameters

Append `is <value>` after a parameter name:

```
define greet person with greeting is "hello"
```

If the caller omits the `with` separator (and subsequent args), the default value is used. Only trailing params can have defaults — there is no way to skip a middle param.

### 5.4 Variadic Parameters

Prefix the last parameter with `many` or `all`:

```
define biggest of many numbers
```

At call site, all remaining values are collected into a list:

```
biggest of 3 7 2 9       spaces
biggest of 3, 7, 2, 9    commas
biggest of 3, 7 and 9    and
```

Commas, `and`, and bare spaces all serve as separators in variadic context.

### 5.5 Pre-scanning

The parser pre-scans the token stream for `define` and `use` statements to collect signatures before the main parse. This allows calls to reference functions defined later in the source.

---

## 6. Data Query Pipeline

The query sublanguage operates on arrays of row-objects.

### 6.1 Implicit Piping

**Newlines pipe results forward.** If a line starts with a transform keyword and the previous line produced a value, the value flows into the transform:

```
take intervals        → array of rows
keep grade above 50   → filtered array (input from previous line)
average grade         → number (input from previous line)
round to 1            → rounded number
```

A blank line (empty `NL`) breaks the pipe.

**Explicit piping** with `then` (and `and then` as sugar) works on a single line:

```
take intervals then keep grade above 50 then average grade
```

### 6.2 Universal `then`

`then` is not limited to data transforms. It chains any function — the left side becomes the first argument of the right side:

```
# data pipeline (existing)
take intervals then keep grade above 50 then average grade

# string pipeline
"  hello world  " then Text.trim then Text.upper

# math pipeline
Math.random then Math.floor

# mixed — any callable works
value of input then Text.trim then Text.upper as cleaned
```

**The rule:** after `then`, if the next token is a transform keyword (`keep`, `sort`, etc.), it's a pipeline step as before. If it's a function name, the piped value is prepended to its arguments:

```
# these are equivalent
"hello" then Text.upper
Text.upper "hello"
```

For multi-arg functions, the piped value becomes the first argument:

```
# these are equivalent
"hello world" then Text.split " "
Text.split "hello world" " "
```

Newline implicit piping only triggers for recognized transform keywords — not for arbitrary functions. This prevents ambiguity with unrelated statements on the next line. Use explicit `then` for non-transform chaining:

```
# this does NOT work — Text.upper is not a transform keyword
"hello"
Text.upper

# this works
"hello" then Text.upper
```

### 6.3 Data Source

```
take <name>
from <name>
```

Both are equivalent. Resolves the name from the environment.

### 6.4 Transforms

**Filter:**
```
keep <condition>      keep matching rows
drop <condition>      remove matching rows
```
`only` and `where` are aliases for `keep`.

In filter conditions, bare identifiers resolve against the current row first, then the environment. This allows: `keep grade above 50` where `grade` is a field of each row.

**Select columns:**
```
pick <field> [and <field>]*
```
`get` is an alias. If one field, returns a flat array of values. If multiple, returns array of objects with only those fields.

**Sort:**
```
sort [by] <field> [ascending|descending]
```
Default is ascending. `by` is optional filler.

**Limit:**
```
first <n>
last <n>
top <n>              alias for first
```

**Count:**
```
count [rows]
```
Returns the number of rows. `rows` is optional filler.

**Aggregation:**
```
average <field>       arithmetic mean
total <field>         sum
smallest <field>      minimum
largest <field>       maximum
```
Aliases: `mean` for `average`, `sum` for `total`, `min` for `smallest`, `max` for `largest`.

All accept `of` as optional filler: `average of grade`.

**Group:**
```
group by <field>
```
Returns an array of objects `{<field>: key, rows: [...], count: N}`.

**Round:**
```
round [<expr>] to <n>
```
Rounds to `n` decimal places. As a pipeline transform, operates on `it`. With an explicit expression, works as a standalone expression:

```
# pipeline transform
average grade
round to 1

# standalone expression
say round 3.14159 to 2
set ratio to round (x over y) to 3
```

**Computed columns:**
```
with <name> is|being|as <expr>
```
Adds a new field to every row, computed from the row's existing fields. The expression is evaluated per-row, with bare identifiers resolving against the current row (like `keep` conditions). `is`, `being`, and `as` are interchangeable.

```
take intervals
with tonnage being length times density
with metal as tonnage times grade
sort by metal descending
```

Multiple `with` lines chain — each can reference fields created by previous `with` transforms. Within a `with` expression, bare identifiers resolve against the row first, then the environment.

### 6.5 Records and Data Loading

**Record literals:**

```
record <field> <expr> [, <field> <expr>]*
```

Creates a single row object. Commas between pairs are optional:

```
set row to record hole "DDH001" grade 62.1 depth 15
set row to record hole "DDH001", grade 62.1, depth 15
```

A list of records is a table:

```
set data to list
  record name "Alice" age 30,
  record name "Bob" age 25,
  record name "Carol" age 35

take data
keep age above 28
```

**Record-with shorthand:**

```
record with <n> [, <n>]* [, <n> is <expr>]*
```

Creates a record using variable names as both field names and values. Like JavaScript's `{name, health}` shorthand:

```
set x to 10
set y to 20
set label to "origin"
set point to record with x, y, label
# → {x: 10, y: 20, label: "origin"}
```

Fields with `is` override the variable value:

```
set point2 to record with x, y, label is "other"
# → {x: 10, y: 20, label: "other"}
```

This is particularly useful for constructors:

```
define make_player called name with health is 100
  return record with name, health, x is 0, y is 0
end

set p to make_player called "Arthur"
say name of p & " has " & health of p & " HP"
```

**Loading external data:**

```
load <path> [into <n>]
load <path> as <n>
```

Loads a data source into a variable. The mechanism is host-defined -- in browser context it fetches a URL or opens a file picker, in Auditable it reads from notebook data sources, in CLI it reads the filesystem. Format detection is extension-based.

```
load "drillholes.csv" into intervals
load "config.json" into settings
load "notes.txt" into content

take intervals
keep grade above 50
```

If `into` / `as` is omitted, the result is available via `it` or flows into the next pipeline line.

**Saving data:**

```
save <expr> to <path> [as <format>]
```

Writes data to a file. The mechanism is host-defined -- in browser context it triggers a download, in CLI it writes to the filesystem.

```
take intervals
keep grade above 50
into ore

save ore to "ore_intervals.csv"
save settings to "config.json"
save "report complete" to "log.txt"
```

**Appending:**

```
append <expr> to <path>
```

Adds to an existing file rather than overwriting:

```
append "run completed at " & Date.today to "log.txt"
```

**Existence checking** uses the already-defined `there is a` syntax:

```
if there is a "results.csv"
  load "results.csv" into old_results
end
```

The load/save/append trio is deliberately minimal. Format detection (CSV, JSON, plain text) is host-defined -- the simplest approach is extension-based.

**Handle-based I/O (streaming):**

For large files or incremental output, use `open`/`write`/`close`:

```
open <path> for reading|writing|appending [as <n>]
write <expr> to <handle>
read from <handle> [into <n>]
close <handle>
```

**Reading line by line:**

```
open "bigfile.csv" for reading as reader
repeat each line in reader
  say line
end
close reader
```

The handle is iterable -- `repeat each line in reader` streams lines without loading the entire file into memory.

**Writing incrementally:**

```
open "output.txt" for writing as writer
write "hole,grade" to writer
repeat each row in intervals
  write hole of row & "," & grade of row to writer
end
close writer
```

**Appending to a log:**

```
open "log.txt" for appending as log
write "run started at " & Date.today to log
# ... do work ...
write "run complete" to log
close log
```

**Reading a single line or chunk:**

```
open "config.txt" for reading as f
read from f into header
read from f into first_line
close f
```

`read from` reads the next line from the handle. The handle tracks position.

**Batch vs streaming:** `load`/`save`/`append` are batch -- they read or write entire files in one operation. `open`/`write`/`read from`/`close` are streaming -- they work incrementally. Use batch for small files and convenience, streaming for large files and control.

### 6.6 Result Capture

Every expression statement that produces a non-null value assigns it to the implicit variable `it`, then auto-displays.

**The `it` variable:**

```
take intervals
keep grade above 50
average grade

say "the average is " & it
if it above 40
  say "above cutoff"
end
```

`it` always holds the last expression result. It is overwritten by every statement that produces a value.

**The `into` / `as` suffix:**

`into <n>` or `as <n>` at the end of any statement captures the result into a named variable and suppresses auto-display. They are synonyms -- use whichever reads more naturally.

```
# pipelines
take intervals
keep lithology is itabirite
average grade
into ore_grade

# function calls
make "li" in taskList as el
make "button" in toolbar into btn

# load
load "data.csv" as intervals

# bare JS calls
Math.pow 2, 10 as result

# any expression
42 times 2 into answer
```

`as` tends to read well for naming/creation (`make X as Y`, `load X as Y`). `into` tends to read well for storing computed results (`average grade into avg`). Both work everywhere.

`into` / `as` cannot appear mid-pipeline -- only at the end, as a terminator.

**Both work with `it`:**

```
# quick one-off -- use 'it'
take collars
largest depth
say "deepest hole is " & it & "m"

# named for reuse -- use 'into' or 'as'
take intervals
keep grade above 50
count
into high_grade_count

say high_grade_count & " intervals above 50%"
```

---

## 7. Foreign Function Interface

### 7.1 Declared Imports (`use`)

```
use Math.round as round
use Math.pow base to power
use Text.upper as shout
```

The `use` statement resolves a dot-path against a host-provided JS globals object and registers it as a callable function. The optional signature provides labeled call syntax.

### 7.2 Bare Dot-Path Calls

```
Math.round 3.7
Math.pow 2, 10
```

Dot-path identifiers at call position resolve directly against JS globals. Multiple args are comma-separated. This is an escape hatch — `use` is the idiomatic path.

### 7.3 The Globals Object

The host environment provides a globals object at evaluator construction. The reference implementation provides:

- `Math.*` — standard JS Math
- `Text.*` — `upper`, `lower`, `trim`, `split`, `replace`, `starts`, `ends`, `slice`
- `List.*` — `range`, `reverse`, `flat`, `unique`, `join`, `zip`
- `Date.*` — `now`, `today`, `time`, `year`
- `JSON.*` — `stringify`, `parse`

Implementations may extend this with domain-specific globals (e.g., Auditable cell references).

### 7.4 Keyword Collision

Imported function names may collide with keywords (e.g., `round`, `sort`, `count`). The parser handles this:

1. `use` accepts keywords after `as` via `expectName()` (accepts both ID and KW tokens).
2. `atom()` checks if a KW token is a registered function name and treats it as a call.
3. Pre-scan registers sigs for imported names regardless of keyword status.

**Data field names that collide with keywords:**

Common data fields like `from`, `to`, `in`, `count` may collide with keywords. These are handled through two mechanisms:

1. **In filter/with contexts** (`keep`, `drop`, `with`), bare identifiers resolve against the current row first. The evaluator checks the row before the keyword has any effect.

2. **In `of` expressions**, use dynamic property access with parentheses:

```
# "to" is a keyword, but this works via dynamic access:
set field_name to "to"
say (field_name) of row

# or use string literal directly:
say ("to") of row
```

As a general rule: avoid naming data fields with common Soft keywords. If you inherit data with keyword field names, use dynamic `of` access or rename the fields with `with`:

```
take intervals
with end_depth being ("to") of it
with start_depth being ("from") of it
```

---

## 8. Truthiness

The following values are falsy:
- `false`
- `null` / `nothing`
- `0`
- `""` (empty string)
- empty list (`list` with no elements)

Everything else is truthy.

---

## 9. `and` Disambiguation

The word `and` has three meanings depending on parser context:

| Context | Meaning | Example |
|---------|---------|---------|
| In conditions and general expressions | Logical AND | `keep grade above 50 and density above 3` |
| In `pick` | Field separator | `pick hole and grade` |
| In variadic calls | Argument separator | `biggest of 3, 7 and 9` |

String concatenation uses the `&` operator, not `and`. See §4.8.

**`and then`** is always a pipe operator — the parser checks for `then` after consuming `and` and backtracks if not found.

## 9.1 `with` Disambiguation

The word `with` has three meanings:

| Context | Meaning | Example |
|---------|---------|---------|
| In function definitions/calls | Labeled parameter separator | `define greet person with greeting` |
| In pipeline (after transform keywords) | Computed column | `with tonnage being length times density` |
| In `ask` | Default value | `ask "Name?" with "Arthur"` |

The parser distinguishes by position: `with` at the start of a pipeline line is a computed column. `with` following `ask` provides a default. `with` following a function name at call site is a parameter separator.

## 9.2 `as` Disambiguation

The word `as` has four meanings:

| Context | Meaning | Example |
|---------|---------|---------|
| In `use` statement | Import rename | `use Math.round as round` |
| In `with` transform | Column binding (synonym for `is`/`being`) | `with tonnage as length times density` |
| At end of statement | Result capture (synonym for `into`) | `make "li" in list as el` |
| Followed by `a`/`an` | Field type annotation | `grade as a number` in typed records |

The parser distinguishes by position and peek: after `use` it's a rename, inside a `with` expression it's a binding. At end of statement, `as` followed by `a`/`an` is a type annotation (the peek rules it out as result capture since `a` and `an` are keywords, not valid variable names). `as` followed by any other NAME is result capture.

## 9.3 Master Disambiguation Table

Every keyword with multiple meanings, the parser function that resolves it, and the resolution rule:

| Keyword | Meaning | Parser function | Resolution rule |
|---------|---------|-----------------|-----------------|
| `and` | Logical AND | `conditionExpr()` | In conditions and general expressions |
| `and` | Field separator | `pickExpr()` | After `pick`/`get` |
| `and` | Argument separator | variadic collection in `atom()`/`identStmt()` | Inside variadic call |
| `&` | String concatenation | `concat()` | Always — binary operator between expressions |
| `and then` | Pipe operator | `matchAndThen()` | Always — checked before any `and` interpretation |
| `with` | Computed column | `pipeLine()` | At start of pipeline line |
| `with` | Default value | `askStmt()` | After `ask` expression |
| `with` | Param separator | `identStmt()` | Mid function call, matches sig |
| `as` | Import rename | `useStmt()` | After `use` path |
| `as` | Column binding | `with_expr` in transforms | Inside `with` transform (synonym for `is`/`being`) |
| `as` | Result capture | statement suffix | `as` + NAME (peek: next is not `a`/`an`) |
| `as a`/`an` | Type annotation | `field_type` in `type_spec` | `as` + `a`/`an` + type name (peek disambiguates from result capture) |
| `is` | Equality (`==`) | `singleCond()` / `comparator` | Bare `is` followed by a value |
| `is not` | Inequality | `singleCond()` | `is` followed by `not` |
| `is above` | Greater than | `singleCond()` | `is` followed by `above` — same as bare `above` |
| `is below` | Less than | `singleCond()` | `is` followed by `below` — same as bare `below` |
| `at least` | Greater or equal | `singleCond()` | `at` followed by `least` → `>=` |
| `at most` | Less or equal | `singleCond()` | `at` followed by `most` → `<=` |
| `is a`/`an` | Type check | `singleCond()` | `is` followed by `a`/`an` then type name |
| `is` | Default value | `parseSig()` | Inside function signature, after param name |
| `is` | Column binding | `with_expr` | Inside `with` transform (synonym for `being`/`as`) |
| `to` | Assignment | `setStmt()` | After `set <name>` |
| `to` | Range end | `range_loop` | Inside `repeat from X to Y` |
| `to` | Sig separator | `identStmt()` | Mid function call, matches sig |
| `to` | Exponent | `exponent()` | After `raised` |
| `to` | Target | `saveStmt()` / `writeStmt()` / `addStmt()` | After `save`/`write`/`add` expression |
| `to` | Round precision | `roundExpr()` | After `round` |
| `of` | Static property | `postfix()` in `eval` | Left side is bare Ref → literal name |
| `of` | Dynamic property | `postfix()` in `eval` | Left side is parenthesized → evaluate as key |
| `of` | Aggregation filler | `aggExpr()` | After `average`/`total`/etc. — optional, consumed and ignored |
| `into` | Assignment | `putStmt()` | After `put` expression |
| `into` | Result capture | statement suffix | End of statement before NL |
| `times` | Loop terminator | `repeatStmt()` | After `repeat` count expression |
| `times` | Multiplication | `term()` | Inside arithmetic context |
| `from` | Data source | `takeExpr()` | At statement start (alias for `take`) |
| `from` | Range start | `range_loop` | Inside `repeat from X to Y` |
| `from` | Remove source | `removeStmt()` | After `remove` expression |
| `from` | Read source | `read_stmt` | After `read` |
| `not` | Logical NOT | `unary()` / `singleCond()` | Prefix in condition or expression |
| `not` | Inequality | after `is` in `singleCond()` | `is not` consumed as a unit |
| `not` | Type negation | after `is` in `singleCond()` | `is not a` consumed as a unit |
| `is` | Scoped override | `supposeStmt()` | After `suppose <n>` |
| `it` | Implicit result variable | `atom()` / environment | Bare reference to last result |
| `it` | Error handler keyword | `tryStmt()` | In `if it fails` — parsed as a fixed phrase |
| `otherwise` | Else branch | `ifStmt()` | After if-body |
| `otherwise` | Error message | `assumeStmt()` | After assume condition |
| `otherwise` | Ternary false-branch | inline conditional | In `X if cond otherwise Y` |
| `called` | Mid-pipeline naming | `transform` / `pipe_step` | After any pipeline step |
| `for` | Loop noise | `each_loop` in `repeatStmt()` | After `repeat`, optional before `each` |
| `for` | Implied repeat | statement dispatch | At statement start, dispatches to each-loop |
| `for` | File mode | `openStmt()` | After `open` path, before `reading`/`writing`/`appending` |
| `while` | Loop condition | `while_loop` in `repeatStmt()` | After `repeat` |
| `while` | Implied repeat | statement dispatch | At statement start, dispatches to while-loop |
| `while` | Wait condition | `waitStmt()` | After `wait` |
| `until` | Loop condition | `until_loop` in `repeatStmt()` | After `repeat` |
| `until` | Implied repeat | statement dispatch | At statement start, dispatches to until-loop |
| `until` | Wait condition | `waitStmt()` | After `wait` |

| `call` | Explicit invocation | `unary()` | `call <expr> [args]` → invoke function value |
| `run` | Explicit invocation | `unary()` | `run <expr> [args]` → invoke function value (synonym for `call`) |
| `result` | Explicit invocation | `unary()` | `result of <expr> [args]` → invoke function value (noun form) |
| `number` | Counting prefix | `unary()` | Followed by `of` → `number of characters in X` |
| `number` | Coercion builtin | `atom()` | Not followed by `of` → convert argument to number |
| `number` | Type name | `type_spec` | After `is a` / `as a` → type check/annotation |
| `text` | Coercion builtin | `atom()` | At call position → convert argument to text |
| `text` | Type name | `type_spec` | After `is a` / `as a` → type check/annotation |
| `stop` | Loop break | statement dispatch | Inside loop → exit loop |
| `stop` | Handler exit | statement dispatch | Inside event handler → return from handler |
| `skip` | Loop continue | statement dispatch | Inside loop → next iteration |

**The invariant:** every multi-meaning keyword is consumed by a specific parser function that was already dispatched based on context. The parser never needs to guess what a keyword means — it knows which function it's in, and each function only looks for one meaning.

**Noise words** (`the`, `a`, `an`, `that`, `this`, `do`) are consumed in `atom()` only, never at statement dispatch level. This prevents them from interfering with statement parsing.

---

## 10. Built-in Functions

These are available without `use`:

| Name | Signature | Returns |
|------|-----------|---------|
| `abs` | 1 arg | Absolute value |
| `floor` | 1 arg | Floor |
| `ceil` | 1 arg | Ceiling |
| `sqrt` | 1 arg | Square root |
| `random` | 0 args | Random float 0..1 |
| `number` | 1 arg | Coerce to number |
| `text` | 1 arg | Coerce to string |

---

## 11. Runtime Semantics

### 11.1 Scoping

Variables use lexical scoping. Each function body creates a new scope frame that chains to its definition scope (lexical parent). Variable lookup walks the chain: local → enclosing → ... → global. Assignment writes to the innermost scope that owns the name; if no scope owns it, it creates in the current scope.

Functions are closures — they capture their definition environment. This enables callbacks, higher-order functions, and event handlers that reference outer state:

```
define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end

set c to make_counter
say c    # 1
say c    # 2
```

`suppose` blocks create a temporary scope frame: the overridden variable is saved, modified in a new frame, and restored when the block ends.

Loop variables (`repeat each x in ...`, `repeat from ... as i`) are scoped to the loop body.

### 11.2 Property Resolution (`of`)

The `of` operator resolves differently based on the left-side node type:

- **Ref node** (bare identifier): uses the name literally. `grade of row` → `row.grade`.
- **Literal or grouped expression** (parenthesized): evaluates the expression, uses the result as the key. `(field) of row` → `row[eval(field)]`. `("to") of row` → `row["to"]`.

This distinction enables both static and dynamic property access through the same syntax.

In filter contexts (`keep`, `drop`, `with`), bare identifiers resolve against the current row first, then the environment. This allows `keep grade above 50` without explicitly writing `grade of row`.

### 11.3 Mutation

All data is mutable. `set` modifies variables, properties, list items, and string chunks in place. `add` and `remove` modify lists in place. This matches the imperative semantics of `set X of Y to Z` — the object is changed, not copied.

### 11.4 Step Limit

The evaluator enforces a step limit (default 50,000) to prevent infinite loops. Each node evaluation counts as one step.

### 11.5 Return Propagation

`return` exits the enclosing function immediately. Returns propagate through block execution and loop bodies.

### 11.6 `it` and Result Capture

Every expression statement assigns its result to the implicit variable `it`. `it` is overwritten on each new expression statement. It is a convenience for short sequences:

```
take intervals
count
say it
```

`into <n>` / `as <n>` at the end of a statement stores the result in a named variable (in addition to `it`):

```
take intervals
count
into total
say total
```

Results are never auto-displayed. Use `say` for output. In Auditable cells, the last expression's value is the cell's reactive output.

---

## 12. String Representation

| Value | Stringified as |
|-------|---------------|
| `null` | `"nothing"` |
| `true` | `"yes"` |
| `false` | `"no"` |
| number | decimal representation |
| string | itself |
| array of primitives | comma-separated |
| array of objects | formatted table |
| object | `key: value` pairs |

---

## 13. Syntax Flexibility

Soft has a rigid canonical syntax but accepts common synonyms and noise words to make the language more forgiving. These do not add ambiguity — each synonym maps to exactly one canonical form.

### 13.1 Noise Words

The following words are consumed and ignored wherever they appear in expression position: `the`, `a`, `an`, `that`, `this`. They allow more natural phrasing without affecting semantics:

```
# all identical
say the length of the names
say length of names

set the cutoff to 50
set cutoff to 50

if the grade of this row is above the cutoff
if grade of row is above cutoff
```

### 13.2 `else` for `otherwise`

`else` is accepted as a synonym for `otherwise`:

```
if x above 5
  say "big"
else
  say "small"
end
```

### 13.3 Optional `do` Before Blocks

`do` may appear before any block body and is ignored:

```
repeat 10 times do
  say "hello"
end

if x above 5 do
  say "big"
end
```

### 13.4 Comparison Synonyms

Additional English phrasings for comparisons, mapped to canonical operators:

| Synonym | Canonical | Notes |
|---------|-----------|-------|
| `greater than` | `above` / `>` | `greater` consumes `than` |
| `less than` | `below` / `<` | `less` consumes `than` |
| `more than` | `above` / `>` | `more` consumes `than` |
| `under` | `below` / `<` | |
| `equals` | `is` / `==` | |
| `is equal to` | `is` / `==` | `equal` consumes `to` |
| `is greater than` | `above` / `>` | after `is`, same as `above` (strictly greater) |
| `is less than` | `below` / `<` | after `is`, same as `below` (strictly less) |
| `at least` | `>=` | greater than or equal |
| `at most` | `<=` | less than or equal |
| `does not equal` | `is not` / `!=` | `does` is noise, `not` inverts, `equal` is comparison |

```
if grade greater than 50
if grade less than 10
if grade equals 50
if name does not equal "Arthur"
```

### 13.5 Plural Tolerance

Singular and plural forms are interchangeable for all unit and chunk keywords:

| Singular | Plural | Both accepted |
|----------|--------|---------------|
| `row` | `rows` | `count row` / `count rows` |
| `second` | `seconds` | `wait 1 second` / `wait 2 seconds` |
| `millisecond` | `milliseconds` | same |
| `character` | `characters` | `character 2 of x` / `characters 2 to 4 of x` |
| `word` | `words` | same |
| `line` | `lines` | same |
| `item` | `items` | same |
| `time` | `times` | `repeat 1 time` / `repeat 3 times` |

### 13.6 Result Aliases

`that`, `result`, and `the result` are aliases for the implicit variable `it`:

```
take intervals
average grade
say "mean is " & that
say "also: " & the result

5 plus 3
say result
```

These all resolve to the same `it` variable in the environment. Bare `result` is distinguished from `result of <expr>` (function invocation, §3.7) by peek: `result` followed by `of` is invocation, bare `result` is the alias.

### 13.7 Range Loop

An alternative loop form using `from`/`to` for numeric ranges, with optional `by` for step size:

```
repeat from 1 to 10 as i
  say i
end

repeat from 0 to count minus 1 as index
  say item index of data
end

repeat from 0 to 100 by 10 as cutoff
  take intervals
  keep grade above cutoff
  count
  say cutoff & "% → " & it & " intervals"
end

repeat from 10 to 0 by -1 as countdown
  say countdown
end
```

This is sugar for a counted loop with a variable. The step defaults to 1 if omitted (or -1 if `from` is greater than `to`). The loop variable takes the value of `from` on the first iteration and increments by `by` each iteration until it exceeds `to`.

---

## 14. Open Questions

1. ~~**Error handling.**~~ Resolved: `try` / `if it fails` / `the error` (§3.17).
2. ~~**Closures.**~~ Resolved: lexical scoping with closures (§11.1). First-class functions via `call`/`run`/`result of` (§3.7).
3. ~~**Dictionaries.**~~ Resolved: `record name "Alice" age 30` creates row objects.
4. **Pattern matching.** Chained `if`s are verbose. Consider `when`/`is` syntax.
5. ~~**Async/IO.**~~ Partially resolved: `load`/`save` for file I/O (host-dependent). `ask`/`wait` still pending (need async evaluator).
6. **Module system.** No imports between files.
7. ~~**String escapes.**~~ Resolved: standard backslash escapes in string literals (§2.1).
8. ~~**Negative numbers in expressions.**~~ Resolved: `negative x` and unary `-x` both work.
9. ~~**Autocomplete integration.**~~ Resolved: CM6 autocomplete for Soft cells with keyword/builtin completions. Plugin autocomplete hook for any cell type with a `completions` handler.
10. **File extension.** `.soft` is the canonical extension. The GCU package name is `@gcu/soft`.
11. ~~**Ordinals.**~~ Deferred: dual indexing system (0-based + 1-based) adds complexity without enough benefit. `first of`/`last of` cover the common cases.
12. ~~**Function invocation.**~~ Resolved: registered functions (via `define`/`use`) are called via sig-aware parsing. Closures and variables use explicit `call`/`run`/`result of` (§3.7). No auto-call — functions are first-class values.
13. **`explain` tree walker.** Not yet implemented. Second AST walker producing prose descriptions.
14. **i18n locale tables.** Not yet implemented. Keyword table swap for localized surface syntax.

---

## 15. Browser Embedding

Soft is designed to run natively in the browser. Two embedding models are supported:

### 15.1 Inline Scripts (PyScript-style)

```html
<script type="text/soft">
on click greetButton
  set name to value of nameField
  set greeting of output to "hello " & name
end
</script>

<input id="nameField">
<button id="greetButton">greet</button>
<div id="output"></div>
```

The runtime scans for `<script type="text/soft">` blocks, parses and evaluates them, and registers any `on` handlers against the DOM. Element IDs are automatically available as names — no `document.getElementById` needed.

### 15.2 Host Globals for DOM

In browser context, the JS globals object is extended with:

- `Dom.get` — element by ID
- `Dom.text` — get/set text content
- `Dom.value` — get/set input value
- `Dom.style` — set CSS property
- `Dom.add` — add CSS class
- `Dom.remove` — remove CSS class
- `Dom.create` — create element
- `Dom.append` — append child
- `Dom.on` — manual event binding (for dynamic elements)

These are all available via `use` or bare dot-path calls:

```
on click addButton
  set item to value of inputField
  Dom.append "list" item
  set value of inputField to ""
end
```

**The `make` statement:**

In browser context, `make` is syntactic sugar for `Dom.create` + `Dom.append`:

```
make <tag> [in <parent>] [as <name>]
```

Creates an HTML element and optionally appends it to a parent and names it:

```
make "div" in body as output
make "li" in taskList as el
make "button" in toolbar as btn
```

`make "div" in body as output` is equivalent to:

```
Dom.create "div" as output
Dom.append body output
```

`make` is host-defined — it exists in browser and Auditable contexts but not in standalone CLI mode.

### 15.3 Auditable Integration

In Auditable, each cell is a Soft program. The globals object carries:

- Cell references as named data sources (`take` resolves cell names)
- Reactive bindings: when an upstream cell changes, downstream cells re-evaluate
- `on change` handlers for interactive cells (sliders, inputs)
- `say` output renders into the cell's output area

The same evaluator powers both standalone browser scripts and Auditable cells — only the globals object differs.

### 15.4 File Conventions

| Extension | Use |
|-----------|-----|
| `.soft` | Standalone Soft source file |
| `.soft.html` | HTML document with embedded Soft scripts |

---

## 16. Internationalization

Soft's keywords are semantic English words, not arbitrary tokens. This makes the language uniquely amenable to localization — the entire surface syntax can be translated by swapping a keyword table.

### 16.1 Architecture

The parser never compares against raw keyword strings. It maps words to token types via a locale table. Swapping the table changes the surface language without affecting the grammar, AST, or evaluator. The AST is always in canonical (English) form regardless of input locale.

A locale definition is a JSON file mapping canonical (English) keywords to accepted localized forms. Each keyword maps to an **array** of accepted forms -- this allows inflected languages to accept multiple conjugations (imperative, infinitive, present tense) for the same keyword:

```json
{
  "locale": "pt-BR",
  "keywords": {
    "take": ["pegar", "pegue", "pega"],
    "keep": ["manter", "mantenha", "mantém"],
    "drop": ["descartar", "descarte"],
    "say": ["dizer", "diga", "diz", "fala", "fale"],
    "ask": ["perguntar", "pergunte"],
    "set": ["definir", "defina", "define", "põe", "ponha"],
    "to": ["como", "para"],
    "of": ["de", "do", "da"],
    "above": ["acima", "maior"],
    "below": ["abaixo", "menor"],
    "is": ["é"],
    "not": ["não"],
    "and": ["e"],
    "or": ["ou"],
    "if": ["se", "caso"],
    "otherwise": ["senão"],
    "end": ["fim"],
    "repeat": ["repetir", "repita", "repete"],
    "each": ["cada"],
    "in": ["em", "nos", "nas"],
    "define": ["definir", "defina"],
    "return": ["retornar", "retorne"],
    "average": ["média"],
    "total": ["total"],
    "true": ["verdadeiro"],
    "false": ["falso"],
    "nothing": ["nada"]
  },
  "noise": ["o", "a", "os", "as", "um", "uma", "este", "esse", "do", "da"]
}
```

On load, the parser **inverts** the locale table into a flat lookup from any accepted form to its canonical token:

```javascript
// parser builds on init
{ "pegar": "take", "pegue": "take", "pega": "take",
  "manter": "keep", "mantenha": "keep", ...
  "dizer": "say", "diga": "say", "diz": "say", "fala": "say", ... }
```

One hash lookup per token, O(1). The parser never sees Portuguese internally -- it sees canonical English tokens. All downstream processing (AST, evaluator, `explain`, transpilation) is locale-independent.

This means both of these parse identically:

```
# formal infinitive
dizer resultado

# colloquial imperative
diz resultado

# both produce: Say("resultado")
```

### 16.2 Scope and Limitations

**Works well for SVO languages** (subject-verb-object word order, like English): Portuguese, Spanish, French, Italian, Chinese, Malay, and others. The verb-first pipeline structure maps naturally:

```
# Portuguese (infinitive — formal, robotic)
pegar intervalos
manter grau acima 50
média de grau
dizer "resultado: " & resultado

# Portuguese (imperative — natural, how you'd actually talk)
pegue intervalos
mantenha grau acima 50
média de grau
diga "resultado: " & resultado

# Both parse identically — the locale accepts all forms.

# Spanish
tomar intervalos
mantener grado sobre 50
promedio de grado
decir "resultado: " & resultado

# French
prendre intervalles
garder grade dessus 50
moyenne de grade
dire "résultat: " & résultat
```

**Awkward for SOV languages** (subject-object-verb: Japanese, Korean, Turkish, Hindi). Soft's grammar forces the verb first (`take intervals`, not `intervals take`). Localization for these languages would require grammar reordering, which is out of scope for the keyword-table approach. English Soft may be preferable for these speakers, as the syntax is simpler than most programming APIs.

**Prepositions are the hard part.** Each language needs its own set of connector/noise words. "set X to Y" might be "definir X como Y" (Portuguese) or "setze X auf Y" (German) — the preposition changes. The locale file includes a per-language noise word set to handle this.

**Some languages benefit from parser-level changes.** The keyword-table approach is the minimum viable localization, but it is not the only option. A locale may include parser modifications for a more natural result. For example, Chinese Soft would benefit from two structural changes:

- **的 (de) — property access particle.** Chinese expresses `grade of row` as `行的品位` (row-de-grade) — left-to-right, the opposite direction from English `of`. A Chinese parser would resolve 的 without the reversal that `of` requires.
- **把 (bǎ) — object-before-verb mutation.** Chinese idiomatically says `把 X 设为 Y` (BA X set-to Y) instead of `设 X 为 Y` (set X to Y) when the object is being modified. A Chinese parser would recognize 把 as an alternative statement dispatch that reads the object first, then the verb.

These are small parser changes — not grammar redesigns. The AST output is identical to the English version; only the surface parsing differs. Locale authors are encouraged to identify and implement such adaptations where they make the language feel native rather than translated.

**A note on Chinese Soft specifically:** We believe a Chinese locale of Soft could be extraordinary — the information density of Chinese characters, the natural left-to-right property access via 的, the SVO word order, and the efficiency of Pinyin input would likely produce the most concise yet readable version of Soft possible. However, we don't feel we could do justice to the language without native fluency. We strongly encourage a native or fluent Chinese speaker to build this locale if they find the idea interesting. The parser changes are small (的 and 把), the keyword set is ~13 single-character verbs, and the result could be genuinely novel — not a translation of an English language, but a programming language that thinks in Chinese.

### 16.3 Recommended Approach

A fully localized Soft dialect is best defined by a native speaker working with an LLM: the speaker provides natural phrasing for each construct, the LLM verifies parser compatibility and identifies collisions. The result is a tested locale file — and optionally a small set of parser patches for structural features like property access direction or alternative statement dispatch — that plugs into any Soft runtime.

Multiple locale tables can be loaded simultaneously, enabling multilingual source files where each programmer writes in their preferred language and the AST is identical. Parser-level adaptations are per-locale and do not affect other locales.

### 16.4 File Conventions

| Extension | Use |
|-----------|-----|
| `.soft` | Soft source (any locale) |
| `soft-locale-pt.json` | Brazilian Portuguese locale |
| `soft-locale-de.json` | German locale |
| `soft-locale-xx.json` | Any locale |

---

## Appendix A: Grammar Summary (Informal EBNF)

```
program       = { statement NL }

statement     = set_stmt | put_stmt | say_stmt | ask_stmt | if_stmt | unless_stmt
              | repeat_stmt | define_stmt | on_stmt | use_stmt
              | return_stmt | add_stmt | remove_stmt
              | load_stmt | save_stmt | append_stmt
              | open_stmt | close_stmt | write_stmt | read_stmt
              | wait_stmt | stop_stmt | skip_stmt | explain_stmt | assume_stmt
              | suppose_stmt | try_stmt | make_stmt
              | suffix_cond | pipeline_stmt | ident_stmt

set_stmt      = "set" ( NAME | of_path | chunk_path ) "to" expression
put_stmt      = "put" expression "into" ( NAME | of_path | chunk_path )
of_path       = ( NAME | "(" expression ")" ) "of" NAME { "of" NAME }
chunk_path    = chunk_kind atom "of" ( NAME | of_path | chunk_path )
              | ORDINAL chunk_kind "of" ( NAME | of_path | chunk_path )
chunk_kind    = "character" | "word" | "line" | "item"
say_stmt      = "say" expression { expression }    (* juxtaposition: multiple values auto-concatenated *)

if_stmt       = "if" condition ["do"] NL block [ ("otherwise"|"else") NL block ] "end"
unless_stmt   = "unless" condition ["do"] NL block "end"
suffix_cond   = statement ( "if" | "unless" ) condition    (* suffix conditional *)
repeat_stmt   = "repeat" ( count_loop | each_loop | while_loop | until_loop | range_loop )
              | "for" ( each_loop | short_each )        (* 'for' implies 'repeat' *)
              | "while" condition ["do"] NL block "end"  (* 'while' implies 'repeat' *)
              | "until" condition ["do"] NL block "end"  (* 'until' implies 'repeat' *)
count_loop    = arithmetic ("times"|"time") ["do"] NL block "end"
each_loop     = ["for"] "each" NAME "in" expression ["do"] NL block "end"
short_each    = NAME "in" expression ["do"] NL block "end"   (* 'for row in X' *)
while_loop    = "while" condition ["do"] NL block "end"
until_loop    = "until" condition ["do"] NL block "end"
range_loop    = "from" arithmetic "to" arithmetic [ "by" arithmetic ] ("as"|"into") NAME ["do"] NL block "end"

define_stmt   = "define" NAME signature NL block "end"
on_stmt       = "on" NAME [ NAME ] [ NAME { NAME } ] NL block "end"
use_stmt      = "use" DOTPATH [ "as" NAME ] [ signature ]
return_stmt   = "return" [ expression ]
add_stmt      = ( "add" | "append" | "push" ) expression "to" NAME
remove_stmt   = "remove" expression "from" NAME
load_stmt     = "load" ( STR | NAME ) [ ( "into" | "as" ) NAME ]
save_stmt     = "save" expression "to" ( STR | NAME ) [ "as" NAME ]
append_stmt   = "append" expression "to" ( STR | NAME )
open_stmt     = "open" ( STR | NAME ) "for" ( "reading" | "writing" | "appending" ) [ ( "as" | "into" ) NAME ]
close_stmt    = "close" NAME
write_stmt    = "write" expression "to" NAME
read_stmt     = "read" "from" NAME [ ( "into" | "as" ) NAME ]
ask_stmt      = "ask" expression [ "with" expression ] [ result_capture ]
wait_stmt     = "wait" ( arithmetic time_unit | "until" condition | "while" condition )
time_unit     = "second" | "seconds" | "millisecond" | "milliseconds"
stop_stmt     = "stop"                  (* break loop or exit handler *)
skip_stmt     = "skip"                  (* continue to next iteration *)
make_stmt     = "make" STR [ "in" NAME ] [ ( "as" | "into" ) NAME ]   (* browser/host-defined *)
explain_stmt  = "explain" ( statement | expression )
assume_stmt   = "assume" condition [ "otherwise" expression ]
suppose_stmt  = "suppose" NAME "is" expression NL block "end"
try_stmt      = "try" NL block "if" "it" "fails" NL block "end"
there_expr    = "there" "is" ( "a" | "an" | "no" ) NAME    (* used in conditions *)

signature     = { noise } { sig_param }
noise         = "takes" | "with"         (* only before first param *)
sig_param     = [ "many" | "all" ] NAME [ "is" default_val ]
              | KW [ "many" | "all" ] NAME [ "is" default_val ]
default_val   = NUM | STR | NAME | "nothing" | "true" | "false"

result_capture = ( "into" | "as" ) NAME   (* universal suffix; peek: 'as' + 'a'/'an' = type, 'as' + NAME = capture *)

pipeline_stmt = pipe_line { NL transform | ("then"|"and" "then") pipe_step } [ result_capture ]
pipe_step     = ( transform | call_expr ) [ "called" NAME ]
call_expr     = ( NAME | DOTPATH ) { arithmetic }
              (* NL only continues to transforms; 'then' continues to any callable *)
ident_stmt    = NAME args [ result_capture ]  (* function call with optional capture *)
pipe_line     = take_expr | transform | expression
take_expr     = ( "take" | "from" ) NAME { inline_transform }

transform     = ( keep_expr | drop_expr | pick_expr | agg_expr
              | count_expr | sort_expr | round_expr | group_expr
              | limit_expr | with_expr ) [ "called" NAME ]

keep_expr     = ( "keep" | "only" | "where" ) condition
drop_expr     = "drop" condition
pick_expr     = ( "pick" | "get" ) NAME { "and" NAME }
agg_expr      = ( "average" | "total" | "count" | "smallest" | "largest"
              |   "mean" | "sum" | "min" | "max" ) [ "of" ] NAME
count_expr    = "count" [ "rows" ]
sort_expr     = "sort" [ "by" ] NAME [ "ascending" | "descending" ]
round_expr    = "round" [ arithmetic ] "to" NUM    (* with explicit value or pipeline implicit *)
group_expr    = "group" "by" NAME
limit_expr    = ( "first" | "last" | "top" ) [ NUM ]
with_expr     = "with" NAME ( "is" | "being" | "as" ) expression

condition     = single_cond { ( "and" | "or" ) single_cond }
single_cond   = there_expr
              | arithmetic comparator arithmetic
              | arithmetic "between" arithmetic "and" arithmetic
              | arithmetic "contains" arithmetic
              | arithmetic "matches" ( STR | REGEX )
              | arithmetic "is" ["not"] ("a"|"an") type_spec
              | arithmetic                        (* bare truthy *)
type_spec     = type_name [ "of" type_name ]     (* list of numbers *)
              | "record" "with" field_type { ("," | "and") field_type }
field_type    = NAME ("as"|"being") ["a"|"an"] type_name
type_name     = "number" | "numbers" | "text" | "list" | "record" | "nothing" | "boolean"
comparator    = "above" | ">" | "greater" "than" | "more" "than"
              | "below" | "<" | "less" "than" | "under"
              | "is" [ "not" | "above" | "below" | "equal" "to" | "greater" "than" | "less" "than" ]
              | "at" "least" | ">="
              | "at" "most" | "<="
              | "==" | "!="
              | "equals" | "does" "not" "equal"
              | "not"

inline_cond   = concat "if" condition "otherwise" concat  (* ternary expression *)
expression    = inline_cond
              | concat
concat        = logic { "&" logic }               (* string concatenation *)
logic         = comparison { ( "and" | "or" ) comparison }  (* always logical AND/OR *)
comparison    = bitwise [ comparator bitwise ]       (* or type check, between, contains, matches *)
bitwise       = shift { ( "bitwise" "and" | "bit" "and"
              | "bitwise" "or" | "bit" "or"
              | "bitwise" "xor" | "bit" "xor" | "xor" ) shift }
shift         = arithmetic { ( "shift" "left" | "<<" | "shift" "right" | ">>" ) arithmetic }
arithmetic    = term { ( "plus" | "+" | "minus" | "-" ) term }
term          = exponent { ( "times" | "*" | "over" | "/" | "mod" | "%" ) exponent }
exponent      = unary [ ( "raised" "to" | "**" ) exponent ]   (* right-associative *)
unary         = ( "not" | "!" ) unary
              | ( "negative" | "-" ) unary         (* unary negation *)
              | ( "bitwise" "not" | "bit" "not" | "~" ) unary  (* bitwise not *)
              | "length" "of" atom
              | "number" "of" chunk_kind_pl "in" atom
              | "item" [ "at" ] atom "of" atom
              | chunk_kind atom "of" atom            (* word 2 of text — 0-based *)
              | chunk_kind_pl atom "to" atom "of" atom
              | "round" arithmetic "to" NUM             (* round as expression *)
              | ( "call" | "run" ) atom { arithmetic }  (* explicit invocation *)
              | "result" "of" atom { arithmetic }       (* explicit invocation, noun form *)
              | postfix
chunk_kind    = "character" | "word" | "line" | "item"
chunk_kind_pl = "characters" | "words" | "lines" | "items"
postfix       = atom { "of" atom }
noise         = "the" | "a" | "an" | "that" | "this"  (* consumed and ignored *)
atom          = NUM | STR | REGEX | "true" | "yes" | "false" | "no"
              | "nothing" | "empty" | noise postfix
              | "result"                           (* alias for 'it' — bare only, 'result of' is invocation *)
              | "(" expression ")"                 (* parenthesized grouping *)
              | "list" { arithmetic }
              | "record" "with" NAME { "," NAME } { "," NAME "is" arithmetic }
              | "record" NAME arithmetic { [ "," ] NAME arithmetic }
              | NAME                               (* ref or call, see §4.9 *)
              | DOTPATH                            (* bare JS, see §4.10 *)

block         = { statement NL }
NAME          = ID | KW                           (* via expectName *)
DOTPATH       = ID containing "."
```

---

## Appendix B: Reference Test Cases

Each case is a program and its expected output.

```
# B.1 — Hello world
say "hello world"
→ hello world

# B.2 — Concatenation (juxtaposition in say, & in expressions)
set name to "Arthur"
say "hello " name "!"
→ hello Arthur!

# B.2b — Explicit & concatenation
set greeting to "hello " & name & "!"
say greeting
→ hello Arthur!

# B.3 — Conditional
set x to 10
if x above 5
say "big"
otherwise
say "small"
end
→ big

# B.4 — Counted loop
set n to 0
repeat 5 times
set n to n plus 1
end
say n
→ 5

# B.5 — For-each
set items to list 1 2 3
repeat each x in items
say x times x
end
→ 1
→ 4
→ 9

# B.6 — Function with labeled params
define send message to person
say message & " → " & person
end
send "hello" to "Arthur"
→ hello → Arthur

# B.7 — Default parameters
define greet person with greeting is "hello"
say greeting & " " & person
end
greet "world"
greet "world" with "howdy"
→ hello world
→ howdy world

# B.8 — Variadic
define total of many numbers
set s to 0
repeat each n in numbers
set s to s plus n
end
return s
end
say total of 1, 2, 3, 4, 5
→ 15

# B.9 — Property access with of
set point to list 0
→ (manual: requires dict support for meaningful test)

# B.10 — Data query pipeline
take intervals
keep lithology is itabirite
average grade
round to 1
→ 48.7

# B.11 — JS FFI via use
use Math.round as round
say round 3.7
→ 4

# B.12 — Bare JS call
say Math.floor 9.9
→ 9

# B.13 — Keyword as function name
use Math.round as round
say round 3.7
→ 4

# B.14 — FizzBuzz
define fizzbuzz takes n
if n mod 15 is 0
return "fizzbuzz"
end
if n mod 3 is 0
return "fizz"
end
if n mod 5 is 0
return "buzz"
end
return n
end
say fizzbuzz 15
say fizzbuzz 9
say fizzbuzz 10
say fizzbuzz 7
→ fizzbuzz
→ fizz
→ buzz
→ 7

# B.15 — Pipe with and then
take collars count
→ 4

# B.16 — HyperTalk put/into
put 42 into answer
say "the answer is " & answer
→ the answer is 42

# B.17 — Chunk read
set s to "the quick brown fox"
say word 2 of s
say character 1 of s
→ quick
→ t

# B.18 — Chunk write
set s to "hello world"
set word 2 of s to "Soft"
say s
→ hello Soft

# B.19 — Chunk nesting
set doc to "first line\nsecond line\nthird line"
say word 1 of line 2 of doc
→ second

# B.20 — Property write via of-path
set row to list 0
→ (requires dict support for meaningful test)

# B.21 — Event handler (runtime-dependent, structure test only)
on load
say "ready"
end
→ (registered as handler, output depends on runtime triggering load)

# B.22 — Implicit 'it' variable
take intervals
count
say "there are " & it & " intervals"
→ 14
→ there are 14 intervals

# B.23 — Pipeline capture with 'into'
take intervals
keep lithology is itabirite
count
into ore_count

take intervals
keep lithology is phyllite
count
into waste_count

say ore_count & " ore, " & waste_count & " waste"
→ 5 ore, 3 waste

# B.24 — Chunk read (0-based numeric indexing)
set s to "the quick brown fox"
say word 2 of s
say character 0 of word 2 of s
→ brown
→ b

# B.25 — Chunk write (0-based)
set s to "hello world"
set word 0 of s to "goodbye"
say s
→ goodbye world

# B.26 — Universal then with functions
use Text.upper as upper
use Text.trim as trim
set s to "  hello  "
s then trim then upper as result
say result
→ HELLO

# B.27 — Result capture with as
42 times 2 as answer
say "the answer is " & answer
→ the answer is 84

# B.28 — Record creation
set r to record name "Alice" age 30
say name of r & " is " & age of r
→ Alice is 30

# B.29 — Computed column with
take intervals
with tonnage being length times density
first 1
say tonnage of it
→ 48

# B.30 — Existence check
set x to 5
if there is a x
say "x exists"
end
if there is no y
say "y missing"
end
→ x exists
→ y missing

# B.31 — Ask (runtime-dependent)
ask "Name?" with "Arthur"
say "hello " & it
→ (prompts user, output depends on input; with default "Arthur")

# B.32 — Wait (runtime-dependent)
say "start"
wait 1 second
say "end"
→ start
→ (1 second pause)
→ end

# B.33 — Stop in event handler
on click deleteButton
say "deleted"
stop
end
→ (handler registered, stop exits handler)

# B.33b — Stop in loop (break)
set items to list 1 2 3 4 5
repeat each x in items
  stop if x above 3
  say x
end
→ 1
→ 2
→ 3

# B.33c — Skip in loop (continue)
set items to list 1 2 3 4 5
repeat each x in items
  skip if x is 3
  say x
end
→ 1
→ 2
→ 4
→ 5

# B.34 — Symbol arithmetic
say 3 + 4 * 2
→ 11

# B.35 — Parenthesized grouping
say (3 + 4) * 2
→ 14

# B.36 — Exponentiation
say 2 raised to 10
say 2 ** 10
→ 1024
→ 1024

# B.37 — Negation
set x to 5
say negative x
→ -5

# B.38 — Mixed English and symbols
set area to (width + margin) * 2
set tonnage to length * density
say 10 plus 5 * 2
→ 20

# B.39 — Symbol comparisons
set x to 10
if x > 5 and x < 20
say "in range"
end
if x != 7
say "not seven"
end
→ in range
→ not seven

# B.40 — Noise words
set the cutoff to 50
say the cutoff
→ 50

# B.41 — else for otherwise
if 1 > 2
say "no"
else
say "yes"
end
→ yes

# B.42 — Comparison synonyms
set x to 10
if x greater than 5
say "big"
end
if x less than 20
say "small enough"
end
if x equals 10
say "exact"
end
→ big
→ small enough
→ exact

# B.43 — Range loop
repeat from 1 to 5 as i
say i
end
→ 1
→ 2
→ 3
→ 4
→ 5

# B.44 — that / the result as it aliases
42 times 2
say "answer is " & that
say "also " & the result
→ answer is 84
→ also 84

# B.45 — Optional do
repeat 3 times do
say "hi"
end
→ hi
→ hi
→ hi

# B.46 — File save (runtime-dependent)
take intervals
keep grade above 50
into ore
save ore to "ore.csv"
→ (writes filtered data to ore.csv, mechanism host-defined)

# B.47 — File append (runtime-dependent)
append "run complete" to "log.txt"
→ (appends to log.txt, mechanism host-defined)

# B.48 — Exponentiation with **
say 2 ** 8
→ 256

# B.49 — Open and read lines (runtime-dependent)
open "data.txt" for reading as reader
repeat each line in reader
say line
end
close reader
→ (reads and prints each line, mechanism host-defined)

# B.50 — Open and write (runtime-dependent)
open "output.txt" for writing as writer
write "hello" to writer
write "world" to writer
close writer
→ (writes two lines to output.txt, mechanism host-defined)

# B.51 — Read single line (runtime-dependent)
open "data.txt" for reading as f
read from f into header
say header
close f
→ (reads first line, mechanism host-defined)

# B.52 — Bitwise AND
say 0xFF bitwise and 0x0F
say 0xFF bit and 0x0F
→ 15
→ 15

# B.53 — Bitwise XOR
say 0xFF xor 0x0F
say 0xFF bitwise xor 0x0F
→ 240
→ 240

# B.54 — Shift
say 1 shift left 8
say 1 << 8
→ 256
→ 256

# B.55 — Bitwise NOT
say bit not 0
say ~0
→ -1
→ -1

# B.56 — Binary and octal literals
say 0b1010
say 0o77
say 0b11110000 bit and 0b00001111
→ 10
→ 63
→ 0

# B.57 — Unless block
set grade to 30
unless grade above 50
say "below cutoff"
end
→ below cutoff

# B.58 — Unless suffix
set ready to false
say "not ready" unless ready
→ not ready

# B.59 — Unless suffix (condition true, should NOT execute)
set ready to true
say "not ready" unless ready
→ (no output)

# B.60 — Inline conditional
set grade to 62
set label to "ore" if grade above 50 otherwise "waste"
say label
→ ore

# B.61 — Inline conditional (false branch)
set grade to 30
set label to "ore" if grade above 50 otherwise "waste"
say label
→ waste

# B.62 — Type checking
set x to 42
set y to "hello"
set z to list 1 2 3
if x is a number
say "x is number"
end
if y is a text
say "y is text"
end
if z is a list
say "z is list"
end
if x is not a text
say "x is not text"
end
→ x is number
→ y is text
→ z is list
→ x is not text

# B.63 — Matches
set hole to "DDH001"
if hole matches "DDH*"
say "diamond drill"
end
if hole matches "RC*"
say "reverse circ"
end
→ diamond drill

# B.64 — Step loop
repeat from 0 to 20 by 5 as n
say n
end
→ 0
→ 5
→ 10
→ 15
→ 20

# B.65 — Step loop countdown
repeat from 3 to 1 by -1 as n
say n
end
→ 3
→ 2
→ 1

# B.66 — Dynamic property access
set r to record name "Alice" age 30
set field to "name"
say (field) of r
→ Alice

# B.67 — Dynamic property write
set r to record x 0 y 0
set axis to "x"
set (axis) of r to 42
say x of r
→ 42

# B.68 — Keyword field via dynamic access
set r to record from 10 to 50
say ("from") of r
say ("to") of r
→ 10
→ 50

# B.69 — Inline conditional in say
set n to 3
say "count: " & ("none" if n is 0 otherwise n)
→ count: 3

# B.70 — Unless suffix (true — should not fire)
set x to 10
say "low" unless x above 5
→ (no output)

# B.71 — Explain (output is prose, not computed values)
explain take intervals keep grade above 50 average grade
→ Start with the data called "intervals".
→ Keep only rows where "grade" is greater than 50.
→ Compute the average of the "grade" field.

# B.72 — Assume (passes)
set x to 10
assume x above 0
say "ok"
→ ok

# B.73 — Assume (fails)
set x to -1
assume x above 0 otherwise "x must be positive"
→ ERROR: x must be positive

# B.74 — Suppose (scoped override)
set cutoff to 50
suppose cutoff is 30
say "inside: " & cutoff
end
say "outside: " & cutoff
→ inside: 30
→ outside: 50

# B.75 — Try / if it fails (success)
try
set x to 10 over 2
if it fails
set x to 0
end
say x
→ 5

# B.76 — Try / if it fails (failure)
try
set x to grade of nothing
if it fails
say "caught: " & the error
end
→ caught: Cannot access property of nothing

# B.77 — Called (mid-pipeline naming)
take intervals
keep grade above 50 called high
count called n
say n & " intervals from " & length of high & " filtered"
→ (n = count, high = filtered array, both accessible after pipeline)

# B.78 — Called with multiple snapshots
take intervals
keep lithology is itabirite called ore_rows
average grade called ore_grade
say length of ore_rows & " ore intervals at " & ore_grade
→ (ore_rows and ore_grade both captured, pipeline continued through)

# B.79 — Record with shorthand
set x to 10
set y to 20
set p to record with x, y
say x of p & ", " & y of p
→ 10, 20

# B.80 — Record with and overrides
set name to "Arthur"
set health to 100
set p to record with name, health, x is 0, y is 0
say name of p & " at " & x of p & "," & y of p
→ Arthur at 0,0

# B.81 — Constructor pattern
define make_enemy called name with health is 50
  return record with name, health, alive is true
end
set e to make_enemy called "Goblin"
say name of e & " has " & health of e & " HP"
→ Goblin has 50 HP

# B.82 — Compound type check
set data to list 1, 2, 3
if data is a list of numbers
say "typed list"
end
→ typed list

# B.83 — Typed record assume
set row to record grade 62.1 depth 15 hole "DDH001"
assume row is a record with grade as a number, depth as a number, hole as a text
say grade of row
→ 62.1

# B.84 — Typed record with being
set point to record x 10 y 20
assume point is a record with x being a number, y being a number
say x of point & ", " & y of point
→ 10, 20

# B.85 — Assume as runtime check (fails)
set x to "hello"
assume x is a number otherwise "expected number, got text"
→ ERROR: expected number, got text

# B.86 — as a peek disambiguation
set data to list 1, 2, 3
set data as result
say result
→ [1, 2, 3]

# (contrast with type annotation — different parse)
assume data is a list of numbers
→ (passes, no output)

# B.87–B.90 — Ordinals: deferred (see §14)

# B.91 — Regex matches
set hole to "DDH042"
if hole matches /^DDH\d{3}$/
say "valid diamond hole"
end
if hole matches /^rc/i
say "reverse circ"
end
→ valid diamond hole

# B.92 — Glob character class
set code to "A12"
if code matches "[A-Z][0-9][0-9]"
say "valid code"
end
→ valid code

# B.93 — At least / at most
set x to 50
if x at least 50
say "pass"
end
if x at most 100
say "in range"
end
→ pass
→ in range

# B.94 — Say juxtaposition
set name to "Arthur"
say "hello " name "!"
→ hello Arthur!

# B.95 — Say juxtaposition with expression
set x to 5
say "result: " (x + 3) " done"
→ result: 8 done

# B.96 — call (explicit invocation)
define make_counter
  set n to 0
  define increment
    set n to n plus 1
    return n
  end
  return increment
end
set c to make_counter
say call c
say call c
→ 1
→ 2

# B.97 — run and result of (synonyms for call)
set c to make_counter
say run c
say result of c
→ 1
→ 2

# B.98 — call with arguments
define make_greeter takes greeting
  define greet takes name
    return greeting & " " & name
  end
  return greet
end
set g to make_greeter "hello"
say call g "Arthur"
→ hello Arthur

# B.99 — First-class functions (no auto-call)
set c to make_counter
set c2 to c
say call c2
say call c2
→ 1
→ 2

# B.100 — then function piping
"  hello world  " then Text.trim then Text.upper
say it
→ HELLO WORLD

# B.101 — then with multi-arg function
"hello world" then Text.split " "
say it
→ hello, world

# B.102 — round as expression
say round 3.14159 to 2
→ 3.14

# B.103 — round expression in set
set ratio to round (2 over 3) to 3
say ratio
→ 0.667

# B.104 — Multi-line list
set data to list
  record name "Alice" age 30,
  record name "Bob" age 25
say length of data
→ 2

# B.105 — is at least / is at most
set x to 50
if x is at least 50
  say "pass"
end
if x is at most 100
  say "ok"
end
→ pass
→ ok

# B.106 — does not equal
if 5 does not equal 6
  say "different"
end
→ different

# B.107 — Chunk read
say word 2 of "the quick brown fox"
say character 0 of "hello"
→ brown
→ h

# B.108 — Chunk write
set s to "hello world"
set word 1 of s to "Soft"
say s
→ hello Soft

# B.109 — Chunk range
say characters 1 to 3 of "hello"
→ ell

# B.110 — number of chunks
say number of words in "the quick brown fox"
→ 4

# B.111 — of-path write
set r to record name "Alice" age 30
set age of r to 31
say age of r
→ 31
```
