// @gcu/over — the static schema pass (SPEC §5, the auditable core). Walk the AST
// once, BEFORE any row, and resolve the output column list as a pure function of
// (transform, input schema, dialect). Evaluation never invents a column.
//
//   schemaPass(ast, inputSchema, opts?) → { columns, lets, warnings }
//     inputSchema: [{ name, type|vtype, … }]   (extra props pass through)
//     columns:     [{ name, vtype, … }]         the resolved, ordered output
//     lets:        [{ name, vtype }]             scratch temps (not in output)
//     warnings:    [string]                      e.g. use-before-def, name-rule
//
// Type inference is dataflow + branch-merge (unify) with bool↔numeric coercion,
// matching the AIR typing model. `vtype` ∈ int | float | bool | string | category
// | dynamic. Native relational/logical → bool; compat → float.

import { parseUnit, inferUnit, dimEq, dimFormat } from './units.js';

const NUM = new Set(['int', 'float']);
const STR = new Set(['string', 'category']);

// Are any units declared (input schema or a `[unit]` type spec)? If not, the whole
// unit channel is skipped — zero overhead when nobody asked for units.
function unitsInPlay(ast, inputSchema) {
  if (inputSchema.some((c) => c.unit)) return true;
  let found = false;
  (function walk(sts) {
    for (const st of sts || []) {
      if (st.type === 'Assign' && st.target.spec && st.target.spec.unit) found = true;
      else if (st.type === 'If') { st.clauses.forEach((c) => walk(c.body)); walk(st.alternate); }
    }
  })(ast && ast.statements);
  return found;
}

const FN_NUMERIC = new Set(['abs', 'sqrt', 'exp', 'log', 'loge', 'logn', 'pow', 'rais',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'azimuth', 'phi', 'mod', 'modc',
  'special', 'round', 'min', 'max', 'minia', 'maxia', 'ijkget']);
const FN_INT = new Set(['int', 'len', 'ijknum', 'xyzijk', 'bin']);
const FN_STRING = new Set(['concat', 'substr', 'trim', 'ucase', 'lcase', 'string', 'join', 'field', 'type', 'binlabel']);
const FN_PASSTHRU = new Set(['default', 'first', 'last', 'prev', 'next']);   // return arg[0]'s type
const FN_LOGICAL = new Set(['not']);

// Unify two types into the most specific common type (bool coerces to int in a
// numeric context; mixed/unknown → dynamic).
export function unify(a, b) {
  if (a === b) return a;
  if (!a || a === 'dynamic' || !b || b === 'dynamic') return 'dynamic';
  if (NUM.has(a) && NUM.has(b)) return (a === 'float' || b === 'float') ? 'float' : 'int';
  if (a === 'bool' && NUM.has(b)) return b;              // bool + int → int, bool + float → float
  if (b === 'bool' && NUM.has(a)) return a;
  if (STR.has(a) && STR.has(b)) return 'string';
  return 'dynamic';
}

function numericResult(a, b, op) {
  if (op === '/') return 'float';
  const an = a === 'bool' ? 'int' : a, bn = b === 'bool' ? 'int' : b;
  if (an === 'int' && bn === 'int') return 'int';
  if (NUM.has(an) && NUM.has(bn)) return 'float';
  return 'float';                                         // dynamic/unknown operand → assume float
}

export function inferType(expr, ctx) {
  switch (expr.type) {
    case 'Num': return Number.isInteger(expr.value) ? 'int' : 'float';
    case 'Str': return 'string';
    case 'Bool': return 'bool';
    case 'Absent': return 'dynamic';
    case 'Field': {
      const t = ctx.get(expr.name);
      if (t === undefined) ctx.warn(`references column "${expr.name}" before it exists`);
      return t || 'dynamic';
    }
    case 'Unary': {
      const t = inferType(expr.operand, ctx);
      return t === 'float' ? 'float' : (t === 'int' || t === 'bool') ? 'int' : 'dynamic';
    }
    case 'Binary': {
      const lt = inferType(expr.left, ctx), rt = inferType(expr.right, ctx);
      const op = expr.op;
      if (op === '+' || op === '-' || op === '*' || op === '/') return numericResult(lt, rt, op);
      if (op === '??') return unify(lt, rt);
      // relational / logical
      return ctx.dialect === 'compat' ? 'float' : 'bool';
    }
    case 'Call': {
      const n = expr.name;
      if (FN_NUMERIC.has(n)) return 'float';
      if (FN_INT.has(n)) return 'int';
      if (FN_STRING.has(n)) return 'string';
      if (FN_LOGICAL.has(n)) return ctx.dialect === 'compat' ? 'float' : 'bool';
      if (FN_PASSTHRU.has(n)) return expr.args[0] ? inferType(expr.args[0], ctx) : 'dynamic';
      return 'dynamic';
    }
    case 'Match': {
      let t = expr.default ? inferType(expr.default, ctx) : undefined;
      for (const arm of expr.arms) t = t === undefined ? inferType(arm.value, ctx) : unify(t, inferType(arm.value, ctx));
      return t || 'dynamic';
    }
    case 'Window': {
      const n = expr.agg && expr.agg.type === 'Call' ? expr.agg.name : null;
      if (n === 'count') return 'int';
      if (n === 'mean' || n === 'std') return 'float';
      if (n === 'sum') return expr.agg.args[0] && inferType(expr.agg.args[0], ctx) === 'int' ? 'int' : 'float';
      // min/max + positional (prev/next/first/last) take the arg's type
      if (['min', 'max', 'prev', 'next', 'first', 'last'].includes(n)) return expr.agg.args[0] ? inferType(expr.agg.args[0], ctx) : 'dynamic';
      return 'dynamic';
    }
    case 'JoinAgg': {
      // aggregate over another table — args reference the MATCHED row (unknown to
      // this schema), so the type is fixed by the aggregate, not the arg.
      const n = expr.agg && expr.agg.type === 'Call' ? expr.agg.name : null;
      if (n === 'count') return 'int';
      return 'float';                       // sum/mean/min/max/std/wmean over matches
    }
    default: return 'dynamic';
  }
}

