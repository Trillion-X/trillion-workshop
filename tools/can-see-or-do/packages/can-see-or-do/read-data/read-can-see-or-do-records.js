function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function readText(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function readBoolean(value) { return value === true || value === false ? value : null; }
function readTextArray(value) { return Array.isArray(value) ? value.map(readText).filter(Boolean) : []; }
function rows(value) { if (Array.isArray(value)) return value; if (isRecord(value) && Array.isArray(value.items)) return value.items; return []; }
function payloadOf(value) { if (!isRecord(value)) return null; const payload = value.payload ?? value; if (typeof payload !== 'string') return isRecord(payload) ? payload : null; try { const parsed = JSON.parse(payload); return isRecord(parsed) ? parsed : null; } catch { return null; } }

/** Scope is written by hosted admission, never composed from browser props. */
export function isAdmittedAnswerScope(value) {
  if (!isRecord(value) || !readText(value.actor_ref) || !readText(value.session_ref) || !readText(value.subject_ref) || !readText(value.action_ref) || !readText(value.decision_proof) || !isRecord(value.revisions)) return false;
  return ['membership_revision', 'policy_revision', 'resource_revision', 'session_revision'].every((key) => readText(value.revisions[key]));
}

export function buildScopedCanSeeOrDoQuery(scope) {
  if (!isAdmittedAnswerScope(scope)) throw new Error('missing-admitted-scope');
  return {
    kind: 'scoped-projection-query/v1',
    record_kind: 'can-see-or-do-answer',
    where: { actor_ref: scope.actor_ref, subject_ref: scope.subject_ref, capability_ref: scope.action_ref },
    admission: scope,
  };
}

/** Never returns an answer feed without an injected actor/subject/action scope. */
export function readCanSeeOrDoAnswers(records, scope) {
  if (!isAdmittedAnswerScope(scope)) return [];
  return rows(records)
    .map(payloadOf)
    .filter((payload) => isRecord(payload) && payload.kind === 'can-see-or-do-answer')
    .map((payload) => ({
      actorRef: readText(payload.actor_ref),
      subjectRef: readText(payload.subject_ref),
      capabilityRef: readText(payload.capability_ref),
      answerRef: readText(payload.answer_ref),
      evidenceRefs: readTextArray(payload.evidence_refs),
      visible: readBoolean(payload.visible), enabled: readBoolean(payload.enabled),
      blockedReasonRef: readText(payload.blocked_reason_ref),
      nextSurfaceRef: readText(payload.next_surface_ref),
      nextSubjectRef: readText(payload.next_subject_ref),
      resultEventRef: readText(payload.result_event_ref),
      copy: isRecord(payload.copy) ? payload.copy : {},
    }))
    .filter((answer) => answer.actorRef === scope.actor_ref && answer.subjectRef === scope.subject_ref && answer.capabilityRef === scope.action_ref);
}

export function findCanSeeOrDoAnswer(records, scope) {
  return readCanSeeOrDoAnswers(records, scope)[0] ?? null;
}
