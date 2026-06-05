// @gcu/over — direct-emit row compiler. Lowers the AST to a JS row function the
// driver runs per record. This is the chunk-3 executor (the proven strata
// `compileFormula`/`new Function` pattern); the `over` AIR lowerer is the next
// chunk's drop-in swap behind the same AST→row-fn interface.
//
// Emitted shape: `(out, ctx, _over) => { … }` — `out` is the working row (seeded
// from the input row, so reads see the evolving row top-to-bottom, EXTRA-style);
// writes land on `out`; `ctx.drop` / `ctx.exit` carry `delete` / `exit`; a window
// expression emits `ctx.win(id, key)` (the driver's two-pass fills ctx.win).
//
// Expression emission is parameterized by an "emit context" (ec) — { ref, defaults,
// onWindow } — so the same emitters serve the row body AND window-argument
// extraction (which reads input rows).

import { overRuntime } from './runtime.js';

const REL = new Set(['==', '!=', '<', '<=', '>', '>=']);
const CMP_FN = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const ARITH_FN = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };

const isBoolish = (e) =>
  e.type === 'Bool' ||
  (e.type === 'Binary' && (REL.has(e.op) || e.op === 'and' || e.op === 'or')) ||
  (e.type === 'Call' && e.name === 'not');

const litDefault = (def) =>
  def.type === 'Absent' ? 'null'
    : def.type === 'Str' ? JSON.stringify(def.value)
      : def.type === 'Bool' ? (def.value ? 'true' : 'false')
        : String(def.value);

function collectDefaults(statements, out = new Map()) {
  for (const st of statements) {
    if (st.type === 'Assign' && st.target.spec && st.target.spec.default) {
      const d = st.target.spec.default;
      if (['Num', 'Str', 'Bool', 'Absent'].includes(d.type)) out.set(st.target.name, litDefault(d));
    } else if (st.type === 'If') {
      for (const c of st.clauses) collectDefaults(c.body, out);
      if (st.alternate) collectDefaults(st.alternate, out);
    }
  }
  return out;
}

// ── expression emit (parameterized by emit context `ec`) ──
export function emitExpr(e, ec) {
  switch (e.type) {
    case 'Num': return String(e.value);
    case 'Str': return JSON.stringify(e.value);
    case 'Bool': return e.value ? 'true' : 'false';
    case 'Absent': return 'null';
    case 'Field': return ec.ref(e.name);
    case 'Unary': return `_over.neg(${emitExpr(e.operand, ec)})`;
    case 'Binary': return emitBinary(e, ec);
    case 'Call': return emitCall(e, ec);
    case 'Match': return emitMatch(e, ec);
    case 'Window': return ec.onWindow(e, ec);
    default: throw new Error(`over emit: unknown expression "${e.type}"`);
  }
}

