// The service-lists leaf over a stand-in service: the first read tells nothing, a new thing is told added, a changed
// one changed, a missing one removed only when the list is whole, a refused tell is told again, pages are followed,
// and the credential goes only into the header the row names. Made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, readList, readSettings, watchForTransitions } from '../do-work/mechanisms/service-lists.mjs';

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
