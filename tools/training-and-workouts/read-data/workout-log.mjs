// tools/training-and-workouts/read-data/workout-log.mjs
//
// A workout log as a ledger of evidence atoms. An atom is one thing observed: when, from what source, about what
// subject, its measured dimensions, links to other atoms and how sure it is. Nothing is edited in place. A person
// confirms, discards, corrects, splits or merges an entry by ADDING another atom that links to the first; the log
// then reads as: canonical atoms (not replaced), the review queue (not confirmed, not yet decided), projection lenses
// (a person's own summary views, run over the atoms), export rows and one numeric progress series.
//
// The words in here are the ledger's own protocol, not a person's: the confidence state `confirmed`, the link roles
// `confirms`, `discards`, `corrects`, `split_from`, `merge_input`, and the dimension roles a chart skips. A person's
// subjects, dimension keys, units and lens definitions are their records; none is built in.
// Pure and total: no clock, no I/O; the input is never changed.

const objectOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const listOf = value => (Array.isArray(value) ? value : []);
const textOf = value => (typeof value === 'string' ? value : '');
const numberOf = value => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const optionalNumber = value => { if (value === undefined || value === null || value === '') return undefined; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; };
const optionalText = value => { const text = textOf(value).trim(); return text || undefined; };
const present = (key, value) => (value === undefined ? {} : { [key]: value });

export const CONFIRMED = 'confirmed';
export const NEEDS_REVIEW = 'needs_review';
export const REVIEW_DECISION_SUBJECT = 'review_decision';
const CONFIRMING_LINK_ROLES = new Set(['confirms']);
const DECIDING_LINK_ROLES = new Set(['confirms', 'discards']);
const REPLACEMENT_LINK_ROLES = new Set(['corrects', 'supersedes', 'discards', 'split_from', 'merge_input']);
const NON_CHART_DIMENSION_ROLES = new Set(['link', 'status', 'raw', 'note', 'order', 'review_operation', 'correction']);

// ---- decoding the stored shapes (camel or snake case) ----

export function decodeEvidenceValue(value) {
  const row = objectOf(value);
  if (!('value' in row)) return { value };
  return {
    value: row.value,
    ...present('unit', optionalText(row.unit)),
    ...present('role', optionalText(row.role)),
    ...present('label', optionalText(row.label)),
    ...present('confidence', optionalNumber(row.confidence)),
  };
}

export const decodeDimensions = value => Object.fromEntries(
  Object.entries(objectOf(value)).filter(([key]) => key.trim()).map(([key, entry]) => [key, decodeEvidenceValue(entry)]),
);

export const decodeSource = (value, fallbackKind) => {
  const row = objectOf(value);
  return { kind: optionalText(row.kind) ?? fallbackKind, ...present('label', optionalText(row.label)), ...present('ref', optionalText(row.ref)) };
};

export const decodeSubject = (value, fallbackKind) => {
  const row = objectOf(value);
  return { kind: optionalText(row.kind) ?? fallbackKind, ...present('id', optionalText(row.id)), ...present('label', optionalText(row.label)) };
};

export function decodeLink(value) {
  const row = objectOf(value);
  const role = optionalText(row.role);
  const targetId = optionalText(row.targetId ?? row.target_id);
  if (!role || !targetId) return null;
  return {
    role,
    targetId,
    ...present('targetKind', optionalText(row.targetKind ?? row.target_kind)),
    ...present('order', optionalNumber(row.order)),
  };
}

export function decodeConfidence(value) {
  const row = objectOf(value);
  const state = optionalText(row.state);
  if (!state) return undefined;
  const missing = listOf(row.missingDimensions ?? row.missing_dimensions).map(textOf).filter(Boolean);
  return {
    state,
    ...present('score', optionalNumber(row.score)),
    ...(missing.length ? { missingDimensions: missing } : {}),
    ...present('reviewReason', optionalText(row.reviewReason ?? row.review_reason)),
  };
}

