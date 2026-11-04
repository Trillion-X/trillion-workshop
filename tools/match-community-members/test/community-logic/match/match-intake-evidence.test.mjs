// Vendored unchanged except for import paths from bitfield-packages/packages/interaction-program/read-data/match-intake-evidence.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_FACTOR_IDS,
  MATCH_INTAKE_QUESTION_CONTRACT,
  MATCH_PRIMITIVE_IDS,
  buildMatchIntakeProfile,
  deriveGroundedFactorEvidence,
  validateGroundedFactorEvidence,
} from "../../../src/community-logic/match/match-intake-evidence.mjs";

function answer(participant, questionId, value) {
  return {
    question_id: questionId,
    answer_fact_ref: `answer:${participant}:${questionId}`,
    value,
  };
}

function completeAnswers(participant, overrides = {}) {
  const values = {
    "scope.pursuit_ref": "pursuit:ship-useful-product",
    "scope.system_ref": "system:product-delivery",
    "scope.timescale_ref": "timescale:this-week",
    "scope.state_ref": "state:blocked-on-implementation",
    "session.selection": { selected: ["session:friday"], mode: "in-person" },
    "mandate.desired_movement": "Ship one working customer-visible capability.",
    "reality.current_state": "The design exists but the integration is not implemented.",
    "judgment.bottleneck": "A bounded implementation and verification owner is missing.",
    "proof.observable_progress": "A real user completes the flow and the receipt is saved.",
    "reality.prior_attempts": "A prototype rendered but did not persist authoritative state.",
    "capability.offered_with_proof": "I implement workflow integrations; I shipped three with runtime receipts.",
    "resource.offered": ["resource:test-environment"],
    "access.offered": { allowed: ["access:repository-read"], unavailable: ["access:production-write"] },
    "capacity.available": "Sixty focused minutes during the selected session.",
    "continuity.constraints": "No constraints.",
    "authority.desired_interventions": ["intervention:pair-working-session"],
    "authority.forbidden_interventions": ["intervention:publish-without-approval"],
    "authority.assignment_level": "prepare-and-ask",
    "authority.disclosure": { allowed: ["capabilities", "desired-outcome"], forbidden: ["private-source-content"] },
    "authority.veto": "None.",
    "access.contact_consent": { channel: "email", purposes: ["session-coordination"] },
    "continuity.follow_up": true,
    "durable.profile_reuse": "event-only",
    "learning.generalization_consent": true,
    ...overrides,
  };
  return MATCH_INTAKE_QUESTION_CONTRACT.map((question) => answer(participant, question.question_id, values[question.question_id]));
}

function claimRef(participant, questionId, claimKind) {
  return `answer:${participant}:${questionId}#${claimKind}`;
}

function evidenceRef(participant, questionId) {
  return `answer:${participant}:${questionId}`;
}

function assessment(factor, subjectClaimRefs, candidateClaimRefs, evidenceRefs) {
  return {
    factor,
    score: 0.8,
    rationale: `${factor} is supported by the cited scoped claims.`,
    inference_ref: `ai-inference:match:${factor}`,
    subject_claim_refs: subjectClaimRefs,
    candidate_claim_refs: candidateClaimRefs,
    evidence_refs: evidenceRefs,
  };
}

