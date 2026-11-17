import type { OperationCandidateFact, OperationEvidence } from '../../../../operation-records/read-data/operation-records';

export interface SourceLinkedProposalBinding {
  from: 'candidate' | 'payload' | 'literal' | 'sourceProof';
  path?: readonly string[];
  value?: unknown;
}

export interface SourceLinkedProposalTaskActionDescriptor {
  actionDefinitionId: string;
  id: string;
  input: Record<string, SourceLinkedProposalBinding | unknown>;
  operation?: 'execute_definition';
  proofGates?: readonly string[];
  target?: string;
}

export interface SourceLinkedProposalTaskContext {
  acceptedAt: string;
  actorRef?: string;
  candidate: OperationCandidateFact;
  evidence: readonly OperationEvidence[];
  idempotencyKey: string;
}

export interface SourceLinkedProposalTaskActionRequest {
  receipt: {
    acceptedAt: string;
    actionId: string;
    actorRef?: string;
    candidateFactRef: string;
    idempotencyKey: string;
    sourceEvidenceRefs: readonly string[];
    targetOwnerPackage: string;
    targetRecordRef: string;
  };
  request: {
    payload: {
      definition_id: string;
      include_output: false;
      include_steps: false;
      input: Record<string, unknown>;
      operation: 'execute_definition';
    };
    target: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPath(value: unknown, path: readonly string[] = []): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isBinding(value: unknown): value is SourceLinkedProposalBinding {
  return isRecord(value)
    && (value.from === 'candidate' || value.from === 'payload' || value.from === 'literal' || value.from === 'sourceProof');
}

function bindingValue(binding: SourceLinkedProposalBinding, context: SourceLinkedProposalTaskContext): unknown {
  if (binding.from === 'literal') return binding.value;
  if (binding.from === 'candidate') return readPath(context.candidate, binding.path);
  if (binding.from === 'payload') return readPath(context.candidate.proposedPatch, binding.path);
  return context.candidate.sourceEvidenceRefs;
}

function materializeInput(
  descriptor: SourceLinkedProposalTaskActionDescriptor,
  context: SourceLinkedProposalTaskContext,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(descriptor.input)) {
    const resolved = isBinding(value) ? bindingValue(value, context) : value;
    if (resolved !== undefined) input[key] = resolved;
  }
  return input;
}

function proofRefs(context: SourceLinkedProposalTaskContext): string[] {
  return Array.from(new Set([
    ...context.candidate.sourceEvidenceRefs,
    ...context.evidence.map((entry) => entry.id),
  ]));
}

export function buildSourceLinkedProposalTaskActionRequest(
  descriptor: SourceLinkedProposalTaskActionDescriptor,
  context: SourceLinkedProposalTaskContext,
): SourceLinkedProposalTaskActionRequest {
  if (descriptor.proofGates?.length && context.candidate.sourceEvidenceRefs.length === 0) {
    throw new Error('This task action needs source proof before it can accept the proposal.');
  }

  return {
    request: {
      target: descriptor.target ?? 'slot::workflow',
      payload: {
        operation: descriptor.operation ?? 'execute_definition',
        definition_id: descriptor.actionDefinitionId,
        include_steps: false,
        include_output: false,
        input: {
          ...materializeInput(descriptor, context),
          source_proof_refs: proofRefs(context),
          source_candidate_fact_ref: context.candidate.id,
          source_accepted_at: context.acceptedAt,
          source_idempotency_key: context.idempotencyKey,
        },
      },
    },
    receipt: {
      actionId: descriptor.id,
      acceptedAt: context.acceptedAt,
      actorRef: context.actorRef,
      candidateFactRef: context.candidate.id,
      idempotencyKey: context.idempotencyKey,
      sourceEvidenceRefs: proofRefs(context),
      targetOwnerPackage: context.candidate.targetOwnerPackage,
      targetRecordRef: context.candidate.targetRecordRef,
    },
  };
}
