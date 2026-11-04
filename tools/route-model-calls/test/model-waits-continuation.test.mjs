// Slow model retries must not occupy the store's only alarm while other sources wait. These tests run the actual
// queue owner on SQLite with controlled model replies, including replies from an obsolete durable claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { modelWaits } from '../src/model-waits.mjs';

const policy = { first_seconds: 60, longest_seconds: 600, batch: 4 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function setup({ run, settings = policy, db = new DatabaseSync(':memory:'), clock = { at: 1_000_000 }, keepAlive, onSettled } = {}) {
  // Match the Durable Object's synchronous SQL interface; writes happen at exec, before cursor consumption.
  const sql = { exec(query, ...values) { const rows = db.prepare(query).all(...values); return { toArray: () => rows }; } };
  const waits = modelWaits(sql, { settings, run, now: () => clock.at, keepAlive, onSettled });
  return { waits, db, clock, tick: seconds => { clock.at += seconds * 1000; } };
}

test('an alarm can run its next source while a tracked model batch is still waiting for inference', { timeout: 1000 }, async () => {
  const answer = deferred(), held = [], called = [];
  let settled = 0;
  const host = setup({ keepAlive: work => held.push(work), onSettled: async () => { settled += 1; },
    run: { story: async key => { called.push(key); await answer.promise; } } });
  for (const key of ['first', 'second']) host.waits.wait('story', key);
  host.tick(60);
  const dispatch = await host.waits.runDue();
  try {
    assert.deepEqual(dispatch, { ran: 0, started: 2 });
    // The batch claims its first row in its own measured step (e8f8a2c83f), a few turns after the alarm returned: let it.
    for (let turn = 0; turn < 50 && !called.length; turn += 1) await Promise.resolve();
    called.push('next alarm source');
    assert.deepEqual(called, ['first', 'next alarm source']);
    assert.equal(held.length, 1, 'the host retains the actual runner promise');
    assert.equal(host.waits.waiting(), 2, 'neither unfinished row has disappeared');
    assert.deepEqual(host.waits.running().map(row => row.key), ['first']);
    assert.ok(host.waits.nextAt() > host.clock.at, 'the active batch keeps a future recovery wake');
    host.tick(1000);
    assert.ok(host.waits.nextAt() > host.clock.at, 'an overdue model does not create a zero-delay alarm loop');
    assert.deepEqual(await host.waits.runDue(), { ran: 0, running: 1, progress: false });
    assert.equal(held.length, 1, 'a later alarm never starts the same batch twice');
  } finally {
    answer.resolve();
    await Promise.all(held);
  }
  assert.deepEqual(called, ['first', 'next alarm source', 'second']);
  assert.equal(host.waits.waiting(), 0);
  assert.equal(host.waits.nextAt(), null);
  assert.equal(settled, 1, 'completion rearms the alarm through its host');
});

test('a retained row survives a restart, and the old answer cannot delete the replacement claim', async () => {
  const first = deferred(), second = deferred(), heldFirst = [], heldSecond = [];
  const settings = { ...policy, batch: 1 };
  const old = setup({ settings, keepAlive: work => heldFirst.push(work), run: { story: () => first.promise } });
  old.waits.wait('story', 'same');
  old.tick(60);
  await old.waits.runDue();
  const oldClaim = old.db.prepare('SELECT claim_id, due_ms FROM model_waits').get();
  old.clock.at = oldClaim.due_ms + 1;
  const replacement = setup({ settings, db: old.db, clock: old.clock, keepAlive: work => heldSecond.push(work), run: { story: () => second.promise } });
  assert.ok(replacement.waits.nextAt() < replacement.clock.at, 'a new instance finds the durable retry due');
  await replacement.waits.runDue();
  const newClaim = old.db.prepare('SELECT claim_id FROM model_waits').get();
  assert.notEqual(newClaim.claim_id, oldClaim.claim_id);
  first.resolve();
  await Promise.all(heldFirst);
  assert.equal(replacement.waits.waiting(), 1, 'the obsolete completion leaves the current attempt intact');
  assert.equal(old.db.prepare('SELECT claim_id FROM model_waits').get().claim_id, newClaim.claim_id);
  second.resolve();
  await Promise.all(heldSecond);
  assert.equal(replacement.waits.waiting(), 0);
});

test('a background retry that still waits or throws keeps its durable row and rearm', async () => {
  const held = [];
  let settled = 0;
  const host = setup({ keepAlive: work => held.push(work), onSettled: async () => { settled += 1; },
    run: { still: async key => host.waits.wait('still', key), failed: async () => { throw new Error('model unavailable'); } } });
  host.waits.wait('still', 'one');
  host.waits.wait('failed', 'two');
  host.tick(60);
  await host.waits.runDue();
  await Promise.all(held);
  assert.equal(host.waits.waiting(), 2);
  assert.deepEqual(host.waits.running(), []);
  assert.ok(host.waits.nextAt() > host.clock.at);
  assert.equal(settled, 1);
});

test('a host without background retention still awaits the result and preserves bounded batches', async () => {
  const ran = [], host = setup({ settings: { ...policy, batch: 1 }, run: { story: async key => ran.push(key) } });
  host.waits.wait('story', 'one');
  host.waits.wait('story', 'two');
  host.tick(60);
  assert.deepEqual(await host.waits.runDue(), { ran: 1 });
  assert.deepEqual(ran, ['one']);
  assert.equal(host.waits.waiting(), 1);
  assert.deepEqual(await host.waits.runDue(), { ran: 1 });
  assert.equal(host.waits.waiting(), 0);
});

test('existing wait rows migrate without losing their retry deadline', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE model_waits (kind TEXT NOT NULL, key TEXT NOT NULL, due_ms INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, key))');
  db.prepare('INSERT INTO model_waits VALUES (?, ?, ?, ?)').run('story', 'existing', 1_060_000, 2);
  const host = setup({ db, run: { story: async () => {} } });
  assert.equal(host.waits.waiting(), 1);
  assert.equal(host.waits.nextAt(), 1_060_000);
  host.tick(60);
  assert.deepEqual(await host.waits.runDue(), { ran: 1 });
  assert.equal(host.waits.waiting(), 0);
});

test('unknown work survives missing wiring and resumes when its runner becomes available', async () => {
  const host = setup({ run: {} });
  // Inherited Object methods are not handlers, either.
  for (const kind of ['new-kind', 'toString']) host.waits.wait(kind, 'retained');
  host.tick(60);
  await host.waits.runDue();
  assert.equal(host.waits.waiting(), 2, 'missing handlers must not report their rows complete');
  const rows = host.db.prepare('SELECT kind, due_ms, tries FROM model_waits ORDER BY kind').all();
  assert.ok(rows.every(row => row.tries === 1 && row.due_ms > host.clock.at), 'each missing handler gets a future retry');
  host.clock.at = host.waits.nextAt();
  const ran = [];
  const recovered = setup({ db: host.db, clock: host.clock, run: {
    'new-kind': async key => ran.push(['new-kind', key]),
    toString: async key => ran.push(['toString', key]),
  } });
  assert.deepEqual(await recovered.waits.runDue(), { ran: 2 });
  assert.deepEqual(ran, [['new-kind', 'retained'], ['toString', 'retained']]);
  assert.equal(recovered.waits.waiting(), 0);
});
