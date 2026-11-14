export type MailActionDescriptor = {
  id: string;
  target: string;
  definitionId?: string;
  definition_id?: string;
  operation: string;
  label: string;
  role?: string;
  disabledReason?: string;
  undoActionId?: string;
  values?: Record<string, unknown>;
};

export type MailActionInput = {
  action: MailActionDescriptor;
  workItemAddress: string;
  accountAddress?: string;
  threadAddress?: string;
  correlationId: string;
  values?: Record<string, unknown>;
};

export type MailTargetRequest = {
  target: string;
  payload: MailOwnerOperationPayload | MailWorkflowDefinitionPayload;
};

export type MailOwnerOperationPayload = {
  operation: string;
  action_id: string;
  work_item_address: string;
  account_address?: string;
  thread_address?: string;
  correlation_id: string;
  values: Record<string, unknown>;
  undo_action_id?: string;
};

export type MailWorkflowDefinitionPayload = {
  operation: 'execute_definition';
  definition_id: string;
  include_steps: false;
  include_output: false;
  input: MailOwnerOperationPayload;
};

export function buildMailActionRequest(input: MailActionInput): MailTargetRequest | { disabledReason: string } {
  if (input.action.disabledReason) {
    return { disabledReason: input.action.disabledReason };
  }

  const definitionId = input.action.definitionId ?? input.action.definition_id;
  if (definitionId) {
    return {
      target: input.action.target,
      payload: {
        operation: 'execute_definition',
        definition_id: definitionId,
        include_steps: false,
        include_output: false,
        input: {
          operation: input.action.operation,
          action_id: input.action.id,
          work_item_address: input.workItemAddress,
          account_address: input.accountAddress,
          thread_address: input.threadAddress,
          correlation_id: input.correlationId,
          values: input.values ?? input.action.values ?? {},
          undo_action_id: input.action.undoActionId,
        },
      },
    };
  }

  return {
    target: input.action.target,
    payload: {
      operation: input.action.operation,
      action_id: input.action.id,
      work_item_address: input.workItemAddress,
      account_address: input.accountAddress,
      thread_address: input.threadAddress,
      correlation_id: input.correlationId,
      values: input.values ?? input.action.values ?? {},
      undo_action_id: input.action.undoActionId,
    },
  };
}

export async function requestMailAction(
  input: MailActionInput,
  send: (request: MailTargetRequest) => Promise<unknown>,
): Promise<unknown> {
  const request = buildMailActionRequest(input);
  if ('disabledReason' in request) return request;
  return send(request);
}
