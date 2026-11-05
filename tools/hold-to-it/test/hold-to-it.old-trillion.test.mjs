// test/hold-to-it.test.mjs
//
// A group held to what it agreed (src/hold-to-it.mjs): keeping an agreement posts it, the scorecard rules and the next
// meeting in the space and sets a reminder and a check; the check marks each person from what was heard and written,
// once per day, and says it to everyone in the space; nobody setting it up is its own mark; unnamed voices are reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aroundNow, makeHoldToIt, marksFor, presentAmong, tally } from '../hold-to-it.mjs';
import { instantAt } from '../../run-work-later-or-on-a-repeat/do-work/wall-time.ts';

// A pretend space and person store: items, events and messages kept in memory.
function fakeIo({ now, messagesByApp = {}, events = [] } = {}) {
  const items = [];
  const schedules = [];
  const told = [];
  const ran = [];
  let n = 0;
  const network = {
    async space() { return { title: 'Riverside Bakery team', members: [] }; },
    async spaceItems({ kind, limit = 50 }) {
      return { items: items.filter(item => !kind || item.kind === kind).slice().reverse().slice(0, limit), next_before: null };
    },
    async addSpaceItems({ items: adding }) {
      const ids = [];
      for (const item of adding) {
        const earlier = item.source_ref && items.find(each => each.source_ref === item.source_ref);
        if (earlier) { ids.push(earlier.item_id); continue; }
        n += 1;
        const kept = { item_id: `item_${n}`, ...item, provenance: { by: 'Sam', app: 'Trillion', added_at: new Date(now()).toISOString() } };
        items.push(kept);
        ids.push(kept.item_id);
      }
      return { ids };
    },
    async spaceEvents({ from, to }) {
      return { events: events.filter(event => event.starts_at < to && event.ends_at >= from) };
    },
    async createEvent({ title, starts_at, ends_at }) {
      events.push({ event_id: `event_${events.length + 1}`, title, starts_at, ends_at });
      return { event_id: `event_${events.length}` };
    },
    async setSpaceItemFacts({ item_id, facts }) {
      const item = items.find(each => each.item_id === item_id);
      item.facts = { ...(item.facts ?? {}), ...facts };
      return { item_id, facts: item.facts };
    },
    async moveEvent({ event_id, starts_at, ends_at }) {
      const event = events.find(each => each.event_id === event_id);
      Object.assign(event, { starts_at, ends_at });
      return { event_id, starts_at, ends_at };
    },
  };
  return {
    io: {
      relay: 'relay_me', network, now,
      readMessages: async ({ app }) => ({ messages: messagesByApp[app] ?? [], next_before: null }),
      schedule: async input => { schedules.push(input); return { schedule_id: `schedule_${schedules.length}` }; },
      tell: async notice => { told.push(notice); return { told: true }; },
      runTool: async input => { ran.push(input); return { state: 'completed' }; },
    },
    items, events, schedules, told, ran,
  };
}

const ZONE = 'America/Los_Angeles';
const cadence = { every: 'day', at: '11:00', minutes: 60, time_zone: ZONE };

test('a local time in a zone is the right instant, across a clock change', () => {
  assert.equal(new Date(instantAt('2026-10-05', '11:00', ZONE)).toISOString(), '2026-10-05T18:00:00.000Z');
  assert.equal(new Date(instantAt('2026-12-05', '11:00', ZONE)).toISOString(), '2026-12-05T19:00:00.000Z');
});

test('the last ended meeting and the next one around now', () => {
  const now = Date.parse('2026-10-05T20:30:00Z');
  const { last, next } = aroundNow(cadence, now);
  assert.equal(new Date(last.starts).toISOString(), '2026-10-05T18:00:00.000Z');
  assert.equal(new Date(next.starts).toISOString(), '2026-10-06T18:00:00.000Z');
  const weekly = aroundNow({ ...cadence, every: 'week', on: ['monday'] }, now);
  assert.equal(new Date(weekly.next.starts).toISOString(), '2026-10-12T18:00:00.000Z');
});

