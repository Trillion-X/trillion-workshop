import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  ContentProductionCompositionDescriptor,
  ContentProductionRunProfile,
} from '@/packages/content-production/read-data/read-content-production';

export type SubmitContentProductionRunRequest = {
  runId?: string;
  promptText: string;
  sources?: unknown[];
  requestedOutputs?: unknown[];
  executionDefinitionId?: string;
  runProfile?: ContentProductionRunProfile | null;
  composition?: ContentProductionCompositionDescriptor;
  metadata?: Record<string, unknown>;
  requestedAt?: string;
};

export type ContentProductionActionInvocationDescriptor = {
  descriptor_id?: string;
  owner_action_target?: string;
  owner_action_id?: string;
  default_execution_definition_id?: string;
};

export type ContentProductionRunInput = {
  run_id: string;
  prompt_text: string;
  sources: unknown[];
  requested_outputs: unknown[];
  execution_definition_id: string;
  metadata: Record<string, unknown>;
  requested_at: string;
};

function createRunId(): string {
  return `production:${crypto.randomUUID()}`;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Content production action descriptor is missing ${name}.`);
  }
  return value.trim();
}

function executionDefinitionIdFrom(
  request: SubmitContentProductionRunRequest,
  descriptor: ContentProductionActionInvocationDescriptor,
): string {
  const definitionId = request.executionDefinitionId
    ?? request.runProfile?.execution_definition_id
    ?? descriptor.default_execution_definition_id;
  if (typeof definitionId !== 'string' || definitionId.trim().length === 0) {
    throw new Error('Content production run is missing execution_definition_id.');
  }
  return definitionId.trim();
}

export function toContentProductionRunInput(
  request: SubmitContentProductionRunRequest,
  descriptor: ContentProductionActionInvocationDescriptor,
): ContentProductionRunInput {
  return {
    run_id: request.runId ?? createRunId(),
    prompt_text: request.promptText,
    sources: request.sources ?? request.runProfile?.sources ?? [],
    requested_outputs: request.requestedOutputs ?? request.runProfile?.requested_outputs ?? [],
    execution_definition_id: executionDefinitionIdFrom(request, descriptor),
    metadata: {
      ...(request.runProfile?.profile_id ? { run_profile_id: request.runProfile.profile_id } : {}),
      ...(request.runProfile?.metadata ?? {}),
      ...(request.metadata ?? {}),
      ...(request.composition ? { composition: request.composition } : {}),
    },
    requested_at: request.requestedAt ?? new Date().toISOString(),
  };
}

function ownerActionPayload(
  descriptor: ContentProductionActionInvocationDescriptor,
  input: unknown,
) {
  return {
    target: requiredText(descriptor.owner_action_target, 'owner_action_target'),
    payload: {
      operation: 'execute_definition',
      definition_id: requiredText(descriptor.owner_action_id, 'owner_action_id'),
      include_steps: false,
      include_output: false,
      input,
    },
  };
}

export async function submitContentProductionRun(
  request: SubmitContentProductionRunRequest,
  descriptor: ContentProductionActionInvocationDescriptor,
): Promise<ContentProductionRunInput> {
  const runInput = toContentProductionRunInput(request, descriptor);
  await sendRequestToBitfieldTarget(ownerActionPayload(descriptor, runInput));
  return runInput;
}
