// What an outside service answered is kept and read from there (src/outside-readings.mjs): looking never asks the
// service, a source is read on its own cadence, a read that finds nothing new writes nothing, a new period is read at
// once, and an answer that is not kept (not connected) is held for one cadence and never scheduled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { outsideReadings } from '../from-old-trillion/src/outside-readings.mjs';
import spendData from '../../shared-code/src/spend-meter.json' with { type: 'json' };

const MINUTE = 60_000;
function harness() {
  let clock = Date.parse('2026-10-05T09:00:00Z');
  const stored = new Map();
  const writes = [];
  let asks = 0;
  const kept = outsideReadings({
    get: id => stored.get(id) ?? null,
    set: (id, value) => { writes.push(id); stored.set(id, value); },
    onAsk: () => { asks += 1; },
    now: () => clock,
  });
  return { kept, writes, stored, asks: () => asks, advance: minutes => { clock += minutes * MINUTE; }, now: () => clock };
}

test('looking never reads a source; a source nobody read is asked for once and read on the next wake', async () => {
  const { kept, writes, asks } = harness();
  const source = { id: 'usage:today', since: '2026-10-05', every_minutes: 15 };
  let reads = 0;
  const read = async () => { reads += 1; return { rows: 10 }; };
  assert.equal(kept.latest(source), null);
  assert.equal(kept.latest(source), null);
  assert.equal(reads, 0, 'a look never reads');
  assert.equal(asks(), 1, 'asked once, however many looks');
  assert.equal(kept.nextAt([source]) !== null, true);
  assert.deepEqual(await kept.refresh([source], { read }), ['usage:today']);
  assert.equal(reads, 1);
  assert.deepEqual(writes, ['usage:today']);
  assert.deepEqual(kept.latest(source).answer, { rows: 10 });
  assert.equal(kept.latest(source).read_at, '2026-10-05T09:00:00.000Z');
});

test('a source is read on its own cadence, and a read that finds nothing new writes nothing', async () => {
  const { kept, writes, advance } = harness();
  const source = { id: 'machines:now', every_minutes: 60 };
  let answer = { apps: [{ name: 'a' }] };
  let reads = 0;
  const read = async () => { reads += 1; return structuredClone(answer); };
  kept.latest(source);
  await kept.refresh([source], { read });
  advance(30);
  assert.deepEqual(await kept.refresh([source], { read }), [], 'not due before its cadence');
  assert.equal(reads, 1);
  advance(31);
  assert.deepEqual(await kept.refresh([source], { read }), [], 'due, read, unchanged');
  assert.equal(reads, 2);
  assert.equal(writes.length, 1, 'an unchanged answer writes nothing');
  assert.equal(kept.latest(source).read_at, '2026-10-05T10:01:00.000Z', 'the look still says when it was last read');
  answer = { apps: [{ name: 'a' }, { name: 'b' }] };
  advance(61);
  assert.deepEqual(await kept.refresh([source], { read }), ['machines:now']);
  assert.equal(writes.length, 2, 'a changed answer writes once');
});

test('looking at an overdue kept answer re-arms its alarm without reading the provider in the request', async () => {
  const { kept, advance, asks, now } = harness();
  const source = { id: 'usage:today', since: '2026-10-05', every_minutes: 15 };
  let reads = 0;
  kept.latest(source);
  await kept.refresh([source], { read: async () => { reads += 1; return { rows: 10 }; } });
  advance(16);
  const stale = kept.latest(source);
  assert.deepEqual(stale, { answer: { rows: 10 }, read_at: '2026-10-05T09:00:00.000Z' });
  assert.equal(reads, 1, 'the read does not ask the provider directly');
  kept.latest(source);
  assert.equal(asks(), 2, 'many looks re-arm one overdue refresh');
  assert.equal(kept.nextAt([source]), now(), 'the existing alarm can now read it');
  await kept.refresh([source], { read: async () => { reads += 1; return { rows: 12 }; } });
  assert.equal(reads, 2);
  assert.deepEqual(kept.latest(source).answer, { rows: 12 });
});

test('a kept answer for another period is not this period\'s, and is read again at once', async () => {
  const { kept, advance, now } = harness();
  const yesterday = { id: 'usage:today', since: '2026-10-05', every_minutes: 15 };
  kept.latest(yesterday);
  await kept.refresh([yesterday], { read: async () => ({ rows: 1 }) });
  advance(5);
  const today = { ...yesterday, since: '2026-10-06' };
  assert.equal(kept.nextAt([today]), now(), 'a new day is due now');
  assert.equal(kept.latest(today), null);
});

test('an answer that is not kept is held for one cadence, never written and never scheduled', async () => {
  const { kept, writes, advance } = harness();
  const source = { id: 'fly:now', every_minutes: 60 };
  kept.latest(source);
  await kept.refresh([source], { read: async () => ({ state: 'not-connected' }), keep: answer => answer.state !== 'not-connected' });
  assert.equal(writes.length, 0);
  assert.deepEqual(kept.latest(source).answer, { state: 'not-connected' });
  assert.equal(kept.nextAt([source]), null, 'nothing reads it again on its own');
  advance(61);
  assert.equal(kept.latest(source), null, 'after a cadence a look asks again (it may be connected now)');
  assert.notEqual(kept.nextAt([source]), null);
});

test('a disconnected new period is not immediately due again because an older period remains stored', async () => {
  const { kept, advance, now, writes } = harness();
  const yesterday = { id: 'spend:cloudflare-usage:today', since: '2026-10-05', every_minutes: 15 };
  kept.latest(yesterday);
  await kept.refresh([yesterday], { read: async () => ({ total: 12 }) });
  advance(5);
  const today = { ...yesterday, since: '2026-10-06' };
  assert.equal(kept.nextAt([today]), now(), 'the new period gets its first read immediately');
  await kept.refresh([today], { read: async () => ({ state: 'not-connected' }), keep: answer => answer.state !== 'not-connected' });
  assert.equal(kept.nextAt([today]), null, 'the disconnected observation suspends automatic reads despite yesterday\'s kept row');
  assert.deepEqual(await kept.refresh([today], { read: async () => { throw new Error('must wait for cadence'); }, keep: () => false }), []);
  assert.deepEqual(writes, [yesterday.id], 'the refused current-period answer is not persisted');
  advance(61);
  assert.equal(kept.nextAt([today]), null, 'elapsed cadence alone does not schedule a disconnected source');
  assert.equal(kept.latest(today), null, 'a fresh look explicitly asks again');
  assert.equal(kept.nextAt([today]), now());
});

test('a change notice reads a source at once', async () => {
  const { kept, now } = harness();
  const source = { id: 'usage:month', since: '2026-10-01', every_minutes: 15 };
  kept.latest(source);
  await kept.refresh([source], { read: async () => ({ rows: 1 }) });
  kept.readNow(source.id);
  assert.equal(kept.nextAt([source]), now());
});

test('every service reading Spend is built from says how often it is read', () => {
  for (const [id, reading] of Object.entries(spendData.readings)) {
    if (reading.kind !== 'service') continue;
    assert.ok(Number.isFinite(reading.every_minutes) && reading.every_minutes >= 1, `${id} has every_minutes`);
  }
  assert.equal('read_every_minutes' in spendData, false, 'no one cadence for every reading');
});
