// The one typed sync status record (do-work/drive-sync-status.mjs) from its DATA rules. Moved from old trillion
// test/drive-sync-status.test.mjs: the first two tests one to one; the two that started the old Drive on its loopback
// port went with that Drive (the record's reader at GET /?sync and the Drives screen are not moved).
import assert from 'node:assert/strict';
import test from 'node:test';
import { causeOf, driveSyncStatus, sayWhereFileSyncStands, settingsOf as settings } from '../do-work/drive-sync-status.mjs';

const rules = settings().sync_status;
const at = Date.parse('2026-10-19T10:00:00.000Z');
const feed = (over = {}) => ({ version: 7, reached_at: at, failure: null, ...over });

test('each state comes from the first DATA row whose conditions hold', () => {
  assert.equal(driveSyncStatus({ rules, feed: feed({ version: null, reached_at: null }) }).state, 'starting', 'never answered is not empty');
  const synced = driveSyncStatus({ rules, feed: feed(), writes: { owing: [], conflicts: [], failed: [] } });
  assert.deepEqual({ state: synced.state, version: synced.version, moving: synced.moving, error: synced.error }, { state: 'synced', version: 7, moving: { count: 0, bytes: 0 }, error: null });
  const sending = driveSyncStatus({ rules, feed: feed(), writes: { owing: [{ size: 10 }, { size: 5 }], conflicts: [], failed: [] } });
  assert.deepEqual([sending.state, sending.moving, sending.said], ['syncing', { count: 2, bytes: 15 }, 'Sending 2 saves to Trillion.']);
  assert.equal(driveSyncStatus({ rules, feed: feed(), writes: { owing: [], conflicts: [{}], failed: [{}] } }).state, 'conflict');
  assert.equal(driveSyncStatus({ rules, feed: feed(), writes: { owing: [], conflicts: [], failed: [{}] } }).state, 'error');
  const offline = driveSyncStatus({ rules, feed: feed({ failure: { at: at + 1 } }), writes: { owing: [{ size: 3 }], conflicts: [], failed: [] } });
  assert.equal(offline.state, 'offline');
  assert.deepEqual(offline.error.cause, 'no_network');
  assert.match(offline.said, /cannot reach Trillion\. 1 saves wait/);
  assert.equal(driveSyncStatus({ rules, feed: feed({ failure: { at: at - 1 } }) }).state, 'synced', 'a failure before the last answer is over');
  const custom = { ...rules, states: [{ state: 'quiet', when: [{ fact: 'moving', at_least: 0 }], said: 'q' }] };
  assert.equal(driveSyncStatus({ rules: custom, feed: feed() }).state, 'quiet', 'a new state is a DATA row');
});

test('a failed ask is filed under the cause its status names', () => {
  assert.equal(causeOf(rules, { at }), 'no_network');
  assert.equal(causeOf(rules, { status: 401, at }), 'signed_out');
  assert.equal(causeOf(rules, { status: 507, at }), 'storage_full');
  assert.equal(causeOf(rules, { status: 429, at }), 'busy');
  assert.equal(causeOf(rules, { status: 503, at }), 'trillion_unavailable');
  assert.equal(causeOf(rules, { status: 404, at }), 'refused');
  assert.equal(causeOf(rules, null), null);
});

test('the tool row answers the same record from its input, and a missing feed is refused in words', () => {
  assert.equal(sayWhereFileSyncStands({ feed: feed(), writes: { owing: [{ size: 4 }], conflicts: [], failed: [] } }).state, 'syncing');
  assert.equal(sayWhereFileSyncStands({ feed: { version: null, reached_at: null, failure: null } }).state, 'starting');
  assert.equal(sayWhereFileSyncStands({ feed: feed({ failure: { status: 401, at: at + 1 } }) }).error.cause, 'signed_out');
  assert.throws(() => sayWhereFileSyncStands({}), /Give feed/);
});
