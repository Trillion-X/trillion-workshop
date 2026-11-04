// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/read-data/bounded-candidates.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_VALUE_FACTORS,
  buildCandidates,
  expectedValueAdmission,
  scoreExpectedValue,
} from "../../../src/community-logic/match/bounded-candidates.mjs";
import { selectPairs } from "../../../src/community-logic/match/select-pairs.mjs";

const ACCESS_TIERS = [
  "external_person",
  "free_ethos_node",
  "stewarded_trillion_user",
];

const SCOPE = Object.freeze({
  pursuit_ref: "pursuit:example",
  system_ref: "system:example",
  timescale_ref: "timescale:now",
  state_ref: "state:current",
});

function factorEvidence(value) {
  return {
    status: "grounded",
    evidence_refs: ["evidence:fixture"],
    factors: Object.fromEntries(EXPECTED_VALUE_FACTORS.map((factor) => [factor, {
      status: "grounded",
      score: value,
      evidence_refs: ["evidence:fixture"],
      inference_ref: `inference:fixture:${factor}`,
    }])),
  };
}

test("bounded retrieval evaluates at most subject count times fixed shortlist size", () => {
  const result = buildCandidates([
    {
      subject: "subject-a",
      scope: SCOPE,
      corpus_size: 1000,
      shortlist: [
        { participant: "a1", access_tier: ACCESS_TIERS[0], factor_evidence: factorEvidence(0.9) },
        { participant: "a2", access_tier: ACCESS_TIERS[1], factor_evidence: factorEvidence(0.8) },
        { participant: "a3", access_tier: ACCESS_TIERS[2], factor_evidence: factorEvidence(0.7) },
      ],
    },
    {
      subject: "subject-b",
      scope: SCOPE,
      corpus_size: 1000,
      shortlist: [
        { participant: "b1", access_tier: ACCESS_TIERS[0], factor_evidence: factorEvidence(0.6) },
        { participant: "b2", access_tier: ACCESS_TIERS[1], factor_evidence: factorEvidence(0.5) },
        { participant: "b3", access_tier: ACCESS_TIERS[2], factor_evidence: factorEvidence(0.4) },
      ],
    },
  ], {
    shortlist_size: 2,
    eligibility: { access_tiers: ACCESS_TIERS },
  });

  assert.equal(result.candidates.length, 4);
  assert.equal(result.instrumentation.subject_count, 2);
  assert.equal(result.instrumentation.shortlist_evaluation_count, 4);
  assert.equal(result.instrumentation.max_bounded_evaluations, 4);
  assert.equal(result.instrumentation.all_pairs_evaluation_count, 0);
  assert.equal(result.instrumentation.expensive_reasoning_count, 0);
});

test("increasing corpus size does not increase shortlist or reasoning work", () => {
  const makeRows = (corpusSize) => Array.from({ length: 12 }, (_, index) => ({
    subject: `subject-${index}`,
    scope: SCOPE,
    corpus_size: corpusSize,
    shortlist: Array.from({ length: 20 }, (__, candidateIndex) => ({
      participant: `candidate-${index}-${candidateIndex}`,
      access_tier: ACCESS_TIERS[candidateIndex % ACCESS_TIERS.length],
      factor_evidence: factorEvidence(1 - candidateIndex / 100),
    })),
  }));
  const config = {
    shortlist_size: 5,
    eligibility: { access_tiers: ACCESS_TIERS },
  };
  const smallCorpus = buildCandidates(makeRows(100), config);
  const largeCorpus = buildCandidates(makeRows(1_000_000), config);

  assert.equal(smallCorpus.instrumentation.shortlist_evaluation_count, 60);
  assert.equal(largeCorpus.instrumentation.shortlist_evaluation_count, 60);
  assert.equal(largeCorpus.instrumentation.expected_value_evaluation_count, 60);
  assert.equal(largeCorpus.instrumentation.all_pairs_evaluation_count, 0);
});

