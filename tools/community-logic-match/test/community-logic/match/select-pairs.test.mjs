// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/read-data/select-pairs.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairKey, priorPairKeys, scopedPairKey, selectPairs } from "../../../src/community-logic/match/select-pairs.mjs";

const SCOPE = Object.freeze({
  pursuit_ref: "pursuit:example",
  system_ref: "system:example",
  timescale_ref: "timescale:now",
  state_ref: "state:current",
});

function numericFactors(expectedValue) {
  return {
    complementarity: expectedValue,
    relevance: 1,
    timing: 1,
    ability_to_act: 1,
    impact: 1,
  };
}

function factorEvidence(expectedValue) {
  const factors = numericFactors(expectedValue);
  return {
    status: "grounded",
    evidence_refs: ["evidence:fixture"],
    factors: Object.fromEntries(Object.entries(factors).map(([factor, score]) => [factor, {
      status: "grounded",
      score,
      evidence_refs: ["evidence:fixture"],
      inference_ref: `inference:fixture:${factor}`,
    }])),
  };
}

const GROUPING = {
  modes: [
    { type: "1:1", min_size: 2, max_size: 2 },
    { type: "small_group", min_size: 3, max_size: 5 },
    { type: "session", min_size: 6, max_size: 100 },
  ],
};

function candidate(subject, participant, expectedValue, extra = {}) {
  return {
    subject,
    participant,
    expected_value: expectedValue,
    factors: numericFactors(expectedValue),
    factor_evidence: factorEvidence(expectedValue),
    evidence_refs: ["evidence:fixture"],
    justification_status: "grounded",
    scope: SCOPE,
    scope_key: "pursuit_ref:pursuit:example|system_ref:system:example|timescale_ref:timescale:now|state_ref:state:current",
    why: `${participant} contributes the missing capability`,
    ...extra,
  };
}

function approvedIntroduction(parties) {
  return {
    initiative: {
      required_level: "introduce",
      pre_authorized_levels: ["prepare", "introduce"],
    },
    consent_policy: {
      approved_values: ["approved"],
      veto_values: ["veto"],
    },
    consents: Object.fromEntries(parties.map((party) => [party, "approved"])),
    introduction: {
      agenda: "Resolve the subject with a concrete exchange of help.",
      next_step: "Confirm a time and owner for the first action.",
    },
  };
}

test("stored connection scope retains every prior pod pair", () => {
  const keys = priorPairKeys([{ payload: {
    members: ["alice", "bob", "carol"],
    attributes: { needle_mover_scope: SCOPE },
  } }]);
  assert.deepEqual(keys, [
    scopedPairKey(SCOPE, "alice", "bob"),
    scopedPairKey(SCOPE, "alice", "carol"),
    scopedPairKey(SCOPE, "bob", "carol"),
  ].sort());
  assert.deepEqual(priorPairKeys([{ members: ["alice", "bob"] }]), []);
});

test("candidate consent lists cannot omit a party or erase a veto", () => {
  for (const consent_party_refs of [[], ["alice"]]) {
    const request = {
      candidates: [candidate("alice", "bob", 0.9, { consent_party_refs })],
      ...approvedIntroduction(["alice"]),
    };
    assert.equal(selectPairs(request).ready_introductions.length, 0);
    request.consents.bob = "veto";
    assert.equal(selectPairs(request).ready_introductions.length, 0);
    request.consents.bob = "approved";
    assert.equal(selectPairs(request).ready_introductions.length, 1);
  }
});

