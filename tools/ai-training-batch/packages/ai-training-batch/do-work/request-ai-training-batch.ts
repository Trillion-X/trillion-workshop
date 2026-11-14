import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type TrainingBatchInput = {
  request?: unknown;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): TrainingBatchInput {
  if (!isRecord(value)) throw new Error('training batch input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  return { request: value.request, target: value.target };
}

export function requestTrainingBatch(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      kind: 'ai-training-batch-request',
      request: request.request,
    },
  });
}
