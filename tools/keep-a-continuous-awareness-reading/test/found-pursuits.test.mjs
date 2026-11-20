import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foundPursuits } from '../src/found-pursuits.mjs';
import { settings } from './made-up-settings.mjs';

const recording = settings.recording;
const at = '2026-11-20T10:00:00.000Z';
const found = { title: 'Learn the cello', now: 'two lessons a week', after: 'a recital', evidence: ['booked a cello lesson'], areas: ['body'] };

test('a seen pursuit with evidence, where it is and where it heads is added as found by the reading', () => {
  const { add, update, end } = foundPursuits([found], [], { recording, at });
  assert.deepEqual(add, [{
    title: 'Learn the cello', now: 'two lessons a week', after: 'a recital', status: 'active', found_by: 'reading', found_at: at,
    evidence: [{ where: 'messages', date: '2026-11-20', quote_or_fact: 'booked a cello lesson' }], areas: ['body'],
  }]);
  assert.deepEqual(update, []);
  assert.deepEqual(end, []);
});

test('a seen pursuit missing evidence, now or after is not recorded', () => {
  const seen = [{ ...found, title: 'No evidence', evidence: [] }, { ...found, title: 'No now', now: '' }, { ...found, title: 'No after', after: '' }];
  assert.deepEqual(foundPursuits(seen, [], { recording, at }).add, []);
});

test('a seen pursuit with no areas gets no areas key', () => {
  const [row] = foundPursuits([{ ...found, areas: [] }], [], { recording, at }).add;
  assert.equal('areas' in row, false);
});

test('a seen pursuit that is recorded by id is not added again, and its new areas are added to it', () => {
  const recorded = [{ id: 'pursuit:learn-the-cello', title: 'Learn the cello', found_by: 'reading', areas: ['body'], status: 'active' }];
  const { add, update, end } = foundPursuits([{ ...found, recorded: 'pursuit:learn-the-cello', areas: ['body', 'mind'] }], recorded, { recording, at });
  assert.deepEqual(add, []);
  assert.deepEqual(update, [{ ...recorded[0], areas: ['body', 'mind'] }]);
  assert.deepEqual(end, []);
});

test('a recorded pursuit matched by title is not updated when the seen areas add nothing new', () => {
  const recorded = [{ id: 'pursuit:learn-the-cello', title: 'Learn the cello', found_by: 'reading', areas: ['body'], status: 'active' }];
  const { update } = foundPursuits([{ ...found, areas: ['body'] }], recorded, { recording, at });
  assert.deepEqual(update, []);
});

test('a pursuit a reading found earlier and no longer sees is ended; one a person recorded is never ended', () => {
  const recorded = [
    { id: 'pursuit:old-found', title: 'Old found', found_by: 'reading', status: 'active' },
    { id: 'pursuit:typed-by-person', title: 'Typed', found_by: 'person', status: 'active' },
    { id: 'pursuit:parent', title: 'Parent', found_by: 'reading', grouped: true, status: 'active' },
    { id: 'pursuit:already-ended', title: 'Done', found_by: 'reading', status: 'ended' },
  ];
  const { end } = foundPursuits([], recorded, { recording, at });
  assert.deepEqual(end.map(item => item.id), ['pursuit:old-found']);
  assert.equal(end[0].status, 'ended');
  assert.equal(end[0].ended_at, at);
});

test('a pursuit a consolidation merged away is not found again, by its recorded id or its title', () => {
  const mergedAway = new Set(['pursuit:learn-the-cello']);
  assert.deepEqual(foundPursuits([found], [], { recording, at, mergedAway }).add, []);
  const byRecordedId = new Set(['pursuit:gone']);
  assert.deepEqual(foundPursuits([{ ...found, recorded: 'pursuit:gone' }], [], { recording, at, mergedAway: byRecordedId }).add, []);
  assert.equal(foundPursuits([{ ...found, recorded: 'pursuit:other' }], [], { recording, at, mergedAway: byRecordedId }).add.length, 1);
});
