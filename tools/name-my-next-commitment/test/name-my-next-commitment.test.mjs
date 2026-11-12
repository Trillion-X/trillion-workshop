// Tests for tool:name-my-next-commitment. The calendar items are made up; what a test checks is the line the menu bar
// would show for them.

import assert from 'node:assert/strict';
import test from 'node:test';

import { nameMyNextCommitment } from '../do-work/name-my-next-commitment.mjs';

const NOW = '2026-01-01T10:00:00.000Z';
const at = iso => iso;

test('the timed item now or next inside the reach is named with its countdown', () => {
  const result = nameMyNextCommitment({
    now: NOW, within_hours: 2,
    items: [
      { title: 'Design review', source: 'work', starts_at: at('2026-01-01T10:12:00.000Z'), ends_at: at('2026-01-01T10:50:00.000Z') },
      { title: 'Planning', source: 'work', starts_at: at('2026-01-01T10:40:00.000Z') },
    ],
  });
  assert.equal(result.line, 'Design review · in 12 min');
  assert.equal(result.refresh_seconds, 60);
  assert.equal(result.look_ahead_minutes, 1440);
});

test('an item that has started and not ended reads as now', () => {
  const result = nameMyNextCommitment({ now: NOW, items: [{ title: 'Standup', starts_at: '2026-01-01T09:55:00.000Z', ends_at: '2026-01-01T10:20:00.000Z' }] });
  assert.equal(result.line, 'Standup · now');
});

test('all-day items, untitled items and items past the reach are never named', () => {
  const result = nameMyNextCommitment({
    now: NOW, within_hours: 1,
    items: [
      { title: 'Holiday', starts_at: '2026-01-01T10:30:00.000Z', all_day: true },
      { title: '   ', starts_at: '2026-01-01T10:30:00.000Z' },
      { title: 'Much later', starts_at: '2026-01-01T15:00:00.000Z' },
    ],
  });
  assert.equal(result.line, null);
});

test("a calendar counted 'never' is skipped and one counted 'always' counts beyond the reach", () => {
  const items = [
    { title: 'Hidden', source: 'personal', starts_at: '2026-01-01T10:05:00.000Z' },
    { title: 'Far off', source: 'work', starts_at: '2026-01-01T14:00:00.000Z' },
  ];
  assert.equal(nameMyNextCommitment({ now: NOW, within_hours: 1, items, counting: { personal: 'never' } }).line, null);
  assert.equal(nameMyNextCommitment({ now: NOW, within_hours: 1, items, counting: { personal: 'never', work: 'always' } }).line, 'Far off · in 4 h');
});

test('within_hours 0 counts only the rest of today', () => {
  // Local clock times, so the test holds in any time zone: 10 AM now, 11 PM tonight, both on the same local day.
  const now = new Date(2026, 0, 1, 10, 0).toISOString();
  const tonight = new Date(2026, 0, 1, 23, 0).toISOString();
  const tomorrow = new Date(2026, 0, 2, 1, 0).toISOString();
  const items = [{ title: 'Tonight', starts_at: tonight }, { title: 'After midnight', starts_at: tomorrow }];
  const result = nameMyNextCommitment({ now, within_hours: 0, items });
  assert.equal(result.within_hours, 0);
  assert.equal(result.line, 'Tonight · in 13 h');
});

test('a request that is not one of its shapes is refused', () => {
  assert.throws(() => nameMyNextCommitment(['not', 'an', 'object']), /one JSON object/);
  assert.throws(() => nameMyNextCommitment({ items: [{ title: 'No start' }] }), /starts_at/);
  assert.throws(() => nameMyNextCommitment({ items: [], within_hours: -1 }), /within_hours/);
  assert.throws(() => nameMyNextCommitment({ items: [], counting: { work: 'sometimes' } }), /never/);
});
