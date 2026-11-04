export type ExternalEffectState =
  | 'prepared'
  | 'dispatching'
  | 'unknown'
  | 'succeeded'
  | 'rejected'
  | 'cancelled';

export interface ExternalEffectAttempt {
  effect_ref: string;
  action_ref: string;
  authorization_ref: string;
  state: ExternalEffectState;
  attempt_count: number;
  remote_effect_ref?: string;
  execution_ref?: string;
  observation?: { provider?: string; account?: string; connection_id?: string; provider_origin?: string; dispatch_route?: string; response_ref?: string; object_id?: string; route?: string; source_ref?: string; observed_at: string; basis: string; origin: string };
  cancellation_requested?: boolean;
}

export interface ExternalEffectDecision {
  dispatch: boolean;
  reconcile: boolean;
  attempt: ExternalEffectAttempt;
  reason: string;
}

/**
 * Decide whether one authorized external effect may be dispatched.
 *
 * `effect_ref` is the durable logical operation identity. A timeout after the
 * transport begins is deliberately `unknown`, never `rejected`: retrying an
 * unknown call/payment/message can duplicate the real-world effect. Only a
 * definitive pre-dispatch rejection can be attempted again with the same ref.
 */
export function decideExternalEffectAttempt(input: {
  effectRef: string;
  actionRef: string;
  authorizationRef: string;
  prior?: ExternalEffectAttempt | null;
  cancellationRequested?: boolean;
  executionRef?: string;
}): ExternalEffectDecision {
  if (!input.effectRef || !input.actionRef || !input.authorizationRef) {
    throw new Error('effectRef, actionRef, and authorizationRef are required');
  }
  const prior = input.prior ?? null;
  if (prior && (
    prior.effect_ref !== input.effectRef
    || prior.action_ref !== input.actionRef
    || prior.authorization_ref !== input.authorizationRef
  )) {
    throw new Error('prior attempt does not describe the same authorized effect');
  }
  if (input.cancellationRequested) {
    if (!prior || prior.state === 'prepared' || prior.state === 'rejected') {
      return {
        dispatch: false,
        reconcile: false,
        reason: 'cancelled-before-dispatch',
        attempt: {
          effect_ref: input.effectRef,
          action_ref: input.actionRef,
          authorization_ref: input.authorizationRef,
          state: 'cancelled',
          attempt_count: prior?.attempt_count ?? 0,
          cancellation_requested: true,
        },
      };
    }
    return {
      dispatch: false,
      reconcile: prior.state !== 'succeeded' && prior.state !== 'cancelled',
      reason: 'effect-may-already-exist-cancel-through-declared-provider-operation',
      attempt: { ...prior, cancellation_requested: true },
    };
  }
  if (prior && prior.state !== 'rejected') {
    return {
      dispatch: false,
      reconcile: prior.state === 'dispatching' || prior.state === 'unknown',
      reason: prior.state === 'dispatching' || prior.state === 'unknown'
        ? 'prior-dispatch-must-be-reconciled-without-redial'
        : 'logical-effect-already-terminal',
      attempt: prior,
    };
  }
  return {
    dispatch: true,
    reconcile: false,
    reason: prior ? 'definitive-pre-dispatch-rejection-may-retry' : 'first-dispatch',
    attempt: {
      effect_ref: input.effectRef,
      action_ref: input.actionRef,
      authorization_ref: input.authorizationRef,
      state: 'dispatching',
      attempt_count: (prior?.attempt_count ?? 0) + 1,
      ...(prior?.execution_ref || input.executionRef ? { execution_ref: prior?.execution_ref ?? input.executionRef } : {}),
    },
  };
}

export function recordExternalEffectResult(
  attempt: ExternalEffectAttempt,
  result: { outcome: 'succeeded' | 'rejected-before-dispatch' | 'timeout-after-dispatch'; remoteEffectRef?: string; observation?: ExternalEffectAttempt['observation'] },
): ExternalEffectAttempt {
  if (attempt.state !== 'dispatching') throw new Error('only a dispatching attempt accepts a transport result');
  if (result.outcome === 'rejected-before-dispatch') return { ...attempt, state: 'rejected' };
  if (result.outcome === 'timeout-after-dispatch') return { ...attempt, state: 'unknown', remote_effect_ref: result.remoteEffectRef, ...(result.observation ? { observation: result.observation } : {}) };
  return { ...attempt, state: 'succeeded', remote_effect_ref: result.remoteEffectRef, ...(result.observation ? { observation: result.observation } : {}) };
}