function emitBinary(e, ec) {
  const { op } = e;
  if (ARITH_FN[op]) return `_over.${ARITH_FN[op]}(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
  if (op === 'and' || op === 'or') return `_over.${op}(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
  if (op === '??') return `_over.coalesce(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
  if (op === '==' || op === '!=') {                        // `== absent` / `!= absent` → presence check
    if (e.right.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${emitExpr(e.left, ec)})`;
    if (e.left.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${emitExpr(e.right, ec)})`;
  }
  return `_over.${CMP_FN[op]}(${emitExpr(e.left, ec)}, ${emitExpr(e.right, ec)})`;
}

function emitCall(e, ec) {
  if (e.name === 'not') return `_over.not(${emitExpr(e.args[0], ec)})`;
  if (e.name === 'present') return `_over.present(${emitExpr(e.args[0], ec)})`;
  if (e.name === 'absent') return 'null';                  // compat: absent() literal
  if (e.name === 'default') {                              // per-column declared fill
    const a = e.args[0];
    return a && a.type === 'Field' && ec.defaults.has(a.name) ? ec.defaults.get(a.name) : 'null';
  }
  if (e.name === 'lookup') {                               // lookup(table, "key", probe, "value")
    if (!ec.hasCtx) throw new Error('over: lookup() is not allowed inside a window aggregate / order / where');
    const a = e.args;
    return `ctx.lookup(${JSON.stringify(a[0].name)}, ${JSON.stringify(a[1].value)}, ${emitExpr(a[2], ec)}, ${JSON.stringify(a[3].value)})`;
  }
  if (e.name === 'lookup_in') {                            // lookup_in(table, "eq", eqProbe, "lo", "hi", pos, "value")
    if (!ec.hasCtx) throw new Error('over: lookup_in() is not allowed inside a window aggregate / order / where');
    const a = e.args;
    return `ctx.lookupIn(${JSON.stringify(a[0].name)}, ${JSON.stringify(a[1].value)}, ${emitExpr(a[2], ec)}, `
      + `${JSON.stringify(a[3].value)}, ${JSON.stringify(a[4].value)}, ${emitExpr(a[5], ec)}, ${JSON.stringify(a[6].value)})`;
  }
  return `_over.call(${JSON.stringify(e.name)}${e.args.map((a) => ', ' + emitExpr(a, ec)).join('')})`;
}

function emitMatch(e, ec) {
  const arms = e.arms.map((arm) => {
    let cond;
    if (arm.rel) cond = `_over.rel(${JSON.stringify(arm.rel)}, _m, ${emitExpr(arm.test, ec)})`;
    else if (isBoolish(arm.test)) cond = `_over.truthy(${emitExpr(arm.test, ec)})`;
    else cond = `_over.eq(_m, ${emitExpr(arm.test, ec)})`;
    return { cond, value: emitExpr(arm.value, ec) };
  });
  const def = e.default ? emitExpr(e.default, ec) : 'null';
  const chain = arms.reduceRight((acc, a) => `(${a.cond} ? ${a.value} : ${acc})`, def);
  return `((_m) => ${chain})(${emitExpr(e.subject, ec)})`;
}

// group key for a window node, emitted against the working row (pass 2)
function windowKey(node) {
  return node.group === 'all' ? 'null'
    : `[${node.group.map((c) => `out[${JSON.stringify(c)}]`).join(', ')}]`;
}

// ── the row function ──
export function emitRowSource(ast) {
  const lets = new Map();           // letName → local id
  const defaults = collectDefaults(ast.statements);
  let lc = 0;

  const ec = {
    ref: (name) => (lets.has(name) ? lets.get(name) : `out[${JSON.stringify(name)}]`),
    defaults,
    onWindow: (node) => `ctx.win(${node._winId | 0}, ${windowKey(node)})`,
    hasCtx: true,                    // the row fn has ctx → lookup() allowed here
  };

  function block(statements) { return statements.map(stmt).filter(Boolean).join('\n'); }

  function stmt(st) {
    switch (st.type) {
      case 'Assign': {
        const v = emitExpr(st.value, ec);
        if (st.kind === 'let') { const id = `_l${lc++}`; lets.set(st.target.name, id); return `let ${id} = ${v};`; }
        lets.delete(st.target.name);
        return `out[${JSON.stringify(st.target.name)}] = ${v};`;
      }
      case 'If': {
        let s = '';
        st.clauses.forEach((c, i) => {
          s += `${i ? ' else ' : ''}if (_over.truthy(${emitExpr(c.test, ec)})) {\n${block(c.body)}\n}`;
        });
        if (st.alternate) s += ` else {\n${block(st.alternate)}\n}`;
        return s;
      }
      case 'Control':
        return st.name === 'delete' ? 'ctx.drop = true; return;' : 'ctx.exit = true; return;';
      case 'Project': return '';                            // driver-level (output projection)
      default: throw new Error(`over emit: unknown statement "${st.type}"`);
    }
  }

  return block(ast.statements);
}

export function compileRowFn(ast, runtime = overRuntime) {
  const source = emitRowSource(ast);
  const fn = new Function('out', 'ctx', '_over', source);   // controlled emission (no AIR yet)
  return { source, run: (out, ctx) => { fn(out, ctx, runtime); return out; } };
}

// Compile a standalone expression over an input row — used by the window two-pass
// to extract aggregate arguments + filters. Reads the row as `out` (no writes).
export function compileExpr(expr, runtime = overRuntime) {
  const ec = {
    ref: (name) => `out[${JSON.stringify(name)}]`,
    defaults: new Map(),
    onWindow: () => { throw new Error('over: a window aggregate cannot nest inside another'); },
  };
  const fn = new Function('out', '_over', `return ${emitExpr(expr, ec)};`);
  return (row) => fn(row, runtime);
}
