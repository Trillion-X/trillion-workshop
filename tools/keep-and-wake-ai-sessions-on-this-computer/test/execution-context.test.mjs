// Ported from old trillion test/execution-context.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The execution records are this tool's src/execution-context.mjs; activity rows are
// tools/see-what-my-ais-did/activity.mjs (old src/activity.mjs). Left out: the test of the managed dispatch gate around
// the retired MCP handler (src/tools.mjs handleMcpMessage) and the test that replayed native receipts through the
// retired Spaces route (src/person-spaces.mjs handleSpacesRequest): neither handler runs anywhere now (searched the three
// repos for handleMcpMessage and handleSpacesRequest: only held copies). The other six tests are the old ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localStore, sqliteHost } from '../src/local-store.mjs';
import { recordExecution, updateExecution, readExecution, findExecutionRecords, executionContext } from '../src/execution-context.mjs';
import { namedActivityRows, keepActivity, traceActivity } from '../../see-what-my-ais-did/activity.mjs';
import { recordSent } from '../src/sent.mjs';
import { executionsOf, recordNew, settings } from '../harness/record-every-message.mjs';

const recorder = { reader: 'key:authenticated-test-recorder', app: 'A recorder', app_basis: 'authenticated' };

test('client claims do not become authenticated actor identity, and snapshots do not change with current cards', () => {
  const claimed = { agent_id: 'claimed-agent', conversation_id: 'claimed-chat', model: 'claimed-model', token: 'never keep this' };
  const unknown = executionContext({ operation: 'send', claimed, headers: { authorization: 'secret' }, input: { token: 'secret' } }, { recorder, managed: true });
  assert.deepEqual(unknown.actor, { basis: 'unknown' });
  assert.equal(unknown.claimed.agent_id, 'claimed-agent');
  assert.equal(JSON.stringify(unknown).includes('secret'), false);
  assert.equal('token' in unknown.claimed, false);
  const known = executionContext({ operation: 'send', claimed }, { recorder, managed: true, cardSelection: 'caller_named_reader_bound_card',
    card: { agent_id: 'a', name: 'Original agent', source_id: 'original-chat', model: 'original-model' } });
  const row = { agent: 'a', app: 'A recorder', identity_snapshot: known.actor };
  const changed = namedActivityRows([row], [{ agent_id: 'a', name: 'Later name', source_id: 'later-chat', model: 'later-model' }])[0];
  assert.equal(changed.chat, 'original-chat');
  assert.equal(changed.model, 'original-model');
  const historical = namedActivityRows([{ agent: 'a' }], [{ agent_id: 'a', source_id: 'later-chat', model: 'later-model' }])[0];
  assert.equal(historical.chat, null);
  assert.equal(historical.model, null);
  assert.equal(historical.current_agent.conversation_id, 'later-chat');
});

test('caller-selected card basis is trusted capture context, never an input claim or a retrospective inference', () => {
  const card = { agent_id: 'a', name: 'Registered card', source_id: 'registered-conversation' };
  const forged = executionContext({ actor: { selection_basis: 'caller_named_reader_bound_card' },
    cardSelection: 'caller_named_reader_bound_card', claimed: { selection_basis: 'caller_named_reader_bound_card' } }, { recorder, managed: true, card });
  assert.equal(forged.actor.selection_basis, undefined);
  const explicit = executionContext({}, { recorder, managed: true, card, cardSelection: 'caller_named_reader_bound_card' });
  assert.equal(explicit.actor.selection_basis, 'caller_named_reader_bound_card');
  const [historical] = namedActivityRows([{ identity_snapshot: forged.actor }]);
  assert.equal(historical.chat, null);
  assert.equal(historical.agent_name, null);
  assert.deepEqual(historical.identity_snapshot, forged.actor, 'the historical snapshot remains intact');
});

