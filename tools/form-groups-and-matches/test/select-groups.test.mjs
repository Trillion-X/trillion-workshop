// Groups formed by expected value, never by similarity, and introductions that wait for consent. Carried from the
// original package's selection tests (sixteen cases), on the made-up program in match-fixtures.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priorPairKeys, scopedPairKey, selectGroups } from '../read-data/select-groups.mjs';
import { approvedIntroduction, candidate, factorScores, GROUPING, OTHER_SCOPE, POLICY, SCOPE, scopeKeyOf } from './match-fixtures.mjs';

const select = request => selectGroups({ expected_value: POLICY, ...request });

test('stored connections keep every pair of a past group in its scope', () => {
  const keys = priorPairKeys([{ payload: { members: ['alice', 'bob', 'carol'], attributes: { scope: SCOPE } } }], POLICY);
  assert.deepEqual(keys, [
    scopedPairKey(SCOPE, 'alice', 'bob', POLICY), scopedPairKey(SCOPE, 'alice', 'carol', POLICY), scopedPairKey(SCOPE, 'bob', 'carol', POLICY),
  ].sort());
  assert.deepEqual(priorPairKeys([{ members: ['alice', 'bob'] }], POLICY), []);
});

test('a candidate\'s consent list cannot leave out a party or erase a veto', () => {
  for (const consent_party_refs of [[], ['alice']]) {
    const request = { candidates: [candidate('alice', 'bob', 0.9, { consent_party_refs })], ...approvedIntroduction(['alice']) };
    assert.equal(select(request).ready_introductions.length, 0);
    request.consents.bob = 'veto';
    assert.equal(select(request).ready_introductions.length, 0);
    request.consents.bob = 'approved';
    assert.equal(select(request).ready_introductions.length, 1);
  }
});

test('groups follow expected value, the same whatever the input order, and never similarity', () => {
  const candidates = [
    candidate('alice', 'bob', 0.95, { retrieval_score: 0.1 }),
    candidate('alice', 'carol', 0.30, { retrieval_score: 1 }),
    candidate('carol', 'dave', 0.80, { retrieval_score: 0.2 }),
    candidate('carol', 'bob', 0.20, { retrieval_score: 0.99 }),
  ];
  const request = { candidates, pairing: { group_size: 2, grouping: GROUPING } };
  const first = select(request);
  assert.deepEqual(first.groups.map(group => group.members), [['alice', 'bob'], ['carol', 'dave']]);
  assert.deepEqual(first, select({ ...request, candidates: [...candidates].reverse() }));
  assert.equal(first.groups[0].expected_value_aggregation, 'minimum_selected_candidate');
  assert.equal(first.groups[0].grouping, '1:1');
});

test('a candidate without an expected value joins no group', () => {
  const result = select({ candidates: [{ subject: 'x', participant: 'y', score: 1, scope: SCOPE }, candidate('p', 'q', 0.8)], pairing: { group_size: 2, grouping: GROUPING } });
  assert.deepEqual(result.groups.map(group => group.members), [['p', 'q']]);
});

test('a number without grounded factor evidence joins no group', () => {
  const result = select({ candidates: [{ subject: 'x', participant: 'y', expected_value: 0.9, factors: factorScores(0.9) }], pairing: { group_size: 2, grouping: GROUPING } });
  assert.deepEqual(result.groups, []);
});

test('a pair already met in this scope is skipped', () => {
  const result = select({
    candidates: [candidate('alice', 'bob', 0.95), candidate('alice', 'carol', 0.70)],
    pairing: { group_size: 2, grouping: GROUPING, exclusion: 'prior-cycles' },
    already_matched: [scopedPairKey(SCOPE, 'alice', 'bob', POLICY)],
  });
  assert.deepEqual(result.groups[0].members, ['alice', 'carol']);
});

test('a pair, a small group or a session comes from the pairing data alone', () => {
  for (const [groupSize, expected] of [[2, '1:1'], [4, 'small_group'], [6, 'session']]) {
    const subject = `subject-${groupSize}`;
    const candidates = Array.from({ length: groupSize - 1 }, (_, index) => candidate(subject, `person-${groupSize}-${index}`, 1 - index / 100));
    const result = select({ candidates, pairing: { group_size: groupSize, grouping: GROUPING } });
    assert.equal(result.groups[0].members.length, groupSize);
    assert.equal(result.groups[0].grouping, expected);
    assert.equal(result.groups[0].reasoning_request.stage, 'after_shortlist');
  }
});

test('a prepared introduction has an agenda, why each person is there, and a next step', () => {
  const parties = ['host', 'miller', 'oven-keeper'];
  const result = select({
    candidates: [candidate('host', 'miller', 0.95), candidate('host', 'oven-keeper', 0.90)],
    pairing: { group_size: 3, grouping: GROUPING },
    subject_context: { host: { why: 'Owns the stall and the decision.' } },
    ...approvedIntroduction(parties),
  });
  const introduction = result.introductions[0];
  assert.equal(introduction.kind, 'prepared-multi-party-introduction');
  assert.equal(introduction.grouping, 'small_group');
  assert.equal(introduction.agenda, 'Bake one loaf together and compare notes.');
  assert.equal(introduction.why_each_person.length, 3);
  assert.ok(introduction.why_each_person.every(entry => typeof entry.why === 'string'));
  assert.equal(introduction.next_step, 'Pick a morning and who brings the starter.');
  assert.equal(introduction.send_gate.status, 'ready');
  assert.equal(introduction.send_authorized, true);
});

