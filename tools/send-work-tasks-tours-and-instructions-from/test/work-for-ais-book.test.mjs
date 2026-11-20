// The operator's per-row book of work (do-work/work-for-ais-book.mjs), ported from the old owner's test/work-for-ais.test.mjs:
// save, end and list each row in its own book; a kept row replaces or ends a shipped one; the row limit from DATA; an
// expired row let go on save (never a shipped id); reading every page of the edge store; and a row saved in its book reaching
// only its audience through delivery.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeWorkRow, planWorkRowSave, readWorkRows, workRowBookName, workRowsOf, PUBLISHED_PREFIX } from '../do-work/work-for-ais-book.mjs';
import { makeWorkDelivery } from '../do-work/work-for-ais-delivery.mjs';
import { WorkForAisError } from '../do-work/work-for-ais-rules.mjs';
import { NOW, HOUR, rules, matches, row, rule, group, factsFor, edgeStore, recordBooks } from './work-for-ais-fakes.mjs';

const shipped = rules.rows;
const SETUP_ROW = shipped.find(item => item.trigger === 'setup-unfinished').id;
const FIRST_ROW = shipped.find(item => item.trigger === 'account-created').id;

// The rows as the operator's book holds them: one book per row id, and the edge store they publish to.
function service({ clock = () => new Date(NOW) } = {}) {
  const kv = edgeStore();
  const books = recordBooks();
  const bookOf = id => makeWorkRow({ ...books.of(workRowBookName(id)), kv, now: clock, rules });
  return { kv, books, rows: workRowsOf({ kv, bookOf, now: clock, rules }) };
}

test('the operator adds and ends rows at runtime, each in its own book; a shipped row can be ended without a deploy', async () => {
  const { kv, books, rows } = service();
  await assert.rejects(rows.save({ row: { id: 'tour' } }), err => err instanceof WorkForAisError && err.message === rules.words.bad_row);
  const saved = await rows.save({ row: row('tour', { said: 'A quick tour', audience: group(rule('bucket', 'between', { min: 0, max: 49 })) }) });
  assert.equal(saved.id, 'tour');
  assert.deepEqual((await rows.list()).in_force.map(item => item.id).sort(), [FIRST_ROW, SETUP_ROW, 'tour'].sort());
  await rows.end({ id: 'tour' });
  assert.deepEqual((await rows.list()).in_force.map(item => item.id).sort(), [FIRST_ROW, SETUP_ROW].sort());
  await rows.end({ id: SETUP_ROW });
  await rows.end({ id: FIRST_ROW });
  assert.deepEqual((await rows.list()).in_force, [], 'a shipped row can be ended without a deploy');
  await assert.rejects(rows.end({ id: 'nothing' }), err => err.message === rules.words.nothing_to_end);
  assert.deepEqual([...books.stores.keys()].sort(), [FIRST_ROW, SETUP_ROW, 'tour'].map(workRowBookName).sort(),
    'each row has its own book, and no book is shared by every row');
  assert.deepEqual(books.stores.get(workRowBookName('tour')).get('row')[0].id, 'tour', 'the book holds its own row');
  assert.ok(JSON.parse(kv.data.get(`${PUBLISHED_PREFIX}tour`)).ended_at, 'the ended row is published with its end time, not removed');
});

test('the list gives the shipped rows, the kept rows and the rows in force; a kept row replaces the shipped row with its id', async () => {
  const { rows } = service();
  await rows.save({ row: row(SETUP_ROW, { job: 'Replaced words.', trigger: 'connect' }) });
  const listed = await rows.list();
  assert.deepEqual(listed.shipped.map(item => item.id), shipped.map(item => item.id));
  assert.deepEqual(listed.kept.map(item => item.id), [SETUP_ROW]);
  assert.equal(listed.in_force.find(item => item.id === SETUP_ROW).job, 'Replaced words.');
  assert.equal(listed.in_force.length, shipped.length);
});

test('a kept row is published with its saved time, and read back as the row in force', async () => {
  const { rows, kv } = service({ clock: () => new Date('2026-11-20T10:00:00Z') });
  await rows.save({ row: row('stamped') });
  const published = JSON.parse(kv.data.get(`${PUBLISHED_PREFIX}stamped`));
  assert.equal(published.saved_at, '2026-11-20T10:00:00.000Z');
  assert.equal(published.job, 'do stamped');
});

