// package://packages/person-list/do-work/refresh-people.ts
//
// Dispatches every refresh owner-action descriptor supplied by package data.

import {
  dispatchOwnerAction,
  type OwnerActionDescriptor,
} from './owner-action-descriptors.ts';

export async function refreshPeople(
  descriptors: readonly OwnerActionDescriptor[],
): Promise<unknown[]> {
  const refreshDescriptors = descriptors.filter((descriptor) => descriptor.key.startsWith('refresh'));
  if (refreshDescriptors.length === 0) throw new Error('Missing refresh owner-action descriptor');
  const results = await Promise.allSettled(
    refreshDescriptors.map((descriptor) => dispatchOwnerAction(descriptor, {})),
  );
  const primary = results[0];
  if (primary?.status === 'rejected') throw primary.reason;
  return results
    .filter((result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled')
    .map((result) => result.value);
}