const NAME_RULES = {
  compat: { max: 8, re: /^[A-Z][A-Z0-9_]*$/, label: 'classic .dm (≤8, UPPER, [A-Z0-9_])' },
  'compat-extended': { max: 24, re: /^[A-Z][A-Z0-9_]*$/, label: 'extended .dm (≤24, UPPER, [A-Z0-9_])' },
};

export function schemaPass(ast, inputSchema = [], opts = {}) {
  const dialect = (ast && ast.dialect) || opts.dialect || 'native';
  const warnings = [];

  const units = unitsInPlay(ast, inputSchema);

  // current output columns, in order, by name
  const map = new Map();
  const order = [];
  const lets = new Map();
  const letUnits = new Map();
  for (const c of inputSchema) {
    const col = { ...c, name: c.name, vtype: normalizeType(c.vtype || c.type) };
    if (units && c.unit != null) col.unit = typeof c.unit === 'string' ? parseUnit(c.unit) : c.unit;
    map.set(col.name, col); order.push(col.name);
  }

  const ctx = {
    dialect,
    get: (name) => lets.has(name) ? lets.get(name) : (map.has(name) ? map.get(name).vtype : undefined),
    warn: (m) => warnings.push(m),
  };
  // unit channel (parallel to ctx): name → dim|null. Only consulted when `units`.
  const uctx = {
    unitOf: (name) => letUnits.has(name) ? letUnits.get(name) : (map.has(name) ? (map.get(name).unit || null) : null),
    warn: (m) => warnings.push(m),
  };

  function declare(name, vtype, hasSpec) {
    if (lets.has(name)) lets.delete(name);                 // a field shadows/replaces a prior let
    if (map.has(name)) {
      const col = map.get(name);
      col.vtype = hasSpec ? vtype : unify(col.vtype, vtype);
    } else {
      map.set(name, { name, vtype }); order.push(name);
    }
    const rule = NAME_RULES[dialect];
    if (rule && (name.length > rule.max || !rule.re.test(name)))
      warnings.push(`column "${name}" violates ${rule.label}`);
  }

  function walk(statements) {
    for (const st of statements) {
      switch (st.type) {
        case 'Assign': {
          const t = st.target.spec && st.target.spec.vtype ? st.target.spec.vtype : inferType(st.value, ctx);
          if (st.kind === 'let') lets.set(st.target.name, t);
          else declare(st.target.name, t, !!(st.target.spec && st.target.spec.vtype));
          if (units) {
            const annotation = st.value == null;
            const declaredUnit = st.target.spec && st.target.spec.unit ? parseUnit(st.target.spec.unit) : null;
            let unit, apply = true;
            if (annotation) {
              unit = declaredUnit;
              apply = declaredUnit != null;        // a vtype-only annotation leaves the unit untouched
            } else if (declaredUnit) {
              unit = declaredUnit;
              const inferred = inferUnit(st.value, uctx);
              if (inferred && !dimEq(inferred, unit))
                warnings.push(`column "${st.target.name}": declared [${st.target.spec.unit}] but the expression is ${dimFormat(inferred)}`);
            } else {
              unit = inferUnit(st.value, uctx);
            }
            if (apply) {
              if (st.kind === 'let') { if (unit) letUnits.set(st.target.name, unit); else letUnits.delete(st.target.name); }
              else { const col = map.get(st.target.name); if (col) { if (unit) col.unit = unit; else delete col.unit; } }
            }
          }
          break;
        }
        case 'If': {
          // Branch-merge approximation: walk every branch on the same env so each
          // branch-declared column lands; declare() unifies a column's type across
          // the branches that assign it. (A column assigned in only some branches
          // still appears — it may be absent in the others at runtime.)
          for (const cl of st.clauses) walk(cl.body);
          if (st.alternate) walk(st.alternate);
          break;
        }
        case 'Project': {
          if (st.name === 'erase') {
            for (const f of st.fields) { if (map.delete(f)) order.splice(order.indexOf(f), 1); else warnings.push(`erase: no column "${f}"`); }
          } else { // keep | saveonly → restrict to the listed fields, in that order
            const next = [];
            for (const f of st.fields) {
              if (map.has(f)) next.push(f); else warnings.push(`${st.name}: no column "${f}"`);
            }
            order.length = 0; order.push(...next);
            for (const k of [...map.keys()]) if (!next.includes(k)) map.delete(k);
          }
          break;
        }
        case 'Control': break;                             // delete / exit: no schema effect
        case 'Check': inferType(st.test, ctx); break;      // validate refs (warns); no output column
        default: break;
      }
    }
  }

  walk((ast && ast.statements) || []);

  return {
    columns: order.map((name) => map.get(name)),
    lets: [...lets].map(([name, vtype]) => ({ name, vtype })),
    warnings,
  };
}

function normalizeType(t) {
  if (!t) return 'dynamic';
  const s = String(t).toLowerCase();
  if (s === 'number' || s === 'f64' || s === 'double' || s === 'real') return 'float';
  if (s === 'i32' || s === 'integer' || s === 'int') return 'int';
  if (s === 'boolean' || s === 'bool') return 'bool';
  if (s === 'str' || s === 'string' || s === 'text' || s === 'alpha') return 'string';
  if (NUM.has(s) || STR.has(s) || s === 'bool' || s === 'dynamic') return s;
  return 'dynamic';
}
