// tools/evaluate-progress: the gates that say no when they cannot tell, the questionnaire scorer and the person linker.
// Carried from the corroboration, safety, nudge, grounding, score-instrument and cohort-stitch tests of bitfield-packages packages/progression-evaluator; the
// safety and nudge gates are the generic risk-gate and nudge-gate here (the threshold, tone, framing and resources are the caller's). Made-up bakery fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stitchCohortLedger } from '../read-data/cohort-stitch.ts';
import { corroborationGate } from '../read-data/corroboration-gate.ts';
import { decideNudge } from '../read-data/nudge-gate.ts';
import { applyRiskGate, evaluateRiskGate } from '../read-data/risk-gate.ts';
import { scoreInstrumentResponses } from '../read-data/score-instrument.ts';
import { verifyGrounding } from '../read-data/verify-grounding.ts';

test('corroboration: no checks is no; a failed required check is no whatever else passed; optional checks must reach the quorum', () => {
  assert.deepEqual(corroborationGate([], 1), { permitted: false, required_failed: [], corroborating: [], reason: 'no signals' });
  assert.deepEqual(corroborationGate(undefined, 0).permitted, false);
  const checks = [{ name: 'till', passed: false, required: true }, { name: 'a', passed: true }, { name: 'b', passed: true }];
  assert.deepEqual([corroborationGate(checks, 1).permitted, corroborationGate(checks, 1).required_failed], [false, ['till']]);
  const fine = [{ name: 'till', passed: true, required: true }, { name: 'a', passed: true }, { name: 'b', passed: false }];
  assert.deepEqual([corroborationGate(fine, 1).permitted, corroborationGate(fine, 1).corroborating, corroborationGate(fine, 2).reason], [true, ['a'], 'only 1 corroborating, need 2']);
});

const resources = ['Call the supplier line'];

test('risk gate: released only for a finished assessment with a number under the threshold', () => {
  const verdict = evaluateRiskGate({ evaluated: true, risk: 0.2 }, { threshold: 0.5, supportResources: resources });
  assert.deepEqual([verdict.release, verdict.hold_back, verdict.support_resources], [true, false, []]);
  const high = evaluateRiskGate({ evaluated: true, risk: 0.5, categories: ['spoilage'] }, { threshold: 0.5, supportResources: resources });
  assert.deepEqual([high.release, high.support_resources, high.categories], [false, resources, ['spoilage']]);
});

test('risk gate: an assessment that did not run, an unknown risk, no assessment or a threshold that is not a number hold the output back', () => {
  const config = { threshold: 0.5, supportResources: resources };
  for (const assessment of [{ evaluated: false, risk: 0.1 }, { evaluated: true, risk: null }, { evaluated: true, risk: Number.NaN }, null, undefined]) {
    const verdict = evaluateRiskGate(assessment, config);
    assert.deepEqual([verdict.release, verdict.hold_back, verdict.support_resources], [false, true, resources]);
  }
  for (const threshold of [Number.NaN, undefined]) assert.equal(evaluateRiskGate({ evaluated: true, risk: 0 }, { threshold }).release, false);   // a risk of 0 against no threshold is not released
});

test('risk gate: applying the verdict gives the output or the held-back notice with the support resources', () => {
  const config = { threshold: 0.5, supportResources: resources };
  assert.deepEqual(applyRiskGate(evaluateRiskGate({ evaluated: true, risk: 0 }, config), 'the plan'), { kind: 'output', output: 'the plan' });
  const held = applyRiskGate(evaluateRiskGate(null, config), 'the plan');
  assert.deepEqual([held.kind, held.support_resources, 'output' in held], ['held-back', resources, false]);
});

