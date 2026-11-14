export type MailSourceTaskInput = {
  target: string;
  operation: string;
  selectedWorkItemAddress: string;
  sourceLabel: string;
  title: string;
  body?: string;
  correlationId: string;
};

export type MailSourceTaskRequest = {
  target: string;
  payload: {
    operation: string;
    source: {
      address: string;
      label: string;
    };
    title: string;
    body?: string;
    correlation_id: string;
  };
};

export function buildTaskFromMailRequest(input: MailSourceTaskInput): MailSourceTaskRequest {
  return {
    target: input.target,
    payload: {
      operation: input.operation,
      source: {
        address: input.selectedWorkItemAddress,
        label: input.sourceLabel,
      },
      title: input.title,
      body: input.body,
      correlation_id: input.correlationId,
    },
  };
}

export async function requestTaskFromMail(
  input: MailSourceTaskInput,
  send: (request: MailSourceTaskRequest) => Promise<{ taskRef?: unknown } | unknown>,
): Promise<unknown> {
  return send(buildTaskFromMailRequest(input));
}
