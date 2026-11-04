// Vendored from bitfield-packages/packages/interaction-program/tests/matchmaker-gauntlet.test.mjs; only import paths changed (and the select-pairs-cli process mount test dropped, since Trillion forms introductions in src/community-matching.mjs instead of a process mount).
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPECTED_VALUE_FACTORS,
  buildCandidates,
  scoreExpectedValue,
} from "../../../../match-community-members/src/community-logic/match/bounded-candidates.mjs";
import { pairKey, selectPairs } from "../../../src/community-logic/match/select-pairs.mjs";

const GROUPING = {
  modes: [
    { type: "one-to-one", min_size: 2, max_size: 2 },
    { type: "working-configuration", min_size: 3, max_size: 64 },
  ],
};

function groundedFactorEvidence(value = 1) {
  const factorScores = {
    complementarity: value,
    relevance: 1,
    timing: 1,
    ability_to_act: 1,
    impact: 1,
  };
  return {
    status: "grounded",
    evidence_refs: ["evidence:gauntlet-fixture"],
    factors: Object.fromEntries(Object.entries(factorScores).map(([factor, score]) => [factor, {
      status: "grounded",
      score,
      evidence_refs: ["evidence:gauntlet-fixture"],
      inference_ref: `inference:gauntlet-fixture:${factor}`,
    }])),
  };
}

const SCOPE = Object.freeze({
  pursuit_ref: "pursuit:gauntlet",
  system_ref: "system:gauntlet",
  timescale_ref: "timescale:current",
  state_ref: "state:current",
});

function candidate(subject, participant, expectedValue, extra = {}) {
  return {
    subject,
    participant,
    expected_value: expectedValue,
    factors: {
      complementarity: expectedValue,
      relevance: 1,
      timing: 1,
      ability_to_act: 1,
      impact: 1,
    },
    factor_evidence: groundedFactorEvidence(expectedValue),
    evidence_refs: ["evidence:gauntlet-fixture"],
    justification_status: "grounded",
    scope: SCOPE,
    why: `${participant} supplies independently evidenced value`,
    ...extra,
  };
}

function approvedRequest(parties) {
  return {
    initiative: {
      required_level: "coordinate",
      pre_authorized_levels: ["coordinate"],
    },
    consent_policy: {
      approved_values: ["approved"],
      veto_values: ["veto", "blocked"],
      require_every_party: true,
    },
    consents: Object.fromEntries(parties.map((party) => [party, "approved"])),
  };
}

test("UNIT / FAIL-CLOSED: one missing grounded expected-value factor produces no score", () => {
  for (const missing of EXPECTED_VALUE_FACTORS) {
    const factorEvidence = groundedFactorEvidence(0.8);
    delete factorEvidence.factors[missing];
    const result = scoreExpectedValue({ factor_evidence: factorEvidence });
    assert.equal(result.expected_value, null);
    assert.equal(result.justified, false);
  }
});

test("INTEGRATION / FAIL-CLOSED: all-zero evidence produces no group, connection, or reasoning request", () => {
  const built = buildCandidates([{
    subject: "pursuit:business:current",
    scope: SCOPE,
    shortlist: [
      { participant: "person:a", factor_evidence: groundedFactorEvidence(0), retrieval_score: 1 },
      { participant: "person:b", factor_evidence: groundedFactorEvidence(0), retrieval_score: 0.99 },
    ],
  }], { shortlist_size: 2 });
  const result = selectPairs({
    candidates: built.candidates,
    pairing: { group_size: 2, grouping: GROUPING },
  });

  assert.deepEqual(result.groups, [], "zero evidence must not be converted into a tie-break match");
  assert.deepEqual(result.introductions, []);
  assert.equal(result.instrumentation.expensive_reasoning_requests, 0);
});

