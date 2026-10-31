// Carried from bitfield-packages packages/person-profile/tests/described-record-action.test.ts: the same two cases and
// expectations, on node:test and assert instead of vitest.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDescribedRecordActionRequest } from '../do-work/described-record-action.ts';

describe('buildDescribedRecordActionRequest', () => {
  it('builds descriptor-owned target requests with bound input', () => {
    const result = buildDescribedRecordActionRequest({
      actionId: 'save-field',
      operationId: 'op-1',
      values: { fieldId: 'display-title', value: 'Ava' },
      sources: { actor: { id: 'actor-1' } },
      descriptors: [{
        id: 'save-field',
        target: 'owner-action:described-record-change',
        method: 'request',
        input: { surfaceId: 'surface-1' },
        bindings: [{ key: 'actorId', source: 'actor', path: ['id'] }],
        resultSelector: { path: ['result'] },
      }],
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.requests, [{
      target: 'owner-action:described-record-change',
      payload: {
        method: 'request',
        action_id: 'save-field',
        operation_id: 'op-1',
        input: {
          surfaceId: 'surface-1',
          fieldId: 'display-title',
          value: 'Ava',
          actorId: 'actor-1',
        },
        result_selector: { path: ['result'] },
      },
      trace: {
        actionId: 'save-field',
        operationId: 'op-1',
        bindingKeys: ['actorId'],
      },
    }]);
  });

  it('reports missing descriptors instead of inventing execution behavior', () => {
    const result = buildDescribedRecordActionRequest({
      actionId: 'unknown',
      operationId: 'op-2',
      descriptors: [],
    });

    assert.deepEqual(result.requests, []);
    assert.deepEqual(result.errors, [{ code: 'missing-descriptor', detail: 'unknown' }]);
  });
});
