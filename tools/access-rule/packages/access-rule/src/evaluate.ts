import type {
  AccessDecision,
  AccessDecisionRequest,
  EnvelopeDispatcher,
  FormulaEnvelopeRequest,
  RevisionVector,
} from './records';
import { isObject, validateAccessDecisionRequest } from './validate-records';

let decisionProofCounter = 0;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function accessDecisionKey(input: Pick<AccessDecisionRequest, 'ambient_actor' | 'action_ref' | 'authorized_action_refs' | 'constraints' | 'subject_ref' | 'revisions'>): string {
  return canonical({
    actor_ref: input.ambient_actor.actor_ref,
    subject_ref: input.subject_ref,
    action_ref: input.action_ref,
    authorized_action_refs: [...input.authorized_action_refs].sort(),
    constraints: input.constraints,
    ...input.revisions,
  });
}

/** Seeded from the instant the runtime received this request, never from a clock this module
 *  read for itself, so the same log re-derives the same proof. Deciding allow or deny is this
 *  module's job; measuring time is not, which is why the fact arrives as an argument. */
function nextDecisionProof(nowMs: number): string {
  decisionProofCounter += 1;
  return `access-decision:${Math.trunc(nowMs).toString(36)}:${decisionProofCounter.toString(36).padStart(8, '0')}`;
}

function denied(
  request: AccessDecisionRequest,
  reason: string,
  nowMs: number,
  revisions: RevisionVector = request.revisions,
): AccessDecision {
  const result: AccessDecision = {
    kind: 'access-decision/v1',
    actor_ref: request.ambient_actor.actor_ref,
    subject_ref: request.subject_ref,
    action_ref: request.action_ref,
    authorized_action_refs: request.authorized_action_refs,
    constraints: request.constraints,
    predicate_ref: request.predicate_ref,
    session_ref: request.ambient_actor.session_ref,
    revisions,
    decision: 'deny',
    confidence: 1,
    decision_key: accessDecisionKey(request),
    decision_proof: nextDecisionProof(nowMs),
    deny_reason: reason,
    provenance: { correlation_id: request.correlation_id, evaluator_slot: 'slot::formula-engine' },
  };
  console.info(`[access-rule] correlation=${request.correlation_id} actor=${request.ambient_actor.actor_ref} subject=${request.subject_ref} action=${request.action_ref} revisions=${accessDecisionKey(request)} result=deny reason=${reason}`);
  return result;
}

export function formulaEnvelopeRequest(request: AccessDecisionRequest): FormulaEnvelopeRequest {
  return {
    to_slot: 'slot::formula-engine',
    correlation_id: request.correlation_id,
    payload: { binding: request.predicate_binding, context: request.context },
  };
}

/**
 * The Formula owner decides the expression.  This module only maps a strict
 * boolean reply into a revision-bound decision; every other reply is denial.
 */
export async function evaluateAccessDecision(
  requestInput: unknown,
  dispatcher: EnvelopeDispatcher,
  nowMs: number,
): Promise<AccessDecision> {
  const checked = validateAccessDecisionRequest(requestInput);
  if (!checked.ok) {
    const unknown: AccessDecisionRequest = {
      kind: 'access-decision-request',
      correlation_id: 'invalid', subject_ref: 'invalid', action_ref: 'invalid', predicate_ref: 'invalid',
      authorized_action_refs: ['invalid'],
      constraints: {},
      predicate_binding: null, context: {},
      ambient_actor: { actor_ref: 'invalid', session_ref: 'invalid', session_revision: 'invalid' },
      revisions: { session_revision: 'invalid', policy_revision: 'invalid', membership_revision: 'invalid', resource_revision: 'invalid' },
    };
    return denied(unknown, checked.reason, nowMs);
  }
  const request = checked.value;
  let reply: unknown;
  try {
    reply = await dispatcher.dispatch(formulaEnvelopeRequest(request));
  } catch {
    return denied(request, 'formula-unavailable', nowMs);
  }
  const result = isObject(reply) ? reply.result : undefined;
  const reason = result === true ? undefined : result === false ? 'predicate-false' : 'formula-invalid';
  console.info(`[access-rule.formula] correlation=${request.correlation_id} predicate=${request.predicate_ref} result=${result === true || result === false ? String(result) : 'invalid'}`);
  if (reason) return denied(request, reason, nowMs);
  const decision: AccessDecision = {
    kind: 'access-decision/v1',
    actor_ref: request.ambient_actor.actor_ref,
    subject_ref: request.subject_ref,
    action_ref: request.action_ref,
    authorized_action_refs: request.authorized_action_refs,
    constraints: request.constraints,
    predicate_ref: request.predicate_ref,
    session_ref: request.ambient_actor.session_ref,
    revisions: request.revisions,
    decision: 'allow',
    confidence: 1,
    decision_key: accessDecisionKey(request),
    decision_proof: nextDecisionProof(nowMs),
    provenance: { correlation_id: request.correlation_id, evaluator_slot: 'slot::formula-engine' },
  };
  console.info(`[access-rule] correlation=${request.correlation_id} actor=${request.ambient_actor.actor_ref} subject=${request.subject_ref} action=${request.action_ref} revisions=${decision.decision_key} result=allow reason=allowed`);
  return decision;
}
