// Ported from old trillion test/hand-off-full-queue-bounded.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old test took agents, the agent store and the record engine from the retired
// PersonStore; here makeAgents (tools/shared-code/src/agents.mjs) runs over this tool's agentRecordStore on the same
// record engine (openRecords), whose reads are counted as before. Every assertion is the old one.
//
// A hand-off to an agent whose queue is full is refused (src/agents.mjs handOff, MAX_WAITING_FOR_ONE), and knowing the
// queue is full needs only its first jobs (waitingCount with `most`). From the person's store on 2026-10-10 (read_use):
// POST /handoffs read 16,600 rows and ran 2,500 statements a call, because the queue was counted job by job, twice, on
// every hand-off to a busy agent. This holds N and then 4N jobs waiting for one agent and fails when a refused hand-off
// reads more from the record engine as the queue grows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../agent-records.mjs';

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const ENGINE_READS = ['read', 'scan', 'scanSelectedValues', 'ids'];

async function refusedHandOff(waiting) {
  const host = sqliteHost(':memory:');
  const eeaf = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  let counting = false;
  let entries = 0;
  for (const name of ENGINE_READS) {
    const read = eeaf[name].bind(eeaf);
    eeaf[name] = (...args) => {
      const out = read(...args);
      if (counting) entries += Array.isArray(out) ? out.length : out ? 1 : 0;
      return out;
    };
  }
  let saved = null;
  const store = { ...agentRecordStore({ records: eeaf, transaction: host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } };
  const agents = makeAgents({ store });
  store.putCard({ agent_id: 'X', name: 'X', description: 'busy', reader: 'key:full', takes_work: true });
  store.transaction(() => {
    for (let i = 0; i < waiting; i += 1) {
      store.putHandoff({ handoff_id: `h_${String(i).padStart(5, '0')}`, job: `Job ${i}`, input: {}, to_agent: 'X', state: 'open', hold_minutes: 30,
        handed_at: iso(NOW - (waiting - i) * 1000) });
    }
  });
  counting = true;
  const refused = (() => { try { agents.handOff({ job: 'One more', request_key: 'one-more', to_agent: 'X' }); return null; } catch (error) { return error.message; } })();
  counting = false;
  return { refused, entries };
}

test('a hand-off to a full queue reads the same however long the queue is', { timeout: 300000 }, async () => {
  const small = await refusedHandOff(100);
  const large = await refusedHandOff(400);
  console.log(`refused hand-off: ${small.entries} engine entries with 100 waiting, ${large.entries} with 400`);
  assert.match(small.refused ?? '', /already has \d+ jobs waiting/);
  assert.match(large.refused ?? '', /already has \d+ jobs waiting/);
  assert.ok(large.entries <= small.entries + 8, `a refused hand-off read ${small.entries} entries with 100 waiting and ${large.entries} with 400`);
});
