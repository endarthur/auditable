// @gcu/dimensions — dimension algebra + registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dimEq, dimMul, dimDiv, dimPow, dimInv, dimEmpty, dimFormat, DimRegistry,
} from '../ext/dimensions/src/dimensions.js';

test('dimEq: matches regardless of key order and stored/missing zeros', () => {
  assert.equal(dimEq({ mass: 1, length: -3 }, { length: -3, mass: 1 }), true);
  assert.equal(dimEq({}, {}), true);
  assert.equal(dimEq({ mass: 1 }, { mass: 1, time: 0 }), true);
  assert.equal(dimEq({ mass: 1 }, { mass: 2 }), false);
  assert.equal(dimEq({ mass: 1 }, { length: 1 }), false);
});

test('dimMul / dimDiv: componentwise add / subtract, drop zeros', () => {
  assert.deepEqual(dimMul({ length: 1 }, { length: 2 }), { length: 3 });
  assert.deepEqual(dimMul({ mass: 1 }, { length: -3 }), { mass: 1, length: -3 });
  assert.deepEqual(dimMul({ mass: 1 }, { mass: -1 }), {});
  assert.deepEqual(dimDiv({ mass: 1, length: 1 }, { length: 1 }), { mass: 1 });
});

test('the density·volume → tonnes identity (the headline win)', () => {
  const length = { length: 1 };
  const volume = dimPow(length, 3);                 // m³
  const density = dimDiv({ mass: 1 }, volume);      // t/m³
  assert.deepEqual(volume, { length: 3 });
  assert.deepEqual(density, { mass: 1, length: -3 });
  assert.ok(dimEq(dimMul(density, volume), { mass: 1 }));   // density · volume = mass
});

test('dimPow / dimInv: scale / negate exponents; zero drops', () => {
  assert.deepEqual(dimPow({ length: 1 }, 3), { length: 3 });
  assert.deepEqual(dimPow({ mass: 1, length: -3 }, 2), { mass: 2, length: -6 });
  assert.deepEqual(dimPow({ length: 1 }, 0), {});
  assert.deepEqual(dimInv({ length: 1, time: -1 }), { length: -1, time: 1 });
  assert.deepEqual(dimInv({}), {});
});

test('dimEmpty: only the scalar dimension', () => {
  assert.equal(dimEmpty({}), true);
  assert.equal(dimEmpty({ mass: 1 }), false);
});

test('dimFormat: readable; dimensionless → "-"', () => {
  assert.equal(dimFormat({ mass: 1, length: -3 }), 'mass·length^-3');
  assert.equal(dimFormat({ length: 1 }), 'length');
  assert.equal(dimFormat({}), '-');
});

test('grade units stay DISTINCT axes (mining semantics, not physics)', () => {
  // a physics engine reduces %, g/t, ppm all to dimensionless → would call them
  // equal. Choosing distinct axes keeps them from silently mixing.
  const pct = { pct: 1 }, gpt = { gpt: 1 };
  assert.equal(dimEq(pct, gpt), false);                       // % + g/t must NOT unify
  assert.equal(dimEq(pct, {}), false);                        // and neither is "dimensionless"
  assert.deepEqual(dimMul(gpt, { mass: 1 }), { gpt: 1, mass: 1 });   // g/t · t → metal-ish
});

test('DimRegistry: base / derived, idempotent re-define, shape conflict throws', () => {
  const reg = new DimRegistry();
  reg.defineBase('Length');
  reg.defineBase('Mass');
  assert.deepEqual(reg.resolve('Length'), { length: 1 });
  reg.defineDerived('Velocity', dimDiv({ length: 1 }, { time: 1 }));
  assert.deepEqual(reg.resolve('Velocity'), { length: 1, time: -1 });
  assert.equal(reg.has('Velocity'), true);
  assert.equal(reg.resolve('Nope'), null);

  reg.defineBase('Length');                                   // same shape → no-op
  assert.throws(() => reg.defineDerived('Length', { mass: 1 }), /different shape/);
  assert.equal(reg.list().length, 3);
});
