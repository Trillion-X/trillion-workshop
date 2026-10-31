// tools/training-and-workouts: the training plan reading, the progression inputs and the next session. Every fixture is a
// made-up juggling club; nothing in the tool names an activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTrainingPlan, sessionsForWeek, trainingPlanSummary } from '../read-data/training-plan.mjs';
import {
  applyAdjustmentToPrescription, applyAdjustments, decodeLastResult, decodeProgressionRule, decodeProgressionRules, prescriptionFor, progressionInputs,
} from '../read-data/progression.mjs';

const BASE = {
  id: 'session:1',
  weekBlockId: 'week:1',
  title: 'Cascade blocks',
  activity: 'technical',
  dose: { sets: 4, reps: '6-8', throws: 60 },
  intensity: { effort: 'RPE 7', heightCm: 100 },
};

const STORED_LADDER = [
  { id: 'r:down', applies_to: 'plan:a', condition: { metricRef: 'block.catch-rate', max: 0.6 }, adjustment: { doseScale: 0.85, note: 'Ease off and rebuild rhythm.' } },
  { id: 'r:hold', applies_to: 'plan:a', condition: { metricRef: 'block.catch-rate', min: 0.6, max: 0.85 }, adjustment: { doseScale: 1 } },
  { id: 'r:up', applies_to: 'plan:a', condition: { metricRef: 'block.catch-rate', min: 0.85 }, adjustment: { doseScale: 1.1, intensityScale: 1.1, note: 'Add load.' } },
];

test('a plan reads from its records, dropping rows with no id and never inventing a missing field', () => {
  const plan = decodeTrainingPlan({
    goals: [{ id: 'g1', name: 'Juggle five', domain: 'juggling' }, { name: 'no id' }],
    phases: [{ id: 'p1', goalId: 'g1', name: 'Build', intent: 'build', sequence: '2' }],
    weeks: [{ id: 'w1', phaseId: 'p1', sequence: 1, loadIntent: 'steady' }],
    sessions: [BASE, { id: 's2', weekBlockId: 'w2', scheduledTaskRef: 'task:9' }, { title: 'no id' }],
  });
  assert.deepEqual(trainingPlanSummary(plan), { goals: 1, phases: 1, weeks: 1, sessions: 2 });
  assert.equal(plan.phases[0].sequence, 2);
  assert.deepEqual(plan.weeks[0].loadIntent, { id: 'steady', label: 'steady', data: {} });
  assert.equal(plan.sessions[1].scheduledTaskRef, 'task:9');
  assert.deepEqual(plan.sessions[1].dose, {});
  assert.deepEqual(sessionsForWeek(plan, 'week:1').map(session => session.id), ['session:1']);
  assert.deepEqual(trainingPlanSummary(decodeTrainingPlan(null)), { goals: 0, phases: 0, weeks: 0, sessions: 0 });
});

test('a load intent keeps its own identifier and fields, in either casing', () => {
  const intent = { id: 'cadence:custom', label: 'Custom cadence', policy: { window: 13 } };
  const camel = decodeTrainingPlan({ weeks: [{ id: 'w', phaseId: 'p', sequence: 1, loadIntent: intent }] });
  const snake = decodeTrainingPlan({ weeks: [{ id: 'w', phaseId: 'p', sequence: 1, load_intent: intent }] });
  assert.deepEqual(camel.weeks[0].loadIntent, { id: 'cadence:custom', label: 'Custom cadence', data: intent });
  assert.deepEqual(snake.weeks[0].loadIntent, camel.weeks[0].loadIntent);
  assert.equal(decodeTrainingPlan({ weeks: [{ id: 'w', loadIntent: { key: 'k', name: 'N' } }] }).weeks[0].loadIntent.label, 'N');
});

test('doseScale scales whole numbers (kept whole) and decimals, and leaves words alone', () => {
  const next = applyAdjustmentToPrescription(BASE, { doseScale: 0.85 });
  assert.equal(next.dose.sets, 3);
  assert.equal(next.dose.throws, 51);
  assert.equal(next.dose.reps, '6-8');
  assert.equal(applyAdjustmentToPrescription({ ...BASE, dose: { km: 2.5 } }, { doseScale: 1.1 }).dose.km, 2.75);
});

test('intensityScale scales intensity numbers and a note is kept at intensity.note', () => {
  const next = applyAdjustmentToPrescription(BASE, { intensityScale: 1.1, note: 'Relax the grip.' });
  assert.equal(next.intensity.heightCm, 110);
  assert.equal(next.intensity.effort, 'RPE 7');
  assert.equal(next.intensity.note, 'Relax the grip.');
});

test('unknown adjustment keys change nothing, and the input is never changed', () => {
  const snapshot = JSON.stringify(BASE);
  const next = applyAdjustmentToPrescription(BASE, { somethingElse: true, levelDelta: 1 });
  assert.deepEqual(next, BASE);
  assert.notEqual(next.dose, BASE.dose);
  applyAdjustments(BASE, [{ doseScale: 0.5, note: 'x' }]);
  assert.equal(JSON.stringify(BASE), snapshot);
});

test('adjustments are applied in order; none gives an unchanged copy', () => {
  const next = applyAdjustments(BASE, [{ doseScale: 0.5 }, { doseScale: 2, note: 'back up' }]);
  assert.equal(next.dose.throws, 60);
  assert.equal(next.intensity.note, 'back up');
  assert.deepEqual(applyAdjustments(BASE, []), BASE);
  assert.deepEqual(applyAdjustments(BASE, undefined), BASE);
});

