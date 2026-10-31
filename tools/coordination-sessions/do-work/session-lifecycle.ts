// tools/coordination-sessions/do-work/session-lifecycle.ts
//
// A coordination session is one gathering a person organizes: its purpose, the times, places and modes it could
// happen in, how many places it has (a reference to a capacity ledger, see tools/reservations), who may see and
// join it, and the lifecycle state it is in. Every function takes sessions and returns the next ones. Nothing is
// stored, authorized or sent here. Purpose, mode, lifecycle state and the policies are open descriptors: data the
// person names, never a list kept in code. Lineage (which sessions a session came from) and the provenance of who
// took part and what they preferred travel through reschedule, fork, merge and supersede.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface OpenDescriptor {
  key: string;
  descriptor_ref: string;
  data?: Record<string, JsonValue>;
}

export interface CandidateOccurrence {
  occurrence_id: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  calendar_system: string;
  availability_owner_ref?: string;
}

export interface CandidatePlace {
  place_ref?: string;
  choice_descriptor?: OpenDescriptor;
}

export interface CapacityPlan {
  capacity_policy_ref: string;
  seat_ledger_ref: string;
}

export interface ParticipationPolicy {
  visibility_predicate_ref: string;
  eligibility_predicate_ref: string;
  guest_policy_ref?: string;
  host_policy_ref?: string;
  cancellation_policy_ref?: string;
}

export interface ParticipantProvenance {
  provenance_id: string;
  subject_ref: string;
  source_session_id: string;
  participant_relation_ref: string;
}

export interface PreferenceProvenance {
  provenance_id: string;
  subject_ref: string;
  source_session_id: string;
  preference_fact_ref: string;
}

export type SessionLineageOperation = 'create' | 'update' | 'reschedule' | 'fork' | 'merge' | 'cancel' | 'supersede' | 'confirm' | 'record_no_show' | 'close' | 'request_feedback';

export interface ForkMergeProvenance {
  operation: SessionLineageOperation;
  source_session_ids: string[];
  lineage_session_ids: string[];
  inheritance_policy_ref: string;
  conflict_policy_ref: string;
}

export interface CoordinationSession {
  session_id: string;
  purpose_contract: OpenDescriptor;
  candidate_occurrences: CandidateOccurrence[];
  candidate_places: CandidatePlace[];
  candidate_modes: OpenDescriptor[];
  capacity_plan: CapacityPlan;
  participation_policy: ParticipationPolicy;
  lifecycle_state: OpenDescriptor;
  workflow_definition_ref: string;
  supersedes_ref?: string;
  fork_merge_provenance: ForkMergeProvenance;
  participant_provenance: ParticipantProvenance[];
  preference_provenance: PreferenceProvenance[];
  feedback_request_ref?: string;
}

export type CreateCoordinationSessionInput = Omit<CoordinationSession, 'fork_merge_provenance'> & {
  fork_merge_provenance?: Partial<ForkMergeProvenance>;
};

type SessionUpdatePatch = Partial<Omit<CoordinationSession, 'session_id' | 'fork_merge_provenance'>> & {
  participant_provenance?: ParticipantProvenance[];
  preference_provenance?: PreferenceProvenance[];
};

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
}

