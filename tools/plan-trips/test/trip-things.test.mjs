// What is open on a trip and how far a checklist is done. Every trip, lane, status and policy here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOpenTripThings } from '../read-data/trip-things.mjs';
import { measureAChecklist } from '../read-data/checklist.mjs';

const policy = {
  priority_order: ['critical', 'high', 'normal', 'low', 'closed'],
  lanes: {
    stops: { default_priority: 'low', priority_by_status: { linked: 'normal' }, default_status: 'scheduled', sort_by: ['day_order', 'starts_at'] },
    bags: { default_priority: 'normal', default_status: 'planned', priority_by_status: { missing: 'high', packed: 'closed', acquired: 'closed', dropped: 'closed' }, sort_by: ['group', 'title'] },
    tickets: { default_priority: 'normal', priority_by_status: { changed: 'critical', cancelled: 'critical', requested: 'high', held: 'high', done: 'closed' }, sort_by: ['starts_at', 'title'] },
  },
};

const trip = () => ({
  policy,
  trip_name: 'Harbour weekend',
  lanes: [
    { id: 'stops', label: 'Stops', rows: [
      { id: 's2', title: 'Fish market', kind: 'visit', day_order: 2, day_date: '2026-03-07', starts_at: '08:00' },
      { id: 's1', title: 'Ferry', kind: 'sea_transport', status: 'linked', day_order: 1, day_date: '2026-03-06', starts_at: '09:30', ends_at: '10:15' },
      { id: 's3', title: 'Walk', kind: 'visit', day_order: 1, day_date: '2026-03-06', starts_at: '14:00' },
    ] },
    { id: 'bags', label: 'Bags', rows: [
      { id: 'b1', title: 'Rain shell', group: 'clothes', status: 'missing' },
      { id: 'b2', title: 'Passport', group: 'documents', status: 'packed' },
      { id: 'b3', title: 'Socks', group: 'clothes' },
    ] },
    { id: 'tickets', label: 'Bookings', rows: [
      { id: 'r1', title: 'Hotel', status: 'changed', starts_at: '2026-03-06' },
      { id: 'r2', title: 'Ferry seats', status: 'held', starts_at: '2026-03-06' },
      { id: 'r3', title: 'Dinner', status: 'done' },
    ] },
  ],
});

test('everything open is ranked by the policy, the first open thing is the focus and the rest come later', () => {
  const answer = rankOpenTripThings(trip());
  assert.equal(answer.trip_name, 'Harbour weekend');
  assert.deepEqual(answer.items.map(item => item.id), [
    'tickets:r1', // critical
    'bags:b1', 'tickets:r2', // high: lane order, then the lane's own order
    'stops:s1', 'bags:b3', // normal
    'stops:s3', 'stops:s2', // low: by day then time
    'bags:b2', 'tickets:r3', // closed
  ]);
  assert.equal(answer.focus.id, 'tickets:r1');
  assert.deepEqual(answer.later.map(item => item.id), ['bags:b1', 'tickets:r2', 'stops:s1', 'bags:b3', 'stops:s3', 'stops:s2']);
  assert.ok(answer.later.every(item => item.priority !== 'closed'));
});

test('a row with no status takes the lane default, and the lane counts say what is open', () => {
  const answer = rankOpenTripThings(trip());
  assert.equal(answer.items.find(item => item.id === 'bags:b3').status, 'planned');
  assert.equal(answer.items.find(item => item.id === 'stops:s2').status, 'scheduled');
  assert.deepEqual(answer.lanes, [
    { id: 'stops', label: 'Stops', count: 3, open_count: 3 },
    { id: 'bags', label: 'Bags', count: 3, open_count: 2 },
    { id: 'tickets', label: 'Bookings', count: 3, open_count: 2 },
  ]);
});

test('rows within a priority sort by the lane fields: numbers as numbers, a missing value last, then by id', () => {
  const answer = rankOpenTripThings({
    policy,
    lanes: [{ id: 'stops', rows: [
      { id: 'c', title: 'No time', day_order: 2 },
      { id: 'b', title: 'Ten', day_order: 10, starts_at: '08:00' },
      { id: 'a', title: 'Two late', day_order: 2, starts_at: '18:00' },
      { id: 'd', title: 'Two early', day_order: 2, starts_at: '07:00' },
    ] }],
  });
  assert.deepEqual(answer.items.map(item => item.source_id), ['d', 'a', 'c', 'b']);
  assert.equal(answer.items[0].time_label, '07:00');
  assert.deepEqual(answer.items.find(item => item.source_id === 'b').detail, ['08:00']);
});

