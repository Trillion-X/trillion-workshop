import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import permissionLeaseContract from '../../record-voice-and-meetings/things-to-store-and-run.json';
import {
  decodeConfiguredPermissionActions,
  type PermissionLeaseAction,
} from '../read-data/permission-lease-surface.ts';

export interface PermissionLeaseRecordRequest {
  leaseRef: string;
  subjectRef: string;
  connectorRef?: string;
  credentialHandleRef?: string;
  providerHandleRef?: string;
  serviceConnectionHandleRef?: string;
  allowedActions: string[];
  allowedOperationRefs?: string[];
  expiresAt?: string | null;
  idempotencyKey: string;
  evidenceRefs?: string[];
}

function recordAction(actions: PermissionLeaseAction[]): PermissionLeaseAction {
  const action = actions.find((candidate) => candidate.operation === 'record-lease');
  if (!action) throw new Error('permission-lease record action is not configured');
  return action;
}

function assertHandleOnly(input: PermissionLeaseRecordRequest) {
  const unsafe = input as PermissionLeaseRecordRequest & {
    credentialValue?: unknown;
    secret?: unknown;
    token?: unknown;
    password?: unknown;
  };
  if (
    unsafe.credentialValue !== undefined
    || unsafe.secret !== undefined
    || unsafe.token !== undefined
    || unsafe.password !== undefined
  ) {
    throw new Error('saved key handle required');
  }
}

export function buildPermissionLeaseRecordRequest(
  input: PermissionLeaseRecordRequest,
  actions: PermissionLeaseAction[] = decodeConfiguredPermissionActions(permissionLeaseContract),
) {
  assertHandleOnly(input);
  const action = recordAction(actions);
  return {
    target: action.target,
    payload: {
      definition_id: action.definitionId,
      input: {
        lease_ref: input.leaseRef,
        subject_ref: input.subjectRef,
        idempotency_key: input.idempotencyKey,
        allowed_actions: input.allowedActions,
        ...(input.connectorRef ? { connector_ref: input.connectorRef } : {}),
        ...(input.credentialHandleRef ? { credential_handle_ref: input.credentialHandleRef } : {}),
        ...(input.providerHandleRef ? { provider_handle_ref: input.providerHandleRef } : {}),
        ...(input.serviceConnectionHandleRef ? { service_connection_handle_ref: input.serviceConnectionHandleRef } : {}),
        ...(input.allowedOperationRefs ? { allowed_operation_refs: input.allowedOperationRefs } : {}),
        ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
        ...(input.evidenceRefs ? { evidence_refs: input.evidenceRefs } : {}),
      },
    },
  };
}

export function recordPermissionLease(input: PermissionLeaseRecordRequest) {
  return sendRequestToBitfieldTarget(buildPermissionLeaseRecordRequest(input));
}
