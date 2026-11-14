// packages/guided-overlay/do-work/walkthrough-progress-writes.ts
//
// Pure request builder for the package-owned durable cursor operation. The host
// can ask only the guided-overlay owner door to mutate progress. The owner target
// is the sole module that knows the underlying live-log write shape.

import {
  PROGRESS_TRANSITION_REQUEST_SCHEMA,
  type ProgressTransitionRequest,
} from './progress-transition-owner.ts';

export interface ProgressTransitionTargetRequest {
  readonly target: 'guided-overlay.progress-transition';
  readonly payload: ProgressTransitionRequest;
}

/** Build the sole package-owner door request for a durable cursor transition. */
export function buildProgressTransitionTargetRequest(
  request: Omit<ProgressTransitionRequest, 'schema'>,
): ProgressTransitionTargetRequest {
  return {
    target: 'guided-overlay.progress-transition',
    payload: { schema: PROGRESS_TRANSITION_REQUEST_SCHEMA, ...request },
  };
}
