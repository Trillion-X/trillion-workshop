import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './load-ts-module.mjs';
const revisions = { session_revision: 'session:1', policy_revision: 'policy:1', membership_revision: 'membership:1', resource_revision: 'resource:1' };
const ambientActor = { actor_ref: 'actor:server', session_ref: 'session:opaque', session_revision: 'session:1' };
const decisionProof = { decision: 'allow', decision_proof: 'decision:one', actor_ref: 'actor:server', session_ref: 'session:opaque', subject_ref: 'subject-1', action_ref: 'item-record.record-space-items', revisions };
test('owner-action builder requires a coupled server admission and returns an owner target', async () => { const { buildOwnerActionRequest } = await loadTsModule('../do-work/owner-actions.ts'); const result = buildOwnerActionRequest({ eventRef: 'event-1', requestedAt: '2026-06-22T00:00:00Z', scopeRef: 'subject-1', targetRef: 'space-1', fields: { any: 'value' }, ambientActor, decisionProof }); assert.equal(result.ok, true); assert.equal(result.request.target, 'item-record.record-space-items'); assert.equal(result.request.payload.mutations[0].target_ref, 'space-1'); assert.equal(result.request.payload.mutations[0].idempotency_ref, 'event-1'); });
test('owner-action builder denies missing, stale, or cross-scope proof', async () => { const { buildOwnerActionRequest } = await loadTsModule('../do-work/owner-actions.ts'); assert.equal(buildOwnerActionRequest({ eventRef: 'event-1', requestedAt: 'now', scopeRef: 'subject-1', targetRef: 'space-1' }).ok, false); assert.equal(buildOwnerActionRequest({ eventRef: 'event-1', requestedAt: 'now', scopeRef: 'subject-2', targetRef: 'space-1', ambientActor, decisionProof }).errors[0].code, 'scope-mismatch'); assert.equal(buildOwnerActionRequest({ eventRef: 'event-1', requestedAt: 'now', scopeRef: 'subject-1', targetRef: 'space-1', ambientActor: { ...ambientActor, session_revision: 'session:2' }, decisionProof }).errors[0].code, 'stale-admission'); });
test('owner target decoder accepts direct and runtime-wrapped JSON replies', async () => {
  const { decodeOwnerTargetReply } = await loadTsModule('../do-work/owner-actions.ts');
  const durable = { verified: true, decision: decisionProof };
  const expected = JSON.stringify(durable);
  assert.equal(JSON.stringify(decodeOwnerTargetReply(durable)), expected);
  assert.equal(JSON.stringify(decodeOwnerTargetReply(new TextEncoder().encode(expected))), expected);
  assert.equal(JSON.stringify(decodeOwnerTargetReply({ payload: new TextEncoder().encode(expected) })), expected);
});

test('historical creation time is accepted only for an admitted zero-revision migration', async () => {
  const { historicalCreationTime } = await loadTsModule('../do-work/owner-actions.ts');
  const mutation = { item_ref: 'post:one', target_ref: 'community:one', expected_revision: 0, idempotency_ref: 'migration:one', fields: {}, requested_at: '2026-08-18T16:00:00.000Z', created_at: '2026-08-18T16:00:00.000Z', operation: 'upsert' };
  const admitted = { constraints: { item_record_migration: { historical_created_at: true, source_basis: 'basis:source' } } };
  assert.equal(historicalCreationTime(mutation, admitted, '2026-08-27T04:00:00.000Z'), mutation.created_at);
  assert.throws(() => historicalCreationTime(mutation, { constraints: {} }, '2026-08-27T04:00:00.000Z'), /admitted zero-revision/);
  assert.throws(() => historicalCreationTime({ ...mutation, expected_revision: 1 }, admitted, '2026-08-27T04:00:00.000Z'), /admitted zero-revision/);
  assert.throws(() => historicalCreationTime({ ...mutation, created_at: '2026-09-01T00:00:00.000Z' }, admitted, '2026-08-27T04:00:00.000Z'), /admitted zero-revision/);
});

test('production index merge preserves a real existing post through migration replay', async () => {
  const { nextSpaceIndexMembers } = await loadTsModule('../do-work/owner-actions.ts');
  const existing = { entries: { 'existing-post-key': { item_ref: 'post:existing', target_ref: 'community:one' } }, item_order: ['existing-post-key'] };
  const migration = [{ item_ref: 'post:migrated', target_ref: 'community:one', operation: 'upsert' }];
  const first = nextSpaceIndexMembers(existing, migration);
  const replay = nextSpaceIndexMembers(first, migration);
  assert.equal(JSON.stringify(first.entries['existing-post-key']), JSON.stringify(existing.entries['existing-post-key']));
  assert.equal(JSON.stringify(replay.entries['existing-post-key']), JSON.stringify(existing.entries['existing-post-key']));
  assert.equal(first.item_order[0], 'existing-post-key');
  assert.equal(replay.item_order[0], 'existing-post-key');
  assert.equal(Object.keys(first.entries).length, 2);
  assert.equal(Object.keys(replay.entries).length, 2);
  assert.equal(new Set(replay.item_order).size, 2);
});
