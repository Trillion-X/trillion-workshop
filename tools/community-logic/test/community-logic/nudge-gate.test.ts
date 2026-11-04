// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/nudge-gate.test.ts.
// packages/progression-evaluator/read-data/nudge-gate.test.ts
//
// MNT03 proof — the SDT-aware fail-closed nudge gate. Anti-harm priorities: autonomy (opt-out)
// > rate limit (anti-nag) > known risk (fail-closed on unknown) > threshold. The tone is
// always autonomy_supportive (shame/controlling is unrepresentable by the type).
//
// Run: ../../node_modules/.bin/vitest run read-data/nudge-gate.test.ts
import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";

import { decideNudge, type NudgeConfig, type AdherenceContext } from '../../src/community-logic/nudge-gate.ts';

const CONFIG: NudgeConfig = { riskThreshold: 0.6, framingRef: "framing:autonomy_supportive_checkin" };

test("nudges at elevated risk, under the cap, not opted out — always autonomy_supportive", () => {
  const v = decideNudge({ adherence_risk: 0.8, rate_limit_ok: true }, CONFIG);
  assert.equal(v.nudge, true);
  assert.equal(v.tone, "autonomy_supportive");
  assert.equal(v.framing_ref, "framing:autonomy_supportive_checkin");
});

test("AUTONOMY first: an opted-out athlete is NEVER nudged, even at max risk", () => {
  const v = decideNudge({ adherence_risk: 1, rate_limit_ok: true, athlete_opted_out: true }, CONFIG);
  assert.equal(v.nudge, false);
  assert.match(v.reason, /opted out/);
});

test("RATE LIMIT (ai-action-guard): over the nudge cap -> no nudge (anti-nag/anti-shame)", () => {
  const v = decideNudge({ adherence_risk: 0.95, rate_limit_ok: false }, CONFIG);
  assert.equal(v.nudge, false);
  assert.match(v.reason, /rate limit/);
});

test("FAIL-CLOSED: unknown risk (null/NaN) -> no nudge", () => {
  for (const risk of [null, Number.NaN] as Array<number | null>) {
    assert.equal(decideNudge({ adherence_risk: risk, rate_limit_ok: true }, CONFIG).nudge, false);
  }
  assert.equal(decideNudge(null, CONFIG).nudge, false);
});

test("below threshold -> no nudge (do not nag a consistent athlete)", () => {
  assert.equal(decideNudge({ adherence_risk: 0.3, rate_limit_ok: true }, CONFIG).nudge, false);
  // exactly at threshold nudges (>=).
  assert.equal(decideNudge({ adherence_risk: 0.6, rate_limit_ok: true }, CONFIG).nudge, true);
});

test("the verdict tone is ALWAYS autonomy_supportive — no shame/controlling variant exists", () => {
  const cases: AdherenceContext[] = [
    { adherence_risk: 0.9, rate_limit_ok: true },
    { adherence_risk: 0.1, rate_limit_ok: true },
    { adherence_risk: 0.9, rate_limit_ok: false },
    { adherence_risk: null, rate_limit_ok: true },
  ];
  for (const c of cases) assert.equal(decideNudge(c, CONFIG).tone, "autonomy_supportive");
});

test("priority order: opt-out beats rate-limit beats unknown-risk beats threshold", () => {
  // opted out AND over rate limit AND unknown risk -> opt-out reason wins (autonomy is first).
  assert.match(decideNudge({ adherence_risk: null, rate_limit_ok: false, athlete_opted_out: true }, CONFIG).reason, /opted out/);
  // not opted out, over rate limit, unknown risk -> rate-limit reason wins.
  assert.match(decideNudge({ adherence_risk: null, rate_limit_ok: false }, CONFIG).reason, /rate limit/);
});
