// parts/service-connections/do-work/workflow-actions.ts
//
// Service connection owner-action bridge. Connection facts stay owned by the
// workflow/action layer; this package only asks that owner to execute actions.
// Trillion has no owner-action host: it passes its own seams to every connect call, so asking one fails with this.
const sendRequestToOwner = (_request: { target: string; payload: unknown }): Promise<unknown> => Promise.reject(new Error('Owner actions are not available here; pass the host\'s own seams.'));

import {
  ownerRecordWorkActionDescriptor,
  type OwnerRecordWorkActionDescriptor,
} from '../read-data/owner-record-work-contract';

type WorkflowActionPayload = {
  operation: 'execute_definition';
  definition_id: string;
  include_steps: boolean;
  include_output: boolean;
  input?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Target replies arrive as envelopes whose `payload` is JSON bytes (same
 * shape the chat connect path decodes). Surface the decoded record so
 * callers can read `output` and error/status fields directly.
 */
function decodeWorkflowReply(reply: unknown): Record<string, unknown> {
  if (!isRecord(reply)) return {};
  const payload = (reply as { payload?: unknown }).payload;
  if (payload instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return isRecord(payload) ? payload : reply;
}

function hasWorkflowError(value: unknown): value is { error: unknown } {
  return !!value && typeof value === 'object' && 'error' in value;
}

function hasRejectedStatus(
  value: unknown,
  acceptedStatuses: ReadonlySet<string>,
): value is { status: unknown } {
  return !!value
    && typeof value === 'object'
    && 'status' in value
    && !acceptedStatuses.has(String((value as { status: unknown }).status));
}

export async function runServiceConnectionWorkflowAction(
  descriptor: OwnerRecordWorkActionDescriptor,
  input: Record<string, unknown> = {},
  options: { includeOutput?: boolean } = {},
): Promise<unknown> {
  const payload: WorkflowActionPayload = {
    operation: 'execute_definition',
    definition_id: descriptor.definition_id,
    include_steps: descriptor.include_steps,
    // Callers that read the action's return value (e.g. the credential
    // verify, which needs status_code) must opt in — include_output:false
    // strips the output entirely and the caller would see undefined.
    include_output: options.includeOutput ?? descriptor.include_output,
    input,
  };

  const response = decodeWorkflowReply(await sendRequestToOwner({
    target: descriptor.target,
    payload,
  }));

  if (hasWorkflowError(response)) {
    throw new Error(String(response.error));
  }

  if (hasRejectedStatus(response, new Set(descriptor.accepted_statuses))) {
    throw new Error(`Owner action ${descriptor.id} returned ${String(response.status)}`);
  }

  return response;
}

export function serviceConnectionOwnerAction(
  operation: string,
): OwnerRecordWorkActionDescriptor {
  return ownerRecordWorkActionDescriptor(operation);
}

export function requireWrittenServiceConnectionFacts(
  reply: unknown,
  expectedCount: number,
): void {
  const record = isRecord(reply) ? reply : {};
  const output = isRecord(record.output) ? record.output : record;
  if (output.writes_emitted !== expectedCount) {
    throw new Error('Connection changes were not saved. Try again.');
  }
}

export function publishServiceConnections(): Promise<unknown> {
  return runServiceConnectionWorkflowAction(serviceConnectionOwnerAction('publish-records'));
}
