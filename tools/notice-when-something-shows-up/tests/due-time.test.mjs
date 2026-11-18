// tools/notice-when-something-shows-up/tests/due-time.test.mjs
//
// The due-time leaf gives the results of the engine's own time wake tests (trillion-rust src/wake/tests.rs
// a_missed_repeat_fires_once_on_wake, a_repeat_in_a_time_zone_keeps_its_wall_clock_time, the once-at tests), plus the
// clock changes wake only says in words: a skipped wall time is the first minute after the gap, a repeated one its
// earlier instant. The clock is a script: each wait jumps to the next time it names, and the watch ends after the last.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSettings, repeatOf, watchForTransitions } from '../do-work/mechanisms/due-time.mjs';
import { engineCarrier } from '../do-work/tell-the-engine.mjs';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

/** Watch `settings` from `start`, each wait jumping to the next of `jumps`; told transitions answer `answers` in turn. */
async function watch(settings, { start, jumps, state = null, answers = [] }) {
  let now = start;
  const told = [];
  const kept = [];
  const controller = new AbortController();
  await watchForTransitions(settings, {
    signal: controller.signal,
    state,
    nowMs: () => now,
    sleep: async () => {
      if (jumps.length === 0) controller.abort();
      else now = jumps.shift();
    },
    keepState: async (value) => { kept.push(value); },
    onTransition: async (transition) => {
      told.push(transition);
      return answers.length > 0 ? answers.shift() : true;
    },
  });
  return { told, kept };
}

test('a new repeat waits for its first due time from now, and a missed repeat fires once saying how many it missed', async () => {
  const { told, kept } = await watch({ every_ms: HOUR, from_ms: 0 }, { start: HOUR / 2, jumps: [HOUR, 11 * HOUR] });
  assert.deepEqual(kept, [{ next_ms: HOUR }], 'its first due time is kept before anything is told');
  assert.deepEqual(told.map(fact => fact.detail), [{ due_ms: HOUR, missed: 0 }, { due_ms: 11 * HOUR, missed: 9 }]);
  assert.deepEqual(told.map(fact => fact.event_key), [String(HOUR), String(11 * HOUR)]);
  assert.deepEqual(told.at(-1).state, { next_ms: 12 * HOUR });
});

test('a restart resumes from the kept next due time: nothing told again, and a due time it slept through still fires', async () => {
  const again = await watch({ every_ms: HOUR, from_ms: 0 }, { start: 11 * HOUR + 5, jumps: [], state: { next_ms: 12 * HOUR } });
  assert.equal(again.told.length, 0);
  const slept = await watch({ every_ms: HOUR, from_ms: 0 }, { start: 14 * HOUR + 5, jumps: [], state: { next_ms: 12 * HOUR } });
  assert.deepEqual(slept.told.map(fact => fact.detail), [{ due_ms: 14 * HOUR, missed: 2 }]);
});

test('a repeat in a time zone keeps its wall-clock time across a change of offset', async () => {
  // Monday 2026-10-26 15:00 UTC is 9:00 AM MDT; daylight time ends Sunday 2026-11-01, so Monday 2026-11-02 9:00 AM MST
  // is 16:00 UTC, one hour later than a fixed week.
  const mondayMdt = 1_793_026_800_000;
  const denver = repeatOf(readSettings({ every_ms: WEEK, from_ms: mondayMdt, zone: 'America/Denver' }));
  assert.equal(denver.slot(1), mondayMdt + WEEK + HOUR);
  assert.equal(denver.slot(2), mondayMdt + 2 * WEEK + HOUR);
  assert.equal(denver.lastAtOrBefore(mondayMdt + WEEK + HOUR - 1), 0);
  assert.equal(denver.after(mondayMdt), mondayMdt + WEEK + HOUR);
  assert.equal(repeatOf(readSettings({ every_ms: WEEK, from_ms: mondayMdt })).slot(1), mondayMdt + WEEK);
  assert.equal(readSettings({ every_ms: WEEK, zone: 'Mars/Olympus_Mons' }), null);
  assert.equal(readSettings({ at_ms: mondayMdt, zone: 'America/Denver' }), null);
  assert.equal(readSettings({ every_ms: 0 }), null);

  const { told } = await watch({ every_ms: WEEK, from_ms: mondayMdt, zone: 'America/Denver' },
    { start: mondayMdt - HOUR, jumps: [mondayMdt + 3 * WEEK + HOUR + 1] });
  assert.deepEqual(told.map(fact => fact.detail), [{ due_ms: mondayMdt + 3 * WEEK + HOUR, missed: 3 }]);
  assert.deepEqual(told[0].state, { next_ms: mondayMdt + 4 * WEEK + HOUR });
});

