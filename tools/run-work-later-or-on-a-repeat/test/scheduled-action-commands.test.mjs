// Ported from bitfield-packages packages/timed-action/__tests__/scheduled-action-commands.test.mjs; the module is imported directly.
import assert from 'node:assert/strict';
const recordModule = await import('../do-work/write-scheduled-action-record.ts');

// Row-carried dispatch doctrine: the action row carries its OWN complete dispatch
// config as DATA. A workflow target is slot::workflow + execute_definition (ask names
// are slot addresses, never bare definition ids).
const ACTION_DISPATCH = {
  name: 'slot::workflow',
  input: {
    operation: 'execute_definition',
    definition_id: 'action:content-distribution.run-publish-intent',
    input: { record_id: 'work-a' }
  }
};

const created = recordModule.buildScheduledActionRecordWrite({
  record_id: 'work-a',
  fields: { title: 'Launch note' },
  relationships: [{ target_id: 'target-1', relation_role: 'target' }],
  time_window: { time_window_id: 'tw-a', start: '2026-06-22T15:00:00.000Z' },
  actions: [{ action_id: 'action-a', dispatch: ACTION_DISPATCH }]
});
assert.equal(created.operation, 'upsert-record');
assert.equal(created.record_id, 'work-a');
// record + relationship + time-window + action = 4 writes
assert.equal(created.writes.length, 4);
assert.equal(created.receipt_preview.write_count, 4);
assert.deepEqual(created.receipt_preview.idempotency_key_material, ['work-a', 'upsert-record']);

// Every graph write must land at a NARROWLY-queryable current-item kind path (so
// find-current-items in:"scheduled-action-<role>" returns it) and self-describe its kind.
for (const w of created.writes) {
  assert.equal(w.path[0], 'current-item', `write path must start at current-item: ${JSON.stringify(w.path)}`);
  assert.ok(String(w.path[1]).startsWith('scheduled-action-'), `queryable kind path: ${JSON.stringify(w.path)}`);
  assert.equal(w.payload.kind, w.path[1], 'payload.kind self-describes the queryable kind');
}
const byKind = Object.fromEntries(created.writes.map((w) => [w.path[1], w]));
assert.ok(byKind['scheduled-action-record']);
assert.ok(byKind['scheduled-action-time-window']);
assert.ok(byKind['scheduled-action-relationship']);
// The action write carries the row's OWN dispatch config the fire definition re-reads
// and asks blindly — never target_ref/method/bindings vocabulary.
assert.deepEqual(byKind['scheduled-action-action'].payload.dispatch, ACTION_DISPATCH);
assert.equal(byKind['scheduled-action-action'].payload.record_id, 'work-a');
assert.equal(byKind['scheduled-action-action'].payload.operation, 'action-a');
assert.equal('target_ref' in byKind['scheduled-action-action'].payload, false);
assert.equal('method' in byKind['scheduled-action-action'].payload, false);
assert.equal('bindings' in byKind['scheduled-action-action'].payload, false);

// A dispatch-less action row is rejected at write time (fail-closed — a row without
// its own dispatch config is unschedulable work).
assert.throws(
  () => recordModule.buildScheduledActionRecordWrite({ record_id: 'work-x', actions: [{ action_id: 'action-x' }] }),
  /action\.dispatch is required/
);

const replaced = recordModule.buildReplaceTimeWindowWrite({
  record_id: 'work-a',
  time_window: { time_window_id: 'tw-a-2', start: '2026-06-23T15:00:00.000Z' }
});
assert.equal(replaced.operation, 'replace-time-window');
assert.equal(replaced.writes.at(-1).payload.time_window_id, 'tw-a-2');

const canceled = recordModule.buildScheduledActionStateWrite({
  record_id: 'work-a',
  operation: 'canceled',
  observed_at: '2026-06-22T15:05:00.000Z',
  reason_refs: ['reason-1']
});
assert.equal(canceled.writes[0].payload.operation, 'canceled');
assert.deepEqual(canceled.receipt_preview.blocked_reason_refs, ['reason-1']);
// The receipt is queryable too (in:"scheduled-action-receipt").
assert.deepEqual(canceled.writes[0].path, ['current-item', 'scheduled-action-receipt']);
assert.equal(canceled.writes[0].payload.kind, 'scheduled-action-receipt');

console.log('scheduled-action-commands: ok');
