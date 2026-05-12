// @gcu/dee — smoke tests for pure-function color utilities.
//
// dee's scene/layers/raycast modules need Three.js + a real DOM, so
// they're verified manually / via example notebooks. The colour helpers
// are pure JS and worth a Node-side regression check — `floorRenderColor`
// in particular is load-bearing for any consumer rendering Leapfrog-style
// data where black-coded classes are common (`@gcu/lfm`, future omf).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { floorRenderColor } from '../ext/dee/src/color.js';

describe('floorRenderColor', () => {
  test('passes a bright colour through unchanged', () => {
    assert.deepEqual(floorRenderColor({ r: 255, g: 255, b: 0 }), { r: 255, g: 255, b: 0 });
  });

  test('substitutes pure black with the default charcoal', () => {
    assert.deepEqual(floorRenderColor({ r: 0, g: 0, b: 0 }), { r: 82, g: 82, b: 92 });
  });

  test('substitutes a very-dark grey (below threshold)', () => {
    // Rec.601 luminance of (20,20,20) = 20 < 40
    assert.deepEqual(floorRenderColor({ r: 20, g: 20, b: 20 }), { r: 82, g: 82, b: 92 });
  });

  test('leaves a colour just above threshold unchanged', () => {
    // Rec.601 of (50,50,50) = 50 ≥ 40
    assert.deepEqual(floorRenderColor({ r: 50, g: 50, b: 50 }), { r: 50, g: 50, b: 50 });
  });

  test('accepts and returns an array form', () => {
    assert.deepEqual(floorRenderColor([0, 0, 0]), [82, 82, 92]);
    assert.deepEqual(floorRenderColor([200, 100, 50]), [200, 100, 50]);
  });

  test('accepts and returns a 0xRRGGBB number form', () => {
    assert.equal(floorRenderColor(0x000000), (82 << 16) | (82 << 8) | 92);
    assert.equal(floorRenderColor(0xff0000), 0xff0000);
  });

  test('respects custom threshold + substitute', () => {
    // Threshold 100: a mid-grey (luminance 100) is exactly at threshold
    // — kept; just below substituted.
    assert.deepEqual(
      floorRenderColor([99, 99, 99], { threshold: 100, substitute: [1, 2, 3] }),
      [1, 2, 3],
    );
    assert.deepEqual(
      floorRenderColor([100, 100, 100], { threshold: 100, substitute: [1, 2, 3] }),
      [100, 100, 100],
    );
  });

  test('weights green more than blue (Rec. 601)', () => {
    // (0, 80, 0) has luminance 0.587·80 ≈ 47 — above threshold (40), kept.
    // (0, 0, 80) has luminance 0.114·80 ≈ 9 — below, substituted.
    assert.deepEqual(floorRenderColor([0, 80, 0]), [0, 80, 0]);
    assert.deepEqual(floorRenderColor([0, 0, 80]), [82, 82, 92]);
  });
});
