// test/work-rounds.test.mjs
//
// Work that runs in rounds is never forced to a false "done" (h_ec5c7c6a4a3d5776aa241d6e, src/work-rounds.mjs): a
// Waiting on you row with a round step finishes only this round, keeps what the round showed, opens the next step and
// reads as measured progress; when its planned rounds are reached it is done the ordinary way.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { inRounds, nextRound } from '../from-old-trillion/src/work-rounds.mjs';
import { progressForListRow } from '../../keep-and-wake-ai-sessions-on-this-computer/src/work-progress.mjs';

const waiting = JSON.parse(readFileSync(new URL('../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json', import.meta.url), 'utf8'));
const rules = waiting.rounds;
const progress = waiting.list.fields.find(field => field.kind === 'progress');
const at = '2026-10-11T06:00:00.000Z';

test('every field the rounds DATA names is a field of the Waiting on you list', () => {
  const ids = new Set(waiting.list.fields.map(field => field.id));
  for (const key of ['step_field', 'next_field', 'done_field', 'planned_field', 'log_field', 'starts_field']) assert.ok(ids.has(rules[key]), `${key} names ${rules[key]}`);
  assert.deepEqual([progress.measure.done_field, progress.measure.total_field, progress.measure.evidence_field], [rules.done_field, rules.planned_field, rules.log_field]);
  for (const field of ['round_step', 'rounds_done', 'progress']) assert.ok(waiting.sources.asks.card[field], `a card carries ${field}`);
});

test('a round finishes its step, keeps what it showed and opens the next step, never the row', () => {
  const row = { what: 'Popcorn shelf test', status: 'Waiting', round_step: 'Put 12 bags on 3 store shelves for a week', next_step: 'Restock the stores that sold out', added: '2026-10-01T00:00:00Z' };
  assert.equal(inRounds(row, rules), true);
  const first = nextRound(row, { showed: 'Three stores said yes', at }, rules);
  assert.equal(first.finished, false);
  assert.equal(first.rounds_done, 1);
  assert.equal(first.round_step, 'Restock the stores that sold out', 'the next step opens');
  assert.equal(first.next_step, null);
  assert.equal(first.added, at, 'the next round waits like any new thing');
  assert.match(first.round_log, /Round 1 \(2026-10-11\): Put 12 bags.*It showed: Three stores said yes/);
  assert.equal('status' in first, false, 'a round never sets the row done');
  const second = nextRound({ ...row, ...first }, { at }, rules);
  assert.equal(second.rounds_done, 2);
  assert.equal(second.round_step, 'Restock the stores that sold out', 'with no next step given, the same step runs again');
  assert.equal(second.round_log.split('\n').length, 2);
  assert.match(second.round_log, new RegExp(rules.showed_unsaid));
});

test('progress is measured from the recorded rounds: a share of the plan, or a count with no end set', () => {
  const values = { rounds_done: 2, round_log: 'Round 1\nRound 2' };
  assert.equal(progressForListRow(progress.measure, values), '2 rounds finished, no end set');
  assert.equal(progressForListRow(progress.measure, { ...values, rounds_planned: 4 }), '2 of 4 rounds finished (50%)');
  assert.equal(progressForListRow(progress.measure, { rounds_done: 2 }), 'Not measured', 'no log, no evidence, no progress');
  assert.equal(progressForListRow(progress.measure, {}), 'Not measured');
});

test('the last planned round is kept and then the row is done the ordinary way', () => {
  const row = { what: 'Three tastings', status: 'Waiting', round_step: 'Run a tasting', rounds_done: 2, rounds_planned: 3, round_log: 'Round 1\nRound 2' };
  const last = nextRound(row, { showed: 'Honey mustard won', at }, rules);
  assert.equal(last.finished, true);
  assert.equal(last.rounds_done, 3);
  assert.match(last.round_log, /Honey mustard won/);
});

test('a row with no round step is not in rounds and finishes as it always did', () => {
  assert.equal(inRounds({ what: 'Sign in to Stripe' }, rules), false);
  assert.equal(nextRound({ what: 'Sign in to Stripe' }, { at }, rules), null);
});
