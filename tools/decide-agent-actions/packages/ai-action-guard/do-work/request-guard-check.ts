import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type GuardCheckInput = {
  action_ref?: string;
  subject_ref?: string;
  target: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInput(value: unknown): GuardCheckInput {
  if (!isRecord(value)) throw new Error('guard check input must be an object');
  if (typeof value.target !== 'string' || !value.target.trim()) throw new Error('target is required');
  return {
    action_ref: typeof value.action_ref === 'string' ? value.action_ref : undefined,
    subject_ref: typeof value.subject_ref === 'string' ? value.subject_ref : undefined,
    target: value.target,
  };
}

export function requestGuardCheck(input: unknown) {
  const request = readInput(input);
  return sendRequestToBitfieldTarget({
    target: request.target,
    payload: {
      action_ref: request.action_ref,
      kind: 'guard-check-request',
      subject_ref: request.subject_ref,
    },
  });
}
