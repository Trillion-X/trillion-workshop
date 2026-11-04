// packages/guided-overlay/do-work/dispatch-step-perform.ts
//
// The I/O boundary for a walkthrough step's EFFECT. A non-internal nav button
// carries opaque `perform` DATA `{ target, operation, params }`; running it is ONE
// blind Envelope dispatch through `sendRequestToBitfieldTarget`, the same generic
// transport chat's `dispatch-addressed-message` uses. This is the ONLY guided-overlay
// show-path file that touches the transport (mirrors `commit-progress.ts`).
//
// BLIND (L090): this never names a role, a concrete target, an operation, or a
// param key. The DATA fully describes the request; the surface never branches on
// what the effect is. One grammar, zero enumerated roles, zero host role-to-effect map.

import { sendRequestToBitfieldTarget } from '#workspace-records';

/**
 * A walkthrough step effect as authored DATA on a nav button. `target` is the
 * Envelope destination (e.g. a slot/owner address), `operation` is the owner op,
 * and `params` are the op's opaque fields, all supplied by the tour DATA and never
 * enumerated here.
 */
export interface StepPerform {
  readonly target: string;
  readonly operation: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The generic Envelope request this module sends (shape only; contents are DATA). */
export interface StepPerformRequest {
  readonly target: string;
  readonly payload: Record<string, unknown>;
}

type RequestSender = (request: StepPerformRequest) => Promise<unknown>;

/**
 * Dispatch one step's `perform` DATA to its declared target. The payload is the
 * inverse of `{ operation, params }`: a flat `{ operation, ...params }` envelope,
 * matching every owner op in the codebase. Missing `target`/`operation` fails
 * closed (nothing dispatched, resolves to null) so malformed DATA never throws
 * into the surface. `send` is injectable for tests; it defaults to the live
 * transport.
 */
export async function dispatchStepPerform(
  perform: StepPerform | null | undefined,
  send: RequestSender = sendRequestToBitfieldTarget as RequestSender,
): Promise<unknown> {
  if (!perform || typeof perform.target !== 'string' || typeof perform.operation !== 'string') {
    return null;
  }
  return send({
    target: perform.target,
    payload: { operation: perform.operation, ...(perform.params ?? {}) },
  });
}
