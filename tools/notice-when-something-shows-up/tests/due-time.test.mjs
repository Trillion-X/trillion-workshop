// tools/notice-when-something-shows-up/tests/due-time.test.mjs
//
// The due-time leaf over timed-action (tools/run-work-later-or-on-a-repeat whenToWake): what the engine's own time
// wake tests asked of time (trillion-rust src/wake/tests.rs: a new repeat waits for its first time from now, a restart
// never fires twice, a zone keeps its wall-clock time, a once-at time is told once), now answered by timed-action's own
// rows, plus what only timed-action has: its clock-change rule per schedule, one run on waking for a schedule that
// repeats within the day, one-off actions. The clock is a script: each wait jumps to the next time it names, and the
// watch ends after the last.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSettings, watchForTransitions } from '../do-work/mechanisms/due-time.mjs';
import { engineCarrier } from '../do-work/tell-the-engine.mjs';

const action = { operation: 'tell', owner_ref: 'wake:arrive', owner_dispatch: { name: 'wake:arrive', input: {} }, completion: { mode: 'synchronous-owner-return' } };
const schedule = (fields) => ({ schedule_id: 'schedule:review', source_generation: 1, schedule_revision: 1, timezone: 'America/New_York',
  start_local_date: '2020-01-06', cadence: { unit: 'week', weekdays: [1] }, local_window: { start: '09:00', duration_minutes: 30 }, action, ...fields });

/** Watch `settings` from `start` (ISO), each wait jumping to the next of `jumps`; told transitions answer `answers` in turn. */
async function watch(settings, { start, jumps, state = null, answers = [], listening }) {
  let now = Date.parse(start);
  const told = [];
  const kept = [];
  const said = [];
  const controller = new AbortController();
  await watchForTransitions(settings, {
    signal: controller.signal,
    state,
    nowMs: () => now,
    sleep: async () => {
      if (jumps.length === 0) controller.abort();
      else now = Date.parse(jumps.shift());
    },
    keepState: async (value) => { kept.push(value); },
    say: (line) => said.push(line),
    listening: listening ? (kind) => listening(kind, now) : undefined,
    onTransition: async (transition) => {
      told.push(transition);
      return answers.length > 0 ? answers.shift() : true;
    },
  });
  return { told, kept, said, last: told.at(-1)?.state ?? kept.at(-1) };
}

const starts = (told) => told.map((fact) => fact.detail.start);
/** A wake as wake:list answers it, hearing due-time and asking `watch`. */
const listener = (watch, switched_on = true) => ({ tool: 'workflow:daily', id: 'daily', switched_on, on: { fact: { kind: 'due-time', from: ['run'], match: { schedule_id: watch.schedules?.[0]?.schedule_id }, watch } } });

test('a schedule first seen starts at its first time from now, and Monday 09:00 New York holds across the clock change', async () => {
  const { told, kept } = await watch({ schedules: [schedule()] },
    { start: '2026-03-01T12:00:00Z', jumps: ['2026-03-02T14:00:00Z', '2026-03-09T13:00:00Z'] });
  assert.equal(kept[0].first_seen_ms, Date.parse('2026-03-01T12:00:00Z'), 'the first-seen time is kept before anything is told');
  assert.deepEqual(starts(told), ['2026-03-02T14:00:00.000Z', '2026-03-09T13:00:00.000Z'], 'six years since start_local_date are not caught up');
  assert.ok(told.every((fact) => fact.detail.schedule_id === 'schedule:review'));
  assert.ok(told.every((fact) => fact.event_key.startsWith('timed-action.recurring-window::')), 'each is named by its occurrence key');
});

