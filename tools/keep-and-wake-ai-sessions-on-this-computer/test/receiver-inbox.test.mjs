import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { receiverInbox } from '../harness/receiver-inbox.mjs';

test('a signed event kept before 202 survives restart and is not replayed after completion', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trillion-receiver-inbox-'));
  try {
    receiverInbox(folder).accept('ev_retry_1', { type: 'handoff.created', subject_id: 'h_1' });
    const afterRestart = receiverInbox(folder);
    assert.equal(afterRestart.pending().length, 1);
    assert.equal(afterRestart.pending()[0][1].event.subject_id, 'h_1');
    afterRestart.accept('ev_retry_1', { type: 'handoff.created', subject_id: 'different' });
    assert.equal(afterRestart.pending()[0][1].event.subject_id, 'h_1');
    afterRestart.done('ev_retry_1');
    assert.deepEqual(receiverInbox(folder).pending(), []);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