test("complementarity, relevance, timing, actability, and impact beat similarity-only", () => {
  const built = buildCandidates([{
    subject: "need-owner",
    scope: SCOPE,
    shortlist: [
      {
        participant: "similar-but-unavailable",
        access_tier: ACCESS_TIERS[0],
        similarity: 0.99,
        factor_evidence: factorEvidence(0.01),
      },
      {
        participant: "complementary-and-ready",
        access_tier: ACCESS_TIERS[2],
        similarity: 0.2,
        factor_evidence: {
          ...factorEvidence(1),
          factors: {
            ...factorEvidence(1).factors,
            relevance: { ...factorEvidence(0.9).factors.relevance },
          },
        },
      },
    ],
  }], {
    shortlist_size: 2,
    eligibility: { access_tiers: ACCESS_TIERS },
  });
  const selected = selectPairs({
    candidates: built.candidates,
    pairing: {
      group_size: 2,
      grouping: { modes: [{ type: "1:1", min_size: 2, max_size: 2 }] },
    },
  });

  assert.deepEqual(selected.groups[0].members, ["complementary-and-ready", "need-owner"]);
  assert.equal(selected.groups[0].selected_shortlist[0].participant, "complementary-and-ready");
});

test("access tier eligibility is DATA and all configured tiers are honored", () => {
  const result = buildCandidates([{
    subject: "subject",
    scope: SCOPE,
    shortlist: [
      { participant: "external", access_tier: "external_person", factor_evidence: factorEvidence(0.9) },
      { participant: "free", access_tier: "free_ethos_node", factor_evidence: factorEvidence(0.8) },
      { participant: "stewarded", access_tier: "stewarded_trillion_user", factor_evidence: factorEvidence(0.7) },
      { participant: "blocked", access_tier: "unlisted-tier", factor_evidence: factorEvidence(1) },
    ],
  }], {
    shortlist_size: 4,
    eligibility: { access_tiers: ACCESS_TIERS },
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.participant), [
    "external",
    "free",
    "stewarded",
  ]);
  assert.equal(result.instrumentation.access_tier_rejected_count, 1);
});

test("similarity and ungrounded numeric factors cannot produce expected value", () => {
  const highSimilarity = scoreExpectedValue({
    similarity: 1,
    factors: Object.fromEntries(EXPECTED_VALUE_FACTORS.map((factor) => [factor, 1])),
  });
  assert.equal(highSimilarity.expected_value, null);
  assert.equal(highSimilarity.justified, false);
  assert.deepEqual(Object.keys(highSimilarity.factors), EXPECTED_VALUE_FACTORS);
});

test("expected value is the exact product of all five factors", () => {
  const score = scoreExpectedValue({
    similarity: 1,
    factor_evidence: {
      ...factorEvidence(1),
      factors: {
        complementarity: { ...factorEvidence(0.9).factors.complementarity },
        relevance: { ...factorEvidence(0.8).factors.relevance },
        timing: { ...factorEvidence(0.7).factors.timing },
        ability_to_act: { ...factorEvidence(0.6).factors.ability_to_act },
        impact: { ...factorEvidence(0.5).factors.impact },
      },
    },
  });

  assert.equal(score.expected_value, 0.9 * 0.8 * 0.7 * 0.6 * 0.5);
  assert.equal(score.factors.timing, 0.7);
});

test("raw negative numeric factors fail closed instead of multiplying into fake positive value", () => {
  const score = scoreExpectedValue({
    factors: {
      complementarity: -1,
      relevance: -1,
      timing: 1,
      ability_to_act: 1,
      impact: 1,
    },
  });
  assert.equal(score.expected_value, null);
  assert.equal(score.justified, false);
});

test("candidate admission requires pursuit, system, timescale, and state scope", () => {
  const candidate = {
    expected_value: 1,
    factors: Object.fromEntries(EXPECTED_VALUE_FACTORS.map((factor) => [factor, 1])),
    factor_evidence: factorEvidence(1),
    scope: { pursuit_ref: "p", system_ref: "s", timescale_ref: "t" },
  };
  assert.deepEqual(expectedValueAdmission(candidate, { require_scope: true }), {
    admitted: false,
    reason: "needle_mover_scope_missing",
  });
  assert.equal(expectedValueAdmission({ ...candidate, scope: SCOPE }, { require_scope: true }).admitted, true);
});

test("missing factor evidence is rejected instead of grouped at zero", () => {
  const result = buildCandidates([{
    subject: "subject",
    shortlist: [{ participant: "candidate", access_tier: ACCESS_TIERS[0] }],
  }], {
    shortlist_size: 1,
    eligibility: { access_tiers: ACCESS_TIERS },
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.instrumentation.missing_evidence_rejected_count, 1);
  assert.equal(result.rejections[0].status, "no_justified_match");
});