export function decodeAtom(value) {
  const row = objectOf(value);
  const id = optionalText(row.id);
  const observedAt = optionalText(row.observedAt ?? row.observed_at);
  if (!id || !observedAt) return null;
  const confidence = decodeConfidence(row.confidence);
  return {
    id,
    schema: optionalText(row.schema) ?? 'evidence-atom',
    observedAt,
    ...present('recordedAt', optionalText(row.recordedAt ?? row.recorded_at)),
    source: decodeSource(row.source, 'unknown'),
    subject: decodeSubject(row.subject, 'observation'),
    dimensions: decodeDimensions(row.dimensions),
    links: listOf(row.links).map(decodeLink).filter(Boolean),
    ...(confidence ? { confidence } : {}),
    rawArtifactRefs: listOf(row.rawArtifactRefs ?? row.raw_artifact_refs).map(textOf).filter(Boolean),
    evidenceRefs: listOf(row.evidenceRefs ?? row.evidence_refs),
  };
}

export function decodeRawArtifact(value) {
  const row = objectOf(value);
  const id = optionalText(row.id);
  const capturedAt = optionalText(row.capturedAt ?? row.captured_at);
  if (!id || !capturedAt) return null;
  return {
    id,
    kind: optionalText(row.kind) ?? 'raw_text',
    capturedAt,
    ...present('text', optionalText(row.text)),
    ...present('ref', optionalText(row.ref)),
    ...present('source', optionalText(row.source)),
  };
}

function decodeQuery(value) {
  const row = objectOf(value);
  return {
    subjectKinds: listOf(row.subjectKinds ?? row.subject_kinds).map(textOf).filter(Boolean),
    dimensionKeys: listOf(row.dimensionKeys ?? row.dimension_keys).map(textOf).filter(Boolean),
    linkRoles: listOf(row.linkRoles ?? row.link_roles).map(textOf).filter(Boolean),
    ...present('window', optionalText(row.window)),
    ...present('comparator', optionalText(row.comparator)),
  };
}

function decodeLens(value) {
  const row = objectOf(value);
  const id = optionalText(row.id);
  const label = optionalText(row.label);
  const output = objectOf(row.output);
  const kind = optionalText(output.kind);
  if (!id || !label || !kind) return null;
  return {
    id,
    label,
    intent: optionalText(row.intent) ?? 'project',
    atomQuery: decodeQuery(row.atomQuery ?? row.atom_query),
    output: {
      kind,
      ...present('primaryMetric', optionalText(output.primaryMetric ?? output.primary_metric)),
      secondaryMetrics: listOf(output.secondaryMetrics ?? output.secondary_metrics).map(textOf).filter(Boolean),
      groupBy: listOf(output.groupBy ?? output.group_by).map(textOf).filter(Boolean),
    },
    ...present('prominence', optionalText(row.prominence)),
  };
}

function decodeSessions(value) {
  return listOf(value).map(entry => {
    const row = objectOf(entry);
    return {
      id: textOf(row.id),
      startedAt: textOf(row.startedAt ?? row.started_at),
      status: optionalText(row.status) ?? NEEDS_REVIEW,
      ...present('plannedSessionRef', optionalText(row.plannedSessionRef ?? row.planned_session_ref)),
      ...present('endedAt', optionalText(row.endedAt ?? row.ended_at)),
      ...present('journalNoteRef', optionalText(row.journalNoteRef ?? row.journal_note_ref)),
    };
  }).filter(session => session.id);
}

function decodeSets(value) {
  return listOf(value).map(entry => {
    const row = objectOf(entry);
    return {
      id: textOf(row.id),
      movementResultId: textOf(row.movementResultId ?? row.movement_result_id),
      sequence: numberOf(row.sequence),
      quantity: objectOf(row.quantity),
      load: objectOf(row.load),
      effort: objectOf(row.effort),
    };
  }).filter(set => set.id);
}

// ---- sessions and sets, read as atoms ----
// A set's result id is `<session id>:<movement name>` with a session id of two parts (`kind:id`); that is the stored shape.

const flatten = (prefix, record) => Object.fromEntries(
  Object.entries(record).filter(([key]) => key.trim()).map(([key, entry]) => [`${prefix}.${key}`, { value: entry, role: prefix, label: key }]),
);