test('a missing consent holds the introduction', () => {
  const result = select({ candidates: [candidate('owner', 'helper', 0.9)], pairing: { group_size: 2, grouping: GROUPING }, ...approvedIntroduction(['owner']) });
  assert.equal(result.introductions[0].send_authorized, false);
  assert.ok(result.introductions[0].send_gate.blockers.some(blocker => blocker.kind === 'missing_consent' && blocker.party === 'helper'));
});

test('any veto holds the introduction', () => {
  const request = approvedIntroduction(['owner', 'helper']);
  request.consents.helper = 'veto';
  const result = select({ candidates: [candidate('owner', 'helper', 0.9)], pairing: { group_size: 2, grouping: GROUPING }, ...request });
  assert.equal(result.introductions[0].send_authorized, false);
  assert.ok(result.introductions[0].send_gate.blockers.some(blocker => blocker.kind === 'veto'));
});

test('an initiative that was not pre-authorized holds the introduction', () => {
  const request = approvedIntroduction(['owner', 'helper']);
  request.initiative.pre_authorized_levels = ['prepare'];
  const result = select({ candidates: [candidate('owner', 'helper', 0.9)], pairing: { group_size: 2, grouping: GROUPING }, ...request });
  assert.equal(result.introductions[0].send_authorized, false);
  assert.ok(result.introductions[0].send_gate.blockers.some(blocker => blocker.kind === 'insufficient_initiative'));
});

test('two-sided roles are only data', () => {
  const result = select({
    candidates: [candidate('giver-a', 'receiver-a', 0.8, { role: 'receiver' }), candidate('giver-a', 'giver-b', 1, { role: 'giver' })],
    pairing: { group_size: 2, grouping: GROUPING, roles: { bipartite: ['giver', 'receiver'] } },
    participant_roles: { 'giver-a': 'giver' },
  });
  assert.deepEqual(result.groups[0].members, ['giver-a', 'receiver-a']);
});

test('a zero expected value forms no group', () => {
  const result = select({ candidates: [candidate('owner', 'helper', 0)], pairing: { group_size: 2, grouping: GROUPING } });
  assert.equal(result.groups.length, 0);
  assert.deepEqual(result.unmatched_details.map(entry => entry.reason), ['missing_grounded_factor_evidence']);
});

test('a cut between equal values forms no group', () => {
  const result = select({ candidates: [candidate('owner', 'helper-a', 0.8), candidate('owner', 'helper-b', 0.8)], pairing: { group_size: 2, grouping: GROUPING } });
  assert.equal(result.groups.length, 0);
  assert.equal(result.unmatched_details[0].reason, 'indistinguishable_expected_value');
  assert.equal(result.instrumentation.indistinguishable_subject_count, 1);
});

test('separate scopes go ahead side by side unless participation is declared exclusive', () => {
  const candidates = [candidate('owner-a', 'shared-helper', 0.9), candidate('owner-b', 'shared-helper', 0.8, { scope: OTHER_SCOPE, scope_key: null })];
  assert.equal(select({ candidates, pairing: { group_size: 2, grouping: GROUPING } }).groups.length, 2);
  assert.equal(select({ candidates, pairing: { group_size: 2, grouping: GROUPING, exclusive_participation: true } }).groups.length, 1);
});

test('a chosen tool or workflow carries its configuration request, and its owner must consent too', () => {
  const result = select({
    candidates: [candidate('outcome', 'capability:proofing-timer', 0.9, {
      resource_ref: 'capability:proofing-timer', resource_kind: 'capability', action_ref: 'action:set-timer',
      configuration_ref: 'configuration:proofing', configuration: { minutes: 'from-recipe' }, consent_party_refs: ['outcome-owner'],
    })],
    pairing: { group_size: 2, grouping: GROUPING },
    ...approvedIntroduction(['outcome-owner']),
  });
  assert.deepEqual(result.groups[0].configuration_requests, [{
    resource_ref: 'capability:proofing-timer', action_ref: 'action:set-timer', configuration_ref: 'configuration:proofing', configuration: { minutes: 'from-recipe' },
  }]);
  assert.deepEqual(result.introductions[0].consent_parties, ['capability:proofing-timer', 'outcome', 'outcome-owner']);
  assert.equal(result.ready_introductions.length, 0);
});

test('a policy without its factors or scope fields is refused', () => {
  assert.throws(() => selectGroups({ candidates: [] }), /factors and scope_fields/);
  assert.throws(() => selectGroups({ candidates: [], expected_value: { factors: ['fit'] } }), /factors and scope_fields/);
  assert.equal(scopeKeyOf(SCOPE), 'goal_ref:goal:bake-bread|horizon_ref:horizon:this-month');
});