test("INTEGRATION / FAIL-CLOSED: missing-factor retrieval rows produce no group", () => {
  const built = buildCandidates([{
    subject: "person:subject",
    scope: SCOPE,
    shortlist: [
      {
        participant: "person:retrieval-winner",
        retrieval_score: 1,
        factor_evidence: (() => {
          const evidence = groundedFactorEvidence(1);
          delete evidence.factors.ability_to_act;
          return evidence;
        })(),
      },
    ],
  }], { shortlist_size: 1 });
  assert.deepEqual(built.candidates, []);
  assert.equal(built.rejections[0].status, "no_justified_match");
  assert.deepEqual(selectPairs({
    candidates: built.candidates,
    pairing: { group_size: 2, grouping: GROUPING },
  }).groups, []);
});

test("CONFORMANCE / SCALING: shortlist access stays subject x configured bound", () => {
  const subjectCount = 2_000;
  const shortlistSize = 7;
  let numericReads = 0;
  const rows = Array.from({ length: subjectCount }, (_, subjectIndex) => {
    const raw = Array.from({ length: 100 }, (_, candidateIndex) => ({
      participant: `candidate:${subjectIndex}:${candidateIndex}`,
      factor_evidence: groundedFactorEvidence(0.8),
    }));
    const shortlist = new Proxy(raw, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          numericReads += 1;
          assert.ok(Number(property) < shortlistSize, "matcher read beyond the configured shortlist");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return { subject: `subject:${subjectIndex}`, scope: SCOPE, corpus_size: 100_000_000, shortlist };
  });

  const started = performance.now();
  const result = buildCandidates(rows, { shortlist_size: shortlistSize });
  const elapsedMs = performance.now() - started;

  assert.equal(result.instrumentation.expected_value_evaluation_count, subjectCount * shortlistSize);
  assert.equal(result.instrumentation.max_bounded_evaluations, subjectCount * shortlistSize);
  assert.equal(result.instrumentation.all_pairs_evaluation_count, 0);
  assert.equal(numericReads, subjectCount * shortlistSize);
  assert.ok(elapsedMs < 5_000, `bounded 14k evaluation benchmark took ${elapsedMs.toFixed(1)}ms`);
});

test("CONFORMANCE: production matcher contains no all-pairs or persona-specific branch", () => {
  const source = [
    "../../../../match-community-members/src/community-logic/match/bounded-candidates.mjs",
    "../../../src/community-logic/match/select-pairs.mjs",
  ].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(source, /every unordered pair|Math\.random\s*\(|cosine|similarity/i);
  assert.doesNotMatch(
    source,
    /(?:if|switch)\s*\([^\n]*(?:founder|doctor|mother|athlete|salesperson|minister|lee|ben|jibran)/i,
  );
});

test("ADVERSARIAL: similarity/retrieval cannot override a smaller positive expected value", () => {
  const result = selectPairs({
    candidates: [
      candidate("owner", "similar-but-low-value", 0.01, { retrieval_score: 1, similarity: 1 }),
      candidate("owner", "complementary-and-ready", 0.7, { retrieval_score: 0, similarity: 0 }),
    ],
    pairing: { group_size: 2, grouping: GROUPING },
  });
  assert.deepEqual(result.groups[0].members, ["complementary-and-ready", "owner"]);
});

test("ADVERSARIAL / INDEPENDENT PARTIES: duplicate evidence rows cannot duplicate one person in a group", () => {
  const result = selectPairs({
    candidates: [
      candidate("owner", "helper", 0.9),
      candidate("owner", "helper", 0.8),
      candidate("owner", "other-helper", 0.7),
    ],
    pairing: { group_size: 3, grouping: GROUPING },
  });
  assert.equal(new Set(result.groups[0].members).size, result.groups[0].members.length);
  assert.deepEqual(result.groups[0].members, ["helper", "other-helper", "owner"]);
});

test("SECURITY / IDENTITY: pair keys are collision-free for hostile delimiter-bearing identities", () => {
  assert.notEqual(
    pairKey("person:a|person:b", "person:c"),
    pairKey("person:a", "person:b|person:c"),
    "two independent pairs must never collapse to one exclusion key",
  );
});

test("SECURITY / CONSENT: inherited prototype values never count as explicit party consent", () => {
  const consents = Object.create({ owner: "approved", helper: "approved" });
  const result = selectPairs({
    candidates: [candidate("owner", "helper", 0.9)],
    pairing: { group_size: 2, grouping: GROUPING },
    ...approvedRequest([]),
    consents,
  });
  assert.equal(result.ready_introductions.length, 0);
  assert.equal(result.blocked_introductions.length, 1);
  assert.ok(result.blocked_introductions[0].send_gate.blockers.every((blocker) => (
    blocker.kind === "missing_consent"
  )));
});

test("SECURITY / CONSENT: veto, missing consent, and missing initiative each fail closed", () => {
  const base = {
    candidates: [candidate("owner", "helper", 0.9)],
    pairing: { group_size: 2, grouping: GROUPING },
  };
  const veto = approvedRequest(["owner", "helper"]);
  veto.consents.helper = "veto";
  const missing = approvedRequest(["owner"]);
  const noInitiative = approvedRequest(["owner", "helper"]);
  noInitiative.initiative.pre_authorized_levels = [];

  for (const request of [veto, missing, noInitiative]) {
    const result = selectPairs({ ...base, ...request });
    assert.equal(result.ready_introductions.length, 0);
    assert.equal(result.blocked_introductions.length, 1);
    assert.equal(result.blocked_introductions[0].send_authorized, false);
  }
});

test("PROPERTY / GENERIC CONFIG: every DATA-selected group size from 2 through 64 emerges without a branch", () => {
  for (let groupSize = 2; groupSize <= 64; groupSize += 1) {
    const subject = `subject:${groupSize}`;
    const result = selectPairs({
      candidates: Array.from({ length: groupSize - 1 }, (_, index) => (
        candidate(subject, `party:${groupSize}:${index}`, 1 - index / 1000)
      )),
      pairing: {
        group_size: groupSize,
        minimum_group_size: groupSize,
        grouping: GROUPING,
      },
    });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].members.length, groupSize);
  }
});

test("FUZZ / SCORE: 10,000 arbitrary missing/non-finite grounded factor records never gain value", () => {
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const poison = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1", {}, []];
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const evidence = groundedFactorEvidence(0.1 + random() * 0.9);
    const missing = EXPECTED_VALUE_FACTORS[Math.floor(random() * EXPECTED_VALUE_FACTORS.length)];
    evidence.factors[missing] = poison[Math.floor(random() * poison.length)];
    const scored = scoreExpectedValue({ factor_evidence: evidence });
    assert.equal(scored.expected_value, null, `iteration ${iteration} admitted ${missing}`);
    assert.equal(scored.justified, false);
  }
});

test("GOLDEN / DETERMINISM: replay and hostile persona labels produce byte-identical output", () => {
  const hostileNames = [
    "founder", "doctor", "mother", "athlete", "salesperson", "minister",
    "Lee\nDROP TABLE", "Ben<script>", "💥|person", "__proto__",
  ];
  const subject = "person:ordinary-independent-party";
  const candidates = hostileNames.map((name, index) => (
    candidate(subject, name, 0.99 - index / 100, { retrieval_score: index / 100 })
  ));
  const request = {
    candidates,
    pairing: { group_size: 5, grouping: GROUPING },
    ...approvedRequest([subject, ...hostileNames]),
  };
  const expected = JSON.stringify(selectPairs(request));
  for (let replay = 0; replay < 100; replay += 1) {
    const rotated = candidates.slice(replay % candidates.length)
      .concat(candidates.slice(0, replay % candidates.length));
    assert.equal(JSON.stringify(selectPairs({ ...request, candidates: rotated })), expected);
  }
});
