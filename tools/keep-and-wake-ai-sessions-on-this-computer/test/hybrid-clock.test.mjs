// Ported from old trillion test/hybrid-clock.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The clock is this tool's src/hybrid-clock.mjs and the kept messages its src/messages.mjs;
// the store's arrival door (old src/inbound.mjs, gone) is stood in by the one call it made, messages.record. The
// microphone turns are tools/run-on-a-persons-computer/listen.mjs over tools/bring-in-new-items-from-this-computer's
// computer-sources.json (old computer/), its state in a scratch folder removed afterwards rather than under ~/.trillion
// and the Mac's trash. Every assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareHybridTimestamps, hybridTimestampKey, receiveHybridClock, tickHybridClock } from '../src/hybrid-clock.mjs';
import { messages } from '../src/messages.mjs';
import { localStore } from '../src/local-store.mjs';
import { rowOf, send, turnsOf } from '../../run-on-a-persons-computer/listen.mjs';

// The store's arrival door (old src/inbound.mjs `inbound`) kept what arrived as a person's message through
// messages.record, the app named by its route; this stand-in does only that.
const inbound = ({ kept }) => ({
  receive: ({ route, conversation_id, source_id, text, at, clock }) => kept.record({ messages: [{ speaker: 'person', conversation_id, source_id, text, at, clock }] }, { app: route }),
});

const sourceRows = JSON.parse(readFileSync(new URL('../../bring-in-new-items-from-this-computer/computer/computer-sources.json', import.meta.url), 'utf8'));
const listen = rowOf(sourceRows).listen;

test('a local clock never moves backward when the device wall clock moves backward', () => {
  const first = tickHybridClock(null, 1000, 'mac');
  const second = tickHybridClock(first, 900, 'mac');
  const third = tickHybridClock(second, 1000, 'mac');
  assert.deepEqual([first, second, third], [
    { wall_ms: 1000, logical: 0, device_id: 'mac' },
    { wall_ms: 1000, logical: 1, device_id: 'mac' },
    { wall_ms: 1000, logical: 2, device_id: 'mac' },
  ]);
  assert.ok(compareHybridTimestamps(first, second) < 0);
  assert.ok(compareHybridTimestamps(second, third) < 0);
});

test('receive merges the greatest physical/logical pair and the next local event follows it', () => {
  const local = { wall_ms: 5000, logical: 4, device_id: 'mac' };
  const remote = { wall_ms: 6000, logical: 8, device_id: 'phone' };
  const merged = receiveHybridClock(local, remote, 4500, 'mac');
  const next = tickHybridClock(merged, 4000, 'mac');
  assert.deepEqual(merged, { wall_ms: 6000, logical: 9, device_id: 'mac' });
  assert.deepEqual(next, { wall_ms: 6000, logical: 10, device_id: 'mac' });
  assert.ok(compareHybridTimestamps(remote, merged) < 0);
  assert.ok(compareHybridTimestamps(merged, next) < 0);
});

test('causal messages stay ordered across devices when the child device wall clock is behind', () => {
  const { eeaf } = localStore(':memory:');
  const kept = messages(eeaf, { now: () => new Date('2026-10-06T12:00:00Z') });
  const door = inbound({ kept, eeaf, arrivalsOf: () => [] });
  const parentAt = '2026-09-27T19:58:00.000Z';
  const childAt = '2026-09-27T19:00:00.000Z';
  const parentClock = { wall_ms: Date.parse(parentAt), logical: 7, device_id: 'mac' };
  const childClock = tickHybridClock(receiveHybridClock(null, parentClock, Date.parse(childAt), 'phone'), Date.parse(childAt), 'phone');

  door.receive({ route: 'Codex', conversation_id: 'shared:work', source_id: 'parent', text: 'Start the shared task', at: parentAt, clock: parentClock });
  door.receive({ route: 'Phone', conversation_id: 'shared:work', source_id: 'child', text: 'Continue the shared task', at: childAt, clock: childClock });

  const ordered = kept.read({ conversation_id: 'shared:work' }).messages;
  assert.deepEqual(ordered.map(message => message.text), ['Continue the shared task', 'Start the shared task']);
  assert.deepEqual(ordered.map(message => message.clock), [childClock, parentClock]);
  assert.ok(ordered[0].at < ordered[1].at, 'authored wall time remains available as data even though causal order controls the ID order');
  assert.ok(compareHybridTimestamps(ordered[1].clock, ordered[0].clock) < 0);
  assert.ok(compareHybridTimestamps(eeaf.read('setting:hybrid-clock-state').clock, childClock) > 0, 'the receiving store carries its merged state forward');
});

test('the HLC key sorts numeric wall and logical values before device tie breaks', () => {
  const lower = { wall_ms: 99, logical: 11, device_id: 'z' };
  const higher = { wall_ms: 100, logical: 0, device_id: 'a' };
  assert.ok(hybridTimestampKey(lower) < hybridTimestampKey(higher));
  assert.ok(compareHybridTimestamps({ wall_ms: 100, logical: 2, device_id: 'a' }, { wall_ms: 100, logical: 2, device_id: 'b' }) < 0);
});

test('microphone turns persist one device clock across calls and clock skew', async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'hybrid-clock-test-'));
  try {
    const waiting = path.join(state, 'waiting.json');
    const posted = [];
    const account = async (_route, { body }) => {
      posted.push(...body.items);
      return { status: 200, body: { items: body.items.map((_, index) => ({ message_id: `message:${posted.length + index}` })) } };
    };
    const status = { sent: 0, left_out: 0, waiting: 0 };
    const moment = { id: 'moment-a', computer: 'mac-a' };
    const turnAt = ms => turnsOf([{ start_ms: ms, end_ms: ms + 3000, text: 'I will send the invoice tomorrow.', voice: 'me', who: { id: 'me', name: 'Me', me: true }, score: 1 }])[0];
    await send([{ turn: turnAt(1790000000000), index: 0, moment }], { listen, account, log: () => {}, status, waiting, now: () => 1790000000000 });
    await send([{ turn: turnAt(1789999999000), index: 0, moment: { ...moment, id: 'moment-b' } }], { listen, account, log: () => {}, status, waiting, now: () => 1789999999000 });
    assert.equal(posted.length, 2);
    assert.deepEqual(posted.map(item => item.clock.device_id), ['mac-a', 'mac-a']);
    assert.ok(compareHybridTimestamps(posted[0].clock, posted[1].clock) < 0);
    assert.equal(posted[1].clock.wall_ms, posted[0].clock.wall_ms, 'a backward wall clock cannot move the device event time backward');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
