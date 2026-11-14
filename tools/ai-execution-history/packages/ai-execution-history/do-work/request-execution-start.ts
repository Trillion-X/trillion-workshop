import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type ExecutionStartInput = {
  agent_ref?: string;
  input?: unknown;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): ExecutionStartInput {
  if (!isRecord(value)) throw new Error('execution start input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  return { agent_ref: typeof value.agent_ref === 'string' ? value.agent_ref : undefined, input: value.input, target: value.target };
}

export function requestExecutionStart(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      agent_ref: request.agent_ref,
      input: request.input,
      kind: 'execution-start-request',
    },
  });
}
