import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './load-ts-module.mjs';

function descriptorWithRoles(values) {
  return {
    id: 'descriptor-under-test',
    fields: [
      { id: 'id', role: 'identity', sourceKeys: ['id'] },
      { id: 'title', role: 'title', sourceKeys: ['title', 'subject'] },
      { id: 'body', role: 'body', sourceKeys: ['body', 'note', 'message'] },
      { id: 'actor', role: 'actor', sourceKeys: ['actor'] },
      { id: 'author', role: 'author', sourceKeys: ['author'] },
      { id: 'created-at', role: 'created-at', sourceKeys: ['when'] },
      { id: 'record-role-key', role: 'record-role-key', sourceKeys: ['type'] },
      { id: 'facet', role: 'facet', sourceKeys: ['label'] },
      { id: 'unknown-extra', role: 'extra', sourceKeys: ['customValue'] },
    ],
    roles: [
      { role: 'primary', values: [values.primary] },
      { role: 'child', values: [values.child] },
      { role: 'effect', values: [values.effect] },
    ],
    relationships: [
      { id: 'parent', role: 'parent', sourceKeys: ['parent'] },
      { id: 'target', role: 'target', sourceKeys: ['target'] },
    ],
    views: [
      {
        id: 'dense',
        fieldIds: ['title', 'body', 'record-role-key', 'unknown-extra'],
        relationshipIds: ['parent', 'target'],
      },
    ],
  };
}

test('descriptor interpreter handles several domain-shaped fixtures with one code path', async () => {
  const { decodeFeedItems, splitFeed } = await loadTsModule('../read-data/read-item-records.ts');
  const scope = {
    actor_ref: 'actor:server',
    session_ref: 'session:server',
    subject_ref: 'scope:descriptor',
    action_ref: 'action:read',
    decision_proof: 'decision:descriptor',
    revisions: { session_revision: 'session:1', policy_revision: 'policy:1', membership_revision: 'membership:1', resource_revision: 'resource:1' },
  };
  const fixtures = [
    descriptorWithRoles({ primary: 'post', child: 'comment', effect: 'reaction' }),
    descriptorWithRoles({ primary: 'lead', child: 'follow-up', effect: 'loss' }),
    descriptorWithRoles({ primary: 'campaign', child: 'touch', effect: 'conversion' }),
    descriptorWithRoles({ primary: 'event', child: 'attendee-note', effect: 'reminder' }),
  ];

  for (const descriptor of fixtures) {
    const [primary, child, effect] = descriptor.roles.map((role) => role.values[0]);
    const items = decodeFeedItems([
      { id: 'a', type: primary, target: 'scope:descriptor', body: 'root', when: '2026-01-01T00:00:00Z' },
      { id: 'b', type: child, target: 'scope:descriptor', parent: 'a', body: 'child', when: '2026-01-01T00:01:00Z' },
      { id: 'c', type: effect, target: 'scope:descriptor', parent: 'a', actor: 'actor:1', when: '2026-01-01T00:02:00Z' },
    ], descriptor, scope);
    const split = splitFeed(items);

    assert.equal(split.posts.length, 1);
    assert.equal(split.commentsByParent.get('a').length, 1);
    assert.equal(split.reactionsByParent.get('a').length, 1);
  }
});

test('unknown descriptor fields are preserved in reader-keyed projection output', async () => {
  const { projectRecordForView } = await loadTsModule('../read-data/record-descriptors.ts');
  const descriptor = descriptorWithRoles({ primary: 'anything', child: 'child', effect: 'effect' });

  const projection = projectRecordForView(
    descriptor,
    'dense',
    { id: 'record-1', type: 'anything', body: 'hello', customValue: { nested: true }, parent: 'parent-1' },
    'record-1',
  );

  assert.equal(
    JSON.stringify(projection.values.find((value) => value.fieldId === 'unknown-extra')),
    JSON.stringify({ fieldId: 'unknown-extra', value: { nested: true } }),
  );
  assert.equal(
    JSON.stringify(projection.relationships.find((value) => value.fieldId === 'parent')),
    JSON.stringify({ fieldId: 'parent', value: 'parent-1' }),
  );
});
