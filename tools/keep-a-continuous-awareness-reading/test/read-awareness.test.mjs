import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAwareness } from '../do-work/read-awareness.mjs';
import { settings, mapSettings } from './made-up-settings.mjs';

const NOW = Date.parse('2026-11-05T09:00:00Z');
const picture = {
  trajectory: 'Moving toward a bakery.',
  traits: { values: [{ name: 'Craft', evidence: ['Bread costs more.'] }], skills: [] },
  pursuits: [{ title: 'Open a bakery', recorded: 'pursuit:open-a-bakery', now: 'planning', after: 'open', areas: ['money'], judgements: {} }],
  observations: [], right_now: { doing: 'costing bread', judgement: { choice: 'on', why: 'on the path' }, nudge: '' },
  read_at: '2026-11-04T09:00:00Z', read_count: 4, model: 'm',
};
const mapRows = [
  { id: 'money', title: 'Money', values: { area: 'Money', means: 'Cash', optional: 'No' } },
  { id: 'body', title: 'Body', values: { area: 'Body', means: 'Health', optional: 'No' } },
];

test('read shows the picture, the reading state and the map placed from the rows the caller hands in', async () => {
  const view = await readAwareness({
    action: 'read', settings, mapSettings, map_list_id: 'your-map', now: NOW,
    state: {
      allowed: true, picture, reading: { last_read_at: '2026-11-04T09:00:00Z', read_count: 4, cursor: { history_done: true } },
      pending: null, stated: [{ id: 'pursuit:open-a-bakery', title: 'Open a bakery', areas: ['money'] }], unread: true, map_rows: mapRows,
    },
  });
  assert.equal(view.picture.trajectory, 'Moving toward a bakery.');
  assert.equal(view.reading.read_count, 4);
  assert.equal(view.reading.history_done, true);
  assert.equal(view.reading.next_read_at, '2026-11-05T09:00:00.000Z', 'a reading is due now when inputs are unread and the last was a day ago');
  assert.equal(view.map.list_id, 'your-map');
  assert.deepEqual(view.map.missing.map(area => area.id), ['body'], 'body is a leaf nobody names');
});

test('next_due says when the next reading is due, and null when the person keeps no records', async () => {
  const due = await readAwareness({ action: 'next_due', settings, now: NOW, state: { allowed: true, reading: null, pending: null, picture: null, unread: false } });
  assert.deepEqual(due, { next_due: null }, 'nothing unread: nothing due');
  const withInputs = await readAwareness({ action: 'next_due', settings, now: NOW, state: { allowed: true, reading: null, pending: null, picture: null, unread: true } });
  assert.deepEqual(withInputs, { next_due: '2026-11-05T09:00:00.000Z' });
  const closed = await readAwareness({ action: 'next_due', settings, now: NOW, state: { allowed: false, unread: true } });
  assert.deepEqual(closed, { next_due: null });
});

test('a waiting reading shows when its retry is due', async () => {
  const view = await readAwareness({
    action: 'read', settings, now: NOW,
    state: { allowed: true, reading: { waiting_until: '2026-11-05T10:00:00.000Z', waiting_misses: 2, waiting_reason: 'No AI answered this reading. It will retry automatically.' }, pending: null, picture: null },
  });
  assert.equal(view.reading.waiting_until, '2026-11-05T10:00:00.000Z');
  assert.match(view.reading.waiting_reason, /No AI answered/);
});

test('a map without its list id or its words is refused, and so is an unknown action', async () => {
  await assert.rejects(readAwareness({ action: 'read', settings, now: NOW, state: { allowed: true, map_rows: mapRows } }), TypeError);
  await assert.rejects(readAwareness({ action: 'write', settings, now: NOW, state: {} }), /Unknown action "write"/);
  await assert.rejects(readAwareness({ action: 'read', now: NOW, state: {} }), /needs the awareness settings/);
});