test('a stored rule decodes flat, nested, snake case and wrapped; one with no metric is dropped', () => {
  assert.deepEqual(decodeProgressionRule(STORED_LADDER[0]), {
    id: 'r:down', metricRef: 'block.catch-rate', band: { max: 0.6 }, adjustment: { doseScale: 0.85, note: 'Ease off and rebuild rhythm.' }, appliesTo: 'plan:a',
  });
  assert.deepEqual(decodeProgressionRule({ id: 'r', condition: { metricRef: 'm', band: { min: 1, max: 2 } }, adjustment: {} }).band, { min: 1, max: 2 });
  const wrapped = decodeProgressionRule({ payload: { id: 'r', applies_to: 'p', label: 'L', condition: { metric_ref: 'drill.fatigue', max: 3 }, adjustment: { note: 'rest' } } });
  assert.deepEqual([wrapped.metricRef, wrapped.appliesTo, wrapped.label, wrapped.band], ['drill.fatigue', 'p', 'L', { max: 3 }]);
  assert.equal(decodeProgressionRule({ id: 'bad', condition: {}, adjustment: { doseScale: 2 } }), null);
});

test('rules decode from a list or a { rules } wrapper in order, dropping malformed rows', () => {
  assert.deepEqual(decodeProgressionRules([STORED_LADDER[0], { id: 'bad' }, STORED_LADDER[2]]).map(rule => rule.id), ['r:down', 'r:up']);
  assert.equal(decodeProgressionRules({ rules: STORED_LADDER }).length, 3);
  assert.deepEqual(decodeProgressionRules(null), []);
  assert.deepEqual(decodeProgressionRules(42), []);
});

test('the last result reads in camel and snake case and is null without a usable signal', () => {
  assert.deepEqual(decodeLastResult({ lastResult: { sessionId: 's1', signals: [{ metricRef: 'm', value: 0.9 }] } }), { sessionId: 's1', signals: [{ metricRef: 'm', value: 0.9 }] });
  assert.deepEqual(decodeLastResult({ last_result: { session_id: 's2', signals: [{ metric_ref: 'm', value: 1 }] } }), { sessionId: 's2', signals: [{ metricRef: 'm', value: 1 }] });
  assert.equal(decodeLastResult({ lastResult: { sessionId: 's1', signals: [] } }), null);
  assert.equal(decodeLastResult({}), null);
  assert.equal(decodeLastResult({ lastResult: { signals: [{ metricRef: 'm', value: 'x' }] } }), null);
});

const FEED = {
  goals: [{ id: 'g1', name: 'Juggle five', domain: 'juggling' }],
  phases: [{ id: 'p1', goalId: 'g1', name: 'Build', intent: 'build', sequence: 1 }],
  weeks: [{ id: 'w1', phaseId: 'p1', sequence: 1, loadIntent: 'build' }],
  sessions: [
    { id: 's1', weekBlockId: 'w1', title: 'Cascade', activity: 'technical', dose: { sets: 4, throws: 60 }, intensity: { heightCm: 100 } },
    { id: 's2', weekBlockId: 'w1', title: 'Cascade 2', activity: 'technical', dose: { sets: 4, throws: 60 }, intensity: { heightCm: 100 } },
  ],
  progressionRules: STORED_LADDER,
};

test('progression inputs give the rules, the signals and the prescription they belong to', () => {
  const inputs = progressionInputs({ ...FEED, lastResult: { sessionId: 's1', signals: [{ metricRef: 'block.catch-rate', value: 0.92 }] } });
  assert.equal(inputs.rules.length, 3);
  assert.deepEqual(inputs.signals, [{ metricRef: 'block.catch-rate', value: 0.92 }]);
  assert.equal(inputs.session_id, 's1');
  assert.equal(inputs.prescription.id, 's1');
});

test('with no result there are no signals and no prescription: nothing is made up', () => {
  const inputs = progressionInputs(FEED);
  assert.deepEqual([inputs.signals, inputs.session_id, inputs.prescription], [[], '', null]);
  assert.equal(inputs.rules.length, 3);
  assert.equal(progressionInputs({ sessions: [], lastResult: { sessionId: 's1', signals: [{ metricRef: 'm', value: 1 }] } }).prescription, null);
});

test('an unknown session id falls back to the last session in the plan', () => {
  assert.equal(prescriptionFor(decodeTrainingPlan(FEED), 'nope').id, 's2');
  assert.equal(prescriptionFor(decodeTrainingPlan(FEED), '').id, 's2');
  assert.equal(prescriptionFor(decodeTrainingPlan({}), 's1'), null);
});

test('the rules this tool decodes, the band an evaluator picks and the adjustment applied give the next session', () => {
  // The evaluator is the evaluate-progress tool; its answer for 0.92 is the rule whose half-open band holds it: r:up.
  const [up] = decodeProgressionRules(STORED_LADDER).filter(rule => 0.92 >= (rule.band.min ?? -Infinity) && 0.92 < (rule.band.max ?? Infinity));
  const next = applyAdjustments(BASE, [up.adjustment]);
  assert.equal(next.dose.throws, 66);
  assert.equal(next.intensity.heightCm, 110);
  assert.equal(next.intensity.note, 'Add load.');
});
