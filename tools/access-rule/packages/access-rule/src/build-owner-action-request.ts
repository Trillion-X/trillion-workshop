import type { AccessDecision, JsonRecord, OpaqueRef, RevisionVector } from './records';
import { revisionsMatch } from './process-method';
import { isObject, validateAccessDecision } from './validate-records';

const ACTOR_ALIAS = /^(actor_ref|actorRef|created_by|createdBy|active_actor_ref|activeActorRef)$/;

function hasCallerActor(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCallerActor);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) => ACTOR_ALIAS.test(key) || hasCallerActor(item));
}

export type AdmittedOwnerActionRequest = {
  action_ref: OpaqueRef;
  ambient_actor: { actor_ref: OpaqueRef; session_ref: OpaqueRef; session_revision: string };
  decision_proof: OpaqueRef;
  payload: JsonRecord;
  revisions: RevisionVector;
  subject_ref: OpaqueRef;
};

export function buildOwnerActionRequest(input: {
  decision: AccessDecision;
  expected_revisions: RevisionVector;
  payload: JsonRecord;
}): AdmittedOwnerActionRequest {
  const checked = validateAccessDecision(input.decision);
  if (!checked.ok) throw new Error(checked.reason);
  const decision = checked.value;
  if (decision.decision !== 'allow') throw new Error(decision.deny_reason ?? 'access-denied');
  if (!revisionsMatch(decision.revisions, input.expected_revisions)) throw new Error('stale-revision');
  if (!isObject(input.payload) || hasCallerActor(input.payload)) throw new Error('caller-actor-alias');
  return {
    action_ref: decision.action_ref,
    subject_ref: decision.subject_ref,
    ambient_actor: {
      actor_ref: decision.actor_ref,
      session_ref: decision.session_ref,
      session_revision: decision.revisions.session_revision,
    },
    decision_proof: decision.decision_proof,
    revisions: decision.revisions,
    payload: input.payload,
  };
}
