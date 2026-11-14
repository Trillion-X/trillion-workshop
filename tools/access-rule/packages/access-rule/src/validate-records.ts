import type {
  AccessDecision,
  AccessDecisionRequest,
  AmbientActor,
  JsonRecord,
  RevisionVector,
} from './records';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export function isObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function opaque(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function opaqueRefs(value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, reason: 'invalid-authorized-actions' };
  const refs = value.map(opaque);
  if (refs.some((entry) => !entry) || new Set(refs).size !== refs.length) {
    return { ok: false, reason: 'invalid-authorized-actions' };
  }
  return { ok: true, value: refs as string[] };
}

function revisions(value: unknown): ValidationResult<RevisionVector> {
  if (!isObject(value)) return { ok: false, reason: 'invalid-revisions' };
  const output = {
    session_revision: opaque(value.session_revision),
    policy_revision: opaque(value.policy_revision),
    membership_revision: opaque(value.membership_revision),
    resource_revision: opaque(value.resource_revision),
  };
  if (Object.values(output).some((entry) => !entry)) return { ok: false, reason: 'invalid-revisions' };
  return { ok: true, value: output as RevisionVector };
}

function ambientActor(value: unknown): ValidationResult<AmbientActor> {
  if (!isObject(value)) return { ok: false, reason: 'missing-ambient-actor' };
  const actor_ref = opaque(value.actor_ref);
  const session_ref = opaque(value.session_ref);
  const session_revision = opaque(value.session_revision);
  if (!actor_ref || !session_ref || !session_revision) {
    return { ok: false, reason: 'missing-ambient-actor' };
  }
  return { ok: true, value: { actor_ref, session_ref, session_revision } };
}

function validateAccessDecisionRequestFields(value: JsonRecord): ValidationResult<AccessDecisionRequest> {
  const correlation_id = opaque(value.correlation_id);
  const subject_ref = opaque(value.subject_ref);
  const action_ref = opaque(value.action_ref);
  const authorizedActionRefs = opaqueRefs(value.authorized_action_refs);
  const predicate_ref = opaque(value.predicate_ref);
  const actor = ambientActor(value.ambient_actor);
  const current = revisions(value.revisions);
  if (!correlation_id || !subject_ref || !action_ref || !authorizedActionRefs.ok || !predicate_ref || value.predicate_binding === undefined || !isObject(value.context) || !isObject(value.constraints)) {
    return { ok: false, reason: 'invalid-decision-request' };
  }
  if (!authorizedActionRefs.value.includes(action_ref)) return { ok: false, reason: 'invalid-authorized-actions' };
  if (!actor.ok) return actor;
  if (!current.ok) return current;
  if (actor.value.session_revision !== current.value.session_revision) {
    return { ok: false, reason: 'session-revision-mismatch' };
  }
  return {
    ok: true,
    value: {
      kind: 'access-decision-request',
      correlation_id,
      subject_ref,
      action_ref,
      authorized_action_refs: authorizedActionRefs.value,
      constraints: value.constraints,
      predicate_ref,
      predicate_binding: value.predicate_binding,
      context: value.context,
      ambient_actor: actor.value,
      revisions: current.value,
    },
  };
}

export function validateAccessDecisionRequest(value: unknown): ValidationResult<AccessDecisionRequest> {
  if (isObject(value) && value.kind === 'access-decision-request') {
    return validateAccessDecisionRequestFields(value);
  }
  if (!isObject(value) || value.kind !== 'access-decision-request/v1') {
    return { ok: false, reason: 'invalid-decision-request' };
  }
  return validateAccessDecisionRequestFields(value);
}

export function validateAccessDecision(value: unknown): ValidationResult<AccessDecision> {
  if (!isObject(value) || value.kind !== 'access-decision/v1') return { ok: false, reason: 'invalid-decision' };
  const actor_ref = opaque(value.actor_ref);
  const session_ref = opaque(value.session_ref);
  const subject_ref = opaque(value.subject_ref);
  const action_ref = opaque(value.action_ref);
  const authorizedActionRefs = opaqueRefs(value.authorized_action_refs);
  const predicate_ref = opaque(value.predicate_ref);
  const decision_key = opaque(value.decision_key);
  const decision_proof = opaque(value.decision_proof);
  const current = revisions(value.revisions);
  const provenance = value.provenance;
  if (!actor_ref || !session_ref || !subject_ref || !action_ref || !authorizedActionRefs.ok || !authorizedActionRefs.value.includes(action_ref) || !isObject(value.constraints) || !predicate_ref || !decision_key || !decision_proof
    || !current.ok || !isObject(provenance) || provenance.evaluator_slot !== 'slot::formula-engine'
    || !opaque(provenance.correlation_id) || (value.decision !== 'allow' && value.decision !== 'deny')
    || typeof value.confidence !== 'number') return { ok: false, reason: 'invalid-decision' };
  return { ok: true, value: value as AccessDecision };
}
