// Profiles from answers and connected facts, and assessments that must cite them. Carried from the original package's
// intake-evidence tests (six cases), with its question contract replaced by a made-up bakers' circle contract given
// as input, which is the point: the questions, factors and citations are the program's, not the code's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatchProfile, deriveGroundedFactorEvidence, readContract, validateGroundedFactorEvidence } from '../read-data/match-evidence.mjs';

const CONTRACT = Object.freeze({
  factors: ['fit', 'timing', 'capacity'],
  primitives: ['goal', 'state', 'skill', 'time', 'consent'],
  scope_fields: ['goal_ref', 'horizon_ref'],
  questions: [
    { question_id: 'goal', claim_kinds: ['scope.goal'], primitive_ids: ['goal'], scope_field: 'goal_ref' },
    { question_id: 'horizon', claim_kinds: ['scope.horizon'], primitive_ids: ['time'], scope_field: 'horizon_ref' },
    { question_id: 'need', claim_kinds: ['need.missing'], primitive_ids: ['state'] },
    { question_id: 'offer', claim_kinds: ['skill.offered', 'skill.proof'], primitive_ids: ['skill'] },
    { question_id: 'hours', claim_kinds: ['time.available'], primitive_ids: ['time'] },
    { question_id: 'allowed', claim_kinds: ['authority.allowed_help'], primitive_ids: ['consent'] },
    { question_id: 'forbidden', claim_kinds: ['authority.forbidden_help'], primitive_ids: ['consent'] },
    { question_id: 'assignment', claim_kinds: ['authority.assignment'], primitive_ids: ['consent'] },
  ],
  citation_requirements: {
    fit: [{ side: 'subject', any_of: ['need.missing'] }, { side: 'candidate', any_of: ['skill.offered'] }],
    timing: [{ side: 'subject', any_of: ['scope.horizon'] }, { side: 'candidate', any_of: ['time.available'] }],
    capacity: [{ side: 'candidate', any_of: ['skill.proof'] }, { side: 'candidate', any_of: ['authority.assignment'] }],
  },
  authority: [
    { name: 'desired_interventions', claim_kind: 'authority.allowed_help', list: true },
    { name: 'forbidden_interventions', claim_kind: 'authority.forbidden_help', list: true },
    { name: 'assignment_level', claim_kind: 'authority.assignment' },
  ],
  forbidden_interventions: 'forbidden_interventions',
});

const answer = (person, questionId, value) => ({ question_id: questionId, answer_fact_ref: `answer:${person}:${questionId}`, value });
function answers(person) {
  const values = {
    goal: 'goal:bake-bread', horizon: 'horizon:this-month', need: 'My loaves come out dense.', offer: 'I teach shaping; my class sold out twice.',
    hours: 'Two mornings a week.', allowed: ['help:bake-together'], forbidden: ['help:post-my-recipes'], assignment: 'prepare-and-ask',
  };
  return CONTRACT.questions.map(question => answer(person, question.question_id, values[question.question_id]));
}
const claim = (person, questionId, kind) => `answer:${person}:${questionId}#${kind}`;
const evidence = (person, questionId) => `answer:${person}:${questionId}`;
const assessment = (factor, subjectClaims, candidateClaims, evidenceRefs) => ({
  factor, score: 0.8, rationale: `${factor} rests on the cited claims.`, inference_ref: `inference:match:${factor}`,
  subject_claim_refs: subjectClaims, candidate_claim_refs: candidateClaims, evidence_refs: evidenceRefs,
});
const PROOF = 'source-fact:recipe-site:class-reviews#skill.proof';
const PROOF_EVIDENCE = 'evidence:recipe-site:review-17';
function groundedAssessments() {
  return [
    assessment('fit', [claim('subject', 'need', 'need.missing')], [claim('candidate', 'offer', 'skill.offered')], [evidence('subject', 'need'), evidence('candidate', 'offer')]),
    assessment('timing', [claim('subject', 'horizon', 'scope.horizon')], [claim('candidate', 'hours', 'time.available')], [evidence('subject', 'horizon'), evidence('candidate', 'hours')]),
    assessment('capacity', [], [PROOF, claim('candidate', 'assignment', 'authority.assignment')], [PROOF_EVIDENCE, evidence('candidate', 'assignment')]),
  ];
}
function connectedFacts() {
  return [{
    fact_ref: 'source-fact:recipe-site:class-reviews',
    claim_kinds: ['skill.proof'],
    value: 'Seventeen reviews of the shaping class, all after the class ran.',
    evidence_refs: [PROOF_EVIDENCE],
    source: {
      kind: 'recipe-site', connection_ref: 'connection:recipe-site:candidate', access_lease_ref: 'lease:recipe-site:candidate:reviews',
      consent_ref: 'consent:candidate:recipe-site:match-evidence', observed_at: '2026-01-01T12:00:00Z',
      field_scope: ['reviews.count', 'reviews.dates'], expires_at: '2026-01-02T12:00:00Z', revocable: true,
    },
  }];
}
const subjectProfile = () => buildMatchProfile({ participant_ref: 'subject', answer_facts: answers('subject') }, CONTRACT);
const candidateProfile = (facts = connectedFacts()) => buildMatchProfile({ participant_ref: 'candidate', answer_facts: answers('candidate'), connected_source_facts: facts }, CONTRACT);

