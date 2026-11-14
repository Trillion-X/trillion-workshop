import type { UniversalActionEventActionDescriptor, UniversalActionEventDescriptorSet } from '../read-data/universal-action-event-contract.ts';

export function ownerActionDisabledReason(
  action: UniversalActionEventActionDescriptor,
  descriptors: UniversalActionEventDescriptorSet,
): string | null {
  const reasons = descriptors.disabledReasons ?? {};
  if (action.availability?.requiresRoute && !action.definitionId && !action.target) {
    return reasons[action.availability.disabledReasonId ?? ''] ?? null;
  }
  if (action.offlinePolicy === 'read-only') {
    return reasons[action.availability?.readOnlyReasonId ?? ''] ?? null;
  }
  return null;
}
