// tools/training-and-workouts: the workout log as a ledger of evidence atoms. Every fixture is a made-up juggling club.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvidence, buildCorrectionAtom, buildEvidenceAtom, buildRawArtifact, buildReviewDecisionAtom, decodeAtom, readWorkoutLog, workoutCompletionRate,
} from '../read-data/workout-log.mjs';

const atom = (id, observedAt, value, extra = {}) => ({
  id,
  observedAt,
  source: { kind: 'manual' },
  subject: { kind: 'drill', id: 'cascade', label: 'Cascade' },
  dimensions: { throws: { value, unit: 'throws', label: 'Throws' } },
  ...extra,
});
const unsure = { confidence: { state: 'needs_review', reviewReason: 'typed fast' } };

test('an atom without an id or a time is dropped; the rest reads in either casing', () => {
  assert.equal(decodeAtom({ observedAt: '2026-01-01T00:00:00Z' }), null);
  assert.equal(decodeAtom({ id: 'a' }), null);
  const read = decodeAtom({ id: 'a', observed_at: '2026-01-01T00:00:00Z', raw_artifact_refs: ['r1'], links: [{ role: 'x', target_id: 't', target_kind: 'k' }, { role: 'no target' }], dimensions: { reps: 8 } });
  assert.deepEqual(read.rawArtifactRefs, ['r1']);
  assert.deepEqual(read.links, [{ role: 'x', targetId: 't', targetKind: 'k' }]);
  assert.deepEqual(read.dimensions.reps, { value: 8 });
  assert.equal(read.schema, 'evidence-atom');
});

test('an unconfirmed atom waits in the review queue, newest first', () => {
  const log = readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 10, unsure), atom('b', '2026-01-02T00:00:00Z', 12), atom('c', '2026-01-03T00:00:00Z', 9, unsure)] });
  assert.deepEqual(log.reviewQueue.map(item => item.id), ['c', 'a']);
  assert.deepEqual(log.canonicalEvidenceAtoms.map(item => item.id), ['a', 'b', 'c']);
});

test('a confirmation takes the entry out of the queue and counts it as confirmed; the decision is not an entry', () => {
  const target = decodeAtom(atom('a', '2026-01-01T00:00:00Z', 10, unsure));
  const decision = buildReviewDecisionAtom({ operation: 'confirm', targetAtom: target, observedAt: '2026-01-02T00:00:00Z', note: 'checked' });
  const log = readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 10, unsure), decision] });
  assert.deepEqual(log.reviewQueue, []);
  assert.deepEqual(log.canonicalEvidenceAtoms.map(item => item.id), ['a']);
  assert.deepEqual(log.exportRows.map(row => row.atomId), ['a']);
  assert.equal(decision.links[0].role, 'confirms');
  assert.equal(decision.dimensions['review.note'].value, 'checked');
});

test('a discard removes the entry from the reading', () => {
  const target = decodeAtom(atom('a', '2026-01-01T00:00:00Z', 10));
  const decision = buildReviewDecisionAtom({ operation: 'discard', targetAtom: target, observedAt: '2026-01-02T00:00:00Z' });
  const log = readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 10), decision] });
  assert.deepEqual(log.canonicalEvidenceAtoms, []);
  assert.deepEqual(log.exportRows, []);
  assert.equal(decision.links[0].role, 'discards');
});

test('a correction replaces the entry and stays in the reading with its own values', () => {
  const target = decodeAtom(atom('a', '2026-01-01T00:00:00Z', 10, unsure));
  const fix = buildCorrectionAtom({ id: 'a2', targetAtom: target, observedAt: '2026-01-02T00:00:00Z', dimensions: { throws: { value: 100, unit: 'throws' } } });
  const log = readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 10, unsure), fix] });
  assert.deepEqual(log.canonicalEvidenceAtoms.map(item => item.id), ['a2']);
  assert.deepEqual(log.reviewQueue, []);
  assert.equal(log.exportRows[0].dimensions.throws, 100);
  assert.equal(fix.dimensions['review.operation'].value, 'correct');
  assert.deepEqual(fix.links.map(link => [link.role, link.targetId]), [['corrects', 'a']]);
});

