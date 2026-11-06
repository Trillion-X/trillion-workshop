// Ported from old trillion test/namespace-move-ownership.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The MOVE receipts and the reset are namespace-store.mjs's, moved here byte for
// byte; only the imports changed. Left out: 'cross-account merge retains recipient MOVE receipts without source replay
// authority', whose owner src/namespace-account-merge.mjs (namespaceAccountMerge) is retired with no running successor
// (searched namespaceAccountMerge, namespace-account-merge, move_receipts and account merge across trillion-workshop,
// trillion-rust src and trillion-apps web: only docs/from-old-trillion copies and port backlogs name them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../namespace-store.mjs';

function fixture(t) {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  return { ...host, namespace: namespaceStore(host.sql) };
}

test('Namespace reset removes unacknowledged MOVE receipts with its original names', t => {
  const { namespace } = fixture(t);
  namespace.saveMoveReceipt('original-operation', 'original-input', { moved: 1 });
  assert.equal(namespace.moveReceiptCount(), 1);
  namespace.clear();
  assert.equal(namespace.moveReceiptCount(), 0);
  assert.equal(namespace.moveReceipt('original-operation'), null);
});
