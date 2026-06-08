# @gcu/air — Auditable Intermediate Representation Specification

**Status:** v0.3 (shipped 2026-05-09); v0.2 baseline still authoritative for §2-§16 below
**Author:** Arthur Endlein Correia / GCU
**Repository:** [gentropic/auditable](https://github.com/gentropic/auditable)

## 0. v0.3 — Self-Describing IR (2026-05-09)

v0.3 ships infrastructure on top of the v0.2 spec without changing IR
semantics. Five modules added under `ext/air/src/`:

| Module | Purpose |
| --- | --- |
| `schema.js` | `OP_SCHEMA` table — one row per op type. Helpers `forEachSsaRef`, `forEachRegion`, `introducesScope`, `isSideEffecting`, `canBeAsync`, `requiredExtras`, `computeStats`. Single source of truth replacing the per-pass `if (op.op === ...)` walkers that existed before. |
| `validate.js` | Schema-driven shape validator. Catches arity mismatch, missing required extras, unknown ops, dangling SSA refs. Off in production; on under `?airdebug=1` URL flag or `window._airValidate = true`. |
| `text.js` | `prettyPrint(module)` — human-readable textual IR. Validator errors include the rendered IR. Round-trippable parser is roadmap. |
| `scope.js` | `ScopeChain` — single chain class shared by `findMutableCaptured`, `ctx.symbols`, and emit-js's `Scope`. Push/pop semantics for inner-scope shadowing. |
| `passes.js#PASSES` | Declarative metadata table: `{name, fn, iterates, requires, produces, invalidates}` for every pass. Discoverability + future-proofing. |

Eight bespoke walkers in passes.js + emit-js.js retired in favor of
schema-derived `forEachSsaRef` / `forEachRegion`: `countUses`,
`needsAsync`, `findOpById`/`findOpAnywhere` (consolidated to one),
`collectWrittenNames`, `foldConstants`/`eliminateDeadCode`/`insertHints`/
`specializeRuntimeHelpers` recursion. Net -165 lines and several free
correctness fixes (try/catch/finally/switch/class bodies were silently
skipped by some legacy walkers).

`ctx.symbols` migrated from flat Map to `ScopeChain` with push/pop at
function-body / arrow / class-method / static-block boundaries — fixes a
latent type-prop bug where inner-fn shadows clobbered outer cell-export
types.

The rest of this document is the v0.2 specification — IR shape,
operations, regions, lowering, passes, emitter — which v0.3 preserves
verbatim. The full op shape catalogue is in §17 (auto-generated from
`OP_SCHEMA`).

---

## 1. Overview

`@gcu/air` is a lightweight, browser-native intermediate representation for the
Auditable notebook runtime. It provides a shared compilation target for multiple
frontend languages (JS/TS, atra, adder, Soft) and enables:

- Fine-grained reactive dependency tracking across notebook cells
- Type-informed JavaScript emission with V8 optimization hints
- WebAssembly emission for fully-typed numeric regions (via atra backend)
- Dead code elimination and constant folding across cell boundaries

The IR is designed to be small (~2000 lines total), pure JS, zero dependencies
(aside from vendored acorn + @sveltejs/acorn-typescript for JS/TS parsing), and
operate entirely in the browser.

### 1.1 Design Principles

- **Data, not classes.** IR nodes are plain JS objects. No inheritance, no
  visitor pattern, no framework.
- **SSA by default.** Every value is assigned exactly once. Def-use chains are
  trivial lookups.
- **Structured regions, not flat CFG.** Control flow is represented as nested
  regions (following JSIR/MLIR design), enabling lossless round-trip to source.
- **Gradual typing.** Every value has a type, which may be `dynamic`. The IR is
  valid regardless of how many types are resolved.
- **Opaque escape hatch.** Code the IR cannot analyze is wrapped in opaque
  regions that are correct but unoptimized.
- **Cell is the unit.** Each notebook cell produces an independent IR module.
  Cross-cell analysis operates on module boundaries (imports/exports), not
  across module internals.

## 2. Type System

### 2.1 Concrete Types

```
Type ::=
  -- Integer types
  | { kind: "i8" }                           -- signed 8-bit
  | { kind: "u8" }                           -- unsigned 8-bit
  | { kind: "i16" }                          -- signed 16-bit
  | { kind: "u16" }                          -- unsigned 16-bit
  | { kind: "i32" }                          -- signed 32-bit
  | { kind: "u32" }                          -- unsigned 32-bit
  | { kind: "i64" }                          -- signed 64-bit (BigInt interop)
  | { kind: "u64" }                          -- unsigned 64-bit (BigInt interop)

  -- Float types
  | { kind: "f32" }                          -- single precision
  | { kind: "f64" }                          -- double precision (JS default)

  -- Other primitives
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "void" }                         -- no value (statement result)

  -- Compound types
  | { kind: "typed_array", element: "i8" | "u8" | "i16" | "u16"
                                    | "i32" | "u32" | "f32" | "f64"
                                    | "i64" | "u64" }
  | { kind: "array", element: Type }          -- JS Array with known element type
  | { kind: "object", fields: Map<string, Type> }  -- known-shape object
  | { kind: "function", params: Type[], ret: Type }
  | { kind: "dynamic" }                      -- unknown / unresolved
```

### 2.2 Type Annotation Mapping

TypeScript annotations from the parser map to IR types as follows:

| TS Annotation         | IR Type                                  |
|-----------------------|------------------------------------------|
| **GCU numeric types (preferred for performance)**                    |
| `i8`                  | `{ kind: "i8" }`                         |
| `u8`                  | `{ kind: "u8" }`                         |
| `i16`                 | `{ kind: "i16" }`                        |
| `u16`                 | `{ kind: "u16" }`                        |
| `i32`                 | `{ kind: "i32" }`                        |
| `u32`                 | `{ kind: "u32" }`                        |
| `i64`                 | `{ kind: "i64" }`                        |
| `u64`                 | `{ kind: "u64" }`                        |
| `f32`                 | `{ kind: "f32" }`                        |
| `f64`                 | `{ kind: "f64" }`                        |
| `bool`                | `{ kind: "bool" }`                       |
| **Standard TS types (aliases, always accepted)**                     |
| `number`              | `{ kind: "f64" }`                        |
| `boolean`             | `{ kind: "bool" }`                       |
| `string`              | `{ kind: "string" }`                     |
| `void`                | `{ kind: "void" }`                       |
| **Typed arrays (standard + GCU aliases)**                            |
| `Int8Array`           | `{ kind: "typed_array", element: "i8" }` |
| `Uint8Array`          | `{ kind: "typed_array", element: "u8" }` |
| `Int16Array`          | `{ kind: "typed_array", element: "i16" }`|
| `Uint16Array`         | `{ kind: "typed_array", element: "u16" }`|
| `Int32Array`          | `{ kind: "typed_array", element: "i32" }`|
| `Uint32Array`         | `{ kind: "typed_array", element: "u32" }`|
| `Float32Array`        | `{ kind: "typed_array", element: "f32" }`|
| `Float64Array`        | `{ kind: "typed_array", element: "f64" }`|
| `BigInt64Array`       | `{ kind: "typed_array", element: "i64" }`|
| `BigUint64Array`      | `{ kind: "typed_array", element: "u64" }`|
| `i8array`             | `{ kind: "typed_array", element: "i8" }` |
| `u8array`             | `{ kind: "typed_array", element: "u8" }` |
| `i16array`            | `{ kind: "typed_array", element: "i16" }`|
| `u16array`            | `{ kind: "typed_array", element: "u16" }`|
| `i32array`            | `{ kind: "typed_array", element: "i32" }`|
| `u32array`            | `{ kind: "typed_array", element: "u32" }`|
| `f32array`            | `{ kind: "typed_array", element: "f32" }`|
| `f64array`            | `{ kind: "typed_array", element: "f64" }`|
| `i64array`            | `{ kind: "typed_array", element: "i64" }`|
| `u64array`            | `{ kind: "typed_array", element: "u64" }`|
| **Generic arrays**                                                   |
| `number[]`            | `{ kind: "array", element: f64 }`        |
| `string[]`            | `{ kind: "array", element: string }`     |
| `i32[]`               | `{ kind: "array", element: i32 }`        |
| `f64[]`               | `{ kind: "array", element: f64 }`        |
| (etc. — `T[]` maps via element type)                                 |
| **Fallback**                                                         |
| anything else / none  | `{ kind: "dynamic" }`                    |

GCU custom type names (i32, f64, f32array, etc.) are not valid TypeScript types
but are parsed by acorn-typescript as `TSTypeReference` nodes with the
corresponding identifier name. The lowerer recognizes them by name. This gives
users a clean, Rust/C-like typing vocabulary without any TS runtime baggage.

Both standard TS annotations and GCU type names are accepted everywhere. A cell
mixing `number` and `i32` annotations works fine — they just resolve to
different IR types. Users familiar with TS use `number`; users wanting precise
control use `i32`/`f64`.

### 2.3 Cross-Language Type Sources

Type annotations enter AIR from three different syntaxes, all producing the same
IR types:

| Language | Syntax | Example | IR Type |
|----------|--------|---------|---------|
| JS | `: type` annotation | `const x: f64 = 1.0` | `{ kind: "f64" }` |
| adder | inferred from usage + future type hints | `x = 1.0` (float literal) | `{ kind: "f64" }` |
| Soft | `assume` statements | `assume grade is a number` | `{ kind: "f64" }` |
| atra | native type declarations | `real :: x` | `{ kind: "f64" }` |

### 2.4 Type Mismatch Reporting

Type annotations are **hints, not contracts**. A mismatch between the declared
type and the actual value does not prevent execution. Instead:

- The cell runs normally (annotation is ignored for that binding).
- A **warning** is shown in the statusbar: `type annotation i32 ignored — assigned string`.
- The variable is treated as `dynamic` from that point forward.

This ensures type annotations never break working code, while giving feedback
to users trying to optimize.

### 2.5 Type Narrowing Rules

Type propagation operates forward over the IR. Rules for binary operations:

```
f64   op f64   → f64       (arithmetic)
f64   op i32   → f64       (promotion: integer widens to float)
f32   op f32   → f32       (single precision preserved)
i32   op i32   → i32       (integer arithmetic)
u32   op u32   → u32       (unsigned integer arithmetic)
i64   op i64   → i64       (64-bit integer)
u64   op u64   → u64       (unsigned 64-bit)
iN    op uN    → iN        (signed wins on mixed sign, same width)
any   |  0     → i32       (JS integer coercion)
any   >>> 0    → u32       (JS unsigned coercion)
Math.fround(any) → f32     (float32 coercion)
bool  && bool  → bool
bool  || bool  → bool
dynamic op T   → dynamic   (conservative)
```

Promotion hierarchy: `i8 → i16 → i32 → i64 → f64`, `u8 → u16 → u32 → u64 → f64`,
`f32 → f64`. Mixed-width operations promote the narrower operand.

Assignment narrows: if `x: dynamic` is assigned `%0: f64`, then `x` becomes
`f64` from that point forward (SSA makes this trivial — it's a new name).

## 3. SSA and Naming

### 3.1 SSA Names

Every computed value gets a unique name: `%0`, `%1`, `%2`, etc. Names are
scoped to the cell module — no global namespace.

```
%0 = const 1.0 : f64
%1 = const 2.0 : f64
%2 = add %0, %1 : f64
```

Source-level variables are tracked in a **symbol table** that maps variable
names to their current SSA name. When a variable is reassigned, a new SSA name
is created:

```js
let x = 1      // symbol_table["x"] = %0
x = x + 2      // symbol_table["x"] = %1
```

```
%0 = const 1 : f64
%1 = add %0, (const 2 : f64) : f64
```

### 3.2 Region Merge Points

When control flow merges (e.g. after an if/else), variables that were assigned
in both branches need a **phi** operation:

```
%5 = phi [%3, if_true], [%4, if_false] : f64
```

Phis only appear at region exits. Inside a region, SSA is linear.

### 3.3 Mutable Bindings and Closures

Not all variables can be SSA-renamed. A variable that is **both assigned and
referenced across a function boundary** (i.e. captured and mutated by a closure)
must remain as a mutable named slot.

```js
let count: i32 = 0
const increment = () => { count++ }    // captures and mutates count
increment()
// count is now 1
```

This cannot be represented as pure SSA because the mutation happens inside a
closure whose execution is not inline with the outer flow.

**Detection:** During lowering, a pre-pass scans the ESTree AST before SSA
conversion:

1. Collect all variable declarations and their scopes.
2. For each assignment (`AssignmentExpression`, `UpdateExpression`), check if
   the target variable was declared in an outer scope *and* the assignment is
   inside a nested function (`FunctionDeclaration`, `ArrowFunctionExpression`,
   `FunctionExpression`).
3. Mark those variables as `mutable_captured`.

This is ~50 lines in the lowerer.

**IR representation:** Mutable captured variables use `slot_load`/`slot_store`
ops instead of SSA names:

```
%slot_count = slot_alloc "count" : i32
slot_store %slot_count, (const 0 : i32)
...
// inside closure body:
%0 = slot_load %slot_count : i32
%1 = add %0, (const 1 : i32) : i32
slot_store %slot_count, %1
```

**Effect on optimization:**
- Type is preserved — `count: i32` stays `i32` through the slot. Hinted JS
  emission still works.
- Constant folding is blocked for that variable (its value may change via the
  closure at any point).
- DCE must treat `slot_store` as side-effecting (never eliminated).
- The JS emitter outputs a plain `let` for slot variables — no `|0` tricks
  needed beyond the initial assignment.

**In practice:** Most closures in Auditable cells are read-only callbacks —
`slider("x", 0, { onInput: v => display(v) })`, `.map(x => x * 2)`,
`setTimeout(() => render())`. These capture variables but don't mutate them,
so they get normal SSA treatment. Only the mutation-through-closure case needs
slots, and that's rare in notebook code.

## 4. Operations

### 4.1 Op Structure

Every operation is a plain JS object:

```js
{
  id: "%0",                // SSA name (string)
  op: "add",               // operation kind (string)
  args: ["%1", "%2"],      // SSA name references
  type: { kind: "f64" },   // result type
  loc: { file: "cell_3", line: 5, col: 10 },  // source location
  meta: {}                 // optional: hints, annotations
}
```

### 4.2 Op Catalog

#### Constants

| Op              | Args        | Result | Notes                          |
|-----------------|-------------|--------|--------------------------------|
| `const`         | value       | T      | Literal: number, string, bool  |
| `undefined`     | —           | void   |                                |
| `null`          | —           | dynamic|                                |

#### Arithmetic

| Op              | Args        | Result | Notes                          |
|-----------------|-------------|--------|--------------------------------|
| `add`           | lhs, rhs    | T      | Numeric or string concat       |
| `sub`           | lhs, rhs    | T      | Numeric                        |
| `mul`           | lhs, rhs    | T      | Numeric                        |
| `div`           | lhs, rhs    | T      | Numeric                        |
| `mod`           | lhs, rhs    | T      | Numeric                        |
| `neg`           | val         | T      | Unary negate                   |
| `bitwise_or`    | lhs, rhs    | i32    | Always produces i32            |
| `bitwise_and`   | lhs, rhs    | i32    |                                |
| `bitwise_xor`   | lhs, rhs    | i32    |                                |
| `shift_left`    | lhs, rhs    | i32    |                                |
| `shift_right`   | lhs, rhs    | i32    | Sign-preserving                |
| `ushift_right`  | lhs, rhs    | i32    | Zero-fill                      |

#### Comparison

| Op              | Args        | Result | Notes                          |
|-----------------|-------------|--------|--------------------------------|
| `eq`            | lhs, rhs    | bool   | `===` semantics                |
| `neq`           | lhs, rhs    | bool   | `!==` semantics                |
| `lt`            | lhs, rhs    | bool   |                                |
| `lte`           | lhs, rhs    | bool   |                                |
| `gt`            | lhs, rhs    | bool   |                                |
| `gte`           | lhs, rhs    | bool   |                                |

#### Logical

| Op              | Args        | Result | Notes                          |
|-----------------|-------------|--------|--------------------------------|
| `logical_and`   | lhs, rhs    | T      | Short-circuit, type of rhs     |
| `logical_or`    | lhs, rhs    | T      | Short-circuit, type of rhs     |
| `logical_not`   | val         | bool   |                                |

#### Variable / Memory

| Op              | Args            | Result  | Notes                        |
|-----------------|-----------------|---------|------------------------------|
| `load`          | name (string)   | T       | Read source-level variable   |
| `store`         | name, value     | void    | Write source-level variable  |
| `slot_alloc`    | name (string)   | slot    | Allocate mutable binding (§3.3) |
| `slot_load`     | slot            | T       | Read mutable captured var    |
| `slot_store`    | slot, value     | void    | Write mutable captured var (side-effecting) |
| `array_new`     | ...elements     | array   | Create JS array literal      |
| `array_get`     | arr, index      | T       | arr[index]                   |
| `array_set`     | arr, index, val | void    | arr[index] = val             |
| `object_new`    | ...kvpairs      | object  | Create object literal        |
| `object_get`    | obj, key        | T       | obj.key or obj[key]          |
| `object_set`    | obj, key, val   | void    | obj.key = val                |
| `ta_new`        | element, length | typed_array | new Float64Array(n)      |
| `ta_get`        | ta, index       | T       | Typed array read             |
| `ta_set`        | ta, index, val  | void    | Typed array write            |
| `spread`        | value           | dynamic | Spread into array/call/object |

#### Function / Call

| Op              | Args            | Result  | Notes                        |
|-----------------|-----------------|---------|------------------------------|
| `call`          | fn, ...args     | T       | Function call                |
| `call_method`   | obj, method, ...args | T  | obj.method(args)             |
| `await`         | value           | T       | Await promise (marks cell async) |
| `return`        | value           | void    | Function return              |

#### Control Flow (Regions)

See §5 for region semantics.

| Op              | Args            | Result  | Notes                        |
|-----------------|-----------------|---------|------------------------------|
| `if_region`     | cond            | void    | Contains then/else regions   |
| `loop_region`   | —               | void    | Contains body region         |
| `for_region`    | init,test,update| void    | C-style for                  |
| `for_in_region` | target, iter    | void    | for...in                     |
| `for_of_region` | target, iter    | void    | for...of                     |
| `func_region`   | name, params    | function| Function declaration         |
| `break`         | —               | void    |                              |
| `continue`      | —               | void    |                              |

#### Destructuring

| Op              | Args            | Result  | Notes                        |
|-----------------|-----------------|---------|------------------------------|
| `destructure_object` | source, ...keys | void | `const { a, b } = obj`  |
| `destructure_array`  | source, ...indices | void | `const [a, b] = arr` |
| `rest`          | source, start   | array   | Rest element in destructuring |

Destructuring ops decompose into sequences of `object_get`/`array_get` + `store`
during lowering. They exist in the op catalog for documentation; the lowerer
emits the decomposed form directly. Nested destructuring is handled recursively.
Defaults (`{ a = 5 }`) emit an `if_region` checking for `undefined`.

#### Cell Boundary

| Op              | Args            | Result  | Notes                        |
|-----------------|-----------------|---------|------------------------------|
| `cell_import`   | name, source_id | T       | Read from another cell       |
| `cell_export`   | name, value     | void    | Expose to other cells        |

#### Escape Hatch

| Op              | Args            | Result  | Notes                        |
|-----------------|-----------------|---------|------------------------------|
| `opaque`        | source_text     | dynamic | Unanalyzed JS, emitted as-is |

An `opaque` op wraps source code the IR cannot represent. It is treated as:
- Producing `dynamic` type
- Potentially side-effecting (never DCE'd)
- Reading all in-scope variables (conservative dependency)

## 5. Regions

Regions are nested scopes that model structured control flow. Each region is an
ordered list of ops with explicit entry/exit points. Regions nest but never
partially overlap.

### 5.1 Region Structure

```js
{
  id: "%10",
  op: "if_region",
  args: ["%9"],            // condition
  type: { kind: "void" },
  then_body: [ ...ops ],   // ops in the "then" branch
  else_body: [ ...ops ],   // ops in the "else" branch (may be empty)
  phis: [                  // merge points
    { id: "%15", pairs: [["%12", "then"], ["%14", "else"]], type: ... }
  ],
  loc: { ... }
}
```

```js
{
  id: "%20",
  op: "loop_region",
  body: [ ...ops ],
  phis: [ ... ],           // loop-carried values
  loc: { ... }
}
```

```js
{
  id: "%30",
  op: "func_region",
  name: "kriging",
  params: [
    { id: "%31", name: "data", type: { kind: "typed_array", element: "f64" } },
    { id: "%32", name: "model", type: { kind: "string" } }
  ],
  body: [ ...ops ],
  ret_type: { kind: "typed_array", element: "f64" },
  loc: { ... }
}
```

### 5.2 Why Regions, Not CFG

A flat control-flow graph (basic blocks + edges) destroys source structure. You
can optimize it, but you can't reconstruct readable code from it without heroic
effort. Structured regions preserve the if/for/while/function nesting from the
source, so:

- The JS emitter can produce readable code trivially
- The atra emitter can produce valid atra source for WASM compilation
- Source locations stay meaningful
- Round-trip (source → IR → source) is feasible

This follows the same design rationale as Google's JSIR.

## 6. Cell Module

Each notebook cell compiles to a **cell module**:

```js
{
  cell_id: "cell_3",
  version: 7,                          // incremented on each edit
  ops: [ ...top-level ops... ],
  symbol_table: Map<string, "%N">,     // final name for each variable
  imports: Map<string, {               // variables read from other cells
    source_cell: "cell_1",
    name: "variogram_model",
    type: { kind: "dynamic" }
  }>,
  exports: Map<string, {               // variables exposed to other cells
    ssa_name: "%42",
    type: { kind: "f64" }
  }>,
  side_effects: boolean                // true if any opaque/call ops present
}
```

### 6.1 Import Resolution

When the IR encounters an identifier that is not defined in the current cell,
it checks the notebook-level scope:

1. If another cell exports a matching name → `cell_import` op
2. If it's a known global (Math, console, etc.) → regular `load` op
3. Otherwise → `opaque` (unknown binding, conservative)

### 6.2 Export Detection

For v1, a cell exports all top-level `let`/`const`/`function` declarations.
This matches the mental model in a notebook: anything you declare at the top
level of a cell is visible to other cells.

## 7. Lowering: ESTree → AIR

### 7.1 Supported Subset (v1)

The following ESTree node types are lowered to AIR ops:

- `VariableDeclaration` (let, const, var) → `const` / expression ops + `store`
- `ExpressionStatement` → lower the expression
- `BinaryExpression` → `add`, `sub`, `mul`, `div`, `mod`, bitwise ops
- `UnaryExpression` → `neg`, `logical_not`
- `AssignmentExpression` → expression ops + `store`
- `Identifier` → `load`
- `Literal` → `const`
- `CallExpression` → `call` / `call_method`
- `MemberExpression` → `object_get`, `ta_get`, `array_get`
- `IfStatement` → `if_region`
- `ForStatement` → `for_region`
- `ForInStatement` → `for_in_region`
- `ForOfStatement` → `for_of_region`
- `WhileStatement` / `DoWhileStatement` → `loop_region`
- `FunctionDeclaration` / `FunctionExpression` / `ArrowFunctionExpression` → `func_region`
- `ReturnStatement` → `return`
- `BreakStatement` → `break`
- `ContinueStatement` → `continue`
- `ArrayExpression` → `array_new`
- `ObjectExpression` → `object_new`
- `UpdateExpression` (++/--) → `add`/`sub` + `store` (or `slot_store` if mutable captured)
- `LogicalExpression` → `logical_and`, `logical_or`
- `ConditionalExpression` → `if_region` (expression-level)
- `TemplateLiteral` → series of `add` (string concat)
- `AwaitExpression` → `await` op (marks cell as async)
- `NewExpression` for typed array constructors → `ta_new`
- `ObjectPattern` / `ArrayPattern` → decomposed `object_get`/`array_get` + `store` (destructuring)
- `RestElement` → slice/spread ops
- `SpreadElement` → `spread` op in arrays, calls, and objects

### 7.2 `var` Hoisting

`var` declarations are function-scoped and hoisted — the variable exists before
its textual declaration. The lowerer handles this with a pre-scan:

1. Before lowering the cell body, scan for all `var` declarations.
2. Emit `store` ops for each at the top of the cell scope, initialized to
   `undefined` (matching JS semantics).
3. When the textual `var x = expr` is encountered during lowering, emit the
   expression and a `store` — the variable already exists in the symbol table.

`let`/`const` declarations are block-scoped and need no hoisting.

### 7.3 Mutable Capture Pre-Pass

Before SSA conversion, the lowerer runs the closure analysis described in §3.3.
Variables identified as `mutable_captured` are allocated with `slot_alloc` and
accessed via `slot_load`/`slot_store` instead of SSA names. All other variables
use normal SSA.

### 7.4 Type Annotation Extraction

During lowering, if a node has a `typeAnnotation` property (from the TS
plugin), the corresponding SSA name gets its type set from the annotation
mapping in §2.2. Otherwise it gets `dynamic`.

### 7.5 Opaque Fallback

Any ESTree node type not in the v1 set is wrapped in an `opaque` op. This
includes: `ClassDeclaration`, `TryStatement`, `WithStatement`, `YieldExpression`,
`ImportDeclaration`, `ExportDeclaration`, `TaggedTemplateExpression`,
`NewExpression` (except typed array constructors), and anything else.

The opaque op stores the original source text for that subtree and is emitted
verbatim by the JS emitter.

## 8. Passes

### 8.1 Type Propagation

Forward pass over the ops list. For each op, compute the result type from the
input types using the rules in §2.5. If all inputs are concrete, the result is
concrete. If any input is `dynamic`, the result is generally `dynamic` (with
exceptions: `bitwise_or` always produces `i32`).

Cross-cell propagation: when processing a `cell_import`, look up the exporting
cell's module and read the type from its exports map.

### 8.2 Constant Folding

If all arguments to an arithmetic op are `const`, replace with a single `const`
of the computed value. Applies recursively: `const 2 + const 3` → `const 5`.

Cross-cell: if a `cell_import` reads from a cell whose export is a `const`,
inline the constant.

### 8.3 Dead Code Elimination

Walk backward from:
- All `cell_export` ops
- All `opaque` ops (assumed side-effecting)
- All `call` / `call_method` ops (assumed side-effecting)
- All `slot_store` ops (mutable captured state)

Mark every op reachable via args from those roots. Remove unmarked ops.

### 8.4 Dependency Extraction

Walk the cell module's ops. For each `cell_import`, record an edge from the
source cell to this cell. The set of edges forms the notebook DAG.

Additionally, record which specific export names are depended on, enabling
fine-grained invalidation: if cell A's export `x` changes type or value but
export `y` doesn't, cells that only import `y` are not invalidated.

### 8.5 Hint Insertion

After type propagation, scan for contiguous subgraphs where all values have
concrete numeric types (i32 or f64). Mark these regions with a `hint: "typed"`
flag in their metadata. The JS emitter uses this to emit `|0` coercions and
typed array access patterns.

### 8.6 WASM Region Detection

A subgraph is WASM-eligible if:
- All values are concretely typed (i32, f64, typed_array)
- No `call` ops to dynamic/unknown functions
- No `opaque` ops
- No `object_get`/`object_set` on dynamic objects
- The region is a `func_region` (WASM needs a function boundary)

WASM-eligible functions are flagged for the atra emitter. The JS emitter
produces a thin wrapper that calls into the WASM module.

## 9. JS Emitter

### 9.1 Normal Mode

Walk the IR ops and produce readable JS. The emitter produces an AsyncFunction (or
sync function when no async ops are present) matching Auditable's existing cell
compilation signature from `engine.js`:

```js
// Current Auditable (engine.js compileCellCode):
const AF = Object.getPrototypeOf(async function(){}).constructor;
new AF(...scopeKeys, ...INJECTED_NAMES,
  `"use strict";\n${code}\n\nreturn { ${defineNames} };\n` +
  `//# sourceURL=auditable://cell-${cellId}${slug}.js`
);
```

The IR emitter produces the same shape — a function that receives upstream
scope values and injected builtins as parameters, and returns an object with
defined names. This means `executeDAG()` in `engine.js` does not change at all.

```js
// IR-emitted cell function (conceptual):
function cell_3(variogram_model, drill_data, /*...injected*/ ui, std, sr, load, ...) {
  "use strict";
  // hinted region — IR detected i32/f64 types
  let n = (drill_data.length) | 0;
  let sum = 0.0;
  for (let i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
    sum = sum + drill_data[i];
  }
  const mean_grade = sum / n;
  const sample_count = n;
  return { mean_grade, sample_count };
  //# sourceURL=auditable://cell-3.js
}
```

Mapping from IR ops to JS:

- `const` → literal value
- `add`/`sub`/`mul`/`div` → infix operators
- `load`/`store` → variable references / assignment
- `if_region` → `if (...) { ... } else { ... }`
- `loop_region` → `while (true) { ... }` (or recover for/while from metadata)
- `func_region` → `function name(...) { ... }`
- `call` → `fn(args)`
- `phi` → `let x;` before the if, assignment in each branch
- `opaque` → verbatim source text
- `cell_import` → parameter reference (from `scopeKeys`)
- `cell_export` → property in the returned object

SSA names are **not** emitted as variables unless they are needed by multiple
ops or by a phi. Single-use values are inlined into their consumer expression.
This produces readable output like `a + b * c` instead of `let %0 = b * c; let
%1 = a + %0`.

#### Sync vs Async

The emitter checks whether the cell's IR contains any `opaque` ops (which may
be async), `call` ops to `load()`/`install()`/`fetch()`, or explicit `await`
expressions. If none are present, the cell is emitted as a plain `Function`
instead of `AsyncFunction`, avoiding promise/microtask overhead. The
`executeDAG` loop already handles both — sync functions return immediately,
async functions are awaited.

### 9.2 Hinted Mode (V8 Optimization Patterns)

Same as normal mode, but for ops inside `hint: "typed"` regions, the emitter
applies patterns that help V8's JIT compilers (Maglev, TurboFan/Turboshaft)
produce optimized machine code. These are not asm.js — no `"use asm"` pragma
is emitted. The coercion idioms create type-stable feedback that V8's speculative
optimizer uses for specialization.

#### Type coercion patterns

| AIR type | Emit pattern | V8 effect |
|----------|-------------|-----------|
| `i32` assignment | `(expr) \| 0` | Forces Int32/Smi representation |
| `i32` loop bound | `(n \| 0)` | Enables integer range analysis |
| `u32` | `(expr) >>> 0` | Forces ToUint32 |
| `f64` initialization | `0.0` (not `0`) | Starts as Double, avoids Smi→Double transition |
| `f64` coercion | `+(expr)` | Forces ToNumber, Double feedback |
| `f32` chain | `Math.fround(Math.fround(a) + Math.fround(b))` | Keeps f32 precision, avoids f64 round-trips |
| typed array index | `arr[(i) \| 0]` | Guarantees integer index feedback |

#### Loop emission

Optimal loop pattern for TurboFan's loop variable analysis:

```js
for (let i = 0; (i | 0) < (n | 0); i = (i + 1) | 0) {
    // body with type-stable operations
}
```

- `let` in the loop header (not `var`) — V8 tracks the type precisely
- Integer coercions on counter, bound, and increment
- No allocations inside hot loops — preallocate typed arrays outside

#### Initialization discipline

The emitter must initialize variables to type-stable values:

```js
// i32 — start as integer (Smi)
let count = 0;

// f64 — start as double (NOT 0, which is Smi)
let sum = 0.0;

// f32 — start as fround (keeps f32 representation)
let val = Math.fround(0);
```

Starting with the wrong representation causes a hidden class transition on
first assignment of the correct type — a deopt that resets JIT compilation.

#### Object shape stability

When emitting object literals, always use the same property order:

```js
// Good — same shape every time
return { mean_grade, sample_count };

// Bad — property order varies
if (x) return { a, b }; else return { b, a };
```

V8's hidden class system (Maps) requires consistent shapes for monomorphic
inline caches. The emitter always emits `cell_export` properties in
declaration order.

#### Typed array notes

- V8 always emits bounds checks on typed array access (hardened post-Spectre).
  No emit pattern can eliminate them. For truly bounds-check-free numeric
  kernels, the path is Phase 4: AIR → atra → WASM.
- Typed array indexing compiles to near-native load/store plus one
  compare+branch. The overhead is small (~1 cycle per access).
- Indices within Smi range (≤2^30) avoid HeapNumber allocation.
- `Float64Array` is preferred over `Float32Array` unless memory is the
  constraint, since JS's native number type is f64.

#### Deoptimization avoidance

The emitter must never produce patterns that trigger deoptimization:

- **No type changes** — a variable typed `i32` stays `i32` throughout
- **No `arguments` object** — use rest parameters if needed
- **No sparse arrays** — always dense, no `delete`
- **No property addition/deletion** on objects in hot paths
- **No megamorphic call sites** — same function shape at each call site

### 9.3 Inlining Strategy

For each SSA name, count its uses:
- **0 uses, no side effects:** eliminate (DCE should have caught this)
- **1 use:** inline into the consumer expression
- **2+ uses:** emit as a `let` binding

This prevents the "everything is a variable" problem that naive SSA→JS has.

## 10. atra Emitter (WASM Backend)

### 10.1 Architecture

Instead of a standalone WASM binary emitter, AIR reuses atra's existing compiler
as its WASM backend. WASM-eligible `func_region` ops (§8.6) are translated to
atra source code, then compiled via atra's pipeline to WASM binary.

This means there is one WASM compiler in Auditable, not two. Bug fixes and
optimizations in atra benefit all languages.

### 10.2 Translation: AIR → atra Source

For v1, the emitter produces atra source text (not AST). This is:
- **Debuggable** — users can inspect the generated atra via a "View as atra"
  option in split view.
- **Testable** — diff generated source against expected output.
- **Simple** — string templates, no AST construction.

A future version may emit atra AST directly for tighter integration.

### 10.3 Type Mapping

| AIR Type                     | atra Type    | Notes                    |
|------------------------------|--------------|--------------------------|
| `i8`, `u8`, `i16`, `u16`    | `i32`        | atra has no sub-32 types |
| `i32`, `u32`                 | `i32`        | Signedness in the ops    |
| `i64`, `u64`                 | `i64`        | BigInt interop on JS side|
| `f32`                        | `f32`        |                          |
| `f64`                        | `real`       | atra's default float     |
| `typed_array`                | array param  | Passed as memory pointer |

### 10.4 Memory Model

Typed arrays from JS are shared with WASM via the same underlying ArrayBuffer.
The WASM module's linear memory is backed by the typed array's buffer when
possible, avoiding copies.

For new allocations within WASM, a simple bump allocator in linear memory
suffices for v1.

### 10.5 Calling Convention

Each WASM-compiled function is exposed to JS as:

```js
const result = wasmModule.exports.kriging(data.buffer, data.length, ...)
```

The JS emitter generates wrapper code that:
1. Passes typed array buffers as pointers
2. Passes lengths as separate i32 arguments
3. Reads the result (scalar or pointer to output buffer)

### 10.6 "View as atra" Debugging

When the atra emitter is active, cells with WASM-eligible regions can show
the generated atra source in split view. This serves as:
- A debugging tool for understanding what AIR optimized
- A learning bridge between JS and atra syntax
- Verification that the translation is correct

## 11. Notebook Integration

### 11.1 What the IR Replaces

The IR replaces specific parts of the existing Auditable runtime while keeping
the execution engine (`engine.js` `executeDAG`) and cell lifecycle unchanged.

#### Replaced: `dag-core.js` name analysis

Current implementation uses regex-based text analysis:

- `stripCommentsAndStrings()` — manual character-by-character string/comment removal
- `parseNames()` — regex scan for top-level `let`/`const`/`var`/`function` at depth 0
- `findUses()` — regex identifier scan against the set of all defined names
- `findHtmlUses()` — regex `${expr}` interpolation scan
- `extractDestructuredNames()` — manual bracket-matching for destructuring

The IR replaces all of these with acorn parse → AIR lowering → dependency
extraction from `cell_import`/`cell_export` ops. This gives:

- Correct handling of nested scopes, shadowing, and closures
- Destructuring support via proper AST pattern walking
- Spread syntax support
- Type information attached to every dependency edge
- Per-export-name granularity (cell A exports `x` and `y`; cell B only uses `x`)

The existing `buildDAG()` function is replaced by the IR's dependency extractor,
which produces the same data shape: `cell.defines: Set<string>` and
`cell.uses: Set<string>`. This means `topoSort()` works as-is.

#### Replaced: `engine.js` `compileCellCode()`

Current implementation wraps raw source in `new AsyncFunction(...)`:

```js
new AF(
  ...scopeKeys, ...INJECTED_NAMES,
  `"use strict";\n${code}\n\nreturn { ${defineNames} };\n` +
  `//# sourceURL=auditable://cell-${cellId}${slug}.js`
);
```

The IR replaces this with: parse → lower to AIR → run passes → emit JS → wrap
in Function. The emitted code has the same signature and return shape, so
`executeCellCode()` and `executeDAG()` see no difference.

#### Kept as-is

- `executeDAG()` — the DAG walker with poisoning, value-equality gating,
  `%manual`/`%norun` handling, `_lastResult` caching, `_prevInputs` snapshots.
  All of this stays. The IR just makes the inputs more precise.
- `INJECTED_NAMES` — `ui`, `std`, `sr`, `load`, `install`, etc. still injected
  as function parameters.
- Cell types — `code`, `md`, `css`, `html` and the plugin system (`_cellTypes`
  with `parseNames`/`findUses`/`execute`). atra already uses this; it just gains
  an IR lowering path.
- Directives — `%manual`, `%hide`, `%norun`, `%cellName`, `%goto`, etc. are
  parsed from source before IR lowering. They are metadata, not code.
- Value-equality gating — stays, but becomes more effective because the IR knows
  which exports depend on which imports.

### 11.2 Integration Points

The IR hooks into the existing architecture at two points:

**Point 1: Cell analysis** (replaces `buildDAG` internals)

```js
// Before (dag-core.js):
c.defines = parseNames(c.code).defines;           // regex
c.uses = findUses(c.code, definedNames, c.defines); // regex

// After (@gcu/air):
const ast = parser.parse(c.code, { ecmaVersion: 'latest', locations: true });
const air = lowerJS(ast);                          // ESTree → AIR
runPasses(air);                                    // type prop, DCE, const fold
c.defines = extractDefines(air);                   // Set<string> — same shape
c.uses = extractUses(air);                         // Set<string> — same shape
c._air = air;                                      // cache for compilation
c._exportTypes = extractExportTypes(air);           // Map<name, Type> — new
```

**Point 2: Cell compilation** (replaces `compileCellCode`)

```js
// Before (engine.js):
const fn = compileCellCode(code, scopeKeys, defineNames, cellId, cellName);

// After (@gcu/air):
const emittedJS = emitJS(c._air, scopeKeys, INJECTED_NAMES, {
  hinted: true,              // enable |0, Math.fround hints
  cellId, cellName
});
const AF = needsAsync(c._air) 
  ? Object.getPrototypeOf(async function(){}).constructor
  : Function;
const fn = new AF(...scopeKeys, ...INJECTED_NAMES, emittedJS);
```

### 11.3 Enhanced Value-Equality Gating

The current `executeDAG` already skips re-execution when inputs haven't changed.
The IR enhances this in two ways:

**Fine-grained dependency tracking.** The IR knows that cell B's export `result`
depends on cell A's export `data` but not on cell A's export `config`. If only
`config` changes, cell B is not invalidated. Currently, any change to any export
of cell A marks cell B as needing re-execution.

Implementation: `c.uses` becomes `Map<name, Set<export_name>>` instead of
`Set<name>`, recording which specific upstream exports feed into which
downstream computations. The `_prevInputs` snapshot and comparison logic stays,
but operates on the narrower dependency set.

**Type-change detection.** When a cell is re-analyzed after editing, the IR
compares export types against the previous version. If a cell's export changes
from `f64` to `string`, all downstream cells must be re-analyzed (not just
re-executed) because their type propagation results may have changed. If types
are unchanged, downstream cells keep their cached AIR and emitted code.

### 11.4 Caching Strategy

Session-level caching only. No persistent cache in saved HTML.

```js
// Per-cell cache structure (extends existing cell._lastResult pattern)
cell._ir_cache = {
  source_hash: uint32,         // FNV-1a hash of cell source text
  air: CellModule,             // cached AIR
  emitted_js: string,          // cached emitted JS code
  compiled_fn: Function,       // cached compiled function
  export_types: Map,           // cached export types for change detection
  wasm_module: WebAssembly.Module | null  // cached WASM (if applicable)
};
```

Cache invalidation:
- **Source changed:** reparse, re-lower, re-emit, recompile. ~5ms.
- **Source unchanged, upstream types changed:** re-run type propagation and
  re-emit if types differ. ~2ms. No reparse.
- **Source unchanged, upstream types unchanged:** reuse everything. 0ms.
- **Source unchanged, upstream values changed:** reuse compiled function,
  re-execute. Only the function call costs.

### 11.5 Lazy Lowering

On notebook load, cells are **not** all parsed and lowered immediately. Instead:

- Cells without cache: register for lazy lowering. On first execution or first
  edit, parse and lower.
- Background: after initial render, incrementally parse remaining cells during
  idle time (`requestIdleCallback`).

This matches the existing pattern where `buildDAG` only re-parses cells whose
`c.code !== c._parsedCode`.

### 11.6 Error Handling

If a cell fails to parse (acorn syntax error) or throws at runtime:

- **Parse error:** the cell cannot be lowered. Fall back to the current
  `compileCellCode` path (wrap raw source in AsyncFunction) so the user sees
  the runtime error in context. The cell's defines/uses are computed via the
  existing regex fallback for DAG purposes.
- **Runtime error:** handled exactly as today — `executeDAG` marks the cell as
  errored, poisons its defines, downstream cells are blocked.
- **IR internal error:** if the lowerer or emitter throws unexpectedly, fall
  back to direct compilation. The IR must never make a working notebook stop
  working. Log a warning for debugging.

### 11.7 Cell Type Integration

#### Code cells (JS/TS)

The primary target. Parsed with acorn + TS plugin, lowered to AIR, emitted as
optimized JS.

#### atra cells

Already have their own compiler. Two integration paths:

1. **Short term:** atra cells continue using their existing `execute` handler
   via the `_cellTypes` plugin system. The IR handles dependency analysis only
   (replacing the atra plugin's `parseNames`/`findUses`).
2. **Long term:** atra's AST lowers to AIR, enabling cross-language type
   propagation (an atra cell exporting a `Float64Array` tells the IR the exact
   type, so a downstream JS cell gets the hinted fast path automatically).

#### adder cells (Python)

Currently tree-walked. With IR: adder's parser produces an AST, the
`lower/adder.js` module converts it to AIR, and the JS emitter produces
transpiled code. This is where the biggest performance gain lives — going from
interpreted to compiled. The cell still uses the `_cellTypes` plugin system
but its `execute` handler calls the IR pipeline instead of the tree-walker.

Adder's scope is deliberately limited (no metaclasses, no descriptors, no
`__new__`). Most adder cells in scientific notebooks are arithmetic, loops,
function calls, and natra operations — all clean AIR territory. Estimated
80-90% of typical adder code is transpilable, and that's where the compute
time lives.

#### Soft cells

Same as adder — parser → AIR → emitted JS. Type information enters via
`assume X is a <type>` statements (see §2.3), which Soft already specifies
as dual-purpose runtime checks and compilation hints (Soft SPEC §3.15).

#### Markdown / HTML / CSS cells

These are not compiled. Markdown and HTML cells continue using the existing
`findHtmlUses()` regex for `${expr}` interpolation dependency tracking.
The IR does not touch these cell types.

### 11.8 Migration Path

The IR can be introduced incrementally without breaking existing notebooks:

1. **Phase 1: Analysis only.** Replace `parseNames`/`findUses` with IR-based
   analysis for code cells. Keep `compileCellCode` as-is. This gives better
   dependency tracking with zero risk to execution.

2. **Phase 2: JS Emission.** Replace `compileCellCode` with IR emit for code
   cells that parse successfully. Fall back to direct compilation on parse
   errors. This gives hinted JS and sync function optimization.

3. **Phase 3: Cross-language.** Add atra → AIR and adder → AIR lowering.
   atra cells get cross-language type propagation. adder cells get transpiled
   execution (massive performance win).

4. **Phase 4: WASM via atra.** Add atra source emitter for WASM-eligible
   `func_region` ops. atra's compiler becomes the shared WASM backend for all
   languages. "View as atra" debugging surface.

Each phase is independently shippable and the fallback to current behavior
ensures no regression.

### 11.9 Activation

AIR is always-on with automatic fallback. There is no user-facing toggle.

- **Normal path:** acorn parse → AIR lower → passes → emit JS (or regex
  analysis + direct compilation for Phase 1).
- **Fallback path:** if acorn parsing fails or the lowerer/emitter throws,
  silently fall back to the current regex analysis (`parseNames`/`findUses`)
  and direct compilation (`compileCellCode`). Log a warning for debugging.
- **The IR must never make a working notebook stop working.**

A `// %noair` directive may be added later if users need to force the old path
for specific cells, but only when a concrete need arises.

## 12. Opaque Escape Hatch

### 12.1 What Goes Opaque

As of Phase 2 implementation, the only construct that goes opaque is:

- `WithStatement` — dynamically injects object properties into scope, making
  static analysis impossible. Also a syntax error in strict mode (which all
  cells use), so it cannot actually appear.

All other modern JavaScript constructs are fully lowered, including:
classes (with private fields, static blocks, computed keys), try/catch/finally,
generators (yield/yield*), switch, labeled statements, optional chaining (?.),
nullish coalescing (??), exponentiation (**), typeof, instanceof, in, void,
delete, bitwise NOT (~), new expressions, tagged templates, destructuring,
spread, async/await, dynamic import(), import.meta, new.target, debugger.

### 12.2 Opaque Granularity

Opaque wrapping operates at the **statement level**. If a single statement
in a cell is unanalyzable, only that statement becomes opaque — the rest of
the cell is still lowered to AIR.

The `lowerOpaque` function scans the AST subtree for identifier references,
so cross-cell dependencies are preserved even for opaque regions. The original
source text is preserved via `ctx.source.slice(node.start, node.end)` for
verbatim emission.

### 12.3 Future Syntax

New ES syntax added by TC39 degrades gracefully:

1. **Acorn doesn't know it yet:** parse error → silent fallback to regex
   analysis + direct compilation. Cell works, just no AIR optimization.
2. **Acorn updated, lowerer not:** new AST node type → opaque fallback →
   source preserved verbatim. Cell works, new syntax unoptimized.
3. **Lowerer updated:** full AIR coverage restored.

## 13. Cross-Language Lowering

### 13.0 Lowerer Architecture

AIR has three independent lowerer modules, each taking a different AST format
and producing the same AIR cell module output:

```
ext/air/src/
  lower/
    js.js       — ESTree (acorn + TS plugin) → AIR
    adder.js    — adder Python AST → AIR
    soft.js     — Soft AST → AIR
```

Each lowerer implements one function: `lower(ast, options) → CellModule`. The
output `CellModule` (§6) is identical regardless of source language. All passes
(§8), emitters (§9, §10), and caching (§11.4) operate on `CellModule` — they
do not know or care which language produced it.

atra does not have a lowerer in v1 — it uses its own compiler pipeline. The
atra→AIR lowerer (§13.1) extracts only dependency and type information for
the DAG. Full atra→AIR lowering is a long-term goal.

### 13.1 atra → AIR

atra already integrates with Auditable via the `_cellTypes` plugin system,
providing its own `parseNames`, `findUses`, and `execute` handlers. The IR
integration path is:

- **Short term:** Keep atra's existing WASM compiler. Add an atra→AIR lowerer
  that only extracts dependency and type information for the DAG. atra cells
  continue to compile and execute via their own pipeline.
- **Long term:** atra's AST lowers fully to AIR. Since atra is statically typed
  and targets numeric computation, this is nearly 1:1. All types are concrete
  from the start — no `dynamic`. Cross-language type flow becomes automatic:
  an atra cell exporting `Float64Array` tells the IR the exact type, so a
  downstream JS cell's type propagation can narrow its imports. ~300 lines.

### 13.2 adder → AIR

adder (Python) is currently a tree-walking interpreter (~4200 lines). The IR
gives it a transpilation path: adder's parser produces a Python AST, the
`lower/adder.js` module converts it to AIR, and the JS emitter produces
compiled code.

Python-specific lowering rules:

- Python `int` → `dynamic` (Python ints are arbitrary precision)
- Python `float` → `f64`
- `range()` → `for_region` with `i32` counter
- `len()` → `array_get` on `.length`
- Dunder methods → `call` ops on known protocols
- List comprehensions → `array_new` + loop
- `numpy`-style operations (via natra) → `call` ops

The tree-walker remains available as a fallback for Python features that are
too dynamic to transpile (e.g. generators, dynamic `exec()`).

### 13.3 Soft → AIR

Soft's `assume X is a <type>` statements provide type information for AIR
lowering (see §2.3). The Soft parser produces an AST, `lower/soft.js` converts
it to AIR, and the JS emitter produces compiled code. Like adder, Soft is
currently tree-walked and will see significant speedup from transpilation.

### 13.4 Future languages

Any new cell language integrates via:

1. Write a parser (or reuse an existing one)
2. Implement `lower(ast) → AIR` — a single function
3. Register as a cell type plugin

The emitters, passes, type system, DAG integration, caching, and all
optimization machinery are shared. The cost of adding a new language is
just the parser and the lowering function.

## 14. Project Structure

```
ext/
  acorn/
    acorn.min.js              — vendored acorn parser (~40KB)
    acorn-typescript.min.js   — vendored TS plugin (~8KB)
  air/
    index.js                  — BUILD OUTPUT (bundled from src/)
    build.js                  — concatenates src/ modules into index.js
    src/
      types.js                — type system: Type constructors, promotion, narrowing
      lower/
        js.js                 — ESTree → AIR lowerer (acorn AST)
        adder.js              — adder Python AST → AIR lowerer (Phase 3)
        soft.js               — Soft AST → AIR lowerer (Phase 3)
      passes.js               — type propagation, constant folding, DCE, dependency extraction, hint insertion
      emit-js.js              — AIR → JavaScript emitter (normal + hinted modes)
      emit-atra.js            — AIR → atra source emitter (Phase 4)
      api.js                  — public API: lowerJS, runPasses, emitJS, extractDefines, extractUses
```

`ext/air/index.js` is included in the main `src/js/main.js` module manifest
(core infrastructure, not an optional extension). `ext/acorn/` is vendored
like `ext/cm6/`.

## 15. Testing

AIR testing lives in `test/air.test.mjs` (pure module, no DOM shim needed).

### 15.1 Test Categories

**Lowering correctness** — each supported ESTree node type lowers to expected
AIR ops:
- Literals, arithmetic, comparison, logical ops
- Variable declarations (let, const, var with hoisting)
- Destructuring (object, array, nested, defaults, rest, rename)
- Spread syntax (arrays, calls, objects)
- Control flow (if/else, for, while, do-while, for-in, for-of)
- Functions (declarations, expressions, arrows)
- Closures (mutable captured → slot ops)
- Type annotations (`: i32`, `: f64`, `: f32array`, etc.)
- Opaque fallback (classes, try/catch, generators wrap as opaque)

**Pass correctness:**
- Type propagation (narrowing rules, cross-cell type flow)
- Constant folding (arithmetic, cross-cell constant inlining)
- Dead code elimination (unreachable ops removed, side-effects preserved)
- Dependency extraction (cell_import/cell_export edges, fine-grained per-export)
- Hint insertion (typed regions detected correctly)
- WASM region detection (eligibility criteria)

**JS emission correctness:**
- Round-trip: `eval(emitJS(lower(parse(code))))` produces same result as `eval(code)`
- Hinted mode: emitted code contains `|0`, `Math.fround()`, `0.0` patterns
- Sync detection: cells without async ops emit plain Function, not AsyncFunction
- SSA inlining: single-use values are inlined, multi-use get `let` bindings
- Opaque passthrough: opaque regions emit verbatim source

**Regression tests:**
- Every existing `dag.test.mjs` case must produce identical `defines`/`uses`
  sets when analyzed via AIR instead of regex
- Every existing notebook example must execute identically with AIR compilation

### 15.2 Test Strategy

Tests import directly from `ext/air/src/` modules (not the bundled index.js),
following the pattern of other ext/ test suites. The lowerer tests use acorn
to parse JS snippets, lower them, and assert on the resulting AIR structure.
The emission tests close the loop: parse → lower → emit → eval → compare.

## 16. Future Considerations

### 16.1 App Export Optimization

Auditable already supports exporting notebooks as standalone reactive apps.
The IR enables deeper optimization for exported apps:

- **DAG flattening:** Inline cross-cell constants and eliminate the scope object,
  producing a single compiled function in topological order.
- **Runtime stripping:** Remove the editor, save system, find/replace, and other
  development-only code from the exported HTML.
- **Whole-notebook WASM:** For fully-typed notebooks with no dynamic cells,
  compile the entire DAG to a single WASM module.

However, the scope-passing overhead is negligible for most apps. The primary
win from the IR in app export is simply that each cell's emitted code is already
faster (hinted JS, sync functions, transpiled adder/Soft). Special export-time
compilation is a v2 concern.

### 16.2 SharedArrayBuffer Parallelism

When two cells operate on independent data (no shared state), the DAG can
schedule them on separate Web Workers sharing typed array memory via
SharedArrayBuffer. The IR's dependency analysis makes this safe — only cells
with no edges between them are parallelizable.

### 16.3 Source Maps

The IR preserves source locations on every op. The JS emitter can produce
source maps from emitted JS back to the original cell source, enabling
accurate debugging in browser devtools. This integrates with the existing
`//# sourceURL=auditable://cell-${cellId}.js` convention.

### 16.4 natra Optimization

While natra operations are `call` ops in the IR (not first-class), a future
optimization pass could pattern-match sequences like:

```
%0 = call natra.zeros, (100, 100)
%1 = call natra.add, (%0, %2)
```

And fuse them into a single WASM kernel that avoids the intermediate allocation.
This is a domain-specific optimization that lives in a pass, not in the core IR.

### 16.5 MCP Integration

Auditable's MCP adapter exposes notebook cells as tools. The IR's type
information could enhance MCP tool descriptions — a cell exporting
`result: Float64Array` generates a more precise schema than the current
untyped approach.

### 16.6 Encrypted Notebook Considerations

Auditable supports AES-256-GCM whole-notebook encryption. Since AIR uses
session-level caching only (no persistent cache), there are no cleartext
leakage concerns. The IR is rebuilt from decrypted cell source on each session.

### 16.7 Relooper

AIR uses structured regions, which map directly to atra's structured control
flow and WASM's block/loop primitives. A relooper (converting arbitrary CFG to
structured control flow) is not needed for normal AIR → atra translation. If
future optimization passes produce unstructured control flow (e.g. aggressive
loop transforms), a relooper could recover structure. Deferred.

<!-- BEGIN: AUTO-GENERATED OPS TABLE — `node ext/air/gen-ops-doc.js` -->

## 17. Op shape catalogue

Auto-generated from `ext/air/src/schema.js#OP_SCHEMA`. Run `node ext/air/gen-ops-doc.js` to regenerate.

Total: 69 op types.

### Constants & loads

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `const` | fixed `[literal]` | `value` | — | — | — | — |
| `load` | fixed `[name]` | `value` | — | — | — | — |
| `meta` | fixed `[meta_name, meta_prop]` | `value` | — | — | — | — |
| `null` | fixed `[]` | `value` | — | — | — | — |
| `slot_alloc` | fixed `[name]` | `value` | — | — | — | — |
| `slot_load` | fixed `[name]` | `value` | — | — | — | — |
| `slot_store` | fixed `[name, ssa]` | `void` | yes | — | — | — |
| `store` | fixed `[name, ssa]` | `void` | yes | — | — | — |

### Arithmetic

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `add` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `div` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `exp` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `mod` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `mul` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `sub` | fixed `[ssa, ssa]` | `value` | — | — | — | — |

### Comparison

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `eq` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `gt` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `gte` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `lt` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `lte` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `neq` | fixed `[ssa, ssa]` | `value` | — | — | — | — |

### Bitwise

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `bitwise_and` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `bitwise_not` | fixed `[ssa]` | `value` | — | — | — | — |
| `bitwise_or` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `bitwise_xor` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `shift_left` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `shift_right` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `ushift_right` | fixed `[ssa, ssa]` | `value` | — | — | — | — |

### Logical

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `logical_and` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `logical_not` | fixed `[ssa]` | `value` | — | — | — | — |
| `logical_or` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `nullish_coalesce` | fixed `[ssa, ssa]` | `value` | — | — | — | — |

### Membership

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `in` | fixed `[ssa, ssa]` | `value` | — | — | — | — |
| `instanceof` | fixed `[ssa, ssa]` | `value` | — | — | — | — |

### Unary

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `delete` | fixed `[ssa]` | `value` | yes | — | — | — |
| `neg` | fixed `[ssa]` | `value` | — | — | — | — |
| `typeof` | fixed `[ssa]` | `value` | — | — | — | — |
| `unary_plus` | fixed `[ssa]` | `value` | — | — | — | — |
| `void` | fixed `[ssa]` | `value` | — | — | — | — |

### Member access

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `array_get` | fixed `[ssa, ssa]` | `value` | — | — | — | _optional_ |
| `array_set` | fixed `[ssa, ssa, ssa]` | `void` | yes | — | — | — |
| `object_get` | fixed `[ssa, key]` | `value` | — | — | — | _optional_ |
| `object_set` | fixed `[ssa, key, ssa]` | `void` | yes | — | — | — |

### Construction

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `array_new` | variadic `ssa_list` | `value` | — | — | — | — |
| `new` | variadic `ssa_list` | `value` | yes | yes | — | — |
| `object_new` | variadic `pair_list` | `value` | — | — | — | — |
| `ta_new` | variadic `ta_new_args` | `value` | — | — | — | — |

### Calls

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `await` | fixed `[ssa]` | `value` | yes | yes | — | — |
| `call` | variadic `ssa_list` | `value` | yes | yes | — | — |
| `call_method` | variadic `method_call` | `value` | yes | yes | — | — |
| `import` | fixed `[ssa]` | `value` | yes | yes | — | — |
| `spread` | fixed `[ssa]` | `value` | — | — | — | — |

### Statements

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `break` | variadic `label_optional` | `void` | yes | — | — | — |
| `continue` | variadic `label_optional` | `void` | yes | — | — | — |
| `debugger` | fixed `[]` | `void` | yes | — | — | — |
| `return` | fixed `[ssa]` | `void` | yes | — | — | — |
| `throw` | fixed `[ssa]` | `void` | yes | — | — | — |
| `yield` | variadic `ssa_optional` | `value` | yes | — | — | — |
| `yield_delegate` | fixed `[ssa]` | `value` | yes | — | — | — |

### Region ops

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `class_region` | fixed `[class_name]` | `value` | — | — | — | **members** · _name, superclass_ |
| `for_in_region` | fixed `[ssa]` | `void` | yes | — | body: loop | _target_name, phis_ |
| `for_of_region` | fixed `[ssa]` | `void` | yes | — | body: loop | **target_name** · _phis_ |
| `for_region` | fixed `[]` | `void` | yes | — | init: loop, test: loop, update: loop, body: loop | _test_val, phis_ |
| `func_region` | fixed `[func_name]` | `value` | — | — | body: function | **params** · _name, ret_type, is_async, is_generator, is_decl_ |
| `if_region` | fixed `[ssa]` | `value` | yes | — | then_body: block, else_body?: block | _then_val, else_val, phis_ |
| `labeled` | fixed `[label]` | `void` | yes | — | body: block | _is_block_ |
| `loop_region` | fixed `[]` | `void` | yes | — | test?: loop, body: loop, update?: loop | _test_val, phis, kind_ |
| `switch_region` | fixed `[ssa]` | `void` | yes | — | — | **cases** |
| `try_region` | fixed `[]` | `void` | yes | — | try_body: block, catch_body?: block, finally_body?: block | _catch_param_ |

### Special

| op | arity / args | result | side fx | async | regions | extras (**req** · _opt_) |
| --- | --- | --- | --- | --- | --- | --- |
| `opaque` | fixed `[source]` | `value` | yes | yes | — | __markDeclared_ |

<!-- END: AUTO-GENERATED OPS TABLE -->