function groundedAssessments() {
  const subject = "subject";
  const candidate = "candidate";
  const candidateCapability = claimRef(candidate, "capability.offered_with_proof", "capability.offered");
  const connectedProof = "source-fact:github:merged-work#capability.proof";
  const connectedEvidence = "evidence:github:pull-request:321";
  return [
    assessment("complementarity", [
      claimRef(subject, "judgment.bottleneck", "judgment.bottleneck"),
    ], [candidateCapability], [
      evidenceRef(subject, "judgment.bottleneck"),
      evidenceRef(candidate, "capability.offered_with_proof"),
    ]),
    assessment("relevance", [
      claimRef(subject, "scope.pursuit_ref", "scope.pursuit"),
      claimRef(subject, "scope.system_ref", "scope.system"),
    ], [candidateCapability, connectedProof], [
      evidenceRef(subject, "scope.pursuit_ref"),
      evidenceRef(subject, "scope.system_ref"),
      evidenceRef(candidate, "capability.offered_with_proof"),
      connectedEvidence,
    ]),
    assessment("timing", [
      claimRef(subject, "scope.timescale_ref", "scope.timescale"),
      claimRef(subject, "session.selection", "continuity.attendance"),
    ], [
      claimRef(candidate, "session.selection", "continuity.attendance"),
      claimRef(candidate, "capacity.available", "capacity.available"),
    ], [
      evidenceRef(subject, "scope.timescale_ref"),
      evidenceRef(subject, "session.selection"),
      evidenceRef(candidate, "session.selection"),
      evidenceRef(candidate, "capacity.available"),
    ]),
    assessment("ability_to_act", [], [
      candidateCapability,
      connectedProof,
      claimRef(candidate, "capacity.available", "capacity.available"),
      claimRef(candidate, "authority.assignment_level", "authority.assignment"),
    ], [
      evidenceRef(candidate, "capability.offered_with_proof"),
      connectedEvidence,
      evidenceRef(candidate, "capacity.available"),
      evidenceRef(candidate, "authority.assignment_level"),
    ]),
    assessment("impact", [
      claimRef(subject, "mandate.desired_movement", "mandate.desired_movement"),
      claimRef(subject, "proof.observable_progress", "proof.observable_progress"),
    ], [candidateCapability, connectedProof], [
      evidenceRef(subject, "mandate.desired_movement"),
      evidenceRef(subject, "proof.observable_progress"),
      evidenceRef(candidate, "capability.offered_with_proof"),
      connectedEvidence,
    ]),
  ];
}

function candidateConnectedFacts() {
  return [{
    fact_ref: "source-fact:github:merged-work",
    claim_kinds: ["capability.proof"],
    value: "Merged pull request 321 changed the workflow integration and passed its checks.",
    evidence_refs: ["evidence:github:pull-request:321"],
    source: {
      kind: "github",
      connection_ref: "service-connection:github:candidate",
      access_lease_ref: "access-lease:github:candidate:read-pulls",
      consent_ref: "consent:candidate:github:match-evidence",
      observed_at: "2026-08-31T12:00:00Z",
      field_scope: ["pull_requests.number", "pull_requests.state", "pull_requests.checks"],
      expires_at: "2026-09-01T12:00:00Z",
      revocable: true,
    },
  }];
}

test("the adaptive intake contract covers all eleven primitives and one scoped pursuit state", () => {
  const profile = buildMatchIntakeProfile({
    participant_ref: "person:subject",
    answer_facts: completeAnswers("subject"),
  });

  assert.equal(profile.status, "grounded");
  assert.deepEqual(profile.scope, {
    pursuit_ref: "pursuit:ship-useful-product",
    system_ref: "system:product-delivery",
    timescale_ref: "timescale:this-week",
    state_ref: "state:blocked-on-implementation",
  });
  assert.deepEqual(Object.keys(profile.primitive_coverage), MATCH_PRIMITIVE_IDS);
  assert.ok(Object.values(profile.primitive_coverage).every((coverage) => coverage.status === "grounded"));
  assert.equal(profile.authority.assignment_level, "prepare-and-ask");
  assert.deepEqual(profile.authority.forbidden_interventions, ["intervention:publish-without-approval"]);
});

test("connected-source facts require field scope, consent, permission lease, expiry provenance, and remain revocable", () => {
  const profile = buildMatchIntakeProfile({
    participant_ref: "person:candidate",
    answer_facts: completeAnswers("candidate"),
    connected_source_facts: candidateConnectedFacts(),
  });
  const proof = profile.claims.find((claim) => claim.claim_ref === "source-fact:github:merged-work#capability.proof");

  assert.equal(profile.status, "grounded");
  assert.equal(proof.provenance.access_lease_ref, "access-lease:github:candidate:read-pulls");
  assert.equal(proof.provenance.consent_ref, "consent:candidate:github:match-evidence");
  assert.deepEqual(proof.provenance.field_scope, ["pull_requests.number", "pull_requests.state", "pull_requests.checks"]);
  assert.equal(proof.provenance.revocable, true);
  assert.ok(proof.evidence_refs.includes("evidence:github:pull-request:321"));
});

