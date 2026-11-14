import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

/** The browser submits intent only; hosted admission supplies actor, policy, and time. */
export function joinGroup(input: { idempotencyRef: string; groupRef: string; expectedRevision?: number }) {
  return sendRequestToBitfieldTarget({
    target: 'subject-participant.join-subject',
    payload: {
      subject_ref: input.groupRef,
      expected_revision: input.expectedRevision ?? 0,
      idempotency_ref: input.idempotencyRef,
    },
  });
}