test('a restart resumes from the kept state: nothing told twice, the state holds one proof however long it runs', async () => {
  const first = await watch({ schedules: [schedule()] }, { start: '2026-03-01T12:00:00Z', jumps: ['2026-03-02T14:00:00Z'] });
  const again = await watch({ schedules: [schedule()] }, { start: '2026-03-02T14:30:00Z', jumps: [], state: first.last });
  assert.equal(again.told.length, 0);
  let state = first.last;
  const sizes = [];
  for (const week of ['2026-03-09T13:00:00Z', '2026-03-16T13:00:00Z', '2026-03-23T13:00:00Z']) {
    state = (await watch({ schedules: [schedule()] }, { start: week, jumps: [], state })).last;
    sizes.push(JSON.stringify(state).length);
  }
  assert.equal(state.schedules['schedule:review'].proofs.length, 1);
  assert.equal(new Set(sizes).size, 1, `the state does not grow week to week: ${sizes}`);
});

test('a weekly schedule asleep for three weeks is told once, for its latest week, saying it missed the two before', async () => {
  const first = await watch({ schedules: [schedule()] }, { start: '2026-03-01T12:00:00Z', jumps: ['2026-03-02T14:00:00Z'] });
  assert.equal(first.told[0].detail.missed_before, 0, 'on time it missed none');
  const woke = await watch({ schedules: [schedule()] }, { start: '2026-03-25T12:00:00Z', jumps: [], state: first.last });
  assert.deepEqual(woke.told.map((fact) => [fact.detail.start, fact.detail.missed_before]), [['2026-03-23T13:00:00.000Z', 2]]);
});

test('a schedule that repeats within the day, asleep, runs once on waking', async () => {
  const every15 = schedule({ cadence: { unit: 'minute', interval: 15 }, local_window: { start: '00:00', duration_minutes: 5 }, timezone: 'UTC' });
  const first = await watch({ schedules: [every15] }, { start: '2026-03-02T10:01:00Z', jumps: ['2026-03-02T10:15:00Z'] });
  assert.deepEqual(starts(first.told), ['2026-03-02T10:15:00.000Z']);
  const woke = await watch({ schedules: [every15] }, { start: '2026-03-02T13:07:00Z', jumps: [], state: first.last });
  assert.deepEqual(starts(woke.told), ['2026-03-02T13:00:00.000Z']);
});

test('each schedule keeps its own clock-change rule: a skipped 02:30 is skipped or moved, as the schedule says', async () => {
  const nightly = (dst) => schedule({ schedule_id: 'schedule:nightly', cadence: { unit: 'day' }, local_window: { start: '02:30', duration_minutes: 10 }, dst });
  const skip = await watch({ schedules: [nightly({ gap: 'skip' })] }, { start: '2026-03-07T12:00:00Z', jumps: ['2026-03-08T07:30:00Z', '2026-03-09T06:30:00Z'] });
  assert.deepEqual(starts(skip.told), ['2026-03-09T06:30:00.000Z'], 'Mar 8 has no 02:30');
  const moved = await watch({ schedules: [nightly({ gap: 'next-valid' })] }, { start: '2026-03-07T12:00:00Z', jumps: ['2026-03-08T07:00:00Z'] });
  assert.deepEqual(starts(moved.told), ['2026-03-08T07:00:00.000Z'], '03:00 EDT, the first minute after the gap');
});

