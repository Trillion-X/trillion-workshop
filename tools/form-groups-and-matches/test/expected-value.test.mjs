// Bounded shortlists and the exact product of grounded factors. Carried from the original package's bounded-candidate
// tests (nine cases); its access tiers and five factors are replaced by the made-up program's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, expectedValueAdmission, scoreExpectedValue } from '../read-data/expected-value.mjs';
import { selectGroups } from '../read-data/select-groups.mjs';
import { FACTORS, POLICY, SCOPE } from './match-fixtures.mjs';

const TIERS = ['guest', 'member', 'steward'];

// Every factor at the same score.
function evidenceAt(value) {
  return {
    status: 'grounded',
    evidence_refs: ['evidence:fixture'],
    factors: Object.fromEntries(FACTORS.map(factor => [factor, { status: 'grounded', score: value, evidence_refs: ['evidence:fixture'], inference_ref: `inference:fixture:${factor}` }])),
  };
}
const build = (rows, config) => buildCandidates(rows, { expected_value: POLICY, ...config });

test('work is at most subjects x the shortlist size', () => {
  const row = (subject, values) => ({ subject, scope: SCOPE, corpus_size: 1000, shortlist: values.map((value, index) => ({ participant: `${subject}-${index}`, access_tier: TIERS[index], factor_evidence: evidenceAt(value) })) });
  const result = build([row('subject-a', [0.9, 0.8, 0.7]), row('subject-b', [0.6, 0.5, 0.4])], { shortlist_size: 2, eligibility: { access_tiers: TIERS } });
  assert.equal(result.candidates.length, 4);
  assert.equal(result.instrumentation.subject_count, 2);
  assert.equal(result.instrumentation.shortlist_evaluation_count, 4);
  assert.equal(result.instrumentation.max_bounded_evaluations, 4);
  assert.equal(result.instrumentation.all_pairs_evaluation_count, 0);
  assert.equal(result.instrumentation.expensive_reasoning_count, 0);
});

test('a larger pool does not add work', () => {
  const rows = corpus => Array.from({ length: 12 }, (_, index) => ({
    subject: `subject-${index}`, scope: SCOPE, corpus_size: corpus,
    shortlist: Array.from({ length: 20 }, (__, at) => ({ participant: `candidate-${index}-${at}`, access_tier: TIERS[at % TIERS.length], factor_evidence: evidenceAt(1 - at / 100) })),
  }));
  const config = { shortlist_size: 5, eligibility: { access_tiers: TIERS } };
  const small = build(rows(100), config);
  const large = build(rows(1_000_000), config);
  assert.equal(small.instrumentation.shortlist_evaluation_count, 60);
  assert.equal(large.instrumentation.shortlist_evaluation_count, 60);
  assert.equal(large.instrumentation.expected_value_evaluation_count, 60);
  assert.equal(large.instrumentation.all_pairs_evaluation_count, 0);
});

test('grounded factors beat similarity', () => {
  const ready = evidenceAt(1);
  ready.factors.timing = { ...evidenceAt(0.9).factors.timing };
  const built = build([{
    subject: 'need-owner', scope: SCOPE,
    shortlist: [
      { participant: 'similar-but-unavailable', access_tier: TIERS[0], similarity: 0.99, factor_evidence: evidenceAt(0.01) },
      { participant: 'different-and-ready', access_tier: TIERS[2], similarity: 0.2, factor_evidence: ready },
    ],
  }], { shortlist_size: 2, eligibility: { access_tiers: TIERS } });
  const selected = selectGroups({ expected_value: POLICY, candidates: built.candidates, pairing: { group_size: 2, grouping: { modes: [{ type: '1:1', min_size: 2, max_size: 2 }] } } });
  assert.deepEqual(selected.groups[0].members, ['different-and-ready', 'need-owner']);
  assert.equal(selected.groups[0].selected_shortlist[0].participant, 'different-and-ready');
});

test('access tiers are data, and every listed tier is honoured', () => {
  const result = build([{
    subject: 'subject', scope: SCOPE,
    shortlist: [
      { participant: 'guest', access_tier: 'guest', factor_evidence: evidenceAt(0.9) },
      { participant: 'member', access_tier: 'member', factor_evidence: evidenceAt(0.8) },
      { participant: 'steward', access_tier: 'steward', factor_evidence: evidenceAt(0.7) },
      { participant: 'blocked', access_tier: 'unlisted-tier', factor_evidence: evidenceAt(1) },
    ],
  }], { shortlist_size: 4, eligibility: { access_tiers: TIERS } });
  assert.deepEqual(result.candidates.map(candidate => candidate.participant), ['guest', 'member', 'steward']);
  assert.equal(result.instrumentation.access_tier_rejected_count, 1);
});

test('similarity and bare numbers give no value', () => {
  const score = scoreExpectedValue({ similarity: 1, factors: Object.fromEntries(FACTORS.map(factor => [factor, 1])) }, POLICY);
  assert.equal(score.expected_value, null);
  assert.equal(score.justified, false);
  assert.deepEqual(Object.keys(score.factors), FACTORS);
});

test('the value is the exact product of the factors', () => {
  const evidence = evidenceAt(1);
  evidence.factors = { fit: { ...evidenceAt(0.9).factors.fit }, timing: { ...evidenceAt(0.7).factors.timing }, capacity: { ...evidenceAt(0.5).factors.capacity } };
  const score = scoreExpectedValue({ similarity: 1, factor_evidence: evidence }, POLICY);
  assert.equal(score.expected_value, 0.9 * 0.7 * 0.5);
  assert.equal(score.factors.timing, 0.7);
});

test('negative bare numbers do not multiply into a positive value', () => {
  const score = scoreExpectedValue({ factors: { fit: -1, timing: -1, capacity: 1 } }, POLICY);
  assert.equal(score.expected_value, null);
  assert.equal(score.justified, false);
});

test('when the program requires a scope, every scope field must be there', () => {
  const candidate = { expected_value: 1, factor_evidence: evidenceAt(1), scope: { goal_ref: 'goal:bake-bread' } };
  assert.deepEqual(expectedValueAdmission(candidate, { ...POLICY, require_scope: true }), { admitted: false, reason: 'scope_missing' });
  assert.equal(expectedValueAdmission({ ...candidate, scope: SCOPE }, { ...POLICY, require_scope: true }).admitted, true);
});

test('a candidate with no factor evidence is refused, not grouped at zero', () => {
  const result = build([{ subject: 'subject', shortlist: [{ participant: 'candidate', access_tier: TIERS[0] }] }], { shortlist_size: 1, eligibility: { access_tiers: TIERS } });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.instrumentation.missing_evidence_rejected_count, 1);
  assert.equal(result.rejections[0].status, 'no_justified_match');
});

test('a shortlist without its size is refused', () => {
  assert.throws(() => build([], {}), /shortlist_size/);
});
