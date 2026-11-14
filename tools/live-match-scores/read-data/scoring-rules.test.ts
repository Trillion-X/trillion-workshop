// packages/live-match-score/read-data/scoring-rules.test.ts
//
// SCR01 proof: the sport enum dissolves into scoring-rule DATA. Verifies:
//   1. GOLDEN — the tennis rule's display reproduces the old `tennisPointLabels`
//      branch EXACTLY (no regression), and a pickleball rule shows raw counts.
//   2. PHASE — tiebreak is read from the rule's `tiebreakAt`, not a sport literal.
//   3. DELETION — a padel golden-point rule, and a wholly invented rule, display
//      from DATA with zero code change (L069/L090 enum dissolution).

import { test } from "../../../test-helpers/vitest-shim.mjs";
import assert from "node:assert/strict";
import {
  resolveDisplayScores,
  resolveScoringPhase,
  findScoringRule,
  TENNIS_SCORING_RULE,
  PICKLEBALL_SCORING_RULE,
  PADEL_GOLDEN_POINT_RULE,
  REFERENCE_SCORING_RULES,
  type ScoringRuleRecord,
} from "./scoring-rules.ts";

// The ORIGINAL tennis display logic, copied verbatim as the golden oracle.
function tennisPointLabelsOracle(points, phase) {
  if (phase === "tiebreak" || phase === "complete") {
    return { "team-a": String(points["team-a"]), "team-b": String(points["team-b"]) };
  }
  const a = points["team-a"];
  const b = points["team-b"];
  if (a >= 3 && b >= 3) {
    if (a === b) return { "team-a": "40", "team-b": "40" };
    return { "team-a": a > b ? "AD" : "40", "team-b": b > a ? "AD" : "40" };
  }
  const labels = ["0", "15", "30", "40"];
  return { "team-a": labels[Math.min(a, 3)] ?? String(a), "team-b": labels[Math.min(b, 3)] ?? String(b) };
}

test("golden: tennis rule display == original tennisPointLabels for every score", () => {
  const model = TENNIS_SCORING_RULE.scoringModel;
  for (let a = 0; a <= 6; a++) {
    for (let b = 0; b <= 6; b++) {
      const points = { "team-a": a, "team-b": b };
      for (const phase of ["standard", "tiebreak", "complete"]) {
        const got = resolveDisplayScores(model, points, points, phase);
        const want = tennisPointLabelsOracle(points, phase);
        assert.deepEqual(got, want, `tennis ${a}-${b} @ ${phase}`);
      }
    }
  }
});

test("golden: pickleball rule shows raw team counts (no labeled ladder)", () => {
  const model = PICKLEBALL_SCORING_RULE.scoringModel;
  const display = resolveDisplayScores(model, { "team-a": 0, "team-b": 0 }, { "team-a": 9, "team-b": 7 }, "standard");
  assert.deepEqual(display, { "team-a": "9", "team-b": "7" });
});

test("phase: tiebreak read from rule tiebreakAt, never a sport literal", () => {
  // tennis: tiebreakAt 6, both games at 6 -> tiebreak
  assert.equal(resolveScoringPhase(TENNIS_SCORING_RULE.scoringModel, { "team-a": 6, "team-b": 6 }), "tiebreak");
  // tennis: 6-5 -> standard
  assert.equal(resolveScoringPhase(TENNIS_SCORING_RULE.scoringModel, { "team-a": 6, "team-b": 5 }), "standard");
  // pickleball: tiebreakAt 0 -> never tiebreak even at 11-11
  assert.equal(resolveScoringPhase(PICKLEBALL_SCORING_RULE.scoringModel, { "team-a": 11, "team-b": 11 }), "standard");
});

test("deletion: padel golden-point rule (no advantageLabel) sudden-deaths at the last label, 0 code", () => {
  const model = PADEL_GOLDEN_POINT_RULE.scoringModel;
  // 40-40 (3-3) shows 40/40
  assert.deepEqual(resolveDisplayScores(model, { "team-a": 3, "team-b": 3 }, { "team-a": 3, "team-b": 3 }, "standard"), {
    "team-a": "40",
    "team-b": "40",
  });
  // 4-3: no advantage zone -> both clamp to the final label (sudden death), NO "AD"
  const adv = resolveDisplayScores(model, { "team-a": 4, "team-b": 3 }, { "team-a": 4, "team-b": 3 }, "standard");
  assert.equal(adv["team-a"], "40");
  assert.equal(adv["team-b"], "40");
  assert.equal(Object.values(adv).includes("AD"), false);
});

test("deletion: a wholly invented rule displays from DATA with zero code change", () => {
  const invented: ScoringRuleRecord = {
    kind: "scoring-rule",
    ruleId: "scoring-rule:invented",
    label: "Invented",
    scoringModel: {
      scoreUnit: "point",
      setsToWin: 1,
      gamesToWinSet: 5,
      tiebreakAt: 0,
      pointsToWinTiebreak: 0,
      winBy: 1,
      pointLabels: ["love", "one", "two", "three"],
      advantageLabel: "plus",
    },
  };
  const d = resolveDisplayScores(invented.scoringModel, { "team-a": 1, "team-b": 2 }, { "team-a": 1, "team-b": 2 }, "standard");
  assert.deepEqual(d, { "team-a": "one", "team-b": "two" });
  // advantage zone uses the invented "plus" label
  const adv = resolveDisplayScores(invented.scoringModel, { "team-a": 4, "team-b": 3 }, { "team-a": 4, "team-b": 3 }, "standard");
  assert.equal(adv["team-a"], "plus");
});

test("findScoringRule: picker source resolves by id, falls back to first", () => {
  assert.equal(findScoringRule(REFERENCE_SCORING_RULES, "scoring-rule:pickleball-11"), PICKLEBALL_SCORING_RULE);
  assert.equal(findScoringRule(REFERENCE_SCORING_RULES, "nope"), TENNIS_SCORING_RULE);
  assert.equal(findScoringRule(REFERENCE_SCORING_RULES, undefined), TENNIS_SCORING_RULE);
});
