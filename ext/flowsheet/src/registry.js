// @gcu/flowsheet — node definitions + registry.
//
// A node type declares typed input/output ports, a typeVersion (mandatory for
// the cache key — bump it when compute() changes so old results auto-invalidate),
// and an async compute(inputs, params, ctx) -> outputs. Ports carry a `kind`
// (table | blockmodel | pointset | mesh | scalar | any); the engine's validate()
// checks wiring compatibility.

export function defineNode(spec) {
  if (!spec || typeof spec.type !== 'string' || !spec.type) {
    throw new Error('flowsheet: defineNode needs a string `type`');
  }
  if (typeof spec.compute !== 'function') {
    throw new Error(`flowsheet: node "${spec.type}" needs a compute() function`);
  }
  return {
    type: spec.type,
    version: spec.version ?? 1,
    inputs: spec.inputs || {},     // { portName: kind }
    outputs: spec.outputs || {},   // { portName: kind }
    params: spec.params || {},     // declared defaults / schema (optional)
    compute: spec.compute,
    meta: spec.meta || {},
  };
}

export function createRegistry() {
  const types = new Map();
  return {
    register(node) {
      const def = node && typeof node.compute === 'function' && node.version !== undefined ? node : defineNode(node);
      types.set(def.type, def);
      return def;
    },
    get: (type) => types.get(type),
    has: (type) => types.has(type),
    list: () => [...types.keys()],
  };
}

// Port-kind compatibility for wiring validation. Equal kinds match; `any` is a
// wildcard; a `blockmodel`/`pointset` may feed a `table` input (a gridded/scattered
// model streams as rows — §4a "a block model IS a table with a spatial contract").
export function compatibleKinds(outKind, inKind) {
  if (!outKind || !inKind) return true;            // unknown kind → don't block
  if (outKind === inKind) return true;
  if (inKind === 'any' || outKind === 'any') return true;
  if ((outKind === 'blockmodel' || outKind === 'pointset') && inKind === 'table') return true;
  return false;
}
