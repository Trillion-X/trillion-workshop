// Ported from bitfield-packages/packages/relationship-graph/do-work/__tests__/request-connection-action.test.ts.
// Changed: imports, and the example target is a made-up word instead of the old runtime's `slot::workflow`.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { prepareConnectionActionRequest } from '../do-work/request-connection-action.ts';
import type { ActionDescriptor } from '../read-data/connection-model.ts';

describe('prepareConnectionActionRequest', () => {
  it('prepares an owner request from descriptor data', () => {
    const action: ActionDescriptor = {
      id: 'record',
      target: 'target:example',
      operation: 'owner-action',
      definition_id: 'action:data-owned',
      input_mapping: {
        selected: { method: 'json-path', params: { path: ['selected'] } },
        note: { method: 'json-path', params: { path: ['note'] } },
      },
      status_mapping: { waiting: { label: 'Waiting' } },
    };

    expect(prepareConnectionActionRequest({
      action,
      input: { selected: 'item:1', note: 'example data' },
      correlation_id: 'corr:1',
    })).toEqual({
      available: true,
      target: 'target:example',
      payload: {
        action_id: 'record',
        operation: 'owner-action',
        definition_id: 'action:data-owned',
        input: { selected: 'item:1', note: 'example data' },
        status_mapping: { waiting: { label: 'Waiting' } },
        correlation_id: 'corr:1',
      },
    });
  });

  it('returns disabled state when no owner target is declared', () => {
    expect(prepareConnectionActionRequest({
      action: { id: 'record' },
      input: {},
    })).toEqual({ available: false, reason: 'missing-target' });
  });

  it('preserves opaque input when no mapping is declared', () => {
    expect(prepareConnectionActionRequest({
      action: { id: 'record', target: 'target:any' },
      input: { arbitrary: { nested: true } },
    })).toMatchObject({
      available: true,
      payload: { input: { arbitrary: { nested: true } } },
    });
  });
});
