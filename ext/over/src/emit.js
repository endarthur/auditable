// @gcu/over — direct-emit row compiler. Lowers the AST to a JS row function the
// driver runs per record. This is the chunk-3 executor (the proven strata
// `compileFormula`/`new Function` pattern); the `over` AIR lowerer is the next
// chunk's drop-in swap behind the same AST→row-fn interface.
//
// Emitted shape: `(out, ctx, _over) => { … }` — `out` is the working row (seeded
// from the input row, so reads see the evolving row top-to-bottom, EXTRA-style);
// writes land on `out`; `ctx.drop` / `ctx.exit` carry `delete` / `exit`.

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

export function emitRowSource(ast) {
  const lets = new Map();           // letName → local id
  const defaults = collectDefaults(ast.statements);
  let lc = 0;

  const ref = (name) => (lets.has(name) ? lets.get(name) : `out[${JSON.stringify(name)}]`);

  function expr(e) {
    switch (e.type) {
      case 'Num': return String(e.value);
      case 'Str': return JSON.stringify(e.value);
      case 'Bool': return e.value ? 'true' : 'false';
      case 'Absent': return 'null';
      case 'Field': return ref(e.name);
      case 'Unary': return `_over.neg(${expr(e.operand)})`;
      case 'Binary': return binary(e);
      case 'Call': return call(e);
      case 'Match': return match(e);
      default: throw new Error(`over emit: unknown expression "${e.type}"`);
    }
  }

  function binary(e) {
    const { op } = e;
    if (ARITH_FN[op]) return `_over.${ARITH_FN[op]}(${expr(e.left)}, ${expr(e.right)})`;
    if (op === 'and' || op === 'or') return `_over.${op}(${expr(e.left)}, ${expr(e.right)})`;
    if (op === '??') return `_over.coalesce(${expr(e.left)}, ${expr(e.right)})`;
    // relational — `== absent` / `!= absent` become presence checks (cf. sift)
    if ((op === '==' || op === '!=')) {
      if (e.right.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${expr(e.left)})`;
      if (e.left.type === 'Absent') return `_over.${op === '==' ? 'isAbsent' : 'present'}(${expr(e.right)})`;
    }
    return `_over.${CMP_FN[op]}(${expr(e.left)}, ${expr(e.right)})`;
  }

  function call(e) {
    if (e.name === 'not') return `_over.not(${expr(e.args[0])})`;
    if (e.name === 'present') return `_over.present(${expr(e.args[0])})`;
    if (e.name === 'absent') return 'null';                          // compat: absent() literal
    if (e.name === 'default') {                                      // per-column declared fill
      const a = e.args[0];
      return a && a.type === 'Field' && defaults.has(a.name) ? defaults.get(a.name) : 'null';
    }
    return `_over.call(${JSON.stringify(e.name)}${e.args.map((a) => ', ' + expr(a)).join('')})`;
  }

  function match(e) {
    const arms = e.arms.map((arm) => {
      let cond;
      if (arm.rel) cond = `_over.rel(${JSON.stringify(arm.rel)}, _m, ${expr(arm.test)})`;
      else if (isBoolish(arm.test)) cond = `_over.truthy(${expr(arm.test)})`;
      else cond = `_over.eq(_m, ${expr(arm.test)})`;
      return { cond, value: expr(arm.value) };
    });
    const def = e.default ? expr(e.default) : 'null';
    const chain = arms.reduceRight((acc, a) => `(${a.cond} ? ${a.value} : ${acc})`, def);
    return `((_m) => ${chain})(${expr(e.subject)})`;
  }

  function block(statements) { return statements.map(stmt).filter(Boolean).join('\n'); }

  function stmt(st) {
    switch (st.type) {
      case 'Assign': {
        const v = expr(st.value);
        if (st.kind === 'let') { const id = `_l${lc++}`; lets.set(st.target.name, id); return `let ${id} = ${v};`; }
        lets.delete(st.target.name);
        return `out[${JSON.stringify(st.target.name)}] = ${v};`;
      }
      case 'If': {
        let s = '';
        st.clauses.forEach((c, i) => {
          s += `${i ? ' else ' : ''}if (_over.truthy(${expr(c.test)})) {\n${block(c.body)}\n}`;
        });
        if (st.alternate) s += ` else {\n${block(st.alternate)}\n}`;
        return s;
      }
      case 'Control':
        return st.name === 'delete' ? 'ctx.drop = true; return;' : 'ctx.exit = true; return;';
      case 'Project': return '';                                     // driver-level (output projection)
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