function sessionToAtom(session) {
  const unknownStatus = session.status === NEEDS_REVIEW || session.status === 'unknown' || session.status === 'unconfirmed';
  return {
    id: `legacy:${session.id}`,
    schema: 'evidence-atom',
    observedAt: session.startedAt,
    ...(session.endedAt ? { recordedAt: session.endedAt } : {}),
    source: { kind: 'legacy_session_record', label: 'Session record' },
    subject: { kind: 'workout_session', id: session.id, label: session.plannedSessionRef ?? session.id },
    dimensions: {
      status: { value: session.status, role: 'status', label: 'Status' },
      ...(session.endedAt ? { ended_at: { value: session.endedAt, role: 'time', label: 'Ended' } } : {}),
      ...(session.plannedSessionRef ? { planned_session_ref: { value: session.plannedSessionRef, role: 'link', label: 'Plan' } } : {}),
      ...(session.journalNoteRef ? { journal_note_ref: { value: session.journalNoteRef, role: 'link', label: 'Journal' } } : {}),
    },
    links: [
      ...(session.plannedSessionRef ? [{ role: 'planned_session', targetId: session.plannedSessionRef, targetKind: 'training_plan_session' }] : []),
      ...(session.journalNoteRef ? [{ role: 'journal_note', targetId: session.journalNoteRef, targetKind: 'journal_note' }] : []),
    ],
    confidence: unknownStatus
      ? { state: NEEDS_REVIEW, missingDimensions: ['status'], reviewReason: 'Session status was missing or unknown.' }
      : { state: CONFIRMED },
    rawArtifactRefs: [],
    evidenceRefs: [],
  };
}

function setToAtom(set, sessions) {
  const parts = set.movementResultId.split(':');
  const sessionId = parts.length > 2 ? parts.slice(0, 2).join(':') : undefined;
  return {
    id: `legacy:${set.id}`,
    schema: 'evidence-atom',
    observedAt: sessions.find(session => session.id === sessionId)?.startedAt ?? '',
    source: { kind: 'legacy_set_record', label: 'Set result' },
    subject: { kind: 'movement_result', id: set.movementResultId, label: parts.length > 2 ? parts.slice(2).join(':') : set.movementResultId },
    dimensions: {
      sequence: { value: set.sequence, role: 'order', label: 'Set' },
      ...flatten('quantity', set.quantity),
      ...flatten('load', set.load),
      ...flatten('effort', set.effort),
    },
    links: [
      { role: 'movement_result', targetId: set.movementResultId, targetKind: 'movement_result', order: set.sequence },
      ...(sessionId ? [{ role: 'session', targetId: sessionId, targetKind: 'workout_session' }] : []),
    ],
    confidence: { state: CONFIRMED },
    rawArtifactRefs: [],
    evidenceRefs: [],
  };
}

// Later atoms of the same id win; the first position is kept.
const mergeAtoms = (primary, secondary) => [...new Map([...primary, ...secondary].map(atom => [atom.id, atom])).values()];

// ---- what each atom means for the reading ----

const atomConfirmed = atom => !atom.confidence || atom.confidence.state === CONFIRMED;
const atomNeedsReview = atom => Boolean(atom.confidence && atom.confidence.state !== CONFIRMED);
// A decision atom only confirms or discards others; a correction carries values of its own and stays in the reading.
const atomIsReviewDecision = atom => atom.links.some(link => DECIDING_LINK_ROLES.has(link.role));

function buildDecisionIndex(atoms) {
  const confirmedTargetIds = new Set();
  const replacedTargetIds = new Set();
  const decisionAtomIds = new Set();
  for (const atom of atoms) {
    if (atomIsReviewDecision(atom)) decisionAtomIds.add(atom.id);
    if (!atomConfirmed(atom)) continue;
    for (const link of atom.links) {
      if (CONFIRMING_LINK_ROLES.has(link.role)) confirmedTargetIds.add(link.targetId);
      if (REPLACEMENT_LINK_ROLES.has(link.role)) replacedTargetIds.add(link.targetId);
    }
  }
  return { confirmedTargetIds, replacedTargetIds, decisionAtomIds };
}