function validateDescriptor(value: OpenDescriptor, field: string): void {
  if (!value || typeof value !== 'object') throw new Error(`${field} must be descriptor data`);
  requireText(value.key, `${field}.key`);
  requireText(value.descriptor_ref, `${field}.descriptor_ref`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeByProvenanceId<T extends { provenance_id: string }>(...groups: T[][]): T[] {
  const records = new Map<string, T>();
  for (const record of groups.flat()) records.set(record.provenance_id, record);
  return [...records.values()];
}

function lineageFor(operation: SessionLineageOperation, sessions: CoordinationSession[], resultSessionId: string, inheritancePolicyRef?: string, conflictPolicyRef?: string): ForkMergeProvenance {
  return {
    operation,
    source_session_ids: unique(sessions.map((session) => session.session_id)),
    lineage_session_ids: unique(sessions.flatMap((session) => session.fork_merge_provenance.lineage_session_ids).concat(resultSessionId)),
    inheritance_policy_ref: inheritancePolicyRef ?? sessions[0]?.fork_merge_provenance.inheritance_policy_ref ?? 'inherit-all-provenance',
    conflict_policy_ref: conflictPolicyRef ?? sessions[0]?.fork_merge_provenance.conflict_policy_ref ?? 'preserve-conflicts-as-data',
  };
}

export function validateCoordinationSession(session: CoordinationSession): CoordinationSession {
  requireText(session.session_id, 'session_id');
  validateDescriptor(session.purpose_contract, 'purpose_contract');
  validateDescriptor(session.lifecycle_state, 'lifecycle_state');
  session.candidate_modes.forEach((mode, index) => validateDescriptor(mode, `candidate_modes[${index}]`));
  session.candidate_occurrences.forEach((occurrence, index) => {
    requireText(occurrence.occurrence_id, `candidate_occurrences[${index}].occurrence_id`);
    requireText(occurrence.starts_at, `candidate_occurrences[${index}].starts_at`);
    requireText(occurrence.ends_at, `candidate_occurrences[${index}].ends_at`);
    requireText(occurrence.time_zone, `candidate_occurrences[${index}].time_zone`);
    requireText(occurrence.calendar_system, `candidate_occurrences[${index}].calendar_system`);
  });
  requireText(session.capacity_plan.capacity_policy_ref, 'capacity_plan.capacity_policy_ref');
  requireText(session.capacity_plan.seat_ledger_ref, 'capacity_plan.seat_ledger_ref');
  requireText(session.workflow_definition_ref, 'workflow_definition_ref');
  requireText(session.fork_merge_provenance.inheritance_policy_ref, 'fork_merge_provenance.inheritance_policy_ref');
  requireText(session.fork_merge_provenance.conflict_policy_ref, 'fork_merge_provenance.conflict_policy_ref');
  return session;
}

export function createCoordinationSession(input: CreateCoordinationSessionInput): CoordinationSession {
  const session: CoordinationSession = {
    ...input,
    candidate_occurrences: [...input.candidate_occurrences],
    candidate_places: [...input.candidate_places],
    candidate_modes: [...input.candidate_modes],
    participant_provenance: [...input.participant_provenance],
    preference_provenance: [...input.preference_provenance],
    fork_merge_provenance: {
      operation: 'create',
      source_session_ids: input.fork_merge_provenance?.source_session_ids ?? [],
      lineage_session_ids: unique([...(input.fork_merge_provenance?.lineage_session_ids ?? []), input.session_id]),
      inheritance_policy_ref: input.fork_merge_provenance?.inheritance_policy_ref ?? 'inherit-all-provenance',
      conflict_policy_ref: input.fork_merge_provenance?.conflict_policy_ref ?? 'preserve-conflicts-as-data',
    },
  };
  return validateCoordinationSession(session);
}

export function readCoordinationSession(sessions: readonly CoordinationSession[], sessionId: string): CoordinationSession | undefined {
  return sessions.find((session) => session.session_id === sessionId);
}

export function updateCoordinationSession(session: CoordinationSession, patch: SessionUpdatePatch): CoordinationSession {
  const updated: CoordinationSession = {
    ...session,
    ...patch,
    session_id: session.session_id,
    participant_provenance: mergeByProvenanceId(session.participant_provenance, patch.participant_provenance ?? []),
    preference_provenance: mergeByProvenanceId(session.preference_provenance, patch.preference_provenance ?? []),
    fork_merge_provenance: lineageFor('update', [session], session.session_id),
  };
  return validateCoordinationSession(updated);
}

export interface RescheduleInput {
  candidate_occurrences: CandidateOccurrence[];
  lifecycle_state: OpenDescriptor;
  candidate_places?: CandidatePlace[];
  candidate_modes?: OpenDescriptor[];
}

export function rescheduleCoordinationSession(session: CoordinationSession, input: RescheduleInput): CoordinationSession {
  return validateCoordinationSession({
    ...session,
    candidate_occurrences: [...input.candidate_occurrences],
    candidate_places: input.candidate_places ? [...input.candidate_places] : session.candidate_places,
    candidate_modes: input.candidate_modes ? [...input.candidate_modes] : session.candidate_modes,
    lifecycle_state: input.lifecycle_state,
    fork_merge_provenance: lineageFor('reschedule', [session], session.session_id),
  });
}

export interface ForkSessionInput {
  session_id: string;
  lifecycle_state: OpenDescriptor;
  overrides?: SessionUpdatePatch;
  inheritance_policy_ref?: string;
  conflict_policy_ref?: string;
}

export function forkCoordinationSession(session: CoordinationSession, input: ForkSessionInput): CoordinationSession {
  return validateCoordinationSession({
    ...session,
    ...input.overrides,
    session_id: input.session_id,
    lifecycle_state: input.lifecycle_state,
    participant_provenance: mergeByProvenanceId(session.participant_provenance, input.overrides?.participant_provenance ?? []),
    preference_provenance: mergeByProvenanceId(session.preference_provenance, input.overrides?.preference_provenance ?? []),
    fork_merge_provenance: lineageFor('fork', [session], input.session_id, input.inheritance_policy_ref, input.conflict_policy_ref),
  });
}

export interface MergeSessionInput {
  session_id: string;
  lifecycle_state: OpenDescriptor;
  overrides?: SessionUpdatePatch;
  inheritance_policy_ref?: string;
  conflict_policy_ref?: string;
}

export function mergeCoordinationSessions(sessions: CoordinationSession[], input: MergeSessionInput): CoordinationSession {
  if (sessions.length < 2) throw new Error('merge requires at least two source sessions');
  const [base] = sessions;
  const merged: CoordinationSession = {
    ...base,
    ...input.overrides,
    session_id: input.session_id,
    lifecycle_state: input.lifecycle_state,
    participant_provenance: mergeByProvenanceId(...sessions.map((session) => session.participant_provenance), input.overrides?.participant_provenance ?? []),
    preference_provenance: mergeByProvenanceId(...sessions.map((session) => session.preference_provenance), input.overrides?.preference_provenance ?? []),
    fork_merge_provenance: lineageFor('merge', sessions, input.session_id, input.inheritance_policy_ref, input.conflict_policy_ref),
  };
  return validateCoordinationSession(merged);
}

function transitionSession(session: CoordinationSession, operation: SessionLineageOperation, lifecycleState: OpenDescriptor, extra: Partial<CoordinationSession> = {}): CoordinationSession {
  return validateCoordinationSession({
    ...session,
    ...extra,
    session_id: session.session_id,
    lifecycle_state: lifecycleState,
    participant_provenance: session.participant_provenance,
    preference_provenance: session.preference_provenance,
    fork_merge_provenance: lineageFor(operation, [session], session.session_id),
  });
}

export function cancelCoordinationSession(session: CoordinationSession, lifecycleState: OpenDescriptor): CoordinationSession {
  return transitionSession(session, 'cancel', lifecycleState);
}

export function confirmCoordinationSession(session: CoordinationSession, lifecycleState: OpenDescriptor): CoordinationSession {
  return transitionSession(session, 'confirm', lifecycleState);
}

export function recordCoordinationSessionNoShow(session: CoordinationSession, lifecycleState: OpenDescriptor): CoordinationSession {
  return transitionSession(session, 'record_no_show', lifecycleState);
}

export function closeCoordinationSession(session: CoordinationSession, lifecycleState: OpenDescriptor): CoordinationSession {
  return transitionSession(session, 'close', lifecycleState);
}

export function requestCoordinationSessionFeedback(session: CoordinationSession, lifecycleState: OpenDescriptor, feedbackRequestRef: string): CoordinationSession {
  requireText(feedbackRequestRef, 'feedback_request_ref');
  return transitionSession(session, 'request_feedback', lifecycleState, { feedback_request_ref: feedbackRequestRef });
}

export interface SupersedeSessionInput extends ForkSessionInput {
  predecessor_lifecycle_state: OpenDescriptor;
}

export function supersedeCoordinationSession(session: CoordinationSession, input: SupersedeSessionInput): { predecessor: CoordinationSession; successor: CoordinationSession } {
  const predecessor = transitionSession(session, 'supersede', input.predecessor_lifecycle_state);
  const successor = validateCoordinationSession({
    ...forkCoordinationSession(session, input),
    supersedes_ref: session.session_id,
    fork_merge_provenance: lineageFor('supersede', [session], input.session_id, input.inheritance_policy_ref, input.conflict_policy_ref),
  });
  return { predecessor, successor };
}

type UnknownRecord = Record<string, unknown>;

function recordInput(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as UnknownRecord;
}

function sessionInput(value: unknown, field: string): CoordinationSession {
  return recordInput(value, field) as CoordinationSession;
}

/**
 * The lifecycle operation family, one request.
 *
 * Every request is explicit about its operation and operands. This prevents a
 * workflow from claiming a lifecycle verb while silently routing every input
 * through creation semantics.
 */
export function runASessionOperation(input: unknown = {}): CoordinationSession | { predecessor: CoordinationSession; successor: CoordinationSession } {
  const request = recordInput(input, 'session lifecycle request');
  const operation = request.operation;
  if (typeof operation !== 'string' || !operation.trim()) {
    throw new Error('session lifecycle request.operation must be a non-empty string');
  }

  switch (operation) {
    case 'create':
      return createCoordinationSession(sessionInput(request.session, 'session lifecycle request.session'));
    case 'update':
      return updateCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.patch, 'session lifecycle request.patch') as SessionUpdatePatch,
      );
    case 'reschedule':
      return rescheduleCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.reschedule, 'session lifecycle request.reschedule') as RescheduleInput,
      );
    case 'fork':
      return forkCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.fork, 'session lifecycle request.fork') as ForkSessionInput,
      );
    case 'merge': {
      if (!Array.isArray(request.sessions) || request.sessions.length < 2) {
        throw new Error('session lifecycle request.sessions must contain at least two sessions for merge');
      }
      return mergeCoordinationSessions(
        request.sessions.map((session, index) => sessionInput(session, `session lifecycle request.sessions[${index}]`)),
        recordInput(request.merge, 'session lifecycle request.merge') as MergeSessionInput,
      );
    }
    case 'cancel':
      return cancelCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.lifecycle_state, 'session lifecycle request.lifecycle_state') as OpenDescriptor,
      );
    case 'supersede':
      return supersedeCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.supersede, 'session lifecycle request.supersede') as SupersedeSessionInput,
      );
    case 'confirm':
      return confirmCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.lifecycle_state, 'session lifecycle request.lifecycle_state') as OpenDescriptor,
      );
    case 'record_no_show':
      return recordCoordinationSessionNoShow(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.lifecycle_state, 'session lifecycle request.lifecycle_state') as OpenDescriptor,
      );
    case 'close':
      return closeCoordinationSession(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.lifecycle_state, 'session lifecycle request.lifecycle_state') as OpenDescriptor,
      );
    case 'request_feedback': {
      if (typeof request.feedback_request_ref !== 'string') {
        throw new Error('session lifecycle request.feedback_request_ref must be a string');
      }
      return requestCoordinationSessionFeedback(
        sessionInput(request.session, 'session lifecycle request.session'),
        recordInput(request.lifecycle_state, 'session lifecycle request.lifecycle_state') as OpenDescriptor,
        request.feedback_request_ref,
      );
    }
    default:
      throw new Error(`unsupported coordination-session lifecycle operation: ${operation}`);
  }
}

