// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/swv03-quantile-op.test.ts.
// packages/progression-evaluator/read-data/swv03-quantile-op.test.ts
//
// SWV03 — the `quantile` scalar measure op proven over the SAME deriveMeasure
// engine. Closes the documented SwingVision speed-scalar gap (match-stat-
// measures.json _speed_scalar_residual): top shot speed (q=1), typical shot
// speed (q=0.5) and ANY percentile of ANY numeric fact field — ONE op, ZERO
// new code per stat, names no sport (L069). Type-7 interpolation, fail-soft.
//
// Run: ../../node_modules/.bin/vitest run read-data/swv03-quantile-op.test.ts
import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";

import { deriveMeasure, type FactRecord, type MeasureDefinition } from '../../read-data/derive-measure.ts';
import { measureOps } from '../../read-data/measure-ops.ts';

const def = (d: Partial<MeasureDefinition>): MeasureDefinition => d as MeasureDefinition;

// Real-shaped perception.shot.speed facts (kmh), as emit_match_facts publishes.
const SHOTS: FactRecord[] = [
  { id: "s1", kind: "perception.shot.speed", kmh: 120 },
  { id: "s2", kind: "perception.shot.speed", kmh: 90 },
  { id: "s3", kind: "perception.shot.speed", kmh: 150 },
  { id: "s4", kind: "perception.shot.speed", kmh: 100 },
  { id: "s5", kind: "perception.shot.speed", kmh: 80 },
]; // sorted: 80, 90, 100, 120, 150

const speed = (params: Record<string, unknown>) =>
  def({
    id: "shot_speed",
    op: "quantile",
    emit: "measure.match.shot_speed",
    inputs: [{ match: { kind: "perception.shot.speed" }, field: ["kmh"] }],
    params,
  });

test("median (q=0.5, default) — typical shot speed = 100", () => {
  assert.equal(deriveMeasure(SHOTS, speed({ q: 0.5 }), measureOps).value, 100);
  assert.equal(deriveMeasure(SHOTS, speed({}), measureOps).value, 100); // q defaults to 0.5
});

test("max (q=1 or reduce:max) — top shot speed = 150", () => {
  assert.equal(deriveMeasure(SHOTS, speed({ q: 1 }), measureOps).value, 150);
  assert.equal(deriveMeasure(SHOTS, speed({ reduce: "max" }), measureOps).value, 150);
});

test("min (q=0 or reduce:min) — slowest = 80", () => {
  assert.equal(deriveMeasure(SHOTS, speed({ q: 0 }), measureOps).value, 80);
  assert.equal(deriveMeasure(SHOTS, speed({ reduce: "min" }), measureOps).value, 80);
});

test("p90 (q=0.9) — type-7 interpolation = 138", () => {
  // pos = 0.9*(5-1) = 3.6 -> nums[3]=120 + 0.6*(150-120) = 120 + 18 = 138
  assert.equal(deriveMeasure(SHOTS, speed({ q: 0.9 }), measureOps).value, 138);
});

test("single fact — returns that value for any q", () => {
  const one: FactRecord[] = [{ id: "s1", kind: "perception.shot.speed", kmh: 42 }];
  assert.equal(deriveMeasure(one, speed({ q: 0 }), measureOps).value, 42);
  assert.equal(deriveMeasure(one, speed({ q: 0.5 }), measureOps).value, 42);
  assert.equal(deriveMeasure(one, speed({ q: 1 }), measureOps).value, 42);
});

test("empty — fail-soft null + confidence 0 (no facts → honest absence)", () => {
  const r = deriveMeasure([], speed({ q: 0.5 }), measureOps);
  assert.equal(r.value, null);
  assert.equal(r.confidence, 0);
});

test("q out of range clamps — q=2 -> max, q=-1 -> min", () => {
  assert.equal(deriveMeasure(SHOTS, speed({ q: 2 }), measureOps).value, 150);
  assert.equal(deriveMeasure(SHOTS, speed({ q: -1 }), measureOps).value, 80);
});

test("q:NaN / q:Infinity fall back to median (Number.isFinite guard), never emit NaN", () => {
  // Codex gauntlet hazard: typeof NaN === 'number' would slip past a typeof guard.
  assert.equal(deriveMeasure(SHOTS, speed({ q: NaN }), measureOps).value, 100);
  assert.equal(deriveMeasure(SHOTS, speed({ q: Infinity }), measureOps).value, 100);
});

test("even-length median interpolates between the two middle values", () => {
  const four: FactRecord[] = [10, 20, 30, 40].map((kmh, i) => ({
    id: `e${i}`, kind: "perception.shot.speed", kmh,
  }));
  // sorted 10,20,30,40; pos=0.5*3=1.5 -> 20 + 0.5*(30-20) = 25
  assert.equal(deriveMeasure(four, speed({ q: 0.5 }), measureOps).value, 25);
});

test("duplicate values are handled (median of repeats is that value)", () => {
  const dup: FactRecord[] = [50, 50, 50].map((kmh, i) => ({
    id: `d${i}`, kind: "perception.shot.speed", kmh,
  }));
  assert.equal(deriveMeasure(dup, speed({ q: 0.5 }), measureOps).value, 50);
  assert.equal(deriveMeasure(dup, speed({ reduce: "max" }), measureOps).value, 50);
});

test("non-finite field values are dropped (numbersOf), not NaN-poisoned", () => {
  const mixed: FactRecord[] = [
    { id: "a", kind: "perception.shot.speed", kmh: 100 },
    { id: "b", kind: "perception.shot.speed", kmh: "n/a" },
    { id: "c", kind: "perception.shot.speed", kmh: 200 },
  ];
  // only 100 & 200 are finite -> median = 150
  assert.equal(deriveMeasure(mixed, speed({ q: 0.5 }), measureOps).value, 150);
});
