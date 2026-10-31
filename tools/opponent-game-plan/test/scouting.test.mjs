// Profiles joined from reports, profiles and tactic outcomes; the search list; the confidence policy (fail closed); the
// context a plan is asked for from, with low-confidence evidence kept out and listed for review; and the plan's shape.
// Everything is made up: two players of an invented game, with ratings and facts in the words of the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAMatchPlan } from '../do-work/prepare-a-match-plan.mjs';
import { scoutAnOpponent } from '../do-work/scout-an-opponent.mjs';
import { profileForSubject, readScoutingState, splitEvidenceByConfidence } from '../read-data/scouting.mjs';

const SHAPE = { strategies: 2, tactics_per_strategy: 3 };
const NOW = '2026-01-01T09:00:00.000Z';

const subject = (subjectId, label, payload = {}) => ({ payload: { kind: 'subject', subjectId, subjectKind: 'player', label, payload, createdAt: NOW } });
const report = (evidenceId, subjectId, visibility, payload = {}, confidence) => ({
  payload: {
    kind: 'evidence', evidenceKind: 'player-report', evidenceId, subject: { id: subjectId, kind: 'player' },
    source: { sourceId: `source:${evidenceId}`, visibility, ...(confidence === undefined ? {} : { confidence }) },
    payload: { authorId: 'coach:1', visibility, styleLabels: [], strengths: [], weaknesses: [], strategiesWorked: [], strategiesFailed: [], ...payload },
    createdAt: NOW,
  },
});
const profile = (profileId, subjectId, payload) => ({ payload: { kind: 'profile-projection', profileId, subject: { id: subjectId, kind: 'player' }, projectionKind: 'zone-profile', source: { sourceId: 's', visibility: 'private' }, sourceRefs: ['s'], payload, createdAt: NOW } });
const outcome = (resultId, outcomeName, tacticId, extra = {}) => ({
  payload: { kind: 'result', resultKind: 'tactic-outcome', resultId, subject: { id: 'p:opp', kind: 'player' }, selfPlayerId: 'p:self', opponentPlayerId: 'p:opp', sourceRefs: [], payload: { planId: 'plan:1', strategyId: 'strategy:1', tacticId, outcome: outcomeName }, createdAt: NOW },
});
const plan = {
  payload: {
    kind: 'result', resultKind: 'match-plan', resultId: 'plan:1', planId: 'plan:1', requestId: 'req:1', selfPlayerId: 'p:self', opponentPlayerId: 'p:opp', evidenceRefs: [], createdAt: NOW,
    strategies: [
      { strategyId: 'strategy:1', name: 'Press early', tactics: [{ tacticId: 'tactic:1', label: 'Take the first move' }, { tacticId: 'tactic:2', label: 'Cut the middle' }, { tacticId: 'tactic:3', label: 'Follow through' }] },
      { strategyId: 'strategy:2', name: 'Wait and counter', tactics: [{ tacticId: 'tactic:4', label: 'Hold the line' }, { tacticId: 'tactic:5', label: 'Answer wide' }, { tacticId: 'tactic:6', label: 'Close the gap' }] },
    ],
  },
};

const seed = () => [
  subject('p:self', 'Alder', { isSelf: true, side: 'right' }),
  subject('p:opp', 'Birch', { side: 'left' }),
  report('ev:self', 'p:self', 'private', { strengths: ['opening'], styleLabels: ['all-round'] }),
  report('ev:opp', 'p:opp', 'public', { strengths: ['opening'], weaknesses: ['late reply'], strategiesWorked: ['Attack the second try'], strategiesFailed: ['Trade blows'], styleLabels: ['all-round'] }),
  profile('profile:self', 'p:self', { strongest: 'opening', weakest: 'late reply', style: 'all-round', ratings: { reach: 82, grip: null, pace: 'fast' } }),
  profile('profile:opp', 'p:opp', { strongest: 'opening', weakest: 'late reply', style: 'all-round', winners: { from: 'B', to: 'D', context: 'short ball after the opener' }, ratings: { reach: 91, pace: 68, stamina: 88 } }),
  plan,
];

const POLICY_ALL = { minimumConfidence: 0, missingConfidenceIsUsable: true };
const POLICY_HALF = { minimumConfidence: 0.5, missingConfidenceIsUsable: false };

test('a profile joins reports, profiles and outcomes without repeats, and keeps public and private reports apart', () => {
  const state = readScoutingState([...seed(), outcome('res:1', 'worked', 'tactic:1'), outcome('res:2', 'failed', 'tactic:2')]);
  const view = profileForSubject(state, 'p:opp');
  assert.deepEqual(view.strengths, ['opening']);
  assert.deepEqual(view.weaknesses, ['late reply']);
  assert.deepEqual(view.styleLabels, ['all-round']);
  assert.deepEqual(view.strategiesWorked, ['Attack the second try', 'Take the first move']);
  assert.deepEqual(view.strategiesFailed, ['Trade blows', 'Cut the middle']);
  assert.deepEqual(view.publicReports.map(item => item.evidenceId), ['ev:opp']);
  assert.deepEqual(view.privateReports, []);
  assert.deepEqual(view.tacticOutcomes.map(item => [item.outcome, item.strategyName, item.tacticLabel]), [['worked', 'Press early', 'Take the first move'], ['failed', 'Press early', 'Cut the middle']]);
});

