import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeSourceReturnCandidate, hasPendingSourceReturns, pendingSourceReturnCandidates, queueSourceReturnCandidates } from '../harness/source-return-pending.mjs';
import { startSourceReturnCheck } from '../harness/record-every-message.mjs';

test('an exact final-answer check survives a failed send and is removed after replay', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-return-'));
  try {
    const item = { handoff_id: 'h_123', source_id: 'codex:01a0cee9-02df-76e2-a6ea-6f202cbd0668', transcript_message_id: 'msg_abc', text: 'The checked result' };
    assert.equal(queueSourceReturnCandidates([item], folder), 1);
    assert.equal(hasPendingSourceReturns(folder), true);
    const first = pendingSourceReturnCandidates(folder)[0];
    assert.match(first.request_id, /^[0-9a-f-]{36}$/);
    const { file: firstFile, request_id: firstRequest, ...firstItem } = first;
    assert.deepEqual(firstItem, item);
    assert.equal(queueSourceReturnCandidates([item], folder), 1);
    assert.equal(pendingSourceReturnCandidates(folder).length, 1);
    assert.equal(pendingSourceReturnCandidates(folder)[0].request_id, firstRequest);
    const claude = { ...item, source_id: 'claude-code:01a0cee9-02df-76e2-a6ea-6f202cbd0668', transcript_message_id: 'claude-final-row' };
    assert.equal(queueSourceReturnCandidates([claude], folder), 1);
    assert.equal(pendingSourceReturnCandidates(folder).length, 2);
    completeSourceReturnCandidate(pendingSourceReturnCandidates(folder)[0].file);
    completeSourceReturnCandidate(pendingSourceReturnCandidates(folder)[0].file);
    assert.equal(hasPendingSourceReturns(folder), false);
    assert.equal(queueSourceReturnCandidates([item], folder), 1);
    assert.notEqual(pendingSourceReturnCandidates(folder)[0].request_id, firstRequest);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('Stop persists the final answer before a detached child can fail to start', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-return-'));
  try {
    const item = { handoff_id: 'h_123', source_id: 'codex:01a0cee9-02df-76e2-a6ea-6f202cbd0668', transcript_message_id: 'msg_crash', text: 'The checked result' };
    assert.equal(startSourceReturnCheck([item], {
      queue: candidates => queueSourceReturnCandidates(candidates, folder),
      spawnChild: () => { throw new Error('child never started'); },
    }), 1);
    const [{ file, request_id, ...candidate }] = pendingSourceReturnCandidates(folder);
    assert.match(request_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(candidate, item);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a check that cannot be sent yet waits longer each time and is dropped after its last check', async () => {
  const { deferSourceReturnCandidate } = await import('../harness/source-return-pending.mjs');
  const folder = mkdtempSync(join(tmpdir(), 'source-return-'));
  try {
    const item = { handoff_id: 'h_456', source_id: 'codex:01a0cee9-02df-76e2-a6ea-6f202cbd0668', transcript_message_id: 'msg_wait', text: 'Not finished yet' };
    queueSourceReturnCandidates([item], folder);
    const start = Date.parse('2026-10-03T05:00:00Z');
    const recheckMinutes = [1, 5];
    const [first] = pendingSourceReturnCandidates(folder, start);
    assert.equal(deferSourceReturnCandidate(first.file, { recheckMinutes, now: start }), 'deferred');
    // Put off: not read again until its next check.
    assert.deepEqual(pendingSourceReturnCandidates(folder, start + 30_000), []);
    const [second] = pendingSourceReturnCandidates(folder, start + 60_000);
    assert.equal(second.checks, 1);
    assert.equal(deferSourceReturnCandidate(second.file, { recheckMinutes, now: start + 60_000 }), 'deferred');
    assert.deepEqual(pendingSourceReturnCandidates(folder, start + 5 * 60_000), []);
    const [third] = pendingSourceReturnCandidates(folder, start + 6 * 60_000);
    assert.equal(deferSourceReturnCandidate(third.file, { recheckMinutes, now: start + 6 * 60_000 }), 'given-up');
    assert.equal(hasPendingSourceReturns(folder), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
