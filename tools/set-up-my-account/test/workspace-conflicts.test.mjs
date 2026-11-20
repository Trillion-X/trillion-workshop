// Ported from the retired repository test/workspace-conflicts.test.mjs (b6ae0ebf81): its first test, assertions unchanged. The other 14 drive
// the old PersonStore over SQLite and the Workers stand-in (a raced write, conflict pages, the client bundle, read budgets);
// that store no longer exists, so they are not run here (see verify-every-port/set-up-my-account).
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeWorkspaceConflict, tickHybridClock, workspaceValueIdentity } from '../read-data/conflicts.mjs';

test('the same fork has one ordered identity and retries advance its persisted clock only once', () => {
  const before = { text: 'before' }, left = { text: 'left' }, right = { text: 'right' };
  const first = makeWorkspaceConflict({ address: 'draft', currentFound: true, currentValue: left, incomingValue: right, expectedIdentity: workspaceValueIdentity(before), clock: { wall_ms: 20, logical: 0, device_id: 'person-store' } });
  const replay = makeWorkspaceConflict({ address: 'draft', currentFound: true, currentValue: right, incomingValue: left, expectedIdentity: workspaceValueIdentity(before), clock: { wall_ms: 99, logical: 0, device_id: 'person-store' } });
  assert.equal(first.id, replay.id);
  assert.deepEqual(first.branches.map(branch => branch.identity), replay.branches.map(branch => branch.identity));
  assert.notEqual(first.branches[0].identity, first.branches[1].identity);
  assert.deepEqual(tickHybridClock({ wall_ms: 20, logical: 3 }, null, 18), { wall_ms: 20, logical: 4, device_id: 'person-store' });
  assert.deepEqual(tickHybridClock({ wall_ms: 20, logical: 3 }, { wall_ms: 21, logical: 7 }, 21), { wall_ms: 21, logical: 8, device_id: 'person-store' });
});

