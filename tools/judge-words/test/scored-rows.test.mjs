// tools/judge-words: rows that carry a weight, a request's least score, and rows capped with at_most, as judge gives
// them. Carried from bitfield-packages packages/content-gate/__tests__/evaluate-gate.test.ts (the gate engine): its
// weighted score, default weight, least score, non-gating outcomes and fail-closed cases, each said as rule rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, makeJudge, scoreOf } from '../do-work/judge-words.mjs';

const found = { id: 'finds-zorblax', words: ['zorblax'], says: 'Use a concrete word.' };
const clean = { id: 'finds-blorp', words: ['blorp'], says: 'Never this.' };
const share = { id: 'half-found', across: true, percent_found_at_least: 100, says: 'Name both.',
  groups: [{ id: 'one', words: ['zorblax'] }, { id: 'two', words: ['quillon'] }] };

test('a rule that finds nothing scores 100 and the request passes', () => {
  const answer = judge({ text: 'Plain words.', rules: [clean] });
  assert.deepEqual([answer.passed, answer.score, answer.findings.length], [true, 100, 0]);
});

test('an uncapped row that finds something fails and scores 0', () => {
  const answer = judge({ text: 'A zorblax.', rules: [found] });
  assert.deepEqual([answer.passed, answer.status, answer.score, answer.findings.length], [false, 'failed', 0, 1]);
});

test('a capped row (the old warn outcome) holds, keeps its finding and its at_most, and scores 0', () => {
  const answer = judge({ text: 'A zorblax.', rules: [{ ...found, at_most: 'warn' }] });
  assert.deepEqual([answer.status, answer.score, answer.findings[0].at_most], ['held', 0, 'warn']);
  assert.equal(answer.passed, false);   // held is not a pass: a person looks at it
});

test('any at_most word caps a row (advisory, auto_fix ...); a row with none is never capped', () => {
  const advisory = judge({ text: 'A zorblax.', rules: [{ ...found, at_most: 'advisory' }] });
  assert.deepEqual([advisory.status, advisory.findings[0].at_most], ['held', 'advisory']);
  // the old spec that made "warn" gating is a row without at_most
  assert.equal(judge({ text: 'A zorblax.', rules: [found] }).status, 'failed');
  const mixed = judge({ text: 'A zorblax blorp.', rules: [found, { ...clean, at_most: 'advisory' }, { id: 'warned', words: ['zorblax'], says: 'Look.', at_most: 'warn' }] });
  assert.equal(mixed.status, 'failed');
  assert.deepEqual(mixed.findings.map(item => item.at_most ?? 'uncapped').sort(), ['advisory', 'uncapped', 'warn']);
});

test('the score is the weighted mean of the rows that apply; a row names its weight, 1 when it names none', () => {
  const answer = judge({ text: 'A zorblax.', rules: [{ ...clean, weight: 2, at_most: 'warn' }, { ...found, weight: 1, at_most: 'warn' }] });
  assert.ok(Math.abs(answer.score - 200 / 3) < 0.01);
  const halves = judge({ text: 'A zorblax.', rules: [share, { ...share, id: 'half-again' }] });
  assert.equal(halves.score, 50);
});

test('a share test scores the share found; a request whose score is under its min_score fails even when every finding is capped', () => {
  const capped = { ...share, at_most: 'warn' };
  const low = judge({ text: 'A zorblax.', rules: [capped], min_score: 80 });
  assert.deepEqual([low.score, low.status], [50, 'failed']);
  assert.match(low.said, /under the least that passes, 80/);
  assert.equal(judge({ text: 'A zorblax.', rules: [capped] }).status, 'held');   // no min_score: the score decides nothing
  assert.throws(() => judge({ text: 'x', rules: [capped], min_score: 101 }), /min_score/);
});

test('findings of every row are given together, each naming its row', () => {
  const twice = makeJudge([{ id: 'rx', pattern: 'z', says: 'No z.' }])(['zz']);
  assert.deepEqual(twice.map(item => [item.rule, item.offset]), [['rx', 0], ['rx', 1]]);
});

test('a row naming no selector, or an unknown check or evidence check, is refused when compiled: nothing is judged by a row it cannot run', () => {
  assert.throws(() => makeJudge([{ id: 'ghost', says: 'x' }]), /needs words, pattern, exact, check, groups, path or evidence/);
  assert.throws(() => makeJudge([{ id: 'ghost', check: 'no-such-check' }]), /names the check no-such-check/);
  assert.throws(() => makeJudge([{ id: 'ghost', evidence: 'no-such-evidence' }]), /names the evidence check no-such-evidence/);
  assert.throws(() => makeJudge([{ ...found, weight: -1 }]), /weight/);
  assert.throws(() => judge({ text: 'x', rules: [] }), /rules/);   // an empty rule set passes nothing
});

test('scoreOf counts only the rows that apply to some item, and is null when none applies', () => {
  const titled = { ...found, kinds: ['title'] };
  assert.equal(scoreOf([titled], [{ text: 'A zorblax.', kind: 'body' }], []), null);
  assert.equal(scoreOf([titled, clean], [{ text: 'A zorblax.', kind: 'body' }], []), 100);
});
