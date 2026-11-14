import type { WorkGraphAction, WorkGraphRecord } from '../read-data/generic-record-work-graph.ts';

export interface GenericRecordWorkActionRequest {
  target: string;
  payload: {
    operation: string;
    definition_id?: string;
    include_steps: false;
    include_output: false;
    input: Record<string, unknown>;
  };
}

export interface GenericRecordWorkActionInput {
  action: WorkGraphAction;
  values?: Record<string, unknown>;
  records?: WorkGraphRecord[];
  projectionRevision?: string;
}

export function buildGenericRecordWorkActionInput(input: GenericRecordWorkActionInput): Record<string, unknown> {
  return {
    ...(input.action.input ?? {}),
    ...(input.values ?? {}),
    records: input.records?.map((record) => record.raw) ?? [],
    projection_revision: input.projectionRevision,
    action_ref: input.action.id,
  };
}

export function buildGenericRecordWorkActionRequest(input: GenericRecordWorkActionInput): GenericRecordWorkActionRequest {
  return {
    target: input.action.target,
    payload: {
      operation: input.action.operation,
      definition_id: input.action.definitionId,
      include_steps: false,
      include_output: false,
      input: buildGenericRecordWorkActionInput(input),
    },
  };
}

export function canInvokeGenericRecordWorkAction(action: WorkGraphAction): boolean {
  return !action.disabledReason;
}
