import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type AiResponseInput = {
  context_refs?: string[];
  request?: unknown;
  target: string;
  thread_ref?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): AiResponseInput {
  if (!isRecord(value)) throw new Error('AI response input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  return {
    context_refs: Array.isArray(value.context_refs) ? value.context_refs.filter((item): item is string => typeof item === 'string') : undefined,
    request: value.request,
    target: value.target,
    thread_ref: typeof value.thread_ref === 'string' ? value.thread_ref : undefined,
  };
}

export function requestAiResponse(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      context_refs: request.context_refs,
      kind: 'ai-response-request',
      request: request.request,
      thread_ref: request.thread_ref,
    },
  });
}
