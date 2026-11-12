// Tests for tool:say-what-the-menu-bar-mark-shows. The records are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sayWhatTheMenuBarMarkShows } from '../do-work/say-what-the-menu-bar-mark-shows.mjs';

test('the newest running record is now, with its progress to two places, and the list names every running one', () => {
  const result = sayWhatTheMenuBarMarkShows({ unread_count: 3, records: [
    { title: 'Older', kind: 'upload', running: true, updatedAt: 10, progress: { value: 0.2 } },
    { title: 'Newest', kind: 'upload', running: true, updatedAt: 20, progress: { value: 0.456 } },
    { title: 'Done', kind: 'job', running: false, updatedAt: 30 },
  ] });
  assert.deepEqual(result, { kind: 'glance', count: 3, working: true, running: 2, now: { title: 'Newest', kind: 'upload', fraction: 0.46 }, list: ['Newest', 'Older'] });
});

test('with nothing running the next calendar line stands in, and with neither the now is null', () => {
  assert.deepEqual(sayWhatTheMenuBarMarkShows({ unread_count: 0, records: [], next: 'Design review · in 12 min' }).now,
    { title: 'Design review · in 12 min', kind: 'next', fraction: null });
  const bare = sayWhatTheMenuBarMarkShows({ unread_count: 0, records: [] });
  assert.equal(bare.now, null);
  assert.equal(bare.working, false);
});

test('a running record with no numeric progress has a null fraction, and only eight titles are listed', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ title: `Job ${index}`, kind: 'job', running: true, updatedAt: index, progress: { value: 'half' } }));
  const result = sayWhatTheMenuBarMarkShows({ unread_count: 0, records });
  assert.equal(result.now.fraction, null);
  assert.equal(result.running, 10);
  assert.equal(result.list.length, 8);
  assert.equal(result.list[0], 'Job 9');
});

test('a request that is not one of its shapes is refused', () => {
  assert.throws(() => sayWhatTheMenuBarMarkShows([]), /one JSON/);
  assert.throws(() => sayWhatTheMenuBarMarkShows({ unread_count: -1, records: [] }), /unread_count/);
  assert.throws(() => sayWhatTheMenuBarMarkShows({ unread_count: 0, records: [{ title: 'x' }] }), /records/);
});
