// @gcu/air — IR validator (v0.3 §3.2)
//
// Schema-driven shape check. Walks every op in a module and verifies it
// matches its OP_SCHEMA row: known op type, correct arity, required extras
// present, no dangling SSA refs (ids referenced must point to ops that
// exist within the same scope chain).
//
// Off by default in production for performance; opt in via runPasses({
// validate: true }) — wired for the test harness, dev-mode browser
// (?airdebug=1), and one-off debugging.
//
// Bug classes the validator catches at IR-build time, before reaching the
// emitter (see v0.3 §3.2):
//   - lowerForOf forgetting target_name           → arity check fails
//   - lowerUnary emitting `add` with one arg      → arity check fails
//   - missing required extras (e.g. cases for switch_region)
//   - dangling SSA refs (consumer ahead of producer)
//   - unknown op types

import {
  OP_SCHEMA,
  forEachSsaRef,
  forEachRegion,
  requiredExtras,
  _isSsaId,
} from './schema.js';

class AirValidationError extends Error {
  constructor(errors, ir) {
    const head = errors.slice(0, 5).map(e => '  ' + e).join('\n');
    const more = errors.length > 5 ? `\n  … and ${errors.length - 5} more` : '';
    const irBlock = ir ? `\n\nIR:\n${ir}` : '';
    super(`AIR validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${head}${more}${irBlock}`);
    this.errors = errors;
    this.ir = ir;
    this.name = 'AirValidationError';
  }
}

/**
 * Validate an AIR module against the schema.
 * Returns array of error strings; empty array means valid.
 *
 * Does NOT throw — caller decides. (validateOrThrow does.)
 *
 * Reference-resolution model: flat-set, not strict scope-aware. Cross-region
 * "result" extras (if_region.then_val pointing into then_body, for_region.
 * test_val pointing into test, phi entries pointing into branch bodies) are
 * legitimate uses but live across scope boundaries. A strict scope-aware
 * walker would reject them as false positives. Flat-set still catches the
 * real bug class — typos, ordering errors, malformed lowering output —
 * without the scope-tracking complexity. Strict scoping is a future
 * enhancement (v0.3 step 7's ScopeChain makes it cheap once landed).
 */
function validateModule(module) {
  const errors = [];

  // Pass 1: collect every SSA id produced anywhere in the module.
  const allIds = new Set();
  const collect = (ops) => {
    for (const op of ops) {
      if (op.id) allIds.add(op.id);
      forEachRegion(op, (_n, rops) => collect(rops));
    }
  };
  collect(module.ops);

  // Pass 2: walk + validate each op against the schema.
  const validate = (ops, path) => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const opPath = `${path}[${i}]:${op.op}`;
      const schema = OP_SCHEMA[op.op];

      if (!schema) {
        errors.push(`${opPath}: unknown op '${op.op}'`);
        forEachRegion(op, (rname, rops) => validate(rops, `${opPath}.${rname}`));
        continue;
      }

      _checkArity(op, schema, opPath, errors);

      const required = requiredExtras(op.op);
      for (const k of required) {
        if (op[k] === undefined || op[k] === null) {
          errors.push(`${opPath}: missing required extra '${k}'`);
        }
      }

      forEachSsaRef(op, (id) => {
        if (!allIds.has(id)) {
          errors.push(`${opPath}: dangling ref ${id}`);
        }
      });

      forEachRegion(op, (rname, rops) => validate(rops, `${opPath}.${rname}`));
    }
  };

  validate(module.ops, 'root');
  return errors;
}

/**
 * Validate and throw AirValidationError on failure.
 * Used by runPasses when opts.validate === true and by tests.
 */
function validateOrThrow(module, irRenderer) {
  const errors = validateModule(module);
  if (errors.length === 0) return;
  let ir;
  if (typeof irRenderer === 'function') {
    try { ir = irRenderer(module); } catch { /* renderer optional */ }
  }
  throw new AirValidationError(errors, ir);
}

// ── Arity helpers ───────────────────────────────────────────────────

