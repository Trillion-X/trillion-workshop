// Ported from old trillion test/ai-space-projection-listener.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old test booted the retired PersonStore, whose revision listener woke
// person.aiSpaceProjections(); here the same owner is built as ai-space-projection-queue.test.mjs builds it: keep-and-wake's
// decisionStore hands each written row to this tool's aiSpaceProjectionQueue (src/ai-space-projection.mjs), whose nextAt
// is read after the write settles.
// Left out: `person.aiSpaceProjectionWakePending === true` after the write, a flag of the retired PersonStore's alarm
// (searched the three repos for aiSpaceProjectionWakePending, aiSpaceProjections, ai_space_projection: only this queue,
// its test and a table name in trillion-rust src/storage/record_store_resources.json). Every other assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiSpaceProjectionQueue, initAiSpaceProjectionQueue } from '../src/ai-space-projection.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';

test('a write of an AI record reaches the AI space projections without a listener failure', async () => {
  const logged = [];
  const warn = console.warn, error = console.error;
  console.warn = (...args) => logged.push(args.map(String).join(' '));
  console.error = (...args) => logged.push(args.map(String).join(' '));
  let owners = 0;
  let projections;
  const host = sqliteHost(':memory:');
  try {
    initAiSpaceProjectionQueue(host.sql);
    const store = decisionStore(host.sql, {
      transaction: host.transaction,
      written: rows => { owners += 1; projections.queue(rows); },
    });
    const person = { store, relay: () => 'member-relay', network: () => ({ spaceAgents: async () => ({ ok: true }) }) };
    projections = aiSpaceProjectionQueue({ sql: host.sql, eeaf: store.eeaf, person, now: () => 1_000 });
    host.transaction(() => store.eeaf.write([{ id: 'ai:listener-fixture', type: 'ai', value: { label: 'Listener fixture' } }]));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.warn = warn;
    console.error = error;
  }
  assert.ok(owners > 0, 'the revision listener asked the owner');
  assert.equal(typeof projections.nextAt, 'function', 'the admitted owner answers nextAt');
  assert.equal(projections.nextAt(), 1_000, 'the AI write left a due projection');
  assert.deepEqual(logged.filter(line => /revision listener|nextAt/.test(line)), [], 'nothing logged as a listener failure');
  host.db.close();
});