test('a wall time the zone skips is the first minute after the gap, and one it repeats is its earlier instant', () => {
  const DAY = 24 * HOUR;
  // New York springs forward on Sunday 2026-03-08: 2:30 AM does not happen that day.
  const daily = repeatOf(readSettings({ every_ms: DAY, from_ms: Date.UTC(2026, 2, 7, 7, 30), zone: 'America/New_York' }));
  assert.equal(daily.slot(1), Date.UTC(2026, 2, 8, 7, 0), '3:00 AM EDT, the first minute after the gap');
  assert.equal(daily.slot(2), Date.UTC(2026, 2, 9, 6, 30), '2:30 AM EDT');
  // New York falls back on Sunday 2026-11-01: 1:30 AM happens twice.
  const fold = repeatOf(readSettings({ every_ms: DAY, from_ms: Date.UTC(2026, 9, 31, 5, 30), zone: 'America/New_York' }));
  assert.equal(fold.slot(1), Date.UTC(2026, 10, 1, 5, 30), '1:30 AM EDT, the earlier of the two');
  assert.equal(fold.slot(2), Date.UTC(2026, 10, 2, 6, 30), '1:30 AM EST');
  // A zone a quarter hour off the hour, and one whose clocks move by half an hour.
  const kathmandu = repeatOf(readSettings({ every_ms: DAY, from_ms: Date.UTC(2026, 0, 1, 3, 15), zone: 'Asia/Kathmandu' }));
  assert.equal(kathmandu.slot(400), Date.UTC(2026, 0, 1, 3, 15) + 400 * DAY);
  const lordHowe = repeatOf(readSettings({ every_ms: DAY, from_ms: Date.UTC(2026, 2, 1, 22, 0), zone: 'Australia/Lord_Howe' }));
  assert.equal(lordHowe.slot(60) - lordHowe.slot(0), 60 * DAY + HOUR / 2, '9 AM stays 9 AM when the clocks go back half an hour');
});

test('a once-at time is told once, at its time, and never again', async () => {
  const first = await watch({ at_ms: 5 * HOUR }, { start: HOUR, jumps: [5 * HOUR] });
  assert.deepEqual(first.told.map(fact => [fact.detail, fact.event_key, fact.state]),
    [[{ due_ms: 5 * HOUR, missed: 0 }, String(5 * HOUR), { done: true, due_ms: 5 * HOUR }]]);
  const again = await watch({ at_ms: 5 * HOUR }, { start: 6 * HOUR, jumps: [], state: first.told[0].state });
  assert.equal(again.told.length, 0);
  const late = await watch({ at_ms: 5 * HOUR }, { start: 9 * HOUR, jumps: [] });
  assert.equal(late.told.length, 1, 'a once-at time not yet told is told when the watch starts after it');
});

test('a refused tell is counted as missed by the next due time told', async () => {
  const { told } = await watch({ every_ms: HOUR, from_ms: 0 }, { start: HOUR / 2, jumps: [HOUR, 2 * HOUR], answers: [false, true] });
  assert.deepEqual(told.map(fact => fact.detail), [{ due_ms: HOUR, missed: 0 }, { due_ms: 2 * HOUR, missed: 1 }]);
});

test('the engine carrier names a fact by its event key and keeps the waiter state in its kept folder across runs', async () => {
  const keep = mkdtempSync(path.join(tmpdir(), 'noticer-kept-'));
  const sent = [];
  const fetchImpl = async (url, { body }) => {
    sent.push(JSON.parse(body).params.arguments.input);
    return new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
  };
  const door = { url: 'http://door.test/mcp', capability: 'c' };
  const first = engineCarrier({ door, waiters: [], fetchImpl, say: () => {}, keep });
  await first.keepState('clock::due', { next_ms: HOUR });
  await first.writeRecord({ addressLabel: 'clock::due', payload: { kind: 'due-time', due_ms: HOUR, sequence: 0 }, eventKey: String(HOUR), state: { next_ms: 2 * HOUR } });
  assert.equal(sent[0].event_id, `clock::due@${HOUR}`);
  const restarted = engineCarrier({ door, waiters: [], fetchImpl, say: () => {}, keep });
  assert.deepEqual(await restarted.readCurrent('clock::due'), { payload: { kind: 'due-time', due_ms: HOUR, sequence: 0 }, state: { next_ms: 2 * HOUR } });
  assert.equal(await restarted.readCurrent('nothing::here'), null);
});