test('a split and a merge link every source atom in order', () => {
  const [a, b] = ['a', 'b'].map(id => decodeAtom(atom(id, '2026-01-01T00:00:00Z', 5)));
  const merged = buildCorrectionAtom({ id: 'ab', operation: 'merge', targetAtom: a, additionalTargetAtoms: [b], observedAt: '2026-01-02T00:00:00Z', dimensions: { throws: { value: 10 } } });
  assert.deepEqual(merged.links.map(link => [link.role, link.targetId, link.order]), [['merge_input', 'a', 0], ['merge_input', 'b', 1]]);
  const split = buildCorrectionAtom({ id: 'a1', operation: 'split', targetAtom: a, observedAt: '2026-01-02T00:00:00Z', dimensions: {} });
  assert.equal(split.links[0].role, 'split_from');
  const log = readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 5), atom('b', '2026-01-01T00:00:00Z', 5), merged] });
  assert.deepEqual(log.canonicalEvidenceAtoms.map(item => item.id), ['ab']);
});

test('an unconfirmed decision does not count', () => {
  const target = decodeAtom(atom('a', '2026-01-01T00:00:00Z', 10, unsure));
  const decision = { ...buildReviewDecisionAtom({ operation: 'confirm', targetAtom: target, observedAt: '2026-01-02T00:00:00Z' }), confidence: { state: 'needs_review' } };
  assert.deepEqual(readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 10, unsure), decision] }).reviewQueue.map(item => item.id), ['a']);
});

const LENSES = [
  { id: 'last', label: 'Last time', atomQuery: { subjectKinds: ['drill'] }, output: { kind: 'previous-value' } },
  { id: 'queue', label: 'To check', atomQuery: {}, output: { kind: 'review-queue' } },
  { id: 'progress', label: 'Progress', atomQuery: { dimensionKeys: ['throws'] }, output: { kind: 'progress-summary', primaryMetric: 'entries' } },
  { id: 'rows', label: 'Rows', atom_query: { subject_kinds: ['drill'] }, output: { kind: 'export-rows' } },
  { id: 'any', label: 'Any', atomQuery: { linkRoles: ['nothing'] }, output: { kind: 'something-else' } },
  { id: 'bad', label: 'no output' },
];

test('lenses run over the canonical atoms and each output kind answers its own way', () => {
  const log = readWorkoutLog({
    projectionLenses: LENSES,
    evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 10), atom('b', '2026-01-03T00:00:00Z', 12), atom('c', '2026-01-02T00:00:00Z', 9, unsure)],
  });
  const by = Object.fromEntries(log.lensOutputs.map(output => [output.lensId, output]));
  assert.equal(log.lensOutputs.length, 5, 'a lens with no output kind is dropped');
  assert.equal(by.last.primaryAtom.id, 'b');
  assert.equal(by.last.primaryText, 'Cascade · 12 throws');
  assert.deepEqual(by.queue.items.map(item => item.id), ['c']);
  assert.deepEqual(by.queue.metric, { label: 'awaiting review', value: 1 });
  assert.deepEqual(by.progress.metric, { label: 'entries', value: 2, detail: 'Latest: Cascade · 12 throws' });
  assert.deepEqual(by.rows.rows.map(row => row.atomId), ['a', 'b']);
  assert.equal(by.any.metric.value, 0);
  assert.deepEqual(log.diagnostics, []);
});

test('a lens that finds nothing says so rather than inventing a value', () => {
  const log = readWorkoutLog({ projectionLenses: [LENSES[0]], evidenceAtoms: [] });
  assert.equal(log.lensOutputs[0].unavailableReason, 'No similar confirmed entry yet.');
  assert.deepEqual(readWorkoutLog({}).diagnostics, ['No summary views (projection lenses) are defined.']);
});

test('sessions and sets read as atoms, a set linked to its session by the id it carries', () => {
  const log = readWorkoutLog({
    sessions: [{ id: 'session:1', started_at: '2026-01-05T08:00:00Z', status: 'completed', plannedSessionRef: 'plan:s1' }, { id: 'session:2', startedAt: '2026-01-06T08:00:00Z' }],
    sets: [{ id: 'set:1', movementResultId: 'session:1:cascade', sequence: 1, quantity: { throws: 40 }, load: { balls: 3 }, effort: {} }],
  });
  const byId = Object.fromEntries(log.evidenceAtoms.map(item => [item.id, item]));
  assert.equal(byId['legacy:session:1'].confidence.state, 'confirmed');
  assert.equal(byId['legacy:session:2'].confidence.state, 'needs_review');
  assert.deepEqual(log.reviewQueue.map(item => item.id), ['legacy:session:2']);
  assert.equal(byId['legacy:set:1'].observedAt, '2026-01-05T08:00:00Z');
  assert.equal(byId['legacy:set:1'].subject.label, 'cascade');
  assert.deepEqual(byId['legacy:set:1'].links.map(link => link.role), ['movement_result', 'session']);
  assert.equal(byId['legacy:set:1'].dimensions['quantity.throws'].value, 40);
});

