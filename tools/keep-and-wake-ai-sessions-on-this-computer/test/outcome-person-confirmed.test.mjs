// The person's confirmed outcome and the AI's inference are kept side by side (src/check-uses.mjs currentDecisionOutcome,
// src/outcome-precedence.json): the inference is always shown beside the value, and with
// person_confirmed_wins on a later check never replaces what the person confirmed; retracting returns the inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentDecisionOutcome } from '../src/check-uses.mjs';
import precedence from '../src/outcome-precedence.json' with { type: 'json' };

const person = { result: 'met', answered_by: 'person', person_source: { basis: 'signed_in_person_screen', source_ref: 'msg:1' }, observed_at: '2026-10-01T10:00:00Z', source_ref: 'r1', summary: 'it worked' };
const check = { result: 'failed', observed_at: '2026-10-02T10:00:00Z', source_ref: 'c1', summary: 'page still shows the old text' };
const record = extra => ({ id: 'd1', decision: { }, reports: [person], observations: [check], ...extra });
const withFlag = async (on, run) => { const was = precedence.person_confirmed_wins; precedence.person_confirmed_wins = on; try { return await run(); } finally { precedence.person_confirmed_wins = was; } };

test('by default the newest evidence is current and the person\'s value is not lost', async () => {
  const outcome = await withFlag(false, () => currentDecisionOutcome(record()));
  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.inference, undefined, 'the inference is the current value, so nothing sits beside it');
});

test('with person_confirmed_wins a later check stays beside the person\'s value and does not replace it', async () => {
  const outcome = await withFlag(true, () => currentDecisionOutcome(record()));
  assert.equal(outcome.result, 'met');
  assert.equal(outcome.by, 'reported');
  assert.deepEqual(outcome.inference, { result: 'failed', at: outcome.inference.at, source_ref: 'c1', summary: 'page still shows the old text' });
});

test('retracting the person\'s value (a report that supersedes it) returns the inference as current', async () => {
  const retract = { result: 'unknown', answered_by: 'person', person_source: person.person_source, observed_at: '2026-10-03T10:00:00Z', source_ref: 'r2', supersedes: 'r1' };
  const outcome = await withFlag(true, () => currentDecisionOutcome(record({ reports: [person, retract] })));
  assert.notEqual(outcome.result, 'met');
  const gone = await withFlag(true, () => currentDecisionOutcome(record({ reports: [person, { ...retract, result: 'failed', supersedes: 'r1' }] })));
  assert.equal(gone.result, 'failed');
});
