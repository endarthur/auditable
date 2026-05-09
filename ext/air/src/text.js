// @gcu/air — Textual IR pretty-printer (v0.3 §3.4)
//
// Round-trippable text format for AIR modules. Pretty for humans;
// validator messages and debug logs use it instead of JSON dumps.
// Parser is deferred (v0.3 step 10).
//
// Format overview:
//
//   module {
//     defines: [grid, n]
//     imports: [ui, std]
//
//     %0 = const 60
//     store n, %0
//     for_region {
//       init: [
//         %1 = const 0
//         store i, %1
//       ]
//       test: [
//         %2 = lt load(i), load(n)
//       ]
//       test_val: %2
//       update: [
//         %3 = const 1
//         %4 = add load(i), %3
//         store i, %4
//       ]
//       body: [
//         array_set load(grid), load(i), load(i)
//       ]
//     }
//   }

import { OP_SCHEMA, forEachRegion } from './schema.js';

const INDENT = '  ';

/**
 * Pretty-print an AIR module to a string.
 */
function prettyPrint(module) {
  const out = [];
  out.push('module {');
  if (module.defines && [...module.defines].length) {
    out.push(`${INDENT}defines: [${[...module.defines].sort().join(', ')}]`);
  }
  if (module.imports && [...module.imports].length) {
    out.push(`${INDENT}imports: [${[...module.imports].sort().join(', ')}]`);
  }
  out.push('');
  for (const op of module.ops) {
    _printOp(op, INDENT, out);
  }
  out.push('}');
  return out.join('\n');
}

function _printOp(op, prefix, out) {
  const schema = OP_SCHEMA[op.op];
  const head = op.id ? `${op.id} = ` : '';

  // Region ops: print the multi-line block form
  if (schema && (schema.regions || op.cases || op.members)) {
    out.push(`${prefix}${head}${op.op}${_renderArgsInline(op, schema)} {`);
    _printRegionsAndExtras(op, schema, prefix + INDENT, out);
    out.push(`${prefix}}`);
    return;
  }

  // Single-line form: `<id> = <op> <args>`
  out.push(`${prefix}${head}${op.op}${_renderArgsInline(op, schema)}${_renderExtrasInline(op, schema)}`);
}

function _renderArgsInline(op, schema) {
  if (!schema || !op.args) return '';
  if (op.args.length === 0) return '';

  if (schema.arity === 'fixed') {
    const parts = [];
    for (let i = 0; i < op.args.length; i++) {
      parts.push(_renderArg(op.args[i], schema.args[i]));
    }
    return ' ' + parts.join(', ');
  }

  switch (schema.args) {
    case 'ssa_list':
      return ' ' + op.args.map(a => String(a)).join(', ');
    case 'pair_list':
      return ' ' + op.args.map(p => {
        if (!p) return 'null';
        if (p.spread) return `...${p.id}`;
        return `${JSON.stringify(p.key)}: ${p.id}`;
      }).join(', ');
    case 'method_call':
      // [obj, method, ...args]
      if (op.args.length < 2) return ' ' + op.args.map(_lit).join(', ');
      return ` ${op.args[0]}.${op.args[1]}(${op.args.slice(2).join(', ')})`;
    case 'ta_new_args':
      if (op.args.length < 1) return '';
      return ` <${op.args[0]}>(${op.args.slice(1).join(', ')})`;
    case 'label_optional':
      return op.args.length ? ' ' + JSON.stringify(op.args[0]) : '';
    case 'ssa_optional':
      return op.args.length ? ' ' + op.args[0] : '';
    default:
      return ' ' + op.args.map(_lit).join(', ');
  }
}

function _renderArg(v, kind) {
  if (kind === 'ssa') return String(v);
  if (kind === 'name' || kind === 'key' || kind === 'label' ||
      kind === 'meta_name' || kind === 'meta_prop' ||
      kind === 'func_name' || kind === 'class_name' || kind === 'source')
    return JSON.stringify(v);
  if (kind === 'literal') return _lit(v);
  return _lit(v);
}

function _lit(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof RegExp) return v.toString();
  try { return JSON.stringify(v); } catch { return String(v); }
}

function _renderExtrasInline(op, schema) {
  if (!schema || !schema.extras) return '';
  const parts = [];
  for (const [key, spec] of Object.entries(schema.extras)) {
    const val = op[key];
    if (val === undefined || val === null) continue;
    // Skip 'phi_list?', 'param_list', 'member_list', 'case_list' — these
    // are heavy and printed inside region blocks; if we're here, the op
    // has none of those (no region map), so they shouldn't be present.
    if (spec === 'phi_list?' || spec === 'param_list' || spec === 'member_list' ||
        spec === 'case_list') continue;
    parts.push(`${key}=${_renderExtraValue(val, spec)}`);
  }
  return parts.length ? `  // ${parts.join(', ')}` : '';
}

function _renderExtraValue(val, spec) {
  if (spec === 'ssa' || spec === 'ssa?') return String(val);
  if (spec === 'string' || spec === 'string?') return JSON.stringify(val);
  if (spec === 'bool' || spec === 'bool?') return String(val);
  if (spec === 'type' || spec === 'type?') {
    return val && val.kind ? val.kind : '?';
  }
  return _lit(val);
}

function _printRegionsAndExtras(op, schema, prefix, out) {
  // Print extras first (inline scalars), then regions.
  if (schema && schema.extras) {
    for (const [key, spec] of Object.entries(schema.extras)) {
      const val = op[key];
      if (val === undefined || val === null) continue;
      if (spec === 'phi_list?' || spec === 'phi_list') {
        if (Array.isArray(val) && val.length) {
          out.push(`${prefix}${key}: [`);
          for (const phi of val) {
            const cnt = phi.var
              ? `${phi.var}: then=${phi.then_val ?? '_'} else=${phi.else_val ?? '_'}`
              : JSON.stringify(phi);
            out.push(`${prefix}${INDENT}${cnt}`);
          }
          out.push(`${prefix}]`);
        }
        continue;
      }
      if (spec === 'param_list') {
        out.push(`${prefix}${key}: ${_renderParamList(val)}`);
        continue;
      }
      if (spec === 'member_list') {
        // members printed via forEachRegion's synthetic regions; skip here.
        continue;
      }
      if (spec === 'case_list') {
        // cases printed via forEachRegion below
        continue;
      }
      // Scalar extra
      out.push(`${prefix}${key}: ${_renderExtraValue(val, spec)}`);
    }
  }

  // Regions
  forEachRegion(op, (rname, rops) => {
    if (rops.length === 0) {
      out.push(`${prefix}${rname}: []`);
      return;
    }
    out.push(`${prefix}${rname}: [`);
    for (const child of rops) {
      _printOp(child, prefix + INDENT, out);
    }
    out.push(`${prefix}]`);
  });
}

function _renderParamList(params) {
  if (!Array.isArray(params)) return '?';
  const parts = params.map(p => {
    if (typeof p === 'string') return p;
    if (p && p.name) {
      let s = p.name;
      if (p.type && p.type.kind && p.type.kind !== 'dynamic') s += `: ${p.type.kind}`;
      if (p.default !== undefined) s += ' = …';
      return s;
    }
    return _lit(p);
  });
  return `(${parts.join(', ')})`;
}

export { prettyPrint };
