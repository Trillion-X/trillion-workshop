import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './load-ts-module.mjs';

test('ref normalization handles entity-form and bare refs', async () => {
  const { decodeFeedItems, splitFeed } = await loadTsModule('../read-data/read-item-records.ts');
  const scope = { actor_ref: 'actor:server', session_ref: 'session:server', subject_ref: 'scope:one', action_ref: 'action:read', decision_proof: 'decision:one', revisions: { session_revision: 'session:1', policy_revision: 'policy:1', membership_revision: 'membership:1', resource_revision: 'resource:1' } };
  const items = decodeFeedItems([
    { item_ref: 'item-record:root', target_ref: 'scope:one', fields: { body: 'root', kind: 'post' } },
    { item_ref: 'item-record:child', target_ref: 'scope:one', fields: { body: 'child', kind: 'comment', parentRef: 'root' } },
    { item_ref: 'effect', target_ref: 'scope:one', fields: { kind: 'reaction', parentRef: 'item-record:root', actor_ref: 'actor:1' } },
  ], undefined, scope);
  const split = splitFeed(items);

  assert.equal(split.posts[0].id, 'root');
  assert.equal(split.commentsByParent.get('root')[0].id, 'child');
  assert.equal(split.reactionsByParent.get('root')[0].id, 'effect');
});

test('dense, compact, and summary projections share one raw authority', async () => {
  const {
    defaultItemRecordDescriptor,
    projectRecordForView,
  } = await loadTsModule('../read-data/record-descriptors.ts');
  const raw = {
    item_ref: 'item-record:one',
    target_ref: 'scope:one',
    actor_ref: 'actor:one',
    created_at: '2026-06-22T00:00:00Z',
    fields: {
      kind: 'post',
      title: 'One',
      body: 'Shared source',
      parentRef: 'parent:one',
      categoryRef: 'category:one',
    },
  };

  const dense = projectRecordForView(defaultItemRecordDescriptor, 'browser-dense', raw, 'one');
  const compact = projectRecordForView(defaultItemRecordDescriptor, 'ios-compact', raw, 'one');
  const summary = projectRecordForView(defaultItemRecordDescriptor, 'voice-summary', raw, 'one');

  assert.equal(dense.itemId, compact.itemId);
  assert.equal(compact.itemId, summary.itemId);
  assert.ok(dense.values.some((value) => value.fieldId === 'category'));
  assert.ok(!compact.values.some((value) => value.fieldId === 'category'));
  assert.ok(summary.values.some((value) => value.fieldId === 'body'));
});