const isCanonical = (atom, index) => !index.decisionAtomIds.has(atom.id) && !index.replacedTargetIds.has(atom.id);
const effectivelyConfirmed = (atom, index) => atomConfirmed(atom) || index.confirmedTargetIds.has(atom.id);
const atomTime = atom => { const parsed = Date.parse(atom.observedAt); return Number.isFinite(parsed) ? parsed : 0; };
const latestFirst = atoms => [...atoms].sort((left, right) => atomTime(right) - atomTime(left));
const earliestFirst = atoms => [...atoms].sort((left, right) => atomTime(left) - atomTime(right));

function atomMatches(atom, query) {
  if (query.subjectKinds?.length && !query.subjectKinds.includes(atom.subject.kind)) return false;
  if (query.dimensionKeys?.length && !query.dimensionKeys.some(key => key in atom.dimensions)) return false;
  if (query.linkRoles?.length && !query.linkRoles.some(role => atom.links.some(link => link.role === role))) return false;
  return true;
}

export const describeEvidenceValue = value => {
  const text = value.value == null ? '' : String(value.value);
  return value.unit ? `${text} ${value.unit}` : text;
};

export function describeAtom(atom) {
  const values = Object.values(atom.dimensions)
    .filter(value => value.role !== 'link' && value.role !== 'status')
    .slice(0, 3).map(describeEvidenceValue).filter(Boolean);
  return [atom.subject.label ?? atom.subject.id ?? atom.subject.kind, ...values].filter(Boolean).join(' · ');
}

const exportRowOf = atom => ({
  atomId: atom.id,
  observedAt: atom.observedAt,
  subjectKind: atom.subject.kind,
  ...present('subjectId', atom.subject.id),
  ...present('subjectLabel', atom.subject.label),
  dimensions: Object.fromEntries(Object.entries(atom.dimensions).map(([key, value]) => [key, value.value])),
  ...present('confidenceState', atom.confidence?.state),
  rawArtifactRefs: atom.rawArtifactRefs,
  evidenceRefs: atom.evidenceRefs,
});

// One lens over the atoms. A lens's output kind is one of: previous-value (the latest confirmed match), review-queue,
// progress-summary (confirmed matches, newest named), export-rows; anything else lists the canonical matches.
function runLens(lens, atoms, reviewQueue, index) {
  const matched = atoms.filter(atom => isCanonical(atom, index)).filter(atom => atomMatches(atom, lens.atomQuery));
  const confirmed = matched.filter(atom => effectivelyConfirmed(atom, index));
  const base = { lensId: lens.id, kind: lens.output.kind, label: lens.label };
  const metricLabel = fallback => lens.output.primaryMetric ?? fallback;
  switch (lens.output.kind) {
    case 'previous-value': {
      const primaryAtom = latestFirst(confirmed)[0];
      return { ...base, items: primaryAtom ? [primaryAtom] : [], ...(primaryAtom ? { primaryAtom, primaryText: describeAtom(primaryAtom) } : { unavailableReason: 'No similar confirmed entry yet.' }) };
    }
    case 'review-queue':
      return { ...base, items: reviewQueue, metric: { label: metricLabel('awaiting review'), value: reviewQueue.length } };
    case 'progress-summary': {
      const latest = latestFirst(confirmed)[0];
      return {
        ...base,
        items: confirmed,
        ...(latest ? { primaryAtom: latest, primaryText: describeAtom(latest) } : {}),
        metric: { label: metricLabel('confirmed entries'), value: confirmed.length, detail: latest ? `Latest: ${describeAtom(latest)}` : 'No confirmed entries yet.' },
      };
    }
    case 'export-rows':
      return { ...base, items: confirmed, rows: confirmed.map(exportRowOf), metric: { label: metricLabel('rows'), value: confirmed.length } };
    default:
      return { ...base, items: matched, metric: { label: metricLabel('entries'), value: matched.length } };
  }
}

// ---- the numeric progress series, as plain numbers ----

function readChartNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^[-+]?\d+(?:\.\d+)?$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimalPlaces(value) {
  const text = String(value);
  return text.includes('e') ? 2 : Math.min(2, text.split('.')[1]?.length ?? 0);
}

