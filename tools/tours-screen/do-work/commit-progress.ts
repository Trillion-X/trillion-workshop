// packages/guided-overlay/do-work/commit-progress.ts
//
// The host-side I/O boundary for durable cursor transitions. It sends only the
// package-owned operation request and decodes the owner's signed receipt.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  type ProgressTransitionReceipt,
  type ProgressTransitionRequest,
} from './progress-transition-owner.ts';
import { buildProgressTransitionTargetRequest } from './walkthrough-progress-writes.ts';

/**
 * Commit one compare-and-set cursor transition through the guided-overlay owner.
 */
export async function commitWalkthroughProgress(
  request: Omit<ProgressTransitionRequest, 'schema'>,
): Promise<ProgressTransitionReceipt> {
  const reply = await sendRequestToBitfieldTarget(buildProgressTransitionTargetRequest(request));
  return JSON.parse(new TextDecoder().decode(reply.payload)) as ProgressTransitionReceipt;
}