test("AI assessments become usable factors only when every factor cites required answer/source evidence", () => {
  const subjectProfile = buildMatchIntakeProfile({
    participant_ref: "person:subject",
    answer_facts: completeAnswers("subject"),
  });
  const candidateProfile = buildMatchIntakeProfile({
    participant_ref: "person:candidate",
    answer_facts: completeAnswers("candidate"),
    connected_source_facts: candidateConnectedFacts(),
  });
  const bundle = deriveGroundedFactorEvidence({
    subject_profile: subjectProfile,
    candidate_profile: candidateProfile,
    assessments: groundedAssessments(),
    proposed_interventions: ["intervention:pair-working-session"],
  });

  assert.equal(bundle.status, "grounded");
  assert.deepEqual(Object.keys(bundle.factors), MATCH_FACTOR_IDS);
  assert.ok(MATCH_FACTOR_IDS.every((factor) => bundle.factors[factor].status === "grounded"));
  assert.ok(bundle.factors.impact.evidence_refs.includes("answer:subject:proof.observable_progress"));
  assert.ok(bundle.factors.impact.evidence_refs.includes("evidence:github:pull-request:321"));
  assert.equal(validateGroundedFactorEvidence(bundle).justified, true);
});

test("invented scores and missing citations fail closed as no justified match", () => {
  const subjectProfile = buildMatchIntakeProfile({
    participant_ref: "person:subject",
    answer_facts: completeAnswers("subject"),
  });
  const candidateProfile = buildMatchIntakeProfile({
    participant_ref: "person:candidate",
    answer_facts: completeAnswers("candidate"),
  });
  const assessments = groundedAssessments().map((entry) => ({
    ...entry,
    candidate_claim_refs: [],
    evidence_refs: [],
  }));
  const bundle = deriveGroundedFactorEvidence({
    subject_profile: subjectProfile,
    candidate_profile: candidateProfile,
    assessments,
    proposed_interventions: ["intervention:pair-working-session"],
  });

  assert.equal(bundle.status, "no_justified_match");
  assert.ok(MATCH_FACTOR_IDS.every((factor) => bundle.factors[factor].status === "missing"));
  assert.equal(validateGroundedFactorEvidence(bundle).justified, false);
});

test("a forbidden proposed intervention blocks every otherwise-grounded factor", () => {
  const subjectProfile = buildMatchIntakeProfile({
    participant_ref: "person:subject",
    answer_facts: completeAnswers("subject"),
  });
  const candidateProfile = buildMatchIntakeProfile({
    participant_ref: "person:candidate",
    answer_facts: completeAnswers("candidate"),
    connected_source_facts: candidateConnectedFacts(),
  });
  const bundle = deriveGroundedFactorEvidence({
    subject_profile: subjectProfile,
    candidate_profile: candidateProfile,
    assessments: groundedAssessments(),
    proposed_interventions: ["intervention:publish-without-approval"],
  });

  assert.equal(bundle.status, "no_justified_match");
  assert.deepEqual(bundle.blockers, [{
    kind: "forbidden_intervention",
    party: "subject",
    intervention: "intervention:publish-without-approval",
  }, {
    kind: "forbidden_intervention",
    party: "candidate",
    intervention: "intervention:publish-without-approval",
  }]);
});

test("a connected fact without explicit consent and least-privilege field scope cannot become evidence", () => {
  const invalidFact = candidateConnectedFacts()[0];
  delete invalidFact.source.consent_ref;
  delete invalidFact.source.field_scope;
  const profile = buildMatchIntakeProfile({
    participant_ref: "person:candidate",
    answer_facts: completeAnswers("candidate"),
    connected_source_facts: [invalidFact],
  });

  assert.equal(profile.status, "partial");
  assert.ok(profile.problems.some((problem) => problem.kind === "invalid_connected_source_fact"));
  assert.equal(profile.claims.some((claim) => claim.provenance.kind === "connected_source_fact"), false);
});

// The intake questions, factors and citation rules are DATA (src/community-logic/match/match-intake-contract.json): the
// leaf reads them from there, so changing a question's words or adding one is an edit to that file, not to code.
test('the intake contract is read from its DATA file', async () => {
  const { readFileSync } = await import('node:fs');
  const contract = JSON.parse(readFileSync(new URL('../../../src/community-logic/match/match-intake-contract.json', import.meta.url), 'utf8'));
  assert.deepEqual([...MATCH_FACTOR_IDS], contract.factor_ids);
  assert.deepEqual(MATCH_INTAKE_QUESTION_CONTRACT.map(question => ({ ...question })), contract.questions);
  const source = readFileSync(new URL('../../../src/community-logic/match/match-intake-evidence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /wording:/, 'no question is written in code');
});
