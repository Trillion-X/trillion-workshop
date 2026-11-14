import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type InstructionUpdateInput = {
  instruction_ref: string;
  patch?: unknown;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): InstructionUpdateInput {
  if (!isRecord(value)) throw new Error('instruction update input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  if (typeof value.instruction_ref !== 'string' || !value.instruction_ref.trim()) throw new Error('instruction_ref is required');
  return { instruction_ref: value.instruction_ref, patch: value.patch, target: value.target };
}

export function requestInstructionUpdate(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      instruction_ref: request.instruction_ref,
      kind: 'instruction-update-request',
      patch: request.patch,
    },
  });
}