function numericSeries(atoms) {
  const groups = new Map();
  for (const atom of earliestFirst(atoms)) {
    const timestamp = atomTime(atom);
    if (timestamp <= 0) continue;
    for (const [key, dimension] of Object.entries(atom.dimensions)) {
      if (dimension.role && NON_CHART_DIMENSION_ROLES.has(dimension.role)) continue;
      const value = readChartNumber(dimension.value);
      if (value === undefined) continue;
      const seriesKey = [atom.subject.kind, atom.subject.id ?? atom.subject.label ?? atom.subject.kind, key, dimension.unit ?? ''].join('::');
      const series = groups.get(seriesKey) ?? {
        key: seriesKey,
        subjectLabel: atom.subject.label ?? atom.subject.id ?? atom.subject.kind,
        metricLabel: optionalText(dimension.label) ?? optionalText(dimension.role) ?? key,
        ...present('unit', dimension.unit || undefined),
        points: [],
      };
      series.points.push({ atomId: atom.id, timestamp, value });
      groups.set(seriesKey, series);
    }
  }
  return [...groups.values()];
}

// The series with the most points, then the most recent, then by key.
const pickSeries = series => [...series].filter(candidate => candidate.points.length).sort((left, right) => {
  const countDiff = right.points.length - left.points.length;
  if (countDiff !== 0) return countDiff;
  const recentDiff = (right.points.at(-1)?.timestamp ?? 0) - (left.points.at(-1)?.timestamp ?? 0);
  return recentDiff !== 0 ? recentDiff : left.key.localeCompare(right.key);
})[0];

function progressSeries(canonical, lensOutputs) {
  const fromLens = lensOutputs.find(output => output.kind === 'progress-summary')?.items ?? [];
  const series = pickSeries(numericSeries(mergeAtoms(canonical.filter(atomConfirmed), fromLens)));
  if (!series) return null;
  const values = series.points.map(point => point.value);
  return {
    metricKey: series.key,
    title: series.subjectLabel === series.metricLabel ? series.metricLabel : `${series.subjectLabel} ${series.metricLabel.toLowerCase()}`,
    metric: series.metricLabel,
    ...present('unit', series.unit),
    valueDecimals: Math.max(...values.map(decimalPlaces), 0),
    points: series.points,
    summary: {
      total: values.at(-1) ?? 0,
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    },
  };
}

// ---- reading a whole log ----

// Reads a log from its raw state ({ sessions?, sets?, evidenceAtoms?, rawArtifacts?, projectionLenses? }, camel or snake case).
export function readWorkoutLog(raw) {
  const root = objectOf(raw);
  const sessions = decodeSessions(root.sessions);
  const sets = decodeSets(root.sets);
  const explicit = listOf(root.evidenceAtoms ?? root.evidence_atoms).map(decodeAtom).filter(Boolean);
  const evidenceAtoms = mergeAtoms(explicit, [...sessions.map(sessionToAtom), ...sets.map(set => setToAtom(set, sessions))]);
  const projectionLenses = listOf(root.projectionLenses ?? root.projection_lenses).map(decodeLens).filter(Boolean);
  const index = buildDecisionIndex(evidenceAtoms);
  const canonicalEvidenceAtoms = evidenceAtoms.filter(atom => isCanonical(atom, index));
  const reviewQueue = latestFirst(evidenceAtoms.filter(atom => atomNeedsReview(atom) && isCanonical(atom, index) && !index.confirmedTargetIds.has(atom.id)));
  const lensOutputs = projectionLenses.map(lens => runLens(lens, evidenceAtoms, reviewQueue, index));
  return {
    sessions,
    sets,
    evidenceAtoms,
    canonicalEvidenceAtoms,
    rawArtifacts: listOf(root.rawArtifacts ?? root.raw_artifacts).map(decodeRawArtifact).filter(Boolean),
    projectionLenses,
    lensOutputs,
    reviewQueue,
    exportRows: canonicalEvidenceAtoms.filter(atom => effectivelyConfirmed(atom, index)).map(exportRowOf),
    progressSeries: progressSeries(canonicalEvidenceAtoms, lensOutputs),
    diagnostics: projectionLenses.length === 0 ? ['No summary views (projection lenses) are defined.'] : [],
  };
}

