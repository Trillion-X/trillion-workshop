import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildOwnerActionEventRequest } from '../do-work/build-owner-action-event-request.ts';
import { ownerActionDisabledReason } from '../do-work/owner-action-disabled-reason.ts';
import { fixtureDescriptors, fixtureRecords } from '../read-data/universal-action-event-fixtures.ts';

describe('owner action event requests', () => {
  it('builds a workflow request from descriptor mappings', () => {
    const action = fixtureDescriptors.actions?.find((entry) => entry.id === 'action:open');
    if (!action) throw new Error('fixture action missing');
    const request = buildOwnerActionEventRequest(action, fixtureDescriptors, { record: fixtureRecords[0] });
    expect(request.target).toBe('slot::workflow');
    expect(request.payload.definition_id).toBe('definition:open');
    expect((request.payload.input as Record<string, unknown>).record_id).toBe('record:1');
    expect((request.payload.input as Record<string, unknown>).title).toBe('A');
  });

  it('does not build local mutation when route is missing', () => {
    const action = fixtureDescriptors.actions?.find((entry) => entry.id === 'action:missing');
    if (!action) throw new Error('fixture action missing');
    expect(ownerActionDisabledReason(action, fixtureDescriptors)).toBe('No owner route is declared.');
    expect(() => buildOwnerActionEventRequest(action, fixtureDescriptors, { record: fixtureRecords[0] })).toThrow(/No owner route/);
  });
});
