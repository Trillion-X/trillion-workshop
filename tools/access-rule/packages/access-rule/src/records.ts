/**
 * Access-rule records describe an authorization boundary; they never describe
 * a domain role or evaluate a predicate.  References remain opaque strings so
 * this owner cannot learn another owner's storage grammar.
 */
export type JsonRecord = Record<string, unknown>;
export type OpaqueRef = string;

export type RevisionVector = {
  membership_revision: string;
  policy_revision: string;
  resource_revision: string;
  session_revision: string;
};

export type AmbientActor = {
  actor_ref: OpaqueRef;
  session_ref: OpaqueRef;
  session_revision: string;
};

export type AccessDecisionRequest = {
  kind: 'access-decision-request';
  action_ref: OpaqueRef;
  authorized_action_refs: OpaqueRef[];
  ambient_actor: AmbientActor;
  constraints: JsonRecord;
  context: JsonRecord;
  correlation_id: string;
  predicate_binding: unknown;
  predicate_ref: OpaqueRef;
  revisions: RevisionVector;
  subject_ref: OpaqueRef;
};

export type AccessDecision = {
  action_ref: OpaqueRef;
  authorized_action_refs: OpaqueRef[];
  actor_ref: OpaqueRef;
  confidence: number;
  constraints: JsonRecord;
  decision: 'allow' | 'deny';
  decision_key: string;
  decision_proof: OpaqueRef;
  deny_reason?: string;
  kind: 'access-decision/v1';
  predicate_ref: OpaqueRef;
  provenance: {
    correlation_id: string;
    evaluator_slot: 'slot::formula-engine';
  };
  revisions: RevisionVector;
  session_ref: OpaqueRef;
  subject_ref: OpaqueRef;
};

export type FormulaEnvelopeRequest = {
  correlation_id: string;
  payload: {
    binding: unknown;
    context: JsonRecord;
  };
  to_slot: 'slot::formula-engine';
};

export type EnvelopeDispatcher = {
  dispatch(request: FormulaEnvelopeRequest): Promise<unknown>;
};

/** Compatibility name for the maintained projection reader. */
export type EvaluationResult = AccessDecision;
