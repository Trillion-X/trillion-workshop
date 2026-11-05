// test/calendar.test.mjs
// The one Calendar (src/calendar.mjs): every source row read into one list, a connected calendar's copy of a meeting
// shown once, a source that cannot be read said in words without stopping the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarError, itemsOf, readCalendar, spanOf } from '../src/calendar.mjs';
import settings from '../src/calendar.json' with { type: 'json' };

const FROM = '2036-10-05T00:00:00Z';
const TO = '2036-10-12T00:00:00Z';
const source = id => settings.sources.find(row => row.id === id);

test('a span is checked: from before to, at most the most days apart', () => {
  assert.deepEqual(spanOf({ from: FROM, to: TO }), { from: '2036-10-05T00:00:00.000Z', to: '2036-10-12T00:00:00.000Z' });
  assert.throws(() => spanOf({ from: TO, to: FROM }), CalendarError);
  assert.throws(() => spanOf({ from: FROM, to: '2037-10-12T00:00:00Z' }), CalendarError);
  assert.throws(() => spanOf({}), CalendarError);
});

test('a connected calendar row reads timed and all-day events and omits incomplete cancellation tombstones', () => {
  const items = itemsOf(source('google-calendar'), { items: [
    { id: 'g1', summary: 'Dentist\nsecond line', start: { dateTime: '2036-10-06T15:00:00Z' }, end: { dateTime: '2036-10-06T16:00:00Z' }, htmlLink: 'https://calendar.google.com/x' },
    { id: 'g2', summary: 'Holiday', start: { date: '2036-10-07' }, end: { date: '2036-10-08' } },
    { id: 'g3', summary: 'Gone', status: 'cancelled', start: { dateTime: '2036-10-06T15:00:00Z' } },
    { summary: 'No id', start: { dateTime: '2036-10-06T15:00:00Z' } },
  ] });
  assert.deepEqual(items.map(item => [item.id, item.title, item.starts_at, item.all_day]), [
    ['google-calendar:g1', 'Dentist', '2036-10-06T15:00:00.000Z', false],
    ['google-calendar:g2', 'Holiday', '2036-10-07T00:00:00.000Z', true],
  ]);
  assert.equal(items[0].link, 'https://calendar.google.com/x');
});

test('event properties are read when present and unknown fields remain absent', () => {
  const rows = itemsOf(source('google-calendar'), { items: [
    { id: 'known', start: { date: '2036-10-07' }, colorId: '7', visibility: 'private', transparency: 'transparent' },
    { id: 'unknown', start: { date: '2036-10-07' } },
  ] });
  assert.deepEqual([rows[0].color_id, rows[0].visibility, rows[0].transparency], ['7', 'private', 'transparent']);
  assert.ok(['color_id', 'visibility', 'transparency'].every(field => !Object.hasOwn(rows[1], field)));
});

test('a complete cancelled event retains its title and time and has no move or removal action', () => {
  const [item] = itemsOf(source('google-calendar'), { items: [
    { id: 'cancelled-complete', summary: 'Cancelled review', status: 'cancelled', organizer: { self: true },
      start: { dateTime: '2036-10-06T15:00:00Z' }, end: { dateTime: '2036-10-06T16:00:00Z' } },
  ] });
  assert.equal(item.title, 'Cancelled review');
  assert.equal(item.status, 'cancelled');
  assert.equal(item.ends_at, '2036-10-06T16:00:00.000Z');
  assert.equal(item.may_move, false);
  assert.equal(item.may_cancel, false);
});

test('the default calendar reads a real optional palette without hiding events on palette failure', async () => {
  for (const succeeds of [true, false]) {
    const calls = [];
    const answer = await readCalendar({ from: FROM, to: TO }, { sources: [source('google-calendar')],
      runTool: async (tool, input, key) => {
        calls.push([tool, input, key]);
        if (tool.endsWith('list_colors')) return succeeds ? { state: 'completed', output: { event: { '7': { background: '#46d6db' }, 'bad': { background: 'url(unsafe)' } } } } : { state: 'failed' };
        return { state: 'completed', output: { items: [{ id: 'own', start: { date: '2036-10-07' }, colorId: '7' }] } };
      }, readRecord: () => null });
    assert.equal(answer.items.length, 1);
    assert.equal(answer.sources[0].read, true);
    assert.equal(calls[0][0], 'tool:google-calendar-list_colors');
    if (succeeds) assert.deepEqual(answer.sources[0].event_colors, [{ value: '7', label: 'Color 7', color: '#46d6db' }]);
    else assert.equal(answer.sources[0].event_colors_unavailable, true);
  }
});

