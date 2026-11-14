import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type MemoryWriteInput = {
  body: string;
  subject_ref?: string;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): MemoryWriteInput {
  if (!isRecord(value)) throw new Error('memory write input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  if (typeof value.body !== 'string' || !value.body.trim()) throw new Error('body is required');
  return { body: value.body, subject_ref: typeof value.subject_ref === 'string' ? value.subject_ref : undefined, target: value.target };
}

export function requestMemoryWrite(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      body: request.body,
      kind: 'memory-write-request',
      subject_ref: request.subject_ref,
    },
  });
}