test('presence matches a name, its first word, or a name the person is also heard as; unnamed voices never count', () => {
  const present = presentAmong(['Sam', 'RILEY', 'Dana Lee'], [{ name: 'Sam Rivera' }, { name: 'dana' }, { name: 'Someone (voice-3)' }], { RILEY: ['Morgan'] });
  assert.deepEqual(present, ['Sam', 'Dana Lee']);
  assert.deepEqual(presentAmong(['RILEY'], [{ name: 'Morgan' }], { RILEY: ['Morgan'] }), ['RILEY']);
});

test('marks come from the DATA rows: present, absent, and nobody set it up', () => {
  const marks = marksFor({ people: ['A', 'B'], present: ['A'], arranged: true });
  assert.deepEqual(marks.map(row => [row.person, row.mark.id, row.mark.points]), [['A', 'came', 1], ['B', 'missed', -3]]);
  assert.deepEqual(marksFor({ people: ['A'], present: ['A'], arranged: false }).map(row => row.mark.id), ['not-arranged']);
});

test('a tally sums points and counts misses in a row from the newest mark back', () => {
  const rows = tally([
    { body: { person: 'B', points: -3, miss: true } },
    { body: { person: 'B', points: -2, miss: true } },
    { body: { person: 'B', points: 1, miss: false } },
    { body: { person: 'A', points: 1, miss: false } },
  ]);
  assert.deepEqual(rows, [{ name: 'B', points: -4, missed_in_a_row: 2, areas: { 'showing up': -4 } }, { name: 'A', points: 1, missed_in_a_row: 0, areas: { 'showing up': 1 } }]);
});

