// The service-lists leaf over a stand-in service: the first read tells nothing, a new thing is told added, a changed
// one changed, a missing one removed only when the list is whole, a refused tell is told again, pages are followed,
// and the credential goes only into the header the row names. Made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, kindsOf, readList, readSettings, watchForTransitions } from '../do-work/mechanisms/service-lists.mjs';

const ROW = { where: 'my-bookings', request: { url: 'https://bookings.example.com/api/bookings', headers: { Authorization: 'Bearer {credential}' } },
  shape: { items: 'data', place: { value: 'booking' }, key: 'id', at: 'updated_at', at_unit: 'iso' }, list_is_whole: true, look_again_seconds: 3600 };
const booking = (id, status = 'confirmed', updated = '2026-11-18T20:00:00Z') => ({ id, status, updated_at: updated });

function service(pages) {
  const asked = [];
  let answer = pages;
  return {
    asked, set: (next) => { answer = next; },
    fetch: async (url, options) => { asked.push({ url, options }); const page = typeof answer === 'function' ? answer(url) : answer; return { ok: true, status: 200, json: async () => page }; },
  };
}

test('the credential goes only into the header the row names, and pages are followed', async () => {
  const stand = service((url) => (url.endsWith('page=2') ? { data: [booking(2)] } : { data: [booking(1)], next: 'https://bookings.example.com/api/bookings?page=2' }));
  const own = readSettings({ ...ROW, shape: { ...ROW.shape, next: 'next' } });
  const { items } = await readList(own, 'made-up-token', stand.fetch);
  assert.deepEqual(items.map((item) => item.id), [1, 2]);
  assert.equal(stand.asked[0].options.headers.Authorization, 'Bearer made-up-token');
  assert.equal(stand.asked.length, 2);
});

test('added, changed and removed are told from the compare; removed only for a whole list', () => {
  const own = readSettings(ROW);
  const first = compare({ own, seen: {}, items: [booking(1), booking(2)], whole: true }).now;
  const { changes } = compare({ own, seen: first, items: [booking(1, 'cancelled', '2026-11-18T21:00:00Z'), booking(3, 'confirmed', '2026-11-18T21:30:00Z')], whole: true });
  assert.deepEqual(changes.map((one) => [one.detail.key, one.detail.change]).sort(), [['1', 'changed'], ['2', 'removed'], ['3', 'added']]);
  const part = compare({ own: readSettings({ ...ROW, list_is_whole: false }), seen: first, items: [booking(1)], whole: false });
  assert.deepEqual(part.changes, []);
});

test('the first read tells nothing; the next tells what changed; a refused tell is told again', async () => {
  const stand = service({ data: [booking(1)] });
  const told = [];
  let refuse = 1;
  let kept = null;
  let reads = 0;
  const control = new AbortController();
  const done = watchForTransitions({ ...ROW, look_again_seconds: 1 }, {
    credential: 'made-up-token', fetch: async (...args) => { reads += 1; if (reads === 2) stand.set({ data: [booking(1), booking(4, 'confirmed', '2026-11-18T22:00:00Z')] }); if (reads >= 4) control.abort(); return stand.fetch(...args); },
    signal: control.signal, keepState: async (state) => { kept = state; },
    onTransition: async (transition) => { if (refuse-- > 0) return false; told.push(transition); return true; },
  });
  await done;
  assert.deepEqual(told.map((one) => [one.detail.key, one.detail.change, one.detail.place, one.detail.where]), [['4', 'added', 'booking', 'my-bookings']]);
  assert.ok(kept.seen['4']);
});

// Made-up booking-kind rules of the shape a booking waiter row gives; the kind words are any a workflow's fires_when reads.
const KINDS = [
  { change: 'added', lacks: 'cancelled_at', kinds: ['a-booking-made'] },
  { change: 'changed', kinds: ['a-booking-moved'] },
  { has: 'cancelled_at', kinds: ['a-booking-moved'] },
  { change: 'removed', kinds: ['a-booking-moved'] },
];