test('the row limit is the one in DATA: rows past it are refused in plain words, and saving over an existing id does not count', async () => {
  const { rows } = service();
  for (let index = 0; index < rules.limits.rows; index += 1) await rows.save({ row: row(`r-${index}`) });
  await assert.rejects(rows.save({ row: row('one-too-many') }), err => err instanceof WorkForAisError
    && err.message.startsWith(rules.words.too_many) && err.message.includes(`The most is ${rules.limits.rows}`));
  await rows.save({ row: row('r-0', { job: 'Same id, new words.' }) });
  assert.equal((await rows.list()).kept.length, rules.limits.rows, 'the replaced row is still one row');
});

test('an expired row is let go on save and holds no place; a kept row with a shipped id is never let go', async () => {
  const { rows, kv } = service();
  for (let index = 0; index < rules.limits.rows - 1; index += 1) await rows.save({ row: row(`live-${index}`) });
  await rows.save({ row: row('expired', { window: { from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' } }) });
  assert.equal((await rows.list()).kept.length, rules.limits.rows);
  await rows.save({ row: row('after-expiry') });
  assert.equal(kv.data.has(`${PUBLISHED_PREFIX}expired`), false, 'the expired row was let go from the store');
  assert.equal((await rows.list()).kept.length, rules.limits.rows, 'and the new row took its place');

  const shippedEnded = service();
  await shippedEnded.rows.save({ row: row(FIRST_ROW, { window: { from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' } }) });
  await shippedEnded.rows.save({ row: row('next') });
  assert.equal(shippedEnded.kv.data.has(`${PUBLISHED_PREFIX}${FIRST_ROW}`), true, 'a kept row with a shipped id stays, so the shipped row does not come back');
});

test('planWorkRowSave: the expired rows to let go, the limit judged after them, and a checked row first', () => {
  const kept = [
    { id: 'old', window: { until: '2026-10-01T00:00:00Z' } },
    { id: 'open' },
    { id: SETUP_ROW, window: { until: '2026-10-01T00:00:00Z' } },
  ];
  const plan = planWorkRowSave({ row: row('next'), kept, shipped, nowMs: NOW, rules });
  assert.deepEqual(plan.letGo, ['old'], 'a shipped id is never let go');
  assert.equal(plan.holding, 2);
  assert.equal(plan.full, false);
  assert.throws(() => planWorkRowSave({ row: { id: 'Bad Id', job: 'x' }, kept, shipped, nowMs: NOW, rules }), err => err.message === rules.words.bad_row);
});

test('readWorkRows reads every page of the edge store under the published prefix', async () => {
  const kv = edgeStore({ pageSize: 2 });
  for (let index = 0; index < 5; index += 1) await kv.put(`${PUBLISHED_PREFIX}p-${index}`, JSON.stringify({ id: `p-${index}` }));
  await kv.put('other:thing', JSON.stringify({ id: 'not-a-row' }));
  assert.deepEqual((await readWorkRows(kv)).map(item => item.id).sort(), ['p-0', 'p-1', 'p-2', 'p-3', 'p-4']);
});

test('a row saved in its book reaches only its audience, through delivery', async () => {
  const { rows } = service();
  await rows.save({ row: row('a-b-test', { audience: group(rule('bucket', 'between', { min: 0, max: 49 })) }) });
  const handed = new Map([['low', []], ['high', []]]);
  const delivery = makeWorkDelivery({
    rowsNow: async () => (await rows.list()).in_force,
    factsOf: async id => factsFor(id, { bucket: id === 'low' ? 10 : 70, setupIncluded: true, setupDone: false }),
    matches,
    handOff: async (id, handoff) => { handed.get(id).push(handoff.input.work_for_ais.row); },
    now: () => NOW,
    rules,
  });
  await delivery.deliver('low'); await delivery.deliver('high');
  assert.deepEqual(handed.get('low').sort(), ['a-b-test', SETUP_ROW].sort());
  assert.deepEqual(handed.get('high'), [SETUP_ROW]);
});

test('a row whose window has ended stays in the list until a save lets it go: the window is the delivery rule, not the list', async () => {
  const { rows } = service({ clock: () => new Date(NOW + HOUR) });
  await rows.save({ row: row('timed', { window: { from: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' } }) });
  const listed = await rows.list();
  assert.ok(listed.kept.some(item => item.id === 'timed'), 'it is kept until a save lets it go');
  assert.ok(listed.in_force.some(item => item.id === 'timed'), 'and listed in force');
});