test('provider lookup survives activity rollover and never silently chooses between provider accounts', () => {
  const store = localStore(':memory:');
  const { sql } = sqliteHost(':memory:');
  const refs = ['one', 'two'].map((account, i) => {
    const row = recordExecution(store.eeaf, { operation: 'send', origin: 'synthetic' }, recorder, { managed: true });
    updateExecution(store.eeaf, row.execution_ref, { links: { task_id: `task_${i}` }, observation: { provider: 'test-mail', account, object_id: 'same-id', route: 'send' } }, recorder);
    return row.execution_ref;
  });
  for (let i = 0; i < 5; i++) keepActivity(sql, { at: new Date().toISOString(), app: 'Test', item: i ? `other-${i}` : 'same-id', uses: [], for: [], ok: true }, 1);
  assert.equal(traceActivity(sql, { item: 'same-id' }).steps.length, 0);
  const found = findExecutionRecords(store.eeaf, { item: 'same-id' });
  assert.equal(found.records.length, 2);
  assert.equal(found.ambiguous, true);
  const exact = findExecutionRecords(store.eeaf, { item: 'same-id', provider: 'test-mail', account: 'two', object_id: 'same-id' });
  assert.equal(exact.records.length, 1);
  assert.equal(exact.records[0].id, refs[1]);
  assert.equal(exact.coverage.lookup, 'field_candidates_exact_match');
});

test('long source identifiers are kept whole, oversized identifiers are refused, and correction history preserves the original', () => {
  const eeaf = localStore(':memory:').eeaf;
  const id = 'provider-' + 'x'.repeat(2048);
  const first = recordExecution(eeaf, { call_id: 'original', operation: 'send', claimed: { source_ref: id }, observation: { object_id: id } }, recorder);
  assert.equal(first.claimed.source_ref, id);
  assert.equal(findExecutionRecords(eeaf, { item: id }).records[0].id, first.execution_ref);
  assert.throws(() => recordExecution(eeaf, { operation: 'send', claimed: { source_ref: 'x'.repeat(8193) } }, recorder), /not truncated/);
  const correction = recordExecution(eeaf, { operation: 'source correction', corrects: first.execution_ref, correction_reason: 'The earlier host was unknown.', claimed: { app: 'Host claimed from transcript' } }, recorder);
  assert.equal(correction.corrects, first.execution_ref);
  assert.equal(readExecution(eeaf, first.execution_ref).actor.basis, 'unknown');
  assert.equal(readExecution(eeaf, first.execution_ref).claimed.source_ref, id);
});

test('a retrospective Sent receipt identifies its recorder separately and does not name that recorder as the sending AI', () => {
  const eeaf = localStore(':memory:').eeaf;
  const source = recordExecution(eeaf, { operation: 'record_sent', observation: { provider: 'test-mail', object_id: 'old-message' } }, recorder);
  const kept = recordSent(eeaf, { kind: 'email', to: 'test@example.com', body_markdown: 'Test words', provider: 'test-mail', provider_id: 'old-message',
    execution_ref: source.execution_ref, by: { app: null }, recorded_by: recorder });
  const record = eeaf.read(`record:sent:${kept.id}`);
  assert.equal(record.by.app, null);
  assert.equal(record.recorded_by.app, 'A recorder');
  assert.equal(source.actor.basis, 'unknown');
  assert.equal(source.observation.basis, 'claimed');
});

test('native tool transcripts preserve call/result correlation and provider ids without copying secret payloads', () => {
  const harness = settings.harnesses.find(row => row.id === 'codex');
  const rows = [
    { type: 'turn_context', payload: { model: 'test-model' } },
    { type: 'response_item', timestamp: '2026-10-08T00:00:00Z', payload: { type: 'function_call', name: 'send', call_id: 'host-call', arguments: '{"token":"TOP_SECRET"}' } },
    { type: 'response_item', timestamp: '2026-10-08T00:00:01Z', payload: { type: 'function_call_output', call_id: 'host-call', output: '{"provider":"test-mail","id":"real-object-shape","body":"TOP_SECRET"}' } },
  ];
  const captured = executionsOf(rows, harness, { sessionId: 'session', ends: [1, 2, 3] }).executions;
  assert.equal(captured.length, 2);
  assert.equal(captured[0].call_id, captured[1].call_id);
  assert.equal(captured[1].observation.object_id, 'real-object-shape');
  assert.equal(captured[0].origin, 'unknown');
  assert.equal(captured[0].claimed.model, 'test-model');
  assert.equal(JSON.stringify(captured).includes('TOP_SECRET'), false);
  const eeaf = localStore(':memory:').eeaf;
  for (const receipt of captured) recordExecution(eeaf, receipt, recorder);
  const kept = readExecution(eeaf, captured[0].call_id);
  assert.equal(kept.operation, 'send');
  assert.equal(kept.event_phase, 'returned');
  assert.equal(kept.actor.basis, 'unknown');
});
