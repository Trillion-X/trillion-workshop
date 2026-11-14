// package-set://bitfield-studio/packages/package-dependencies/do-work/create-owner-action-intent.ts

import { readPackageDependencyDescriptors } from '../read-data/read-relation-projection.ts';

export interface OwnerActionIntentInput {
  descriptor?: Record<string, unknown>;
  descriptor_id?: string;
  selected_refs?: string[];
  expected_projection_generation?: number | string;
  confirmation_proof?: Record<string, unknown>;
  idempotency_key?: string;
  requested_at?: string;
  context?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function generation(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

function descriptorFromInput(input: OwnerActionIntentInput): Record<string, unknown> | null {
  const direct = record(input.descriptor);
  if (text(direct.id)) return direct;
  const descriptorId = text(input.descriptor_id);
  return readPackageDependencyDescriptors().ownerActionIntents.find((descriptor) => descriptor.id === descriptorId) ?? null;
}

export function createOwnerActionIntent(input: OwnerActionIntentInput) {
  const descriptor = descriptorFromInput(input);
  if (!descriptor) return { error: 'owner action intent descriptor is required' };

  const selectedRefs = textList(input.selected_refs);
  const expectedGeneration = generation(input.expected_projection_generation);
  const confirmationProof = record(input.confirmation_proof);
  const idempotencyKey = text(input.idempotency_key);
  const requestedAt = text(input.requested_at);
  const errors = [
    ...(selectedRefs.length === 0 ? ['selected_refs must include at least one ref'] : []),
    ...(!expectedGeneration ? ['expected_projection_generation is required'] : []),
    ...(Object.keys(confirmationProof).length === 0 ? ['confirmation_proof is required'] : []),
    ...(!idempotencyKey ? ['idempotency_key is required'] : []),
    ...(!requestedAt ? ['requested_at is required'] : []),
  ];
  if (errors.length > 0) return { error: 'owner action intent input is incomplete', details: errors };

  return {
    kind: 'owner-action-intent-record',
    id: `owner-action-intent:${idempotencyKey}`,
    descriptorId: descriptor.id,
    ownerTargetRef: descriptor.owner_target_ref,
    ownerActionRef: descriptor.owner_action_ref,
    target: descriptor.target ?? 'slot::workflow',
    selectedRefs,
    expectedProjectionGeneration: expectedGeneration,
    confirmationProof,
    idempotencyKey,
    requestedAt,
    payload: {
      ...record(descriptor.payload_template),
      descriptor_id: descriptor.id,
      selected_refs: selectedRefs,
      expected_projection_generation: expectedGeneration,
      confirmation_proof: confirmationProof,
      context: record(input.context),
    },
  };
}

export function createOwnerActionIntentTarget(input: unknown) {
  return createOwnerActionIntent(record(input) as OwnerActionIntentInput);
}