test('meetings, posts and a connected calendar read as one list, a placed meeting shown once, in time order', async () => {
  const routes = [];
  const answer = await readCalendar({ from: FROM, to: TO }, {
    route: async path => {
      routes.push(path);
      if (path.startsWith('/community/events')) return { events: [{ event_id: 'e1', title: 'Target sourdough aisle', starts_at: '2036-10-06T16:00:00Z', ends_at: '2036-10-06T18:00:00Z', space_id: 'membership_a', space_title: 'Riverside Bakery Co', you_are_going: true, may_move: true }] };
      return { posts: [{ post_id: 'post_1', caption: 'Launch post', at: '2036-10-05T09:00:00Z', status: 'scheduled' }] };
    },
    runTool: async (tool, input, key) => {
      assert.equal(tool, 'tool:google-calendar-list_events_between');
      assert.deepEqual([input.time_min, input.time_max], ['2036-10-05T00:00:00.000Z', '2036-10-12T00:00:00.000Z']);
      assert.match(key, /^calendar:google-calendar:/);
      return { state: 'completed', output: { items: [
        { id: 'copy-of-e1', summary: 'Target sourdough aisle', start: { dateTime: '2036-10-06T16:00:00Z' } },
        { id: 'own', summary: 'Gym', start: { dateTime: '2036-10-07T07:00:00Z' } },
      ] } };
    },
    readRecord: id => (id === 'space-calendar-event:e1' ? { calendar_event_id: 'copy-of-e1' } : null),
  });
  assert.ok(routes.every(path => path.includes('from=') && path.includes('to=')));
  assert.deepEqual(answer.items.map(item => item.id), ['posts:post_1', 'meetings:e1', 'google-calendar:own']);
  const meeting = answer.items.find(item => item.source === 'meetings');
  assert.deepEqual([meeting.space_id, meeting.going, meeting.may_move, meeting.ends_at], ['membership_a', true, true, '2036-10-06T18:00:00.000Z']);
  assert.equal(answer.items.find(item => item.source === 'posts').ref, 'post_1');
  assert.ok(answer.sources.every(row => row.read));
});

test('a calendar that is not connected is said as such, and one that cannot be read never stops the others', async () => {
  const answer = await readCalendar({ from: FROM, to: TO }, {
    route: async path => { if (path.startsWith('/posts')) throw new Error('down'); return { events: [] }; },
    runTool: async () => ({ connected: false }),
    readRecord: () => null,
  });
  const by = Object.fromEntries(answer.sources.map(row => [row.id, row]));
  assert.equal(by.meetings.read, true);
  assert.equal(by.posts.read, false);
  assert.match(by.posts.said, /could not be read/);
  assert.equal(by['google-calendar'].connected, false);
  assert.match(by['google-calendar'].said, /not connected/);
});

test('a thing given to you in a space with a due date is on your Calendar that day, until it is done', () => {
  const items = itemsOf(source('given'), { items: [
    { ref: 'membership_a:item_1', title: 'Connect your calendar', body: { text: 'So the meeting lands when all are free.', link: '/work/connect/google-calendar' }, facts: { assignee: 'Bo', due: '2036-10-08' }, space_id: 'membership_a', space_title: 'Riverside Bakery Co' },
    { ref: 'membership_a:item_2', title: 'Print the boxes', facts: { assignee: 'Bo', due: '2036-10-09T15:00:00Z', status: 'done' }, space_id: 'membership_a' },
    { ref: 'membership_a:item_3', title: 'No date', facts: { assignee: 'Bo' }, space_id: 'membership_a' },
  ] });
  assert.deepEqual(items.map(item => [item.id, item.title, item.starts_at, item.all_day, item.space_id, item.link]), [
    ['given:membership_a:item_1', 'Connect your calendar', '2036-10-08T00:00:00.000Z', true, 'membership_a', '/work/connect/google-calendar'],
  ]);
});
