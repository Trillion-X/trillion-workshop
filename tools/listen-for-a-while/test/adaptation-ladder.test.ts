// tools/listen-for-a-while/show/adaptation-ladder.ts (moved with Trillion-X/trillion test/adaptation-ladder.test.ts): readings step the live-words stream (live-audio-stream.ts) down and up one rung at
// a time with named events, and a failed endpoint is left alone for a persisted cooldown. record-in-the-browser.ts, the consumer, stays in Trillion, so its wiring test stays there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFailover, createLadder, pageStore } from '../show/adaptation-ladder.ts';
import { createLiveStream } from '../show/live-audio-stream.ts';
import data from '../show/adaptation-ladder.json' with { type: 'json' };
import streamData from '../show/live-audio-stream.json' with { type: 'json' };

const BAD = { backlog: data.bad.backlog_bytes + 1 };
const memory = () => { const kept = new Map<string, string>(); return { kept, get: (key: string) => kept.get(key) ?? null, set: (key: string, value: string) => { kept.set(key, value); } }; };

test('bad readings step the live stream down one rung per run, never below the last, and good ones step it back up', () => {
  const rows = { ...streamData, codecs: streamData.codecs.map(row => ({ ...row, enabled: true })) };
  const lines: string[] = [];
  const stream = createLiveStream({
    open: () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} }), isOpen: () => true, chunkSeconds: 0.1,
    conditions: { browserHasOpus: true, routeAcceptsOpus: true, layerFlag: true, layerModelReady: true, rung: 0 }, onLine: line => lines.push(line), rows,
  });
  const events: string[] = [];
  const ladder = createLadder(change => { events.push(change.event); stream.setRung(change.rung); });
  assert.equal(stream.codec().id, 'opus-fec');
  ladder.observe(BAD);
  assert.equal(ladder.rung(), 0, 'a lone bad reading moves nothing');
  ladder.observe(BAD);
  assert.deepEqual([ladder.rung(), events], [1, ['downgrade_once']]);
  ladder.observe(BAD); ladder.observe(BAD);
  assert.equal(stream.codec().id, 'opus-neural-layer', 'the last rung speaks the layered row');
  ladder.observe(BAD); ladder.observe(BAD); ladder.observe(BAD); ladder.observe(BAD);
  assert.deepEqual(events, ['downgrade_once', 'downgrade_once', 'too_low_to_downgrade'], 'told once while it stays at the bottom');
  for (let index = 0; index < data.recover_after_good; index += 1) ladder.observe({ backlog: 0 });
  assert.deepEqual([ladder.rung(), events.at(-1), stream.codec().id], [1, 'recovered', 'opus-fec']);
  assert.equal(JSON.parse(lines.at(-1) as string).rung, 'reduced');
});

test('a lost connection is a bad reading', () => {
  const events: string[] = [];
  const ladder = createLadder(change => events.push(change.event));
  ladder.observe({ lost: true }); ladder.observe({ lost: true });
  assert.deepEqual(events, ['downgrade_once']);
});

test('a failed endpoint is skipped until its cooldown ends, across pages, and the first is used when all are cooling', () => {
  const store = memory();
  const rows = { ...data.failover, endpoints: [{ id: 'primary', path: '/a' }, { id: 'backup', path: '/b' }] };
  const page = createFailover(store, rows);
  assert.equal(page.pick(1000).id, 'primary');
  page.failed('primary', 1000);
  assert.equal(createFailover(store, rows).pick(1000 + data.failover.cooldown_ms - 1).id, 'backup', 'another page reads the persisted cooldown');
  assert.equal(page.pick(1000 + data.failover.cooldown_ms).id, 'primary');
  page.failed('primary', 5000); page.failed('backup', 5000);
  assert.equal(page.pick(5001).id, 'primary');
  assert.deepEqual(Object.keys(JSON.parse(store.get(data.failover.store_key) as string)).sort(), ['backup', 'primary']);
});

test('the page store falls back to memory when storage refuses', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  try {
    const store = pageStore();
    store.set('k', 'v');
    assert.equal(store.get('k'), 'v');
  } finally { if (real) Object.defineProperty(globalThis, 'localStorage', real); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
