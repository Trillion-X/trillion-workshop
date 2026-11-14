import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import permissionLeaseContract from '../../record-voice-and-meetings/things-to-store-and-run.json';
import {
  decodeConfiguredPermissionActions,
  type PermissionLeaseAction,
} from '../read-data/permission-lease-surface.ts';

export interface PermissionLeaseCheckRequest {
  operationRef: string;
  requestedActionRef: string;
  subjectRef?: string;
  leaseRef?: string;
  idempotencyKey: string;
  evidenceRefs?: string[];
}

function checkAction(actions: PermissionLeaseAction[]): PermissionLeaseAction {
  const action = actions.find((candidate) => candidate.operation === 'check-lease');
  if (!action) throw new Error('permission-lease check action is not configured');
  return action;
}

export function buildPermissionLeaseCheckRequest(
  input: PermissionLeaseCheckRequest,
  actions: PermissionLeaseAction[] = decodeConfiguredPermissionActions(permissionLeaseContract),
) {
  const action = checkAction(actions);
  return {
    target: action.target,
    payload: {
      definition_id: action.definitionId,
      input: {
        operation_ref: input.operationRef,
        requested_action_ref: input.requestedActionRef,
        idempotency_key: input.idempotencyKey,
        ...(input.subjectRef ? { subject_ref: input.subjectRef } : {}),
        ...(input.leaseRef ? { lease_ref: input.leaseRef } : {}),
        ...(input.evidenceRefs ? { evidence_refs: input.evidenceRefs } : {}),
      },
    },
  };
}

export function requestPermissionLeaseCheck(input: PermissionLeaseCheckRequest) {
  return sendRequestToBitfieldTarget(buildPermissionLeaseCheckRequest(input));
}
