// The agents store tests run makeAgents over (src/agents.mjs): the record store a person's store keeps its agents in
// (src/agent-records.mjs), over a fresh in-memory database on the log engine, with saved instructions kept beside it.
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';

export function agentStoreForTests() {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  let saved = null;
  return {
    ...agentRecordStore({ records, transaction: host.transaction }),
    savedInstructions: () => structuredClone(saved),
    putSavedInstructions: list => { saved = structuredClone(list); },
  };
}
