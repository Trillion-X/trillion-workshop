export type CanSeeOrDoAnswer = { actorRef: string; subjectRef: string; capabilityRef: string; answerRef: string | null; evidenceRefs: string[]; visible: boolean | null; enabled: boolean | null; blockedReasonRef: string | null; nextSurfaceRef: string | null; nextSubjectRef: string | null; resultEventRef: string | null; copy: Record<string, unknown> };
export type AdmittedAnswerScope = { actor_ref: string; session_ref: string; subject_ref: string; action_ref: string; decision_proof: string; revisions: { membership_revision: string; policy_revision: string; resource_revision: string; session_revision: string } };
export function isAdmittedAnswerScope(value: unknown): value is AdmittedAnswerScope;
export function buildScopedCanSeeOrDoQuery(scope: AdmittedAnswerScope): unknown;
export function readCanSeeOrDoAnswers(records: unknown, scope: AdmittedAnswerScope): CanSeeOrDoAnswer[];
export function findCanSeeOrDoAnswer(records: unknown, scope: AdmittedAnswerScope): CanSeeOrDoAnswer | null;
