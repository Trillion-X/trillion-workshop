// Ported from old trillion test/decision-call-payload-cost.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old store logged every refused answer as a call with its payload kept apart
// in a bounded SQLite table (src/decision-store.mjs KEPT_CALL_PAYLOADS); this tool keeps no call log and keeps a
// logged call only of a decision once kept whole, as it was, never the payload it carried (read-data/decision-records.mjs
// `bareCall`: "the old store kept those apart and bounded"). So: a 300-row refused answer writes nothing at all through
// the door (the old bound on SQL statements, at its tightest), and a whole decision with an embedded refused answer is
// laid apart on its next change with its call kept and the payload no longer embedded; that the sent words "remain
// available" is changed as the owner behaves: bareCall drops them by design.
// Left out, no running owner: reading a refused answer back for replay, the per-decision payload retention
// (KEPT_CALL_PAYLOADS), removing a decision's payloads with it, and the second test (a refused payload insert rolling
// back with its call record): searched the three repos for KEPT_CALL_PAYLOADS, decision_call_payloads, addCall and
// recordCall: only the moved import closure tools/keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs,
// whose addCall nothing calls (trillion-rust lists decision_call_payloads among the retired tables,
// src/storage/record_store_resources.json `retire`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionEvidence, startADecision } from '../read-data/decisions.mjs';
import { recordMethodAnswers } from '../method-rows/answers.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account } from './old-engine-for-tests.mjs';
import { METHOD_VIEW } from './fixtures.mjs';

const open = (door, mode) => startADecision({
  source_id: `structured-refusal-${mode}`, goal: 'Choose a safe shared collection',
  evidence: [{ ref: 'request', claim: 'One link should share several things.' }],
  options: [{ id: 'collection', label: 'One collection' }, { id: 'separate', label: 'Separate links' }],
}, { door });
const callKey = (id, n) => `decision-call:${id}:${String(n).padStart(6, '0')}`;

test('a refused batch of answers writes nothing at all through the door and keeps no call', async () => {
  const door = account();
  const { case_id: id } = await open(door, 'one');
  const answers = Array.from({ length: 300 }, (_, n) => ({ row: `record:method-row:wrong-${n}`, answer: 'kept for a retry', evidence_refs: ['request'] }));
  const writes = door.writes.length;
  const reply = await recordMethodAnswers({ decision_id: id, method: METHOD_VIEW, answers }, { door });
  assert.equal(reply.refused.length, 300);
  assert.equal(reply.recorded.length, 0);
  assert.equal(door.writes.length, writes, 'a refusal writes nothing');
  assert.equal(door.value(callKey(id, 0)), null, 'no call record holds the refused payload');
});

test('changing a legacy whole decision moves its embedded refused answer without losing it', async () => {
  const door = account();
  const { case_id: id } = await open(door, 'legacy');
  const old = { route: 'guide', step_id: 'wrong', accepted: false, at: new Date().toISOString(), submission: { answer: { rows: [{ name: 'kept' }] } }, problems: ['A check failed.'] };
  // The decision as an older store kept it: whole, its guidance and calls inside its one record.
  const record = await readDecision(door, id);
  const { counts, method_identity, input_identity, call_count, ...own } = door.value(id);
  door.put(id, 'decision', { ...own, input: record.input, method: record.method, guidance: [], calls: [old] });
  assert.deepEqual((await readDecision(door, id)).calls[0].submission, old.submission, 'a whole decision reads as it is');
  // Its next change lays it apart.
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'request-2', claim: 'The same link should also work on a phone.' }] }, { door });
  const call = door.value(callKey(id, 0));
  assert.equal(call.step_id, 'wrong', 'the call is kept');
  assert.equal(call.accepted, false);
  assert.equal(door.value(id).calls, undefined, 'the whole record no longer embeds the call');
  assert.equal(door.value(id).call_count, 1);
  assert.equal(call.submission, undefined, 'its payload is not kept (decision-records.mjs bareCall)');
  assert.equal(call.problems, undefined);
});
