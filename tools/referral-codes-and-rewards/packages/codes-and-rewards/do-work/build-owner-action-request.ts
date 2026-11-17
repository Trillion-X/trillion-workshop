// package-set://bitfield-studio/packages/codes-and-rewards/do-work/build-owner-action-request.ts
//
// Builds owner-action request records from action descriptor data. This module
// materializes requests; workflow, HTTP, payment, account, and process-session
// owners execute and prove their own work.

import defaultContract from '../record-interaction-contract.json';
import type { ActionDescriptor, JsonRecord, RecordInteractionContract } from '../read-data/read-record-interaction-surface';

export interface BuildOwnerActionRequestInput {
  contract?: RecordInteractionContract;
  action_id?: string;
  input_facts?: JsonRecord;
  subject?: JsonRecord;
  idempotency_key?: string;
  requested_at?: string;
  metadata?: JsonRecord;
}

export interface OwnerActionRequest {
  kind: 'owner-action-request';
  id: string;
  actionId: string;
  ownerInvoke: JsonRecord;
  inputFacts: JsonRecord;
  subject: JsonRecord;
  relationshipRefs: readonly string[];
  evidenceRef?: string;
  projectionRef?: string;
  idempotencyKey: string;
  requestedAt: string;
  payload: JsonRecord;
  metadata: JsonRecord;
}

export interface LocalPresentationAcknowledgement {
  kind: 'local-presentation-acknowledgement';
  id: string;
  actionId: string;
  inputFacts: JsonRecord;
  metadata: JsonRecord;
}

export interface OwnerActionRequestError {
  error: {
    code: 'missing-action' | 'missing-input' | 'invalid-descriptor';
    message: string;
    details?: readonly string[];
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function normalizeContract(value: unknown): RecordInteractionContract {
  const contract = isRecord(value) ? value as unknown as RecordInteractionContract : defaultContract as RecordInteractionContract;
  return {
    ...contract,
    action_descriptors: list(contract.action_descriptors) as ActionDescriptor[],
  };
}

function actionById(contract: RecordInteractionContract, actionId: string): ActionDescriptor | undefined {
  return contract.action_descriptors?.find((action) => action.id === actionId);
}

function requiredInputErrors(action: ActionDescriptor, inputFacts: JsonRecord): string[] {
  return list(action.input_bindings)
    .filter(isRecord)
    .filter((binding) => binding.required !== false && inputFacts[text(binding.key)] === undefined)
    .map((binding) => `Missing required input binding: ${text(binding.key)}`);
}

function ownerInvokeErrors(action: ActionDescriptor): string[] {
  if (action.local_acknowledgement) return [];
  const ownerInvoke = record(action.owner_invoke);
  return [
    ...(!text(ownerInvoke.target) ? ['owner_invoke.target is required'] : []),
    ...(!text(ownerInvoke.action_definition_id) ? ['owner_invoke.action_definition_id is required'] : []),
  ];
}

export function buildOwnerActionRequest(input: BuildOwnerActionRequestInput): OwnerActionRequest | LocalPresentationAcknowledgement | OwnerActionRequestError {
  const contract = normalizeContract(input.contract);
  const actionId = text(input.action_id);
  const action = actionId ? actionById(contract, actionId) : undefined;
  if (!action) {
    return {
      error: {
        code: 'missing-action',
        message: 'Action descriptor is required.',
        details: actionId ? [`Unknown action descriptor: ${actionId}`] : ['action_id is required'],
      },
    };
  }

  const inputFacts = record(input.input_facts);
  const metadata = { ...record(action.metadata), ...record(input.metadata) };
  const inputErrors = [
    ...requiredInputErrors(action, inputFacts),
    ...(!action.local_acknowledgement && !text(input.idempotency_key) ? ['idempotency_key is required'] : []),
    ...(!action.local_acknowledgement && !text(input.requested_at) ? ['requested_at is required'] : []),
  ];
  if (inputErrors.length > 0) {
    return {
      error: {
        code: 'missing-input',
        message: 'Action request input is incomplete.',
        details: inputErrors,
      },
    };
  }

  if (action.local_acknowledgement) {
    return {
      kind: 'local-presentation-acknowledgement',
      id: `local-presentation:${action.id}:${text(inputFacts.visible_value) || action.id}`,
      actionId: action.id,
      inputFacts,
      metadata,
    };
  }

  const descriptorErrors = ownerInvokeErrors(action);
  if (descriptorErrors.length > 0) {
    return {
      error: {
        code: 'invalid-descriptor',
        message: 'Action descriptor cannot build an owner request.',
        details: descriptorErrors,
      },
    };
  }

  const idempotencyKey = text(input.idempotency_key);
  const requestedAt = text(input.requested_at);
  return {
    kind: 'owner-action-request',
    id: `owner-action:${action.id}:${idempotencyKey}`,
    actionId: action.id,
    ownerInvoke: record(action.owner_invoke),
    inputFacts,
    subject: record(input.subject),
    relationshipRefs: list(action.relationship_refs).map(text).filter(Boolean),
    evidenceRef: text(action.evidence_ref) || undefined,
    projectionRef: text(action.projection_ref) || undefined,
    idempotencyKey,
    requestedAt,
    payload: {
      ...record(action.payload_template),
      action_id: action.id,
      input_facts: inputFacts,
      subject: record(input.subject),
    },
    metadata,
  };
}
