// package-set://bitfield-studio/packages/travel-operations/do-work/travel-operation-requests.ts

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  TravelNotesState,
  TripAction,
  TripCreateAction,
  TripItem,
} from '../read-data/travel-operations';

export const TRAVEL_NOTE_WRITE_ACTION = 'action:travel-operations:write-evidence';

export function buildTravelItemActionRequest(item: TripItem, action: TripAction) {
  if (action.ownerPackage !== item.source.package) {
    throw new Error(`Action ${action.id} does not belong to ${item.source.package}.`);
  }
  return {
    target: action.target ?? 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: action.actionDefinitionId,
      include_steps: false,
      include_output: true,
      input: {
        ...action.input,
        operationId: item.id,
        operationRef: item.id,
        sourceRecord: item.source,
        evidenceRefs: action.supportRefs,
      },
    },
  };
}

export function dispatchTravelItemAction(item: TripItem, action: TripAction) {
  return sendRequestToBitfieldTarget(buildTravelItemActionRequest(item, action));
}

export function buildTripCreateActionRequest(action: TripCreateAction) {
  return {
    target: 'slot::workflow' as const,
    payload: {
      operation: 'execute_definition',
      definition_id: action.actionDefinitionId,
      include_steps: false,
      include_output: true,
      input: action.input,
    },
  };
}

export function dispatchTripCreateAction(action: TripCreateAction) {
  return sendRequestToBitfieldTarget(buildTripCreateActionRequest(action));
}

export function buildTravelNoteWriteRequest(state: TravelNotesState) {
  return {
    target: 'slot::workflow' as const,
    payload: {
      operation: 'execute_definition',
      definition_id: TRAVEL_NOTE_WRITE_ACTION,
      include_steps: false,
      include_output: false,
      input: state,
    },
  };
}

export function writeTravelNoteState(state: TravelNotesState): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildTravelNoteWriteRequest(state));
}
