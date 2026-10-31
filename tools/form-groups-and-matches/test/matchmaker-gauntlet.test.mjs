// Hostile and boundary cases for matching. Carried from the original package's matchmaker gauntlet (fourteen cases);
// the consent-effect case runs the tool's command instead of the old process script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { buildCandidates, scoreExpectedValue } from '../read-data/expected-value.mjs';
import { pairKey, selectGroups } from '../read-data/select-groups.mjs';
import { formMatches } from '../do-work/form-matches.mjs';
import { candidate, factorEvidence, FACTORS, POLICY, SCOPE } from './match-fixtures.mjs';

const GROUPING = { modes: [{ type: 'one-to-one', min_size: 2, max_size: 2 }, { type: 'working-group', min_size: 3, max_size: 64 }] };
const select = request => selectGroups({ expected_value: POLICY, ...request });
const build = (rows, config) => buildCandidates(rows, { expected_value: POLICY, ...config });
const approved = parties => ({
  initiative: { required_level: 'coordinate', pre_authorized_levels: ['coordinate'] },
  consent_policy: { approved_values: ['approved'], veto_values: ['veto', 'blocked'] },
  consents: Object.fromEntries(parties.map(party => [party, 'approved'])),
});

test('one missing factor gives no score', () => {
  for (const missing of FACTORS) {
    const evidence = factorEvidence(0.8);
    delete evidence.factors[missing];
    const result = scoreExpectedValue({ factor_evidence: evidence }, POLICY);
    assert.equal(result.expected_value, null);
    assert.equal(result.justified, false);
  }
});

test('all-zero evidence forms no group, introduction or review request', () => {
  const built = build([{ subject: 'baker:current', scope: SCOPE, shortlist: [
    { participant: 'person:a', factor_evidence: factorEvidence(0), retrieval_score: 1 },
    { participant: 'person:b', factor_evidence: factorEvidence(0), retrieval_score: 0.99 },
  ] }], { shortlist_size: 2 });
  const result = select({ candidates: built.candidates, pairing: { group_size: 2, grouping: GROUPING } });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.introductions, []);
  assert.equal(result.instrumentation.expensive_reasoning_requests, 0);
});

test('a search winner missing one factor forms no group', () => {
  const evidence = factorEvidence(1);
  delete evidence.factors.capacity;
  const built = build([{ subject: 'person:subject', scope: SCOPE, shortlist: [{ participant: 'person:search-winner', retrieval_score: 1, factor_evidence: evidence }] }], { shortlist_size: 1 });
  assert.deepEqual(built.candidates, []);
  assert.equal(built.rejections[0].status, 'no_justified_match');
  assert.deepEqual(select({ candidates: built.candidates, pairing: { group_size: 2, grouping: GROUPING } }).groups, []);
});