test('ratings keep only numbers from 0 to 100, with no name needing to be known in advance, and a later profile replaces an earlier one', () => {
  const view = profileForSubject(readScoutingState(seed()), 'p:self');
  assert.deepEqual(view.ratings, { reach: 82 });
  const twice = readScoutingState([...seed(), profile('profile:self-2', 'p:self', { ratings: { reach: 90, balance: 101, focus: 40 } })]);
  assert.deepEqual(profileForSubject(twice, 'p:self').ratings, { reach: 90, focus: 40 });
});

test('the search lists everyone but the person themself, with counts of reports, profiles and outcomes', () => {
  const rows = [...seed(), outcome('res:1', 'worked', 'tactic:1'), outcome('res:2', 'failed', 'tactic:2'), outcome('res:3', 'mixed', 'tactic:3')];
  const { opponents } = scoutAnOpponent({ operation: 'search', rows });
  assert.equal(opponents.length, 1);
  assert.deepEqual(opponents[0], { subjectId: 'p:opp', name: 'Birch', facts: { side: 'left' }, styleLabels: ['all-round'], reportCount: 1, profileCount: 1, workedCount: 1, failedCount: 1 });
});

test('subject_kind keeps only subjects of that kind', () => {
  const rows = [...seed(), { payload: { kind: 'subject', subjectId: 'p:team', subjectKind: 'team', label: 'Elm Club', payload: {}, createdAt: NOW } }];
  assert.equal(scoutAnOpponent({ operation: 'search', rows }).opponents.length, 2);
  assert.deepEqual(scoutAnOpponent({ operation: 'search', rows, subject_kind: 'team' }).opponents.map(item => item.name), ['Elm Club']);
});

test('with no confidence policy nothing is usable: every report waits for review', () => {
  const reports = [report('ev:high', 'p:opp', 'public', {}, 0.85).payload, report('ev:low', 'p:opp', 'public', {}, 0.2).payload];
  assert.deepEqual(splitEvidenceByConfidence(reports, null), { usable: [], needsReview: reports });
  assert.equal(readScoutingState([{ payload: reports[0] }]).policy, null);
});

test('a report with no confidence, or below the minimum, needs review unless the policy trusts a missing one', () => {
  const reports = [report('ev:missing', 'p:opp', 'public').payload, report('ev:low', 'p:opp', 'public', {}, 0.2).payload, report('ev:high', 'p:opp', 'public', {}, 0.85).payload];
  const strict = splitEvidenceByConfidence(reports, POLICY_HALF);
  assert.deepEqual(strict.usable.map(item => item.evidenceId), ['ev:high']);
  assert.deepEqual(strict.needsReview.map(item => item.evidenceId), ['ev:missing', 'ev:low']);
  assert.deepEqual(splitEvidenceByConfidence(reports, { minimumConfidence: 0.5, missingConfidenceIsUsable: true }).usable.map(item => item.evidenceId), ['ev:missing', 'ev:high']);
  const own = report('ev:own', 'p:opp', 'public', { confidence: 0.9 }).payload;
  assert.equal(splitEvidenceByConfidence([own], POLICY_HALF).usable.length, 1);
});

test('a profile answer says which reports the policy from the rows allows', () => {
  const rows = [...seed(), { payload: { kind: 'evidence-confidence-policy', policyId: 'policy:1', ...POLICY_HALF } }];
  assert.deepEqual(scoutAnOpponent({ operation: 'profile', rows, subject_id: 'p:opp' }).evidence, { usable: [], needsReview: ['ev:opp'] });
  assert.deepEqual(scoutAnOpponent({ operation: 'profile', rows, subject_id: 'p:opp', confidence_policy: POLICY_ALL }).evidence, { usable: ['ev:opp'], needsReview: [] });
  assert.throws(() => scoutAnOpponent({ operation: 'profile', rows, subject_id: 'p:nobody' }), /Nothing on file/);
  assert.throws(() => scoutAnOpponent({ operation: 'profile', rows, subject_id: 'p:opp', confidence_policy: { minimumConfidence: 'half' } }), /confidence policy is/);
});

const context = (extra = {}) => prepareAMatchPlan({ operation: 'context', rows: seed(), self_id: 'p:self', opponent_id: 'p:opp', requester_id: 'p:self', plan_shape: SHAPE, request_id: 'req:1', now: NOW, confidence_policy: POLICY_ALL, ...extra }).request_record;

