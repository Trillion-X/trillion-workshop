// tools/media-composition/test/keyframe-curves.test.mjs
//
// A keyframe curve is one row of keyframe-curves.json, read by both the ffmpeg expression compiler and the numeric
// sampler. Every row's expression and its number agree across the span, and a name no row has is refused by both.
import assert from 'node:assert/strict';
import test from 'node:test';
import CURVES from '../do-work/keyframe-curves.json' with { type: 'json' };
import { curveOf, shareAt, shareExpr } from '../do-work/keyframe-curve.mjs';
import { sampleEnvelope } from '../do-work/effect-registry.mjs';

const evalShare = (expr) => Function(`return ${expr.replaceAll('--', '- -')}`)();

test('every curve row starts at its start value, and its expression equals its number across the span', () => {
  for (const [name, coefficients] of Object.entries(CURVES.curves)) {
    assert.equal(shareAt(coefficients, 0), 0, `${name} starts at the start value`);
    for (let i = 0; i <= 20; i += 1) {
      const f = i / 20;
      const expr = shareExpr(coefficients, String(f));
      assert.ok(Math.abs(evalShare(expr) - shareAt(coefficients, f)) < 1e-12, `${name} at ${f}: ${expr}`);
    }
  }
});

test('the numeric sampler moves along each curve row between two knots', () => {
  for (const [name, coefficients] of Object.entries(CURVES.curves)) {
    const got = sampleEnvelope([{ t: 0, value: 2 }, { t: 4, value: 6, interp: name }], 1);
    assert.ok(Math.abs(got - (2 + 4 * shareAt(coefficients, 0.25))) < 1e-12, `${name}: ${got}`);
  }
});

test('a curve no row names is refused', () => {
  assert.throws(() => curveOf('bounce'), /interp "bounce" not in/);
  assert.throws(() => sampleEnvelope([{ t: 0, value: 0 }, { t: 1, value: 1, interp: 'bounce' }], 0.5), /not in/);
});
