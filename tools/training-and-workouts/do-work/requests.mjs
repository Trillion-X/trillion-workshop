// tools/training-and-workouts/do-work/requests.mjs
//
// The functions the rows in tool-rows.json run (one per row, through run-request.mjs). Each takes the request a
// person's AI gives and answers with plain JSON; a request that cannot be run throws a sentence saying what to fix.
// Nothing is stored here: the log and the plan come in as the person's records and the next log state goes back out
// for the AI to store through the person's records door.
import { decodeTrainingPlan, sessionsForWeek, trainingPlanSummary } from '../read-data/training-plan.mjs';
import { applyAdjustments, progressionInputs } from '../read-data/progression.mjs';
import {
  appendEvidence, buildCorrectionAtom, buildEvidenceAtom, buildRawArtifact, buildReviewDecisionAtom, decodeConfidence, decodeDimensions, decodeLink, decodeSource, decodeSubject,
  readWorkoutLog, workoutCompletionRate,
} from '../read-data/workout-log.mjs';

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

function need(request, field, test, sentence) {
  if (!test(request[field])) throw new Error(sentence);
  return request[field];
}

export function readTrainingPlan(request) {
  const plan = decodeTrainingPlan(need(request, 'plan', isObject, 'plan must be the training plan record: goals, phases, weeks and sessions.'));
  return {
    plan,
    summary: trainingPlanSummary(plan),
    ...(isText(request.week_id) ? { week_sessions: sessionsForWeek(plan, request.week_id) } : {}),
  };
}

export function readProgressionInputs(request) {
  return progressionInputs(need(request, 'feed', isObject, 'feed must be the training plan record, with its progression rules and the last session\'s result.'));
}

export function adaptNextSession(request) {
  const adjustments = need(request, 'adjustments', Array.isArray, 'adjustments must be the list of adjustments the progress evaluator returned (it may be empty).');
  let from = request.prescription;
  if (from === undefined) {
    const plan = decodeTrainingPlan(need(request, 'plan', isObject, 'give the prescription to adapt, or the plan and the session_id it came from.'));
    from = plan.sessions.find(session => session.id === request.session_id);
    if (!from) throw new Error(`session_id ${JSON.stringify(request.session_id ?? '')} is not a session in the plan (${plan.sessions.length} sessions).`);
  }
  if (!isObject(from) || !isObject(from.dose) || !isObject(from.intensity)) {
    throw new Error('the prescription must be a record with a dose record and an intensity record.');
  }
  return { from, next: applyAdjustments(from, adjustments), applied: adjustments.length };
}

export function readMyWorkoutLog(request) {
  const log = readWorkoutLog(need(request, 'log', isObject, 'log must be the workout log record.'));
  return {
    ...log,
    ...(isText(request.done_status) ? { completion_rate: workoutCompletionRate(log.sessions, request.done_status) } : {}),
  };
}

const OPERATIONS = ['add', 'confirm', 'discard', 'correct', 'split', 'merge'];

function targetsOf(log, ids) {
  const atoms = readWorkoutLog(log).evidenceAtoms;
  return ids.map(id => {
    const atom = atoms.find(candidate => candidate.id === id);
    if (!atom) throw new Error(`target atom ${JSON.stringify(id)} is not in the log.`);
    return atom;
  });
}

// Adds one thing to the log: new evidence, or a decision about an entry already in it. Answers the next log state, the
// atom that was added and the log read afresh, so the caller sees the review queue after the change.
export function addToWorkoutLog(request) {
  const log = need(request, 'log', isObject, 'log must be the workout log record.');
  const operation = need(request, 'operation', value => OPERATIONS.includes(value), `operation must be one of ${OPERATIONS.join(', ')}.`);
  const observedAt = need(request, 'observed_at', value => isText(value) && !Number.isNaN(Date.parse(value)), 'observed_at must be a date and time such as 2026-01-01T09:00:00Z: the tool holds no clock.');
  const rawArtifact = isObject(request.raw_artifact) ? buildRawArtifact({ capturedAt: observedAt, ...request.raw_artifact }) : undefined;
  const source = isObject(request.source) ? decodeSource(request.source, 'manual') : undefined;
  let atom;
  if (operation === 'add') {
    need(request, 'descriptor_id', isText, 'descriptor_id must name the way the evidence was captured (it is part of the atom id).');
    need(request, 'subject', value => isObject(value) && isText(value.kind), 'subject must be a record with a kind.');
    atom = buildEvidenceAtom({
      id: request.id,
      descriptorId: request.descriptor_id,
      observedAt,
      source: source ?? { kind: 'manual' },
      subject: decodeSubject(request.subject, 'observation'),
      dimensions: decodeDimensions(request.dimensions),
      links: (Array.isArray(request.links) ? request.links : []).map(decodeLink).filter(Boolean),
      confidence: request.confidence ? decodeConfidence(request.confidence) : undefined,
      rawArtifactRefs: [...(Array.isArray(request.raw_artifact_refs) ? request.raw_artifact_refs : []), ...(rawArtifact ? [rawArtifact.id] : [])],
      evidenceRefs: Array.isArray(request.evidence_refs) ? request.evidence_refs : undefined,
    });
  } else {
    const [target] = targetsOf(log, [need(request, 'target_atom_id', isText, 'target_atom_id must be the id of the entry this decision is about.')]);
    if (operation === 'confirm' || operation === 'discard') {
      atom = buildReviewDecisionAtom({ id: request.id, operation, targetAtom: target, observedAt, source, note: request.note });
    } else {
      const extras = request.additional_target_atom_ids ?? [];
      if (!Array.isArray(extras)) throw new Error('additional_target_atom_ids must be a list of atom ids.');
      atom = buildCorrectionAtom({
        id: request.id,
        operation,
        descriptorId: request.descriptor_id,
        targetAtom: target,
        additionalTargetAtoms: targetsOf(log, extras),
        observedAt,
        source,
        subject: isObject(request.subject) ? decodeSubject(request.subject, 'observation') : undefined,
        dimensions: decodeDimensions(need(request, 'dimensions', isObject, 'dimensions must hold the corrected values.')),
        rawArtifactRefs: Array.isArray(request.raw_artifact_refs) ? request.raw_artifact_refs : undefined,
        evidenceRefs: Array.isArray(request.evidence_refs) ? request.evidence_refs : undefined,
        note: request.note,
      });
    }
  }
  const next = appendEvidence(log, atom, rawArtifact);
  const read = readWorkoutLog(next);
  return { log: next, atom, review_queue_ids: read.reviewQueue.map(item => item.id), canonical_count: read.canonicalEvidenceAtoms.length };
}
