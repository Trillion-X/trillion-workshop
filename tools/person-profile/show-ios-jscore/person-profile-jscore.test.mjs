import assert from 'node:assert/strict';
import test from 'node:test';

import { materializationToNativeTree } from './person-profile-jscore-model.js';

test('JSCore model consumes the same materialized shape', () => {
  const tree = materializationToNativeTree({
    key: { surfaceId: 'shared.fixture', readerId: 'ios', transport: 'native-json' },
    value: {
      surfaceId: 'shared.fixture',
      readerId: 'ios',
      identity: { title: 'Shared source', badges: [] },
      fields: [{ id: 'field-a', label: 'Field A', value: 'same value' }],
      relationships: [],
      actions: [{ id: 'action-a', label: 'Do it' }],
      diagnostics: { sourceIds: [], problems: [] },
    },
  });

  assert.equal(tree.surfaceId, 'shared.fixture');
  assert.deepEqual(tree.sections.map((section) => section.kind), ['identityHeader', 'fieldGroup', 'actionArea']);
});