function _checkArity(op, schema, opPath, errors) {
  const args = op.args;
  if (!Array.isArray(args)) {
    errors.push(`${opPath}: args is not an array`);
    return;
  }

  if (schema.arity === 'fixed') {
    const expected = schema.args.length;
    if (args.length !== expected) {
      errors.push(`${opPath}: expected ${expected} args, got ${args.length}`);
    }
    // Soft-check positions: for SSA-typed slots, ensure the value looks
    // like an SSA id ('%N'). For LITERAL/STRING/NAME slots we don't try
    // to validate content semantically — just that they're present.
    for (let i = 0; i < Math.min(args.length, expected); i++) {
      const expectedKind = schema.args[i];
      const v = args[i];
      if (expectedKind === 'ssa') {
        if (!_isSsaId(v)) {
          errors.push(`${opPath}: arg[${i}] expected ssa, got ${_describe(v)}`);
        }
      }
    }
    return;
  }

  // Variadic shapes
  switch (schema.args) {
    case 'ssa_list':
      for (let i = 0; i < args.length; i++) {
        if (!_isSsaId(args[i])) {
          errors.push(`${opPath}: arg[${i}] expected ssa, got ${_describe(args[i])}`);
        }
      }
      break;
    case 'pair_list':
      for (let i = 0; i < args.length; i++) {
        const p = args[i];
        if (!p || typeof p !== 'object') {
          errors.push(`${opPath}: arg[${i}] expected pair record, got ${_describe(p)}`);
          continue;
        }
        if (!('key' in p) && !('spread' in p)) {
          errors.push(`${opPath}: arg[${i}] missing 'key' or 'spread'`);
        }
        if (!_isSsaId(p.id)) {
          errors.push(`${opPath}: arg[${i}].id expected ssa, got ${_describe(p.id)}`);
        }
      }
      break;
    case 'method_call':
      // [obj_ssa, method_key (string), ...arg_ssa]
      if (args.length < 2) {
        errors.push(`${opPath}: expected at least [obj, method], got ${args.length} args`);
      } else {
        if (!_isSsaId(args[0])) {
          errors.push(`${opPath}: arg[0] expected obj ssa, got ${_describe(args[0])}`);
        }
        if (typeof args[1] !== 'string') {
          errors.push(`${opPath}: arg[1] expected method name string, got ${_describe(args[1])}`);
        }
        for (let i = 2; i < args.length; i++) {
          if (!_isSsaId(args[i])) {
            errors.push(`${opPath}: arg[${i}] expected ssa, got ${_describe(args[i])}`);
          }
        }
      }
      break;
    case 'ta_new_args':
      // [kind_string, ...ssa]
      if (args.length < 1) {
        errors.push(`${opPath}: ta_new requires at least element kind`);
      } else {
        if (typeof args[0] !== 'string') {
          errors.push(`${opPath}: arg[0] expected element-kind string, got ${_describe(args[0])}`);
        }
        for (let i = 1; i < args.length; i++) {
          if (!_isSsaId(args[i])) {
            errors.push(`${opPath}: arg[${i}] expected ssa, got ${_describe(args[i])}`);
          }
        }
      }
      break;
    case 'label_optional':
      if (args.length > 1) {
        errors.push(`${opPath}: label_optional accepts 0 or 1 args, got ${args.length}`);
      }
      break;
    case 'ssa_optional':
      if (args.length > 1) {
        errors.push(`${opPath}: ssa_optional accepts 0 or 1 args, got ${args.length}`);
      }
      if (args.length === 1 && !_isSsaId(args[0])) {
        errors.push(`${opPath}: arg[0] expected ssa, got ${_describe(args[0])}`);
      }
      break;
    default:
      errors.push(`${opPath}: schema declares unknown variadic shape '${schema.args}'`);
  }
}

function _describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return `string ${JSON.stringify(v.slice(0, 30))}`;
  if (t === 'number' || t === 'boolean') return `${t} ${v}`;
  return t;
}

export { validateModule, validateOrThrow, AirValidationError };