test('the completion rate counts the status word the person gives, and is 0 with no sessions', () => {
  const { sessions } = readWorkoutLog({ sessions: [{ id: 's:1', startedAt: 'x', status: 'finished' }, { id: 's:2', startedAt: 'x', status: 'skipped' }] });
  assert.equal(workoutCompletionRate(sessions, 'finished'), 0.5);
  assert.equal(workoutCompletionRate([], 'finished'), 0);
});

test('the progress series is the numeric dimension with the most points, in time order, as plain numbers', () => {
  const log = readWorkoutLog({
    evidenceAtoms: [
      atom('a', '2026-01-03T00:00:00Z', 30), atom('b', '2026-01-01T00:00:00Z', 10), atom('c', '2026-01-02T00:00:00Z', '20'),
      { ...atom('d', '2026-01-02T00:00:00Z', 5), subject: { kind: 'drill', id: 'other', label: 'Other' } },
      atom('e', '2026-01-04T00:00:00Z', 99, unsure),
    ],
  });
  const series = log.progressSeries;
  assert.equal(series.title, 'Cascade throws');
  assert.equal(series.unit, 'throws');
  assert.deepEqual(series.points.map(point => point.value), [10, 20, 30]);
  assert.deepEqual(series.summary, { total: 30, average: 20, min: 10, max: 30, count: 3 });
  assert.equal(series.valueDecimals, 0);
  assert.equal(readWorkoutLog({ evidenceAtoms: [atom('a', '2026-01-01T00:00:00Z', 1.25)] }).progressSeries.valueDecimals, 2);
  assert.equal(readWorkoutLog({}).progressSeries, null);
});

test('status, link and note dimensions never become a series, and an atom with no valid time is left out', () => {
  const noTime = atom('a', 'not a date', 5);
  const notes = atom('b', '2026-01-01T00:00:00Z', 'x', { dimensions: { note: { value: '12', role: 'note' }, order: { value: 1, role: 'order' } } });
  assert.equal(readWorkoutLog({ evidenceAtoms: [noTime, notes] }).progressSeries, null);
});

test('adding evidence keeps every other key of the state, the opaque references and the raw artifact', () => {
  const evidenceRefs = [{ address: 'evidence://opaque', revision: 7 }, ['nested', 'reference']];
  const added = buildEvidenceAtom({ descriptorId: 'capture:any', observedAt: '2026-01-01T00:00:00Z', source: { kind: 'external' }, subject: { kind: 'observed-work' }, dimensions: {}, evidenceRefs });
  const raw = buildRawArtifact({ kind: 'raw_text', capturedAt: '2026-01-01T00:00:00Z', text: 'typed note' });
  const state = appendEvidence({ owner: 'club', projectionLenses: LENSES, evidence_atoms: [atom('a', '2026-01-01T00:00:00Z', 1)] }, added, raw);
  assert.equal(state.owner, 'club');
  assert.deepEqual(state.evidenceAtoms.map(item => item.id), ['a', added.id]);
  assert.deepEqual(state.evidenceAtoms[1].evidenceRefs, evidenceRefs);
  assert.deepEqual(state.rawArtifacts, [raw]);
  assert.equal('evidence_atoms' in state, false, 'one key holds the atoms');
  assert.match(added.id, /^evidence:capture:any:/);
});

test('adding the same atom twice keeps one; a raw artifact with the same id is replaced', () => {
  const added = buildEvidenceAtom({ id: 'x', descriptorId: 'd', observedAt: '2026-01-01T00:00:00Z', source: { kind: 'manual' }, subject: { kind: 'k' }, dimensions: {} });
  const once = appendEvidence({}, added, { id: 'r', kind: 'raw_text', capturedAt: '2026-01-01T00:00:00Z', text: 'first' });
  const twice = appendEvidence(once, added, { id: 'r', kind: 'raw_text', capturedAt: '2026-01-01T00:00:00Z', text: 'second' });
  assert.equal(twice.evidenceAtoms.length, 1);
  assert.deepEqual(twice.rawArtifacts.map(item => item.text), ['second']);
});