test('nudge: opt-out first, then the rate limit, then an unknown risk or threshold; only a risk at or over the threshold nudges', () => {
  const config = { riskThreshold: 0.5, framingRef: 'framing:welcome-back', tone: 'warm' };
  const reason = context => decideNudge(context, config);
  assert.equal(reason(null).nudge, false);
  assert.match(reason({ risk: 0.9, rate_limit_ok: false, opted_out: true }).reason, /opted out/);
  assert.match(reason({ risk: 0.9, rate_limit_ok: false }).reason, /rate limit/);
  assert.equal(reason({ risk: null, rate_limit_ok: true }).nudge, false);
  assert.equal(decideNudge({ risk: 0.9, rate_limit_ok: true }, { riskThreshold: Number.NaN }).nudge, false);
  assert.equal(reason({ risk: 0.49, rate_limit_ok: true }).nudge, false);
  assert.deepEqual(reason({ risk: 0.5, rate_limit_ok: true }), { nudge: true, tone: 'warm', framing_ref: 'framing:welcome-back', reason: 'the risk is at or above the threshold' });
  assert.deepEqual(decideNudge({ risk: 1, rate_limit_ok: true }, { riskThreshold: 0.5 }).tone, null);   // no tone given, none made up
});

test('grounding: a cited retrieved source grounds a claim; no citation or a source never read fails the answer; the ratio is the caller\'s', () => {
  const claims = [{ text: 'Opens at six.', citations: [{ source_id: 'times' }] }, { text: 'Sells rye.', citations: [{ source_id: 'times' }, { source_id: 'ghost' }] }];
  const answer = verifyGrounding(claims, ['times'], { minGroundedRatio: 1 });
  assert.deepEqual([answer.grounded, answer.fabricated_citations, answer.grounded_ratio], [false, ['ghost'], 1]);   // grounded claims, but one reference was made up
  assert.equal(verifyGrounding(claims.slice(0, 1), ['times'], { minGroundedRatio: 1 }).grounded, true);
  const half = [{ text: 'Cited.', citations: [{ source_id: 'times' }] }, { text: 'Bare claim.' }];
  assert.deepEqual([verifyGrounding(half, ['times'], { minGroundedRatio: 1 }).grounded, verifyGrounding(half, ['times'], { minGroundedRatio: 0.5 }).grounded], [false, true]);
  assert.deepEqual(verifyGrounding(half, ['times'], { minGroundedRatio: 1 }).ungrounded_claims, ['Bare claim.']);
  assert.equal(verifyGrounding([], ['times'], { minGroundedRatio: 0 }).grounded, false);
  assert.equal(verifyGrounding(null, null, undefined).grounded, false);
});

const quiz = { id: 'taste-quiz', validated: true, responseFactKind: 'quiz.answer', responseScale: { min: 1, max: 5 }, subscales: [{ id: 'sweet', items: ['q1', 'q2'] }, { id: 'savory', items: ['q3'] }], reverseItems: ['q2'] };

test('a questionnaire\'s responses become facts: reverse-keyed items are reflected, each item is filed under its subscale', () => {
  const facts = scoreInstrumentResponses(quiz, [{ item: 'q1', response: 4 }, { item: 'q2', response: 2 }, { item: 'q3', response: 5 }, { item: 'q9', response: 3 }]);
  assert.deepEqual(facts.map(fact => [fact.id, fact.subscale, fact.scored_value, fact.reversed]), [
    ['taste-quiz:q1:0', 'sweet', 4, false], ['taste-quiz:q2:1', 'sweet', 4, true], ['taste-quiz:q3:2', 'savory', 5, false], ['taste-quiz:q9:3', null, 3, false],
  ]);
  assert.equal(facts[0].kind, 'quiz.answer');
  assert.throws(() => scoreInstrumentResponses({ ...quiz, responseFactKind: undefined }, [{ item: 'q1', response: 1 }]), /no responseFactKind/);
  assert.throws(() => scoreInstrumentResponses({ ...quiz, responseFactKind: '' }, []), /no responseFactKind/);
});

