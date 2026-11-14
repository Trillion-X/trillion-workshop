// package://packages/person-list/do-work/search-people.ts
//
// Builds a search owner-action input and dispatches it through the descriptor
// selected by package data.

import {
  dispatchOwnerAction,
  requireOwnerActionDescriptor,
  type OwnerActionDescriptor,
} from './owner-action-descriptors.ts';

export interface SearchPeopleRequest {
  eventRef: string;
  query: string;
  requestedAt: string;
}

export async function searchPeople(
  request: SearchPeopleRequest,
  descriptors: readonly OwnerActionDescriptor[],
): Promise<unknown> {
  return dispatchOwnerAction(
    requireOwnerActionDescriptor(descriptors, 'search'),
    {
      event_ref: request.eventRef,
      actor_ref: '',
      target_ref: '',
      requested_at: request.requestedAt,
      query: request.query,
    },
  );
}