// The share of sessions whose status is `doneStatus`, a word the person gives; 0 for no sessions.
export const workoutCompletionRate = (sessions, doneStatus) => (
  sessions.length === 0 ? 0 : sessions.filter(session => session.status === doneStatus).length / sessions.length
);

// ---- adding to a log ----

const stableSuffix = value => JSON.stringify(value).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'evidence';

export function buildEvidenceAtom({ id, descriptorId, observedAt, source, subject, dimensions, links, confidence, rawArtifactRefs, evidenceRefs }) {
  return {
    id: id ?? `evidence:${descriptorId}:${stableSuffix([observedAt, subject, dimensions])}`,
    schema: 'evidence-atom',
    observedAt,
    recordedAt: observedAt,
    source,
    subject,
    dimensions,
    links: links ?? [],
    confidence: confidence ?? { state: CONFIRMED },
    rawArtifactRefs: rawArtifactRefs ?? [],
    evidenceRefs: evidenceRefs ?? [],
  };
}

const operationDimension = operation => ({ 'review.operation': { value: operation, role: 'review_operation', label: 'Review operation' } });
const noteDimension = note => (note ? { 'review.note': { value: note, role: 'note', label: 'Review note' } } : {});

// Confirms or discards one atom, by a new atom that links to it.
export function buildReviewDecisionAtom({ id, operation, targetAtom, observedAt, source, note }) {
  return buildEvidenceAtom({
    id,
    descriptorId: `review:${operation}`,
    observedAt,
    source: source ?? { kind: 'manual_review', label: 'Manual review' },
    subject: { kind: REVIEW_DECISION_SUBJECT, id: `${operation}:${targetAtom.id}`, label: operation === 'confirm' ? 'Looks right' : 'Remove entry' },
    dimensions: {
      ...operationDimension(operation),
      'review.target': { value: targetAtom.id, role: 'link', label: 'Entry' },
      ...noteDimension(note),
    },
    links: [{ role: operation === 'confirm' ? 'confirms' : 'discards', targetId: targetAtom.id, targetKind: targetAtom.subject.kind }],
  });
}

// Corrects one atom, or splits one into several, or merges several into one, by a new atom carrying the new values.
export function buildCorrectionAtom({ id, operation = 'correct', descriptorId, targetAtom, additionalTargetAtoms = [], observedAt, source, subject, dimensions, rawArtifactRefs, evidenceRefs, note }) {
  const role = operation === 'split' ? 'split_from' : operation === 'merge' ? 'merge_input' : 'corrects';
  return buildEvidenceAtom({
    id,
    descriptorId: descriptorId ?? `review:${operation}`,
    observedAt,
    source: source ?? { kind: 'manual_review', label: 'Manual review' },
    subject: subject ?? targetAtom.subject,
    dimensions: { ...dimensions, ...operationDimension(operation), ...noteDimension(note) },
    links: [targetAtom, ...additionalTargetAtoms].map((target, order) => ({ role, targetId: target.id, targetKind: target.subject.kind, order })),
    rawArtifactRefs: rawArtifactRefs ?? targetAtom.rawArtifactRefs,
    evidenceRefs: evidenceRefs ?? targetAtom.evidenceRefs,
  });
}

export function buildRawArtifact({ id, kind, capturedAt, text, ref, source }) {
  return {
    id: id ?? `raw:${kind}:${stableSuffix([capturedAt, text ?? ref ?? 'artifact'])}`,
    kind,
    capturedAt,
    ...present('text', text || undefined),
    ...present('ref', ref || undefined),
    ...present('source', source || undefined),
  };
}

// The log's next raw state with one atom (and its raw artifact) added. Every other key of the state is kept as given.
export function appendEvidence(raw, atom, rawArtifact) {
  const log = readWorkoutLog(raw);
  const kept = Object.fromEntries(Object.entries(objectOf(raw)).filter(([key]) => !['evidenceAtoms', 'evidence_atoms', 'rawArtifacts', 'raw_artifacts'].includes(key)));
  return {
    ...kept,
    evidenceAtoms: mergeAtoms(log.evidenceAtoms, [atom]),
    rawArtifacts: rawArtifact ? [...log.rawArtifacts.filter(artifact => artifact.id !== rawArtifact.id), rawArtifact] : log.rawArtifacts,
  };
}