test('each change is labelled by the row rules over the whole thing, and only the carried paths travel', () => {
  const own = readSettings({ ...ROW, shape: { ...ROW.shape, at: ['cancelled_at', 'updated_at'], kinds: KINDS, carry: ['id', 'email', 'starts_at', 'cancelled_at'] } });
  const big = (id, extra = {}) => ({ ...booking(id), email: `b${id}`, starts_at: '2026-11-20T15:00:00Z', cancelled_at: null, questions: 'x'.repeat(4000), ...extra });
  const first = compare({ own, seen: {}, items: [big(1), big(2)], whole: true }).now;
  const { changes } = compare({ own, seen: first, whole: true,
    items: [big(1, { cancelled_at: '2026-11-18T23:00:00Z' }), big(3)] });
  const by = Object.fromEntries(changes.map((one) => [one.detail.key, one.detail]));
  assert.equal(by['3'].kinds, JSON.stringify(['a-booking-made']));
  assert.equal(by['1'].kinds, JSON.stringify(['a-booking-moved']));
  assert.equal(by['1'].at, '2026-11-18T23:00:00.000Z', 'a cancel is told at its cancelled_at');
  assert.equal(by['2'].kinds, JSON.stringify(['a-booking-moved']));
  assert.deepEqual(JSON.parse(by['3'].after), { id: 3, email: 'b3', starts_at: '2026-11-20T15:00:00Z', cancelled_at: null });
  assert.equal(compare({ own: readSettings(ROW), seen: {}, items: [big(4)], whole: false }).changes[0].detail.after, null, 'without carry a thing over 1,000 bytes is not carried');
  const renamed = readSettings({ ...ROW, tell_what_is_there_at_first: true, shape: { ...ROW.shape, carry: { starts_at: 'event.start_time', email: ['invitee.email', 'email'] } } });
  const [one] = compare({ own: renamed, seen: {}, whole: false, items: [{ id: 5, event: { start_time: '2026-11-21T10:00:00Z' }, email: 'b5', questions: 'x'.repeat(4000) }] }).changes;
  assert.deepEqual(JSON.parse(one.detail.after), { starts_at: '2026-11-21T10:00:00Z', email: 'b5' }, 'a service field is carried under the name its readers read');
});

test('no rule that holds gives no kinds, and a booking made already cancelled is not a booking made', () => {
  assert.equal(kindsOf(undefined, 'added', {}), null);
  assert.equal(kindsOf([{ change: 'removed', kinds: ['x'] }], 'added', {}), null);
  assert.equal(kindsOf(KINDS, 'added', { cancelled_at: '2026-11-18T23:00:00Z' }), JSON.stringify(['a-booking-moved']));
});

test('with print, a field that moves on every read does not tell a thing as changed; a named field does', () => {
  const post = (id, views, text = 'made-up words') => ({ id, text, views, updated_at: '2026-11-21T19:00:00Z' });
  const own = readSettings({ ...ROW, list_is_whole: false, shape: { ...ROW.shape, print: ['id', 'text'] } });
  const first = compare({ own, seen: {}, items: [post(1, 10), post(2, 10)], whole: false }).now;
  assert.deepEqual(compare({ own, seen: first, items: [post(1, 99), post(2, 500)], whole: false }).changes, [], 'views moved, nothing told');
  const { changes } = compare({ own, seen: first, items: [post(1, 99, 'edited words'), post(3, 1)], whole: false });
  assert.deepEqual(changes.map((one) => [one.detail.key, one.detail.change]).sort(), [['1', 'changed'], ['3', 'added']]);
  const whole = readSettings({ ...ROW, list_is_whole: false });
  assert.equal(compare({ own: whole, seen: compare({ own: whole, seen: {}, items: [post(1, 10)], whole: false }).now, items: [post(1, 11)], whole: false }).changes.length, 1, 'without print the whole thing is the fingerprint');
});