test('an item listed in the instrument\'s items keeps that subscale; a questionnaire that is not validated or is banned is refused', () => {
  const withItems = { ...quiz, items: [{ id: 'q1', subscale: 'bitter' }] };
  assert.equal(scoreInstrumentResponses(withItems, [{ item: 'q1', response: 1 }])[0].subscale, 'bitter');
  assert.throws(() => scoreInstrumentResponses({ ...quiz, validated: false }, []), /not validated/);
  assert.throws(() => scoreInstrumentResponses({ ...quiz, banned: true, bannedReason: 'no evidence' }, []), /banned construct: no evidence/);
});

const config = {
  keyPaths: [['member'], ['phone']], strongKeyPaths: [['member']],
  stageRules: [{ when: { field: ['event'], equals: 'signup' }, stage: 'signed-up', rank: 1 }, { when: { field: ['amount'], gt: 0 }, stage: 'bought', rank: 2 }],
  baseStage: { stage: 'seen', rank: 0 }, sourcePath: ['source'], timePath: ['at'], valuePath: ['amount'], confidence: { identified: 'known', anonymous: 'unknown' },
};
const events = [
  { phone: '111', event: 'visit', source: 'flyer', at: '2026-01-01' },
  { phone: '111', member: 'm-17', event: 'signup', source: 'web', at: '2026-01-02' },
  { member: 'm-17', amount: 12, source: 'shop', at: '2026-01-03' },
  { phone: '222', event: 'visit', source: 'web', at: '2026-01-01' },
];

test('records sharing a key are one person: highest stage, earliest source, summed value, and known only with a strong key', () => {
  const { ledger } = stitchCohortLedger(events, config);
  assert.deepEqual(ledger.map(row => [row.personId, row.stage, row.stageRank, row.source, row.value, row.confidence, row.keyCount, row.factCount]), [
    ['m-17', 'bought', 2, 'flyer', 12, 'known', 2, 3], ['222', 'seen', 0, 'web', 0, 'unknown', 1, 1],
  ]);
});

test('the same value at two different key paths never links two records, and no base stage leaves a person with no stage word', () => {
  const { ledger } = stitchCohortLedger([{ member: '3', source: 'a', at: 1 }, { phone: '3', source: 'b', at: 2 }], { ...config, stageRules: [], baseStage: undefined });
  assert.deepEqual([ledger.length, ledger.map(row => row.stage)], [2, [null, null]]);
  assert.deepEqual(stitchCohortLedger([], config), { ledger: [] });
});

test('with allowed tones, a nudge goes out only in a listed tone; any other tone, or none, is no nudge', () => {
  const context = { risk: 0.9, rate_limit_ok: true };
  const config = { riskThreshold: 0.5, tone: 'warm', allowedTones: ['warm', 'plain'] };
  assert.deepEqual([decideNudge(context, config).nudge, decideNudge(context, config).tone], [true, 'warm']);
  const refused = decideNudge(context, { ...config, tone: 'sharp' });
  assert.equal(refused.nudge, false);
  assert.equal(refused.tone, null);
  assert.match(refused.reason, /not one of the allowed tones/);
  assert.equal(decideNudge(context, { ...config, tone: undefined }).nudge, false);
  assert.equal(decideNudge(context, { ...config, allowedTones: [] }).nudge, false);
  assert.equal(decideNudge(context, { riskThreshold: 0.5, tone: 'sharp' }).nudge, true);   // no list given: the caller's tone as before
});

test('a person no stage rule reaches, with no baseStage, has a null stage and rank (never a made-up one) and sorts after ranked people', () => {
  const rules = [{ when: { field: ['visit'], equals: 'bought' }, stage: 'customer', rank: 2 }];
  const { ledger } = stitchCohortLedger([{ member: '1', visit: 'looked', source: 'a', at: 1 }, { member: '2', visit: 'bought', source: 'a', at: 1 }], { ...config, stageRules: rules, baseStage: undefined });
  assert.deepEqual(ledger.map(row => [row.personId, row.stage, row.stageRank]), [['2', 'customer', 2], ['1', null, null]]);
  assert.equal(JSON.parse(JSON.stringify(ledger))[1].stageRank, null);
});