test('detail holds the kind and group as words (separators turned to spaces), then the day and the time range as given', () => {
  const item = rankOpenTripThings(trip()).items.find(entry => entry.id === 'stops:s1');
  assert.deepEqual(item.detail, ['sea transport', '2026-03-06', '09:30 - 10:15']);
  assert.equal(item.time_label, '09:30');
});

test('nothing open leaves no focus; rows with no id are skipped and named', () => {
  const answer = rankOpenTripThings({
    policy,
    lanes: [{ id: 'tickets', rows: [{ id: 'r', status: 'done' }, { title: 'No id' }, 'not a row'] }],
  });
  assert.equal(answer.focus, null);
  assert.deepEqual(answer.later, []);
  assert.deepEqual(answer.skipped, [{ lane: 'tickets', index: 1, why: 'the row has no id' }, { lane: 'tickets', index: 2, why: 'the row is not an object' }]);
  assert.equal(answer.items[0].title, 'r');
});

test('a policy that is missing or does not fit is refused and says what to give', () => {
  assert.throws(() => rankOpenTripThings({ lanes: [{ id: 'stops', rows: [] }] }), /policy must be an object/);
  assert.throws(() => rankOpenTripThings({ policy: { ...policy, priority_order: ['only'] }, lanes: [{ id: 'stops', rows: [] }] }), /priority_order/);
  assert.throws(() => rankOpenTripThings({ policy, lanes: [{ id: 'unplanned', rows: [] }] }), /no rule for lane unplanned/);
  assert.throws(() => rankOpenTripThings({ policy: { ...policy, lanes: { stops: { default_priority: 'soon' } } }, lanes: [{ id: 'stops', rows: [] }] }), /default_priority must be one of/);
  assert.throws(() => rankOpenTripThings({ policy: { ...policy, lanes: { stops: { default_priority: 'low', priority_by_status: { x: 'soon' } } } }, lanes: [{ id: 'stops', rows: [] }] }), /not in priority_order/);
  assert.throws(() => rankOpenTripThings({ policy, lanes: [] }), /lanes must list/);
  assert.throws(() => rankOpenTripThings({ policy, lanes: [{ id: 'stops', rows: [] }, { id: 'stops', rows: [] }] }), /needs an id of its own/);
});

test('a checklist counts done items out of the counted ones and groups every item', () => {
  const answer = measureAChecklist({
    items: [
      { id: 'i1', label: 'Shoes', group: 'clothes', status: 'packed' },
      { id: 'i2', label: 'Coat', group: 'clothes', status: 'planned' },
      { id: 'i3', label: 'Charger', status: 'acquired' },
      { id: 'i4', label: 'Umbrella', group: 'clothes', status: 'dropped' },
    ],
    done_statuses: ['packed', 'acquired'],
    skipped_statuses: ['dropped'],
  });
  assert.deepEqual([answer.done, answer.total, answer.ratio], [2, 3, 2 / 3]);
  assert.deepEqual(answer.groups.map(group => [group.group, group.count, group.done]), [['clothes', 3, 1], ['uncategorized', 1, 1]]);
  assert.equal(answer.groups[0].items.length, 3);
});

test('the old package case: one of two packed is half, and an empty list is zero', () => {
  const half = measureAChecklist({
    items: [{ id: 'item:1', group: 'clothes', status: 'packed' }, { id: 'item:2', group: 'clothes', status: 'planned' }],
    done_statuses: ['packed'],
    skipped_statuses: [],
  });
  assert.deepEqual([half.done, half.total, half.ratio, half.groups[0].items.length], [1, 2, 0.5, 2]);
  assert.equal(measureAChecklist({ items: [], done_statuses: [], skipped_statuses: [] }).ratio, 0);
  assert.equal(measureAChecklist({ items: [{ id: 'x', status: 'z' }], done_statuses: [], skipped_statuses: ['z'], ungrouped_label: 'loose' }).groups[0].group, 'loose');
});

test('a checklist refuses an item with no id and a status list that is not given', () => {
  assert.throws(() => measureAChecklist({ items: [{ status: 'x' }], done_statuses: [], skipped_statuses: [] }), /items\[0\] needs an id/);
  assert.throws(() => measureAChecklist({ items: [], skipped_statuses: [] }), /done_statuses must be a list/);
  assert.throws(() => measureAChecklist({ items: [], done_statuses: [] }), /skipped_statuses must be a list/);
  assert.throws(() => measureAChecklist({}), /items must be a list/);
});