test("ranks by expected value deterministically and never by similarity", () => {
  const candidates = [
    candidate("alice", "bob", 0.95, { retrieval_score: 0.1 }),
    candidate("alice", "carol", 0.30, { retrieval_score: 1 }),
    candidate("carol", "dave", 0.80, { retrieval_score: 0.2 }),
    candidate("carol", "bob", 0.20, { retrieval_score: 0.99 }),
  ];
  const request = {
    candidates,
    pairing: { group_size: 2, grouping: GROUPING },
  };
  const first = selectPairs(request);
  const second = selectPairs({ ...request, candidates: [...candidates].reverse() });

  assert.deepEqual(first.groups.map((group) => group.members), [
    ["alice", "bob"],
    ["carol", "dave"],
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.groups[0].expected_value_aggregation, "minimum_selected_candidate");
  assert.equal(first.groups[0].grouping, "1:1");
});

test("fail-closed on candidates without expected value", () => {
  const result = selectPairs({
    candidates: [
      { subject: "x", participant: "y", score: 1, scope: SCOPE },
      candidate("p", "q", 0.8),
    ],
    pairing: { group_size: 2, grouping: GROUPING },
  });
  assert.deepEqual(result.groups.map((group) => group.members), [["p", "q"]]);
});

test("fail-closed on candidates with a numeric value but no grounded factor evidence", () => {
  const result = selectPairs({
    candidates: [{
      subject: "x",
      participant: "y",
      expected_value: 0.9,
      factors: numericFactors(0.9),
    }],
    pairing: { group_size: 2, grouping: GROUPING },
  });
  assert.deepEqual(result.groups, []);
});

test("prior-cycle exclusions skip the blocked relationship", () => {
  const result = selectPairs({
    candidates: [
      candidate("alice", "bob", 0.95),
      candidate("alice", "carol", 0.70),
    ],
    pairing: { group_size: 2, grouping: GROUPING, exclusion: "prior-cycles" },
    already_matched: [scopedPairKey(SCOPE, "alice", "bob")],
  });
  assert.deepEqual(result.groups[0].members, ["alice", "carol"]);
});

test("grouping output emerges as 1:1, small_group, or session from DATA", () => {
  for (const [groupSize, expected] of [[2, "1:1"], [4, "small_group"], [6, "session"]]) {
    const subject = `subject-${groupSize}`;
    const candidates = Array.from({ length: groupSize - 1 }, (_, index) => (
      candidate(subject, `person-${groupSize}-${index}`, 1 - index / 100)
    ));
    const result = selectPairs({
      candidates,
      pairing: { group_size: groupSize, grouping: GROUPING },
    });
    assert.equal(result.groups[0].members.length, groupSize);
    assert.equal(result.groups[0].grouping, expected);
    assert.equal(result.groups[0].reasoning_request.stage, "after_shortlist");
  }
});

test("prepared multi-party introduction includes agenda, why_each_person, and next_step", () => {
  const parties = ["request-owner", "operator", "specialist"];
  const result = selectPairs({
    candidates: [
      candidate("request-owner", "operator", 0.95),
      candidate("request-owner", "specialist", 0.90),
    ],
    pairing: { group_size: 3, grouping: GROUPING },
    subject_context: { "request-owner": { why: "Owns the outcome and decision." } },
    ...approvedIntroduction(parties),
  });
  const introduction = result.introductions[0];

  assert.equal(introduction.kind, "prepared-multi-party-introduction");
  assert.equal(introduction.grouping, "small_group");
  assert.equal(introduction.agenda, "Resolve the subject with a concrete exchange of help.");
  assert.equal(introduction.why_each_person.length, 3);
  assert.ok(introduction.why_each_person.every((entry) => typeof entry.why === "string"));
  assert.equal(introduction.next_step, "Confirm a time and owner for the first action.");
  assert.equal(introduction.send_gate.status, "ready");
  assert.equal(introduction.send_authorized, true);
});

test("missing consent blocks send", () => {
  const result = selectPairs({
    candidates: [candidate("owner", "helper", 0.9)],
    pairing: { group_size: 2, grouping: GROUPING },
    ...approvedIntroduction(["owner"]),
  });
  assert.equal(result.introductions[0].send_authorized, false);
  assert.ok(result.introductions[0].send_gate.blockers.some((blocker) => (
    blocker.kind === "missing_consent" && blocker.party === "helper"
  )));
});

test("any veto blocks send", () => {
  const request = approvedIntroduction(["owner", "helper"]);
  request.consents.helper = "veto";
  const result = selectPairs({
    candidates: [candidate("owner", "helper", 0.9)],
    pairing: { group_size: 2, grouping: GROUPING },
    ...request,
  });
  assert.equal(result.introductions[0].send_authorized, false);
  assert.ok(result.introductions[0].send_gate.blockers.some((blocker) => blocker.kind === "veto"));
});

test("insufficient pre-authorized initiative blocks send", () => {
  const request = approvedIntroduction(["owner", "helper"]);
  request.initiative.pre_authorized_levels = ["prepare"];
  const result = selectPairs({
    candidates: [candidate("owner", "helper", 0.9)],
    pairing: { group_size: 2, grouping: GROUPING },
    ...request,
  });
  assert.equal(result.introductions[0].send_authorized, false);
  assert.ok(result.introductions[0].send_gate.blockers.some((blocker) => (
    blocker.kind === "insufficient_initiative"
  )));
});

test("bipartite role eligibility remains generic DATA", () => {
  const result = selectPairs({
    candidates: [
      candidate("giver-a", "receiver-a", 0.8, { role: "receiver" }),
      candidate("giver-a", "giver-b", 1, { role: "giver" }),
    ],
    pairing: {
      group_size: 2,
      grouping: GROUPING,
      roles: { bipartite: ["giver", "receiver"] },
    },
    participant_roles: { "giver-a": "giver" },
  });
  assert.deepEqual(result.groups[0].members, ["giver-a", "receiver-a"]);
});

test("zero expected value forms no group", () => {
  const result = selectPairs({
    candidates: [candidate("owner", "helper", 0)],
    pairing: { group_size: 2, grouping: GROUPING },
  });
  assert.equal(result.groups.length, 0);
  assert.deepEqual(result.unmatched_details.map((entry) => entry.reason), [
    "missing_grounded_factor_evidence",
  ]);
});

test("an indistinguishable selection boundary forms no group", () => {
  const result = selectPairs({
    candidates: [
      candidate("owner", "helper-a", 0.8),
      candidate("owner", "helper-b", 0.8),
    ],
    pairing: { group_size: 2, grouping: GROUPING },
  });
  assert.equal(result.groups.length, 0);
  assert.equal(result.unmatched_details[0].reason, "indistinguishable_expected_value");
  assert.equal(result.instrumentation.indistinguishable_subject_count, 1);
});

test("independent scopes advance in parallel unless DATA declares a real participation collision", () => {
  const otherScope = {
    pursuit_ref: "pursuit:other",
    system_ref: "system:other",
    timescale_ref: "timescale:now",
    state_ref: "state:current",
  };
  const candidates = [
    candidate("owner-a", "shared-helper", 0.9),
    candidate("owner-b", "shared-helper", 0.8, { scope: otherScope, scope_key: null }),
  ];
  const parallel = selectPairs({ candidates, pairing: { group_size: 2, grouping: GROUPING } });
  assert.equal(parallel.groups.length, 2);

  const exclusive = selectPairs({
    candidates,
    pairing: { group_size: 2, grouping: GROUPING, exclusive_participation: true },
  });
  assert.equal(exclusive.groups.length, 1);
});

test("selected software or workflow resources carry actionable configuration requests", () => {
  const result = selectPairs({
    candidates: [candidate("outcome", "capability:analysis", 0.9, {
      resource_ref: "capability:analysis",
      resource_kind: "capability",
      action_ref: "action:configure-capability",
      configuration_ref: "configuration:analysis",
      configuration: { input_ref: "state:current" },
      consent_party_refs: ["outcome-owner"],
    })],
    pairing: { group_size: 2, grouping: GROUPING },
    ...approvedIntroduction(["outcome-owner"]),
  });
  assert.deepEqual(result.groups[0].configuration_requests, [{
    resource_ref: "capability:analysis",
    action_ref: "action:configure-capability",
    configuration_ref: "configuration:analysis",
    configuration: { input_ref: "state:current" },
  }]);
  assert.deepEqual(result.introductions[0].consent_parties, ["capability:analysis", "outcome", "outcome-owner"]);
  assert.equal(result.ready_introductions.length, 0);
});