test('the shortlist is never read past its size, however large the pool', () => {
  const subjectCount = 2_000;
  const shortlistSize = 7;
  let reads = 0;
  const rows = Array.from({ length: subjectCount }, (_, subjectIndex) => {
    const raw = Array.from({ length: 100 }, (_, index) => ({ participant: `candidate:${subjectIndex}:${index}`, factor_evidence: factorEvidence(0.8) }));
    const shortlist = new Proxy(raw, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          reads += 1;
          assert.ok(Number(property) < shortlistSize, 'read beyond the shortlist size');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return { subject: `subject:${subjectIndex}`, scope: SCOPE, corpus_size: 100_000_000, shortlist };
  });
  const started = performance.now();
  const result = build(rows, { shortlist_size: shortlistSize });
  const elapsed = performance.now() - started;
  assert.equal(result.instrumentation.expected_value_evaluation_count, subjectCount * shortlistSize);
  assert.equal(result.instrumentation.max_bounded_evaluations, subjectCount * shortlistSize);
  assert.equal(result.instrumentation.all_pairs_evaluation_count, 0);
  assert.equal(reads, subjectCount * shortlistSize);
  assert.ok(elapsed < 5_000, `bounded evaluation of 14,000 took ${elapsed.toFixed(1)} ms`);
});

test('the matching code has no randomness, no similarity score and no branch on who someone is', () => {
  const source = ['../read-data/expected-value.mjs', '../read-data/select-groups.mjs']
    .map(relative => readFileSync(new URL(relative, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /Math\.random\s*\(|cosine|\.similarity\b/i);
  assert.doesNotMatch(source, /(?:if|switch)\s*\([^\n]*(?:founder|doctor|mother|athlete|salesperson|minister|baker)/i);
});

test('a high search score cannot beat a higher expected value', () => {
  const result = select({ candidates: [
    candidate('owner', 'similar-but-low-value', 0.01, { retrieval_score: 1, similarity: 1 }),
    candidate('owner', 'different-and-ready', 0.7, { retrieval_score: 0, similarity: 0 }),
  ], pairing: { group_size: 2, grouping: GROUPING } });
  assert.deepEqual(result.groups[0].members, ['different-and-ready', 'owner']);
});

test('repeated evidence rows cannot put one person in a group twice', () => {
  const result = select({ candidates: [candidate('owner', 'helper', 0.9), candidate('owner', 'helper', 0.8), candidate('owner', 'other-helper', 0.7)], pairing: { group_size: 3, grouping: GROUPING } });
  assert.equal(new Set(result.groups[0].members).size, result.groups[0].members.length);
  assert.deepEqual(result.groups[0].members, ['helper', 'other-helper', 'owner']);
});

test('pair keys stay apart for ids that hold the separator', () => {
  assert.notEqual(pairKey('person:a|person:b', 'person:c'), pairKey('person:a', 'person:b|person:c'));
});

test('an inherited object value is never a party\'s consent', () => {
  const consents = Object.create({ owner: 'approved', helper: 'approved' });
  const result = select({ candidates: [candidate('owner', 'helper', 0.9)], pairing: { group_size: 2, grouping: GROUPING }, ...approved([]), consents });
  assert.equal(result.ready_introductions.length, 0);
  assert.equal(result.blocked_introductions.length, 1);
  assert.ok(result.blocked_introductions[0].send_gate.blockers.every(blocker => blocker.kind === 'missing_consent'));
});

test('a veto, a missing consent and a missing initiative each hold the introduction', () => {
  const veto = approved(['owner', 'helper']);
  veto.consents.helper = 'veto';
  const missing = approved(['owner']);
  const noInitiative = approved(['owner', 'helper']);
  noInitiative.initiative.pre_authorized_levels = [];
  for (const request of [veto, missing, noInitiative]) {
    const result = select({ candidates: [candidate('owner', 'helper', 0.9)], pairing: { group_size: 2, grouping: GROUPING }, ...request });
    assert.equal(result.ready_introductions.length, 0);
    assert.equal(result.blocked_introductions.length, 1);
    assert.equal(result.blocked_introductions[0].send_authorized, false);
  }
});

test('a held introduction gives no connection to record', () => {
  const base = { program_id: 'program:consent-effect', cycle: '1', relationship_kind: 'practice-partner', expected_value: POLICY, candidates: [candidate('owner', 'helper', 0.9)], pairing: { group_size: 2, grouping: GROUPING } };
  const held = [
    { ...approved(['owner', 'helper']), consents: { owner: 'approved', helper: 'veto' } },
    approved(['owner']),
    { ...approved(['owner', 'helper']), initiative: { required_level: 'coordinate', pre_authorized_levels: [] } },
  ];
  for (const request of held) assert.deepEqual(formMatches({ ...base, ...request }).connections, []);
  const ready = formMatches({ ...base, ...approved(['owner', 'helper']) });
  assert.deepEqual(ready.connections.map(connection => [connection.id, connection.relation]), [['program:consent-effect:1:helper-owner', 'practice-partner']]);
  assert.deepEqual(ready.pair_keys, [pairKey('helper', 'owner')]);
});

test('every group size from 2 to 64 comes from data alone', () => {
  for (let groupSize = 2; groupSize <= 64; groupSize += 1) {
    const subject = `subject:${groupSize}`;
    const result = select({
      candidates: Array.from({ length: groupSize - 1 }, (_, index) => candidate(subject, `party:${groupSize}:${index}`, 1 - index / 1000)),
      pairing: { group_size: groupSize, minimum_group_size: groupSize, grouping: GROUPING },
    });
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].members.length, groupSize);
  }
});

test('ten thousand poisoned factor records never gain a value', () => {
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const poison = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '1', {}, []];
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const evidence = factorEvidence(0.1 + random() * 0.9);
    const missing = FACTORS[Math.floor(random() * FACTORS.length)];
    evidence.factors[missing] = poison[Math.floor(random() * poison.length)];
    const scored = scoreExpectedValue({ factor_evidence: evidence }, POLICY);
    assert.equal(scored.expected_value, null, `iteration ${iteration} admitted ${missing}`);
    assert.equal(scored.justified, false);
  }
});

test('hostile labels replay to the same bytes in any input order', () => {
  const hostile = ['founder', 'doctor', 'mother', 'athlete', 'salesperson', 'minister', 'Alder\nDROP TABLE', 'Birch<script>', '\u{1F4A5}|person', '__proto__'];
  const subject = 'person:ordinary-independent-party';
  const candidates = hostile.map((name, index) => candidate(subject, name, 0.99 - index / 100, { retrieval_score: index / 100 }));
  const request = { candidates, pairing: { group_size: 5, grouping: GROUPING }, ...approved([subject, ...hostile]) };
  const expected = JSON.stringify(select(request));
  for (let replay = 0; replay < 100; replay += 1) {
    const rotated = candidates.slice(replay % candidates.length).concat(candidates.slice(0, replay % candidates.length));
    assert.equal(JSON.stringify(select({ ...request, candidates: rotated })), expected);
  }
});
