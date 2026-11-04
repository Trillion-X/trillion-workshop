import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { NativeWorkspaceRecords, workspaceWriteInputSchema } from '../src/native-workspace-records.mjs';
import { workspaceValueIdentity } from '../../set-up-my-account/read-data/conflicts.mjs';
import { schemaProblems } from '../../shared-code/src/typed-operation-contract.mjs';

test('native workspace input describes ordinary, conditional and conflict-resolution writes through one owner', () => {
  const schema = workspaceWriteInputSchema();
  for (const input of [
    { writes: [{ address_label: 'recordings', payload: [] }] },
    { writes: [{ address_label: 'recordings', payload: [], expected_identity: null }], conflict_policy: 'retry' },
    { resolve_conflict: { id: 'a-conflict', branch_identity: 'a-kept-branch' } },
  ]) assert.deepEqual(schemaProblems(input, schema), []);
  for (const input of [{}, { writes: [] }, { writes: [{ address_label: 'recordings' }] },
    { writes: [{ address_label: 'recordings', payload: [], expected_identity: 42 }] },
    { writes: [{ address_label: 'recordings', payload: [] }], resolve_conflict: { id: 'a', branch_identity: 'b' } },
    { resolve_conflict: { id: 'a' } }]) assert.ok(schemaProblems(input, schema).length > 0);
});

test('native saved recording changes preserve siblings and refuse a stale whole-record candidate', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const owner = new NativeWorkspaceRecords({ sql: host.sql, transaction: host.transaction, live: { changedFor: (_paths, write) => write() } });
  const before = [{ id: 'take-a', file_identity: '1f:media', title: 'A', meeting_context: null }, { id: 'take-b', title: 'B' }];
  owner.putWorkspaceRecords([{ address_label: 'recordings', payload: before, expected_identity: null }], { conflictPolicy: 'retry' });
  const associated = before.map(row => row.id === 'take-a' ? { ...row, meeting_context: { source_id: 'calendar:a', event_id: 'event:a' } } : row);
  assert.deepEqual(owner.putWorkspaceRecords([{ address_label: 'recordings', payload: associated, expected_identity: workspaceValueIdentity(before) }], { conflictPolicy: 'retry' }), { written: 1 });
  const stale = owner.putWorkspaceRecords([{ address_label: 'recordings', payload: before, expected_identity: workspaceValueIdentity(before) }], { conflictPolicy: 'retry' });
  assert.equal(stale.written, 0);
  assert.equal(stale.conflicts[0].current.identity, workspaceValueIdentity(associated));
  assert.deepEqual(owner.workspaceRecords({ labels: ['recordings'] }).recordings, associated);
});