test('a complete set of answers covers every primitive and one scope', () => {
  const profile = subjectProfile();
  assert.equal(profile.status, 'grounded');
  assert.deepEqual(profile.scope, { goal_ref: 'goal:bake-bread', horizon_ref: 'horizon:this-month' });
  assert.equal(profile.scope_key, 'goal:bake-bread|horizon:this-month');
  assert.deepEqual(Object.keys(profile.primitive_coverage), CONTRACT.primitives);
  assert.ok(Object.values(profile.primitive_coverage).every(coverage => coverage.status === 'grounded'));
  assert.equal(profile.authority.assignment_level, 'prepare-and-ask');
  assert.deepEqual(profile.authority.forbidden_interventions, ['help:post-my-recipes']);
});

test('a connected fact keeps its consent, lease, field scope and expiry, and stays revocable', () => {
  const profile = candidateProfile();
  const proof = profile.claims.find(entry => entry.claim_ref === PROOF);
  assert.equal(profile.status, 'grounded');
  assert.equal(proof.provenance.access_lease_ref, 'lease:recipe-site:candidate:reviews');
  assert.equal(proof.provenance.consent_ref, 'consent:candidate:recipe-site:match-evidence');
  assert.deepEqual(proof.provenance.field_scope, ['reviews.count', 'reviews.dates']);
  assert.equal(proof.provenance.revocable, true);
  assert.ok(proof.evidence_refs.includes(PROOF_EVIDENCE));
});

test('an assessment is usable only when every factor cites what the contract asks', () => {
  const bundle = deriveGroundedFactorEvidence({ subject_profile: subjectProfile(), candidate_profile: candidateProfile(), assessments: groundedAssessments(), proposed_interventions: ['help:bake-together'] }, CONTRACT);
  assert.equal(bundle.status, 'grounded');
  assert.deepEqual(Object.keys(bundle.factors), CONTRACT.factors);
  assert.ok(CONTRACT.factors.every(factor => bundle.factors[factor].status === 'grounded'));
  assert.ok(bundle.factors.capacity.evidence_refs.includes(PROOF_EVIDENCE));
  assert.ok(bundle.factors.fit.evidence_refs.includes('answer:subject:need'));
  assert.equal(validateGroundedFactorEvidence(bundle, CONTRACT.factors).justified, true);
});

test('scores without citations are no justified match', () => {
  const assessments = groundedAssessments().map(entry => ({ ...entry, candidate_claim_refs: [], evidence_refs: [] }));
  const bundle = deriveGroundedFactorEvidence({ subject_profile: subjectProfile(), candidate_profile: candidateProfile([]), assessments, proposed_interventions: ['help:bake-together'] }, CONTRACT);
  assert.equal(bundle.status, 'no_justified_match');
  assert.ok(CONTRACT.factors.every(factor => bundle.factors[factor].status === 'missing'));
  assert.equal(validateGroundedFactorEvidence(bundle, CONTRACT.factors).justified, false);
});

test('a proposal either person forbids blocks every factor', () => {
  const bundle = deriveGroundedFactorEvidence({ subject_profile: subjectProfile(), candidate_profile: candidateProfile(), assessments: groundedAssessments(), proposed_interventions: ['help:post-my-recipes'] }, CONTRACT);
  assert.equal(bundle.status, 'no_justified_match');
  assert.deepEqual(bundle.blockers, [
    { kind: 'forbidden_intervention', party: 'subject', intervention: 'help:post-my-recipes' },
    { kind: 'forbidden_intervention', party: 'candidate', intervention: 'help:post-my-recipes' },
  ]);
});

test('a connected fact without consent and field scope is not evidence', () => {
  const invalid = connectedFacts()[0];
  delete invalid.source.consent_ref;
  delete invalid.source.field_scope;
  const profile = candidateProfile([invalid]);
  assert.equal(profile.status, 'partial');
  assert.ok(profile.problems.some(problem => problem.kind === 'invalid_connected_source_fact'));
  assert.equal(profile.claims.some(entry => entry.provenance.kind === 'connected_source_fact'), false);
});

test('a contract that is missing a part, or names what it does not declare, is refused with what is wrong', () => {
  assert.throws(() => readContract({ ...CONTRACT, factors: [] }), /factors must be a list/);
  assert.throws(() => readContract({ ...CONTRACT, citation_requirements: { fit: [] } }), /citation_requirements\.timing/);
  assert.throws(() => readContract({ ...CONTRACT, forbidden_interventions: 'nothing-like-it' }), /forbidden_interventions must name/);
  assert.throws(() => readContract({ ...CONTRACT, questions: [{ question_id: 'goal', claim_kinds: ['scope.goal'], primitive_ids: ['undeclared'] }] }), /primitive the contract does not list/);
  assert.equal(readContract(CONTRACT), CONTRACT);
});
