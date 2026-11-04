// test/cut-off.test.mjs
// A call a deploy cut off is sent once more on a fresh handle; any other failure is thrown as it came.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onceMore, passing } from '../src/cut-off.mjs';

test('a call cut off by a deploy is sent once more through a fresh handle', async () => {
  const reset = Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true });
  const old = { ask: async () => { throw reset; } };
  const fresh = { ask: async () => 'answered' };
  assert.equal(await onceMore(person => person.ask(), old, () => fresh), 'answered');
  assert.ok(passing(new Error('Network connection lost.')));
});

test('any other failure is not repeated', async () => {
  let calls = 0;
  const broken = { ask: async () => { calls += 1; throw new Error('Not allowed'); } };
  await assert.rejects(onceMore(person => person.ask(), broken, () => broken), /Not allowed/);
  assert.equal(calls, 1);
});

test('an object reset for running out of memory is never sent again', async () => {
  const reset = Object.assign(new Error("Durable Object's isolate exceeded its memory limit and was reset."), { retryable: true });
  assert.equal(passing(reset), false);
  let calls = 0;
  const heavy = { ask: async () => { calls += 1; throw reset; } };
  await assert.rejects(onceMore(person => person.ask(), heavy, () => heavy), /exceeded its memory limit/);
  assert.equal(calls, 1);
});

test('an overloaded object is answered with retry-after without doubling its queue', async () => {
  const overload = Object.assign(new Error('Durable Object is overloaded. Requests queued for too long.'), { overloaded: true });
  let calls = 0;
  const busy = { ask: async () => { calls += 1; throw overload; } };
  assert.equal(passing(overload), true, 'the Worker still answers this as a retryable 503');
  await assert.rejects(onceMore(person => person.ask(), busy, () => busy), /overloaded/);
  assert.equal(calls, 1, 'a fresh handle cannot relieve an overloaded object within the same request');
});

test('a storage-timeout reset does not repeat the read on an immediate fresh handle', async () => {
  for (const retryable of [false, true]) {
    const reset = Object.assign(new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'), { retryable });
    let calls = 0, freshHandles = 0;
    const timedOut = { ask: async () => { calls += 1; throw reset; } };
    assert.equal(passing(reset), true, 'the Worker still answers a retryable 503');
    await assert.rejects(onceMore(person => person.ask(), timedOut, () => { freshHandles += 1; return timedOut; }), error => error === reset);
    assert.equal(calls, 1);
    assert.equal(freshHandles, 0);
  }
});

test('a second cut-off is thrown, never retried forever', async () => {
  const reset = () => Object.assign(new Error('Network connection lost.'), { retryable: true });
  let calls = 0;
  const flaky = { ask: async () => { calls += 1; throw reset(); } };
  await assert.rejects(onceMore(person => person.ask(), flaky, () => flaky), /Network connection lost/);
  assert.equal(calls, 2);
});


test('CPU-limit resets are not immediately repeated even when the platform marks them retryable', async () => {
  for (const message of ['Worker exceeded CPU time limit.', "Durable Object's isolate exceeded its CPU time limit and was reset.", 'Durable Object exceeded its CPU limit.']) {
    const reset = Object.assign(new Error(message), { retryable: true });
    let calls = 0;
    let freshHandles = 0;
    const heavy = { ask: async () => { calls += 1; throw reset; } };
    assert.equal(passing(reset), false, message);
    await assert.rejects(onceMore(person => person.ask(), heavy, () => { freshHandles += 1; return heavy; }), error => error === reset);
    assert.equal(calls, 1, message);
    assert.equal(freshHandles, 0, message);
  }
});
