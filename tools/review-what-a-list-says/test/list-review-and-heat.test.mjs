// Keeping what a list says true, as values (read-data/list-review.mjs reviewWrites) and noticing what nobody uses (heat).
// The review writes were run through the old lists engine in the old tree; the lane proof checks them against the store
// forms in PostgreSQL and a JSON folder. Here: the values each action answers, and the refusals in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heatNow, reviewWrites, usedHeat } from '../read-data/list-review.mjs';
import settings from '../read-data/lists.json' with { type: 'json' };
import { findColdRows, heatOfARow } from '../do-work/review-a-list.mjs';

const DAY = 86_400_000;
const docs = { id: 'docs', title_field: 'title', fields: [{ id: 'title', label: 'Title' }, { id: 'body', label: 'Body', kind: 'long-text' }] };

test('use heat grows with use, halves with time, is written at most once per gap', () => {
  const now = Date.parse('2026-10-19T00:00:00Z');
  const first = usedHeat(null, now);
  assert.deepEqual(first, { heat: settings.use_heat.add, at: new Date(now).toISOString() });
  assert.equal(usedHeat(first, now + 60_000), null, 'a second use inside the gap writes nothing');
  const later = usedHeat(first, now + settings.use_heat.half_life_days * DAY);
  assert.equal(later.heat, settings.use_heat.add * 1.5);
  assert.equal(heatNow(later, Date.parse(later.at) + 2 * settings.use_heat.half_life_days * DAY), later.heat / 4);
  assert.equal(heatNow(null, now), 0);
});

test('set_up saves the review fields and views once; a row action answers the values each row takes', () => {
  const now = Date.parse('2026-11-04T00:00:00Z');
  const set = reviewWrites(docs, 'docs', { action: 'set_up' }, { now });
  assert.equal(set.save.id, 'docs');
  assert.ok(set.answer.fields_added.includes('review_state') && set.answer.fields_added.includes('review_due'), 'the review fields are added');
  const again = reviewWrites({ ...docs, ...set.save }, 'docs', { action: 'set_up' }, { now });
  assert.deepEqual(again.answer.fields_added, [], 'a list already set up gets nothing new');
  const verified = reviewWrites({ ...docs, ...set.save }, 'docs', { action: 'verify', row_ids: ['row-1'] }, { now, actor: { by: 'sam' } });
  assert.equal(verified.putRows.rows[0].id, 'row-1');
  assert.equal(Object.values(verified.putRows.rows[0].values).includes('Verified'), true);
  assert.equal(new Date(Object.values(verified.putRows.rows[0].values).find(v => typeof v === 'string' && v.startsWith('2027'))).getTime(), now + set.save.review.expires_days * DAY);
});

test('a missing list, a list not set up for review, and bad rows are refused in words', () => {
  assert.throws(() => reviewWrites(null, 'notes', { action: 'verify', row_ids: ['x'] }), error => typeof error.message === 'string' && error.message.length > 0);
  assert.throws(() => reviewWrites(docs, 'docs', { action: 'verify', row_ids: ['x'] }), error => typeof error.message === 'string' && error.message.length > 0);
  assert.throws(() => reviewWrites(docs, 'docs', { action: 'verify', row_ids: [] }), error => typeof error.message === 'string' && error.message.length > 0);
});

test('cold rows and heat are read over rows handed in', async () => {
  const answer = await findColdRows({ list: { id: 'docs', title_field: 'title', fields: [] }, rows: [{ id: 'r1', title: 'Old', values: {} }], heats: {} });
  assert.ok(answer, 'answers');
  const heat = heatOfARow({ kept: null, now: '2026-10-19T00:00:00.000Z', used: true });
  assert.ok(heat, 'a use leaves a heat record');
});
