// test/request-classes.test.mjs
// A send, stop or approval never waits behind catalogue reads; background reads are limited and yield to writes (F-0191).
import assert from 'node:assert/strict';
import test from 'node:test';
import { classOf, requestScheduler } from '../src/workspace/request-classes.ts';
const gate = () => { let open; const promise = new Promise(done => { open = done; }); return { promise, open }; };

test('requests are classed by DATA: writes critical, catalogue reads background, the rest interactive', () => {
  assert.equal(classOf('/work/api/ai-work', 'POST').id, 'critical');
  assert.equal(classOf('/work/api/screens?page=2', 'GET').id, 'background');
  assert.equal(classOf('/work/api/lists/x', undefined).id, 'interactive');
});

test('background reads run two at a time and wait for a write in flight; a write never waits', async () => {
  const scheduler = requestScheduler();
  const order = [];
  const holds = [gate(), gate(), gate()];
  const reads = holds.map((hold, n) => scheduler.run('/work/api/screens', 'GET', async () => { order.push(`read${n}-start`); await hold.promise; order.push(`read${n}-end`); }));
  await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(order, ['read0-start', 'read1-start']);
  assert.equal(scheduler.waiting(), 1);
  const write = gate();
  const send = scheduler.run('/work/api/ai-work', 'POST', async () => { order.push('send-start'); await write.promise; order.push('send-end'); });
  await new Promise(done => setTimeout(done, 10));
  assert.ok(order.includes('send-start'), 'the send started while two reads were in flight');
  holds[0].open(); holds[1].open();
  await new Promise(done => setTimeout(done, 10));
  assert.equal(order.includes('read2-start'), false, 'the third read yields while the send is in flight');
  write.open(); await send;
  holds[2].open();
  await Promise.all(reads);
  console.log('readback', JSON.stringify(order));
  assert.ok(order.indexOf('read2-start') > order.indexOf('send-end'));
});

test('a failing request frees its place', async () => {
  const scheduler = requestScheduler();
  await assert.rejects(scheduler.run('/work/api/screens', 'GET', async () => { throw new Error('x'); }), /x/);
  assert.equal(scheduler.inFlight('background'), 0);
});
