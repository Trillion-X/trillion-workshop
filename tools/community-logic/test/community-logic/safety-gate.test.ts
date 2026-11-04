// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/safety-gate.test.ts.
// packages/progression-evaluator/read-data/safety-gate.test.ts
//
// MNT07 proof — the fail-closed crisis safety gate. The cardinal property: there is NO path to
// deliver_coaching=true except a present, evaluated, below-threshold assessment. Everything
// else (missing detector, unknown risk, at/above threshold) suppresses coaching and routes to
// support. This is the required non-removable substrate (L112) — deleting/absent detection does
// NOT open the gate, it CLOSES it.
//
// Run: ../../node_modules/.bin/vitest run read-data/safety-gate.test.ts
import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";

import {
  evaluateSafetyGate, applySafetyGate,
  type SafetyGateConfig, type CrisisAssessment,
} from '../../src/community-logic/safety-gate.ts';

const CONFIG: SafetyGateConfig = {
  threshold: 0.7,
  supportResources: [{ kind: "crisis_resource", label: "988 Suicide & Crisis Lifeline", contact: "988" }],
};

test("FAIL-CLOSED: a MISSING assessment suppresses coaching and routes to safety", () => {
  for (const missing of [null, undefined]) {
    const v = evaluateSafetyGate(missing, CONFIG);
    assert.equal(v.deliver_coaching, false);
    assert.equal(v.route_to_safety, true);
    assert.ok(v.support_resources.length > 0, "athlete must still receive support");
  }
});

test("FAIL-CLOSED: the detector ran but risk is UNKNOWN (null/NaN) -> suppress", () => {
  for (const risk of [null, Number.NaN] as Array<number | null>) {
    const v = evaluateSafetyGate({ evaluated: true, risk }, CONFIG);
    assert.equal(v.deliver_coaching, false);
    assert.equal(v.route_to_safety, true);
  }
});

test("FAIL-CLOSED: evaluated=false (check skipped) -> suppress even if a risk number is present", () => {
  const v = evaluateSafetyGate({ evaluated: false, risk: 0.1 }, CONFIG);
  assert.equal(v.deliver_coaching, false); // a stale/low number cannot open the gate if the check didn't run
});

test("CRISIS: risk at/above threshold suppresses coaching + carries categories", () => {
  const assessment: CrisisAssessment = { evaluated: true, risk: 0.82, categories: ["self_harm", "burnout"] };
  const v = evaluateSafetyGate(assessment, CONFIG);
  assert.equal(v.deliver_coaching, false);
  assert.equal(v.route_to_safety, true);
  assert.deepEqual(v.categories, ["self_harm", "burnout"]);
  assert.ok(v.support_resources.length > 0);
  // exactly at threshold is still a crisis (>=).
  assert.equal(evaluateSafetyGate({ evaluated: true, risk: 0.7 }, CONFIG).deliver_coaching, false);
});

test("ALLOW: only a present, evaluated, below-threshold assessment opens the gate", () => {
  const v = evaluateSafetyGate({ evaluated: true, risk: 0.12 }, CONFIG);
  assert.equal(v.deliver_coaching, true);
  assert.equal(v.route_to_safety, false);
  assert.equal(v.support_resources.length, 0);
});

test("NON-BYPASSABLE OUTPUT: coaching text cannot reach the athlete when suppressed", () => {
  const coachText = { cue: "brush up through contact for more topspin" };
  // suppressed -> the athlete gets the safety payload, NEVER the coaching text.
  const crisis = applySafetyGate(evaluateSafetyGate({ evaluated: true, risk: 0.9, categories: ["self_harm"] }, CONFIG), coachText);
  assert.equal(crisis.kind, "safety");
  assert.ok(!("output" in crisis), "coaching output must not be present in a safety result");
  if (crisis.kind === "safety") assert.ok(crisis.support_resources.length > 0);

  // allowed -> coaching flows.
  const ok = applySafetyGate(evaluateSafetyGate({ evaluated: true, risk: 0.1 }, CONFIG), coachText);
  assert.equal(ok.kind, "coaching");
  if (ok.kind === "coaching") assert.deepEqual(ok.output, coachText);
});

test("REQUIRED SUBSTRATE (L112): no config/threshold edit creates a bypass — absent detection stays closed", () => {
  // Even a permissive threshold cannot open the gate when the detector didn't run.
  const permissive: SafetyGateConfig = { threshold: 0.999, supportResources: CONFIG.supportResources };
  assert.equal(evaluateSafetyGate({ evaluated: false, risk: 0 }, permissive).deliver_coaching, false);
  assert.equal(evaluateSafetyGate(null, permissive).deliver_coaching, false);
});
