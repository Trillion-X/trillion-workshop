// tools/training-and-workouts: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>,
// the request on standard input), the whole loop through the rows, and the refusals a person's AI gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const folder = new URL('..', import.meta.url).pathname;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const run = (argv, input) => new Promise(resolve => {
  const child = promisify(execFile)(argv[0], argv.slice(1), { cwd: folder });
  child.child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  child.then(({ stdout }) => resolve({ code: 0, last: JSON.parse(stdout.trim().split('\n').pop()) }), error => resolve({ code: error.code, last: JSON.parse(error.stdout.trim().split('\n').pop()) }));
});
const select = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((at, key) => at?.[key], value);
const argvOf = fn => ['node', 'do-work/run-request.mjs', fn];

test('every row runs its own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 5);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row names its folder, is offline, and carries no maker name of its own', () => {
  for (const row of rows) {
    assert.deepEqual([row.invoke.files.package_files.package, row.invoke.internet, row.maker], ['training-and-workouts', false, 'maker:training-and-workouts']);
    assert.ok(Array.isArray(row.input_schema.required) && row.job.length > 20, row.id);
  }
});

test('requests that cannot run are refused with a sentence', async () => {
  assert.match((await run(argvOf('readTrainingPlan'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  assert.match((await run(argvOf('readTrainingPlan'), {})).last.error, /plan must be/);
  assert.match((await run(argvOf('readProgressionInputs'), {})).last.error, /feed must be/);
  assert.match((await run(argvOf('adaptNextSession'), { prescription: {} })).last.error, /adjustments must be/);
  assert.match((await run(argvOf('adaptNextSession'), { adjustments: [] })).last.error, /give the prescription/);
  assert.match((await run(argvOf('adaptNextSession'), { adjustments: [], plan: { sessions: [] }, session_id: 'x' })).last.error, /not a session in the plan/);
  assert.match((await run(argvOf('adaptNextSession'), { adjustments: [], prescription: { dose: 1 } })).last.error, /dose record and an intensity record/);
  assert.match((await run(argvOf('readMyWorkoutLog'), {})).last.error, /log must be/);
  const log = { evidenceAtoms: [] };
  assert.match((await run(argvOf('addToWorkoutLog'), { log, operation: 'rename' })).last.error, /operation must be one of/);
  assert.match((await run(argvOf('addToWorkoutLog'), { log, operation: 'add', observed_at: 'soon' })).last.error, /observed_at must be a date/);
  assert.match((await run(argvOf('addToWorkoutLog'), { log, operation: 'add', observed_at: '2026-01-01T00:00:00Z' })).last.error, /descriptor_id/);
  assert.match((await run(argvOf('addToWorkoutLog'), { log, operation: 'confirm', observed_at: '2026-01-01T00:00:00Z' })).last.error, /target_atom_id/);
  assert.match((await run(argvOf('addToWorkoutLog'), { log, operation: 'confirm', observed_at: '2026-01-01T00:00:00Z', target_atom_id: 'ghost' })).last.error, /not in the log/);
  assert.match((await run(argvOf('addToWorkoutLog'), { log: { evidenceAtoms: [{ id: 'a', observedAt: '2026-01-01T00:00:00Z' }] }, operation: 'correct', observed_at: '2026-01-02T00:00:00Z', target_atom_id: 'a' })).last.error, /dimensions must hold/);
});

test('the loop runs through the rows: add an unsure entry, see it queued, correct it, and the queue empties', async () => {
  const at = '2026-01-01T09:00:00Z';
  const first = await run(argvOf('addToWorkoutLog'), {
    log: {}, operation: 'add', descriptor_id: 'drill-log', observed_at: at, id: 'entry:1',
    source: { kind: 'typed' }, subject: { kind: 'drill', label: 'Cascade' }, dimensions: { throws: { value: 400, unit: 'throws' } },
    confidence: { state: 'needs_review', reviewReason: 'a lot of throws' },
  });
  assert.deepEqual(first.last.result.review_queue_ids, ['entry:1']);
  const second = await run(argvOf('addToWorkoutLog'), {
    log: first.last.result.log, operation: 'correct', observed_at: '2026-01-01T09:05:00Z', target_atom_id: 'entry:1', id: 'entry:1b',
    dimensions: { throws: { value: 40, unit: 'throws' } }, note: 'typo',
  });
  assert.deepEqual(second.last.result.review_queue_ids, []);
  const read = await run(argvOf('readMyWorkoutLog'), { log: second.last.result.log });
  assert.deepEqual(read.last.result.canonicalEvidenceAtoms.map(item => item.id), ['entry:1b']);
  assert.equal(read.last.result.progressSeries.summary.total, 40);
});

test('the next session loop runs through the rows: inputs, then adapt with the adjustments an evaluator returned', async () => {
  const feed = {
    sessions: [{ id: 's1', weekBlockId: 'w1', title: 'Cascade', activity: 'technical', dose: { throws: 60 }, intensity: { heightCm: 100 } }],
    progressionRules: [{ id: 'r:up', condition: { metricRef: 'catch-rate', min: 0.85 }, adjustment: { doseScale: 1.1, note: 'More.' } }],
    lastResult: { sessionId: 's1', signals: [{ metricRef: 'catch-rate', value: 0.9 }] },
  };
  const inputs = (await run(argvOf('readProgressionInputs'), { feed })).last.result;
  assert.deepEqual(inputs.rules[0].band, { min: 0.85 });
  const adapted = (await run(argvOf('adaptNextSession'), { prescription: inputs.prescription, adjustments: [inputs.rules[0].adjustment] })).last.result;
  assert.equal(adapted.next.dose.throws, 66);
  assert.equal(adapted.applied, 1);
  const byPlan = (await run(argvOf('adaptNextSession'), { plan: feed, session_id: 's1', adjustments: [] })).last.result;
  assert.deepEqual(byPlan.next, byPlan.from);
});
