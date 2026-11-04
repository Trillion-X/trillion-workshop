// Keeping what a list says true and noticing what nobody uses (read-data/list-review.mjs, moved unchanged from old
// trillion src/list-review.mjs; its test is old trillion test/list-review-and-heat.test.mjs). The heat test is moved
// with its assertions unchanged. The review and cold-rows tests there ran through the old lists engine's HTTP routes
// (src/lists.mjs handleListsRequest over src/local-store.mjs); here the same steps run through the moved functions over
// the person's records door kept in memory, with the assertions that do not need that engine kept as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heatNow, usedHeat } from '../read-data/list-review.mjs';
import settings from '../read-data/lists.json' with { type: 'json' };
import { findColdRows, heatOfARow, reviewListRows } from '../do-work/review-a-list.mjs';
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { memoryDoor } from '../../watch-my-sources/test/memory-door.mjs';

const DAY = 86_400_000;
const docs = { id: 'docs', label: 'Docs', fields: [{ id: 'title', label: 'Title' }, { id: 'body', label: 'Body', kind: 'long-text' }] };

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

test('a list set up for review gets its fields and views once, and rows are verified, assigned and flagged in place', async () => {
  const door = memoryDoor();
  const lists = listsOverDoor(door);
  await lists.ensure({ ...docs, title_field: 'title' });
  await lists.putRows('docs', { rows: [{ id: 'onboarding', values: { title: 'Onboarding', body: 'Steps' } }, { id: 'pricing', values: { title: 'Pricing' } }, { id: 'blank', values: { body: 'no title yet' } }] });
  const ask = input => reviewListRows({ list_id: 'docs', ...input }, { door });
  const setUp = await ask({ action: 'set_up', expires_days: 30 });
  assert.deepEqual(setUp.fields_added, ['owner', 'review_state', 'review_due', 'verified_by']);
  assert.deepEqual(setUp.views_added, ['review-needed', 'review-expired', 'review-empty']);
  assert.equal((await reviewListRows({ list_id: 'docs', action: 'set_up' }, { door: memoryDoor([...door.kept.values()]) })).fields_added.length, 0, 'setting up again adds nothing twice');
  await ask({ action: 'assign', row_ids: ['onboarding', 'blank'], owner: 'Ana' });
  await ask({ action: 'assign', row_ids: ['pricing'], owner: 'Ben' });
  const verified = await ask({ action: 'verify', row_ids: ['onboarding'], by: 'Ana' });
  assert.deepEqual(verified.kept, ['onboarding']);
  const row = async id => (await listsOverDoor(door).read('docs', { row_ids: [id] })).rows[0].values;
  const onboarding = await row('onboarding');
  assert.equal(onboarding.review_state, 'Verified');
  assert.equal(onboarding.verified_by, 'Ana');
  assert.equal(onboarding.owner, 'Ana');
  assert.ok(Math.abs(Date.parse(onboarding.review_due) - (Date.now() + 30 * DAY)) < 60_000);
  // Flagging clears the date; an unknown action or a list never set up is refused in words.
  await ask({ action: 'flag_outdated', row_ids: ['onboarding'] });
  assert.equal((await row('onboarding')).review_state, 'Outdated');
  assert.equal((await row('onboarding')).review_due, undefined);
  await assert.rejects(ask({ action: 'shred', row_ids: ['onboarding'] }), error => error.detail.code === 'bad_review');
  await lists.ensure({ id: 'notes', label: 'Notes', title_field: 'title', fields: [{ id: 'title', label: 'Title' }] });
  await assert.rejects(reviewListRows({ list_id: 'notes', action: 'verify', row_ids: ['x'] }, { door }), error => error.detail.code === 'no_review');
});

test('cold rows are the ones nobody uses, leaving out rows whose review is current', async () => {
  const list = { id: 'docs', title_field: 'title', fields: [...docs.fields, ...Object.values(settings.review.fields)] };
  const rows = ['a', 'b', 'c', 'd'].map(id => ({ id, title: id.toUpperCase(), values: { title: id.toUpperCase() } }));
  rows[3].values = { ...rows[3].values, review_state: 'Verified', review_due: new Date(Date.now() + 30 * DAY).toISOString() };
  const heats = { a: usedHeat(null, Date.now()), b: { heat: 1, at: new Date(Date.now() - 400 * DAY).toISOString() } };
  const cold = await findColdRows({ list, rows, heats });
  assert.equal(cold.complete, true);
  assert.deepEqual(cold.rows.map(row => row.id).sort(), ['b', 'c'], 'a is warm and d is verified');
  assert.ok(cold.rows.find(row => row.id === 'b').last_used);
  const paged = await findColdRows({ list, rows: Array.from({ length: 120 }, (_, n) => ({ id: `r${n}`, values: {} })), heats: {} });
  assert.equal(paged.rows.length, 120, 'every page is read within scan_rows');
});

test('a row\'s heat as of a moment, and the record a use leaves', () => {
  const at = '2026-10-19T00:00:00.000Z';
  assert.deepEqual(heatOfARow({ now: at, used: true }), { heat: 0, used: { heat: settings.use_heat.add, at } });
  const kept = { heat: 2, at };
  assert.equal(heatOfARow({ kept, now: new Date(Date.parse(at) + settings.use_heat.half_life_days * DAY).toISOString() }).heat, 1);
  assert.throws(() => heatOfARow({ now: 'not a time' }), /ISO time/);
});