test('keeping an agreement posts it with the rules, books the next meeting and sets a reminder and a check', async () => {
  const now = () => Date.parse('2026-10-05T21:00:00Z');
  const fake = fakeIo({ now });
  const tool = makeHoldToIt(fake.io);
  const kept = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam', 'RILEY', 'Dana Lee'], proposed_by: 'Dana Lee', quote: 'We need to have a meeting every day', cadence });
  assert.ok(kept.agreement_id);
  assert.deepEqual(fake.items.map(item => item.kind), ['scorecard-rules', 'agreement', 'message']);
  assert.equal(fake.events.length, 1);
  assert.equal(fake.events[0].starts_at, '2026-10-06T18:00:00.000Z');
  assert.deepEqual(fake.schedules.map(row => [row.every.at, row.then.input.operation]), [['10:50', 'remind'], ['12:30', 'check']]);
  assert.match(kept.said, /Sam, RILEY and Dana Lee agreed/);
  // Keeping it again adds nothing twice.
  await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam'], cadence });
  assert.equal(fake.items.filter(item => item.kind === 'agreement').length, 1);
  assert.equal(fake.events.length, 1);
  // ...and its reminder and check keep the same two schedule ids instead of adding more.
  const ids = fake.schedules.map(row => row.schedule_id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(ids.slice(2), ids.slice(0, 2));
});

test('an agreement is kept in the zone it was said in, and a zone that is not one is refused, never read as UTC', async () => {
  const fake = fakeIo({ now: () => Date.parse('2026-10-05T21:00:00Z') });
  const tool = makeHoldToIt(fake.io);
  await assert.rejects(tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam'], cadence: { ...cadence, time_zone: 'Pacific Time' } }), /not a time zone/);
  assert.equal(fake.items.length, 0, 'nothing is kept');
  await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam'], cadence: { ...cadence, time_zone: 'america/los_angeles' } });
  assert.equal(fake.items.find(item => item.kind === 'agreement').body.cadence.time_zone, 'America/Los_Angeles');
});

test('the check marks who came from what was heard, says it in the space, and never marks twice', async () => {
  let clock = Date.parse('2026-10-05T17:00:00Z');
  const fake = fakeIo({
    now: () => clock,
    messagesByApp: { Listening: [
      { at: '2026-10-05T18:10:00Z', speaker: 'Sam Rivera' },
      { at: '2026-10-05T16:00:00Z', speaker: 'Dana Lee' },
    ] },
  });
  const tool = makeHoldToIt(fake.io);
  const { agreement_id } = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam', 'RILEY', 'Dana Lee'], cadence, aliases: { RILEY: ['Morgan'] } });
  clock = Date.parse('2026-10-05T19:30:00Z');
  const checked = await tool.run({ operation: 'check', space_id: 'space_1', agreement_id });
  assert.deepEqual(checked.present, ['Sam']);
  assert.deepEqual(checked.absent, ['RILEY', 'Dana Lee']);
  assert.equal(checked.unnamed_voices, 0);
  assert.match(checked.said, /RILEY and Dana Lee agreed to this and did not show up/);
  const marks = fake.items.filter(item => item.kind === 'scorecard-mark');
  assert.deepEqual(marks.map(item => [item.body.person, item.body.rule]), [['Sam', 'came'], ['RILEY', 'missed'], ['Dana Lee', 'missed']]);
  assert.equal(fake.told.length, 1);
  await tool.run({ operation: 'check', space_id: 'space_1', agreement_id });
  assert.equal(fake.items.filter(item => item.kind === 'scorecard-mark').length, 3);
  const card = await tool.run({ operation: 'scorecard', space_id: 'space_1' });
  assert.deepEqual(card.people.map(row => [row.name, row.points]), [['Dana Lee', -3], ['RILEY', -3], ['Sam', 1]]);
});

test('voices with no name never score anyone absent, and a later mark for the same day replaces the earlier one', async () => {
  let clock = Date.parse('2026-10-05T17:00:00Z');
  const fake = fakeIo({
    now: () => clock,
    messagesByApp: { Listening: [
      { at: '2026-10-05T18:10:00Z', speaker: 'Sam Rivera' },
      { at: '2026-10-05T18:20:00Z', speaker: 'Someone (voice-3)' },
    ] },
  });
  const tool = makeHoldToIt(fake.io);
  const { agreement_id } = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam', 'RILEY', 'Dana Lee'], cadence });
  clock = Date.parse('2026-10-05T19:30:00Z');
  const checked = await tool.run({ operation: 'check', space_id: 'space_1', agreement_id });
  assert.equal(checked.unnamed_voices, 1);
  assert.deepEqual(checked.marks.map(row => [row.person, row.mark, row.points]), [['Sam', 'came', 1], ['RILEY', 'not-counted', 0], ['Dana Lee', 'not-counted', 0]]);
  assert.match(checked.said, /voices with no name yet were heard during it \(1\), so RILEY and Dana Lee could not be counted/);
  // Once it is known Dana was there, a mark for that day replaces the unclear one.
  await tool.run({ operation: 'mark', space_id: 'space_1', agreement_id, person: 'Dana Lee', rule: 'came', date: '2026-10-05', evidence: 'she ran the meeting' });
  const card = await tool.run({ operation: 'scorecard', space_id: 'space_1' });
  assert.deepEqual(card.people.map(row => [row.name, row.points]), [['RILEY', 0], ['Dana Lee', 1], ['Sam', 1]]);
  await assert.rejects(tool.run({ operation: 'mark', space_id: 'space_1', agreement_id, person: 'Sam', rule: 'came', date: 'yesterday' }), /date is the day/);
});

test('an agreement with no time is kept but never booked on a guess; the person is asked, and retime books and moves it', async () => {
  let clock = Date.parse('2026-10-05T17:00:00Z');
  const fake = fakeIo({ now: () => clock });
  const tool = makeHoldToIt(fake.io);
  const kept = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam', 'Dana Lee'], cadence: { every: 'day', time_zone: ZONE }, suggested_at: '15:00' });
  assert.equal(kept.needs_time, true);
  assert.equal(fake.events.length, 0);
  assert.equal(fake.schedules.length, 0);
  assert.match(kept.said, /agreed to it every day, but nobody said when/);
  assert.deepEqual(fake.told.map(notice => [notice.kind, notice.title]), [['needs-you', 'Choose a time for Daily team meeting']]);
  assert.match(fake.told[0].body, /Suggested: 15:00\./);
  assert.match((await tool.run({ operation: 'check', space_id: 'space_1', agreement_id: kept.agreement_id })).said, /no time yet/);

  const timed = await tool.run({ operation: 'retime', space_id: 'space_1', agreement_id: kept.agreement_id, at: '15:00', because: 'Sam chose it.' });
  assert.deepEqual(fake.events.map(event => event.starts_at), ['2026-10-05T22:00:00.000Z']);
  assert.deepEqual(fake.schedules.map(row => [row.every.at, row.then.input.operation]), [['14:50', 'remind'], ['16:00', 'check']]);
  assert.match(timed.said, /now has its time: Mon, Oct 5, 3:00 PM\. Sam chose it\./);

  // A new time moves the booked meeting (never a second one) and the same two schedules.
  const moved = await tool.run({ operation: 'retime', space_id: 'space_1', agreement_id: kept.agreement_id, at: '16:00' });
  assert.deepEqual(fake.events.map(event => event.starts_at), ['2026-10-05T23:00:00.000Z']);
  assert.equal(new Set(fake.schedules.map(row => row.schedule_id)).size, 2);
  assert.match(moved.said, /moves to Mon, Oct 5, 4:00 PM\. The reminder and the check move with it\./);
  // Keeping it again keeps the chosen time.
  const again = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam', 'Dana Lee'], cadence: { every: 'day' } });
  assert.equal(again.needs_time, undefined);
  assert.match(again.said, /every day at 16:00/);
  await assert.rejects(tool.run({ operation: 'retime', space_id: 'space_1', agreement_id: kept.agreement_id, at: '4pm' }), /at is the time/);
  const asked = await tool.run({ operation: 'ask_time', space_id: 'space_1', agreement_id: kept.agreement_id, because: 'Nobody said the time.' });
  assert.equal(asked.suggested_at, '16:00');
  assert.match(fake.told.at(-1).body, /Suggested: 16:00\..*Nobody said the time\./);
});

test('a meeting nobody set up marks everyone who agreed as not arranged', async () => {
  let clock = Date.parse('2026-10-05T19:30:00Z');
  const fake = fakeIo({ now: () => clock });
  const tool = makeHoldToIt(fake.io);
  // Kept after today's meeting time: the first booked meeting is tomorrow, so today was never arranged.
  const { agreement_id } = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam', 'Dana Lee'], cadence });
  clock = Date.parse('2026-10-05T19:40:00Z');
  const checked = await tool.run({ operation: 'check', space_id: 'space_1', agreement_id });
  assert.equal(checked.arranged, false);
  assert.deepEqual(checked.marks.map(row => row.mark), ['not-arranged', 'not-arranged']);
  assert.match(checked.said, /nobody set it up/);
});

test('remind says it in the space, tells the person and turns listening on', async () => {
  let clock = Date.parse('2026-10-05T17:00:00Z');
  const fake = fakeIo({ now: () => clock });
  const tool = makeHoldToIt(fake.io);
  const { agreement_id } = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Daily team meeting', agreed_by: ['Sam'], cadence });
  clock = Date.parse('2026-10-05T17:50:00Z');
  const reminded = await tool.run({ operation: 'remind', space_id: 'space_1', agreement_id });
  assert.match(reminded.said, /starts in 10 minutes/);
  assert.equal(fake.ran[0].tool_id, 'tool:listen');
  assert.equal(fake.told.length, 1);
});

test('an unknown operation and a missing agreement say what to send', async () => {
  const tool = makeHoldToIt(fakeIo({ now: () => Date.now() }).io);
  await assert.rejects(tool.run({ operation: 'nope' }), /Choose an operation/);
  await assert.rejects(tool.run({ operation: 'check', space_id: 'space_1', agreement_id: 'item_x' }), /No agreement item_x/);
  await assert.rejects(tool.run({ operation: 'keep', space_id: 'space_1', what: 'x' }), /agreed_by/);
});

test('a one-time session is on the calendar however far off it is, with its reminder and its check', async () => {
  const now = () => Date.parse('2026-10-07T23:40:00Z');
  const fake = fakeIo({ now });
  const tool = makeHoldToIt(fake.io);
  const once = (date, at = '09:00') => ({ every: 'once', date, at, minutes: 150, time_zone: ZONE });
  const soon = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Learning Mastery lock-in', agreed_by: ['Sam'], cadence: once('2026-10-08') });
  assert.equal(soon.booked.starts_at, '2026-10-08T16:00:00.000Z');
  const far = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Quarterly review', agreed_by: ['Sam'], cadence: once('2026-11-20', '10:30') });
  assert.equal(far.booked?.starts_at, '2026-11-20T18:30:00.000Z');
  assert.deepEqual(fake.events.map(event => event.starts_at), ['2026-10-08T16:00:00.000Z', '2026-11-20T18:30:00.000Z']);
  assert.deepEqual(fake.schedules.filter(row => row.then.input.agreement_id === far.agreement_id).map(row => [row.once_at, row.then.input.operation]), [['2026-11-20T18:20:00.000Z', 'remind'], ['2026-11-20T21:30:00.000Z', 'check']]);
});

test('weekly reminder and check offsets shift weekday data across midnight and week boundaries', async () => {
  const now = () => Date.parse('2026-10-05T12:00:00Z');
  const fake = fakeIo({ now });
  const tool = makeHoldToIt(fake.io);
  const kept = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Monday check-in', agreed_by: ['Sam'], cadence: { every: 'week', on: ['monday'], at: '00:05', minutes: 30, time_zone: ZONE } });
  const rows = fake.schedules.filter(row => row.then.input.agreement_id === kept.agreement_id);
  assert.deepEqual(rows.map(row => [row.then.input.operation, row.every.at, row.every.on]), [
    ['remind', '23:55', ['sunday']],
    ['check', '01:05', ['monday']],
  ]);

  const second = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Late meeting', agreed_by: ['Sam'], cadence: { every: 'week', on: ['monday'], at: '23:45', minutes: 30, time_zone: ZONE } });
  const lateCheck = fake.schedules.find(row => row.then.input.agreement_id === second.agreement_id && row.then.input.operation === 'check');
  assert.deepEqual([lateCheck.every.at, lateCheck.every.on], ['00:45', ['tuesday']]);

  const manyDays = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Long session', agreed_by: ['Sam'], cadence: { every: 'week', on: ['monday', 'wednesday'], at: '00:05', minutes: 1500, time_zone: ZONE } });
  const longCheck = fake.schedules.find(row => row.then.input.agreement_id === manyDays.agreement_id && row.then.input.operation === 'check');
  assert.deepEqual([longCheck.every.at, longCheck.every.on], ['01:35', ['tuesday', 'thursday']], 'offsets spanning more than one day shift every weekday by the full day count');

  const weekWrap = await tool.run({ operation: 'keep', space_id: 'space_1', what: 'Sunday session', agreed_by: ['Sam'], cadence: { every: 'week', on: ['sunday'], at: '00:05', minutes: 30, time_zone: ZONE } });
  const wrappedReminder = fake.schedules.find(row => row.then.input.agreement_id === weekWrap.agreement_id && row.then.input.operation === 'remind');
  assert.deepEqual([wrappedReminder.every.at, wrappedReminder.every.on], ['23:55', ['saturday']]);
});

test('a one-time session whose day nobody said is never kept as if it were on the calendar', async () => {
  const fake = fakeIo({ now: () => Date.parse('2026-10-07T23:40:00Z') });
  const kept = await makeHoldToIt(fake.io).run({ operation: 'keep', space_id: 'space_1', what: 'Study session', agreed_by: ['Sam'], cadence: { every: 'once', at: '09:00', time_zone: ZONE } });
  assert.equal(kept.needs_time, true);
  assert.equal(fake.events.length, 0);
  assert.equal(fake.schedules.length, 0);
  assert.equal(fake.told[0].key, `hold-time:${kept.agreement_id}`);
  assert.match(kept.said, /agreed to it once at 09:00, but nobody said when/);
});