test('a fold told as both instants tells both, once each', async () => {
  const nightly = schedule({ schedule_id: 'schedule:fold', cadence: { unit: 'day' }, local_window: { start: '01:30', duration_minutes: 10 }, dst: { fold: 'both' } });
  const { told } = await watch({ schedules: [nightly] }, { start: '2026-10-31T12:00:00Z', jumps: ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-02T06:30:00Z'] });
  assert.deepEqual(starts(told), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  assert.equal(new Set(told.map((fact) => fact.event_key)).size, 3);
});

test('a one-off action is told once at its time, and its receipt keeps it from being told again', async () => {
  const oneOff = { time_windows: [{ record_id: 'remind-a', due_at: '2026-03-10T09:00:00Z' }],
    actions: [{ record_id: 'remind-a', action_id: 'send', dispatch: { name: 'wake:arrive' } }] };
  const first = await watch(oneOff, { start: '2026-03-09T00:00:00Z', jumps: ['2026-03-10T09:00:00Z'] });
  assert.deepEqual(first.told.map((fact) => [fact.detail.record_id, fact.event_key]), [['remind-a', 'remind-a#send']]);
  const again = await watch(oneOff, { start: '2026-03-11T00:00:00Z', jumps: [], state: first.last });
  assert.equal(again.told.length, 0);
});

test('a refused tell leaves the occurrence due, and it is told again', async () => {
  const { told } = await watch({ schedules: [schedule()], retry_seconds: 5 },
    { start: '2026-03-01T12:00:00Z', jumps: ['2026-03-02T14:00:00Z', '2026-03-02T14:00:05Z'], answers: [false, true] });
  assert.deepEqual(starts(told), ['2026-03-02T14:00:00.000Z', '2026-03-02T14:00:00.000Z']);
  assert.equal(told[0].event_key, told[1].event_key, 'the same occurrence, the same key');
});

test('timed-action refuses a schedule it cannot read, and says so once', async () => {
  const { told, said } = await watch({ schedules: [schedule({ timezone: 'Mars/Olympus_Mons' })] }, { start: '2026-03-01T12:00:00Z', jumps: ['2026-03-02T14:00:00Z'] });
  assert.equal(told.length, 0);
  assert.deepEqual(said, ['due-time: timed-action refused schedule schedule:review: invalid_timezone']);
  assert.equal(readSettings({}), null, 'settings naming nothing are refused');
});

test('the engine carrier names a fact by its event key and keeps the waiter state in its kept folder across runs', async () => {
  const keep = tempFolder(path.join(tmpdir(), 'noticer-kept-'));
  const sent = [];
  const fetchImpl = async (url, { body }) => {
    sent.push(JSON.parse(body).params.arguments.input);
    return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  };
  const door = { url: 'http://door.test/mcp', capability: 'c' };
  const first = engineCarrier({ door, waiters: [], fetchImpl, say: () => {}, keep });
  await first.keepState('clock::due', { first_seen_ms: 1 });
  await first.writeRecord({ addressLabel: 'clock::due', payload: { kind: 'due-time', schedule_id: 's', sequence: 0 }, eventKey: 'k1', state: { first_seen_ms: 1, schedules: {}, receipts: [] } });
  assert.equal(sent[0].event_id, 'clock::due@k1');
  const restarted = engineCarrier({ door, waiters: [], fetchImpl, say: () => {}, keep });
  assert.deepEqual((await restarted.readCurrent('clock::due')).state, { first_seen_ms: 1, schedules: {}, receipts: [] });
  assert.equal(await restarted.readCurrent('nothing::here'), null);
});

test('from_wakes: the schedules switched-on wakes ask for are watched, each once, and one switched on later starts then', async () => {
  const daily = schedule({ schedule_id: 'schedule:daily-14', cadence: { unit: 'day' }, local_window: { start: '14:00', duration_minutes: 1 }, timezone: 'UTC' });
  const hourly = schedule({ schedule_id: 'schedule:hourly', cadence: { unit: 'hour' }, local_window: { start: '00:00', duration_minutes: 1 }, timezone: 'UTC' });
  const asked = [];
  const listening = async (kind, now) => {
    asked.push(kind);
    // The hourly wake is switched on at 15:30; two wakes ask for the same daily schedule.
    const wakes = [listener({ schedules: [daily] }), listener({ schedules: [daily] })];
    return now >= Date.parse('2026-03-02T15:30:00Z') ? [...wakes, listener({ schedules: [hourly] })] : wakes;
  };
  const { told } = await watch({ from_wakes: { kind: 'due-time' }, look_again_seconds: 3600 },
    { start: '2026-03-02T12:00:00Z', jumps: ['2026-03-02T13:00:00Z', '2026-03-02T14:00:00Z', '2026-03-02T15:30:00Z', '2026-03-02T16:00:00Z'], listening });
  assert.ok(asked.every((kind) => kind === 'due-time'));
  assert.deepEqual(told.map((fact) => [fact.detail.schedule_id, fact.detail.start]), [
    ['schedule:daily-14', '2026-03-02T14:00:00.000Z'],
    ['schedule:hourly', '2026-03-02T16:00:00.000Z'],
  ], 'the daily schedule once, and the hourly one from when its wake was switched on, not the times before');
});

test('from_wakes: a wake the engine could not list is said once, and the leaf keeps looking', async () => {
  const { told, said } = await watch({ from_wakes: { kind: 'due-time' }, look_again_seconds: 60 },
    { start: '2026-03-02T12:00:00Z', jumps: ['2026-03-02T12:01:00Z', '2026-03-02T12:02:00Z'], listening: async () => { throw new Error('the door said no'); } });
  assert.equal(told.length, 0);
  assert.deepEqual(said, ['due-time: the door said no']);
});

// Kept workflow rows (`from_rows`): each pass reads the rows' switched-on wake entries through the waiter's own database,
// here a stand-in whose answer the test changes between passes.
const kept = (id, cadence, extra = {}) => ({ id, switched_on: true, on: { fact: { kind: 'due-time', from: ['run'], match: { schedule_id: `schedule:${id}` },
  watch: { schedules: [schedule({ schedule_id: `schedule:${id}`, timezone: 'UTC', start_local_date: '1970-01-01', cadence, local_window: { start: '00:00', duration_minutes: 1 } })] } } }, ...extra });

/** Watch `from_rows` with a database whose rows answer `rowsAt(now)` (a list of wake entries, or an Error to throw). */
async function watchRows(rowsAt, { start, jumps }) {
  let now = Date.parse(start);
  const told = [];
  const said = [];
  const asked = [];
  const controller = new AbortController();
  await watchForTransitions({ from_rows: {}, look_again_seconds: 60 }, {
    signal: controller.signal,
    nowMs: () => now,
    sleep: async () => {
      if (jumps.length === 0) controller.abort();
      else now = Date.parse(jumps.shift());
    },
    say: (line) => said.push(line),
    connection: 'postgres://stand-in',
    connect: async () => ({ query: async (sql) => {
      asked.push(sql);
      const rows = rowsAt(now);
      if (rows instanceof Error) throw rows;
      return { rows: rows.map((wake) => ({ wake })) };
    } }),
    onTransition: async (transition) => { told.push(transition); return true; },
  });
  return { told, said, asked };
}

test('a kept row switched on is watched from its own wakes, and a row changed or taken away is rewatched or let go', async () => {
  const every = (minutes) => ({ unit: 'minute', interval: minutes });
  const { told, asked } = await watchRows((now) => {
    if (now < Date.parse('2026-11-21T10:20:30Z')) return [kept('a', every(10))];
    if (now < Date.parse('2026-11-21T10:40:30Z')) return [kept('a', every(10)), kept('b', every(5))];
    return [kept('a', every(30))];
  }, { start: '2026-11-21T10:00:30Z', jumps: ['2026-11-21T10:10:00Z', '2026-11-21T10:20:30Z', '2026-11-21T10:25:00Z', '2026-11-21T10:30:00Z',
    '2026-11-21T10:40:30Z', '2026-11-21T10:50:00Z', '2026-11-21T11:00:00Z'] });
  assert.ok(asked.every((sql) => /FROM workflow_recipes r/.test(sql) && /switched_on/.test(sql)), 'the default table and column, switched-on entries only');
  const seen = told.map((fact) => `${fact.detail.schedule_id}@${fact.detail.start.slice(11, 16)}`);
  assert.deepEqual(seen, ['schedule:a@10:10', 'schedule:a@10:20', 'schedule:b@10:25', 'schedule:a@10:30', 'schedule:b@10:30', 'schedule:a@11:00'],
    'b is watched once its row says so and let go once it does not; a at 30 minutes skips 10:50');
});

test('kept rows that name nothing, a malformed cadence, a failed read and a name that is not plain', async () => {
  const empty = await watchRows(() => [{ id: 'x', switched_on: true }, { id: 'y', switched_on: true, on: { fact: { kind: 'due-time' } } }],
    { start: '2026-11-21T10:00:30Z', jumps: ['2026-11-21T10:10:00Z'] });
  assert.deepEqual(empty.told, [], 'an entry with no watch names no time');
  const bad = await watchRows(() => [kept('bad', { unit: 'fortnight' })], { start: '2026-11-21T10:00:30Z', jumps: ['2026-11-21T10:10:00Z'] });
  assert.deepEqual(bad.told, []);
  assert.ok(bad.said.some((line) => /refused schedule schedule:bad/.test(line)), `timed-action's refusal is said: ${bad.said}`);
  let calls = 0;
  const flaky = await watchRows(() => (calls++ === 1 ? new Error('connection lost') : [kept('a', { unit: 'minute', interval: 10 })]),
    { start: '2026-11-21T10:00:30Z', jumps: ['2026-11-21T10:05:00Z', '2026-11-21T10:10:00Z'] });
  assert.ok(flaky.said.some((line) => /kept rows could not be read: connection lost/.test(line)));
  assert.deepEqual(flaky.told.map((fact) => fact.detail.start.slice(11, 16)), ['10:10'], 'a failed read keeps what the last read found');
  assert.throws(() => readSettings({ from_rows: { table: 'workflow_recipes; drop table x' } }), /not a plain name/);
  assert.notEqual(readSettings({ from_rows: {} }), null, 'from_rows alone is something to wait for');
});

test('a connection lost between reads is opened again at the next read, said once, and never ends the waiter', async () => {
  // Nov 22 2026, 2:02 to 2:48 AM CST on the Mac: the run proxy's tunnel closed while the waiter slept; pg emitted 'error'
  // with no listener and the session crashed 8 times. A pg client is an EventEmitter: an 'error' no one hears throws.
  let now = Date.parse('2026-11-21T10:00:30Z');
  const jumps = ['2026-11-21T10:05:00Z', '2026-11-21T10:10:00Z', '2026-11-21T10:15:00Z', '2026-11-21T10:20:00Z'];
  const told = [];
  const said = [];
  const clients = [];
  const controller = new AbortController();
  await watchForTransitions({ from_rows: {}, look_again_seconds: 60 }, {
    signal: controller.signal,
    nowMs: () => now,
    sleep: async () => {
      if (clients.length === 1 && now === Date.parse('2026-11-21T10:05:00Z')) clients[0].emit('error', new Error('Connection terminated unexpectedly'));
      if (jumps.length === 0) controller.abort();
      else now = Date.parse(jumps.shift());
    },
    say: (line) => said.push(line),
    connection: 'postgres://stand-in',
    connect: async () => {
      const client = Object.assign(new EventEmitter(), { ended: false });
      client.query = async () => {
        if (client.ended) throw new Error('Client was closed and is not queryable');
        return { rows: [{ wake: kept('a', { unit: 'minute', interval: 10 }) }] };
      };
      client.end = async () => { client.ended = true; };
      clients.push(client);
      return client;
    },
    onTransition: async (transition) => { told.push(transition); return true; },
  });
  assert.equal(clients.length, 2, 'the lost connection is let go and one new one is opened');
  assert.ok(clients[0].ended, 'the lost one is ended');
  assert.deepEqual(said.filter((line) => /connection was lost: Connection terminated unexpectedly/.test(line)).length, 1, `said once: ${said}`);
  assert.deepEqual(told.map((fact) => fact.detail.start.slice(11, 16)), ['10:10', '10:20'], 'every time after the loss is still told');
});
