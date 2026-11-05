// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/corroboration-gate.test.ts.
// packages/progression-evaluator/read-data/corroboration-gate.test.ts
//
// MNT04 proof — the WF-MENTAL fail-closed affect gate as a corroboration config: PERMIT a
// perceived mental-state cue only if confidence + baseline (required) hold AND >= 2 modalities
// agree; else deny (the CALLER routes a denial to self-report — the gate names no route).
// Run: ../../node_modules/.bin/vitest run read-data/corroboration-gate.test.ts
import { test } from '../../../match-community-members/test/vitest-shim.mjs';
import assert from "node:assert/strict";

import { corroborationGate, type SignalCheck } from '../../../evaluate-progress/read-data/corroboration-gate.ts';

// The WF-MENTAL affect-cue config: confidence+baseline required, >=2 corroborating modalities.
function affectChecks(p: { confOk: boolean; baseline: boolean; modalities: Record<string, boolean> }): SignalCheck[] {
  return [
    { name: "confidence", passed: p.confOk, required: true },
    { name: "baseline", passed: p.baseline, required: true },
    ...Object.entries(p.modalities).map(([name, passed]) => ({ name, passed })),
  ];
}
const MIN = 2;

test("emit cue when confidence+baseline hold AND >=2 modalities agree", () => {
  const v = corroborationGate(affectChecks({ confOk: true, baseline: true, modalities: { face_au: true, prosody: true, hrv: false } }), MIN);
  assert.equal(v.permitted, true);
  assert.deepEqual(v.corroborating, ["face_au", "prosody"]);
});

test("FAIL-CLOSED: only ONE modality agrees -> deny -> self-report (no fabricated single-channel reading)", () => {
  const v = corroborationGate(affectChecks({ confOk: true, baseline: true, modalities: { face_au: true, prosody: false, hrv: false } }), MIN);
  assert.equal(v.permitted, false);
  assert.match(v.reason, /only 1 corroborating/);
});

test("FAIL-CLOSED: missing baseline denies even with all modalities agreeing", () => {
  const v = corroborationGate(affectChecks({ confOk: true, baseline: false, modalities: { face_au: true, prosody: true, hrv: true } }), MIN);
  assert.equal(v.permitted, false);
  assert.deepEqual(v.required_failed, ["baseline"]);
});

test("FAIL-CLOSED: low overall confidence denies even with corroboration", () => {
  const v = corroborationGate(affectChecks({ confOk: false, baseline: true, modalities: { face_au: true, prosody: true } }), MIN);
  assert.equal(v.permitted, false);
  assert.deepEqual(v.required_failed, ["confidence"]);
});

test("FAIL-CLOSED: zero signals -> deny + self-report", () => {
  assert.equal(corroborationGate([], MIN).permitted, false);
  assert.equal(corroborationGate(null, MIN).permitted, false);
});

test("generic: a 3-of-5 detector quorum (different domain) uses the SAME gate, zero code", () => {
  // e.g. 5 independent ball-bounce detectors; act on a bounce only if >=3 corroborate.
  const detectors: SignalCheck[] = [
    { name: "d1", passed: true }, { name: "d2", passed: true }, { name: "d3", passed: false },
    { name: "d4", passed: true }, { name: "d5", passed: false },
  ];
  assert.equal(corroborationGate(detectors, 3).permitted, true); // 3 of 5
  assert.equal(corroborationGate(detectors, 4).permitted, false); // need 4, only 3
});
