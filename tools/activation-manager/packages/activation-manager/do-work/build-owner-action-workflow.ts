import { record, text } from '../read-data/capability-state-records';

export interface WorkflowRequestDescriptor {
  target: string;
  operation: string;
  definitionId: string;
  includeSteps: boolean;
  includeOutput: boolean;
  inputTemplate: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface OwnerWorkflowRequest {
  target: string;
  payload: {
    operation: string;
    definition_id: string;
    include_steps: boolean;
    include_output: boolean;
    input: Record<string, unknown>;
  };
}

export function readWorkflowRequestDescriptor(value: unknown): WorkflowRequestDescriptor {
  const descriptor = record(value);
  const target = text(descriptor.target);
  const operation = text(descriptor.operation);
  const definitionId = text(descriptor.definition_id ?? descriptor.definitionId);
  if (!target || !operation || !definitionId) {
    throw new Error('workflow request descriptor requires target, operation, and definition id');
  }
  return {
    target,
    operation,
    definitionId,
    includeSteps: descriptor.include_steps === true || descriptor.includeSteps === true,
    includeOutput: descriptor.include_output !== false && descriptor.includeOutput !== false,
    inputTemplate: record(descriptor.input_template ?? descriptor.inputTemplate),
    result: record(descriptor.result),
  };
}

export function buildOwnerActionWorkflow(
  descriptor: WorkflowRequestDescriptor,
  input: Record<string, unknown>,
): OwnerWorkflowRequest {
  return {
    target: descriptor.target,
    payload: {
      operation: descriptor.operation,
      definition_id: descriptor.definitionId,
      include_steps: descriptor.includeSteps,
      include_output: descriptor.includeOutput,
      input: {
        ...descriptor.inputTemplate,
        ...input,
      },
    },
  };
}