test('the context asks for the shape the person set and lists only facts the evidence holds', () => {
  const withOutcome = prepareAMatchPlan({ operation: 'context', rows: [...seed(), outcome('res:1', 'worked', 'tactic:1')], self_id: 'p:self', opponent_id: 'p:opp', requester_id: 'p:self', plan_shape: SHAPE, request_id: 'req:1', now: NOW, confidence_policy: POLICY_ALL }).request_record;
  const text = withOutcome.promptText;
  assert.ok(text.startsWith('Create exactly 2 strategies with exactly 3 tactics each.'));
  assert.match(text, /Opponent: Birch/);
  assert.match(text, /side: left/);
  assert.match(text, /winners context: short ball after the opener/);
  assert.match(text, /strategies that worked: Attack the second try, Take the first move/);
  assert.match(text, /reach: 91\/100/);
  assert.doesNotMatch(text, /isSelf/);
  assert.doesNotMatch(text, /unknown|undefined|null/);
  assert.equal(withOutcome.kind, 'plan-request');
  assert.equal(withOutcome.requestKind, 'match-plan');
  assert.deepEqual(withOutcome.publicEvidenceRefs, ['ev:opp']);
  assert.deepEqual(withOutcome.privateEvidenceRefs, ['ev:self']);
  assert.deepEqual(withOutcome.reviewEvidenceRefs, []);
  assert.deepEqual(withOutcome.profileRefs, ['profile:self', 'profile:opp']);
  assert.deepEqual(withOutcome.resultRefs, ['res:1']);
  assert.equal(prepareAMatchPlan({ operation: 'context', rows: seed(), self_id: 'p:self', opponent_id: 'p:opp', requester_id: 'p:self', plan_shape: { strategies: 1, tactics_per_strategy: 4 }, confidence_policy: POLICY_ALL }).request_record.promptText.split('\n')[0], 'Create exactly 1 strategies with exactly 4 tactics each.');
});

test('evidence below the policy is left out of the text and listed for review', () => {
  const rows = seed();
  rows[2].payload.source.confidence = 0.85;
  rows[3].payload.source.confidence = 0.2;
  const request = prepareAMatchPlan({ operation: 'context', rows, self_id: 'p:self', opponent_id: 'p:opp', requester_id: 'p:self', plan_shape: SHAPE, request_id: 'req:1', now: NOW, confidence_policy: POLICY_HALF }).request_record;
  assert.deepEqual(request.privateEvidenceRefs, ['ev:self']);
  assert.deepEqual(request.publicEvidenceRefs, []);
  assert.deepEqual(request.reviewEvidenceRefs, ['ev:opp']);
  assert.doesNotMatch(request.promptText, /Attack the second try|Trade blows/);
  assert.match(request.promptText, /strongest: opening/);
});

test('with no policy at all the context holds no report and every report is listed for review', () => {
  const request = prepareAMatchPlan({ operation: 'context', rows: seed(), self_id: 'p:self', opponent_id: 'p:opp', requester_id: 'p:self', plan_shape: SHAPE, now: NOW }).request_record;
  assert.deepEqual(request.reviewEvidenceRefs, ['ev:self', 'ev:opp']);
  assert.match(request.promptText, /^Create exactly 2 strategies/);
  assert.doesNotMatch(request.promptText, /Attack the second try/);
  assert.match(request.requestId, /^plan-request:/);
});

test('the context needs a shape, both sides and a requester', () => {
  assert.throws(() => context({ plan_shape: { strategies: 2 } }), /plan_shape must be/);
  assert.throws(() => context({ plan_shape: undefined }), /plan_shape must be/);
  assert.throws(() => context({ opponent_id: undefined }), /opponent_id is required/);
  assert.throws(() => context({ requester_id: '' }), /requester_id is required/);
  assert.throws(() => prepareAMatchPlan({ operation: 'context', self_id: 'a' }), /rows must be a list/);
  assert.throws(() => prepareAMatchPlan({ operation: 'dance' }), /operation must be/);
});

const strategies = tacticCounts => tacticCounts.map((count, index) => ({
  strategyId: `strategy:${index}`, name: `Strategy ${index}`,
  tactics: Array.from({ length: count }, (_, at) => ({ tacticId: `tactic:${index}.${at}`, label: `Tactic ${index}.${at}` })),
}));
const record = (counts, extra = {}) => prepareAMatchPlan({ operation: 'record-plan', plan_id: 'plan:9', request_id: 'req:9', self_id: 'p:self', opponent_id: 'p:opp', plan_shape: SHAPE, strategies: strategies(counts), now: NOW, ...extra });

test('a plan is recorded only in the shape that was asked for', () => {
  const { plan_record: planRecord } = record([3, 3]);
  assert.equal(planRecord.resultKind, 'match-plan');
  assert.equal(planRecord.planId, 'plan:9');
  assert.equal(planRecord.resultId, 'plan:9');
  assert.deepEqual(planRecord.evidenceRefs, []);
  assert.equal(planRecord.strategies.length, 2);
  assert.throws(() => record([1, 3]), /exactly 3 tactics/);
  assert.throws(() => record([3, 3, 3]), /exactly 2 strategies/);
  assert.throws(() => record([3, 3], { strategies: 'none' }), /exactly 2 strategies/);
  assert.throws(() => record([3, 3], { plan_id: undefined }), /plan_id is required/);
  const unnamed = strategies([3, 3]);
  unnamed[1].tactics[2].label = '';
  assert.throws(() => record([3, 3], { strategies: unnamed }), /tactic needs a tacticId and a label/);
});
