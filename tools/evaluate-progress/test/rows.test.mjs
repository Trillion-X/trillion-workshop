// tools/evaluate-progress: every row's sample run exactly as the container runs it (node do-work/run-request.mjs <function>, the request on standard input),
// and the refusals a person's AI gets for a request the tool cannot run.
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

test('the eight rows run their own sample and the output holds the words the row says it will', async () => {
  assert.equal(rows.length, 8);
  for (const row of rows) {
    for (const check of row.verify) {
      const { code, last } = await run(row.invoke.argv, check.input);
      assert.equal(code, 0, `${row.id}: ${JSON.stringify(last)}`);
      assert.ok(String(select(select(last, row.result_selector), check.output_selector)).includes(check.contains), row.id);
    }
  }
});

test('every row names its folder, is offline, and keeps its own words generic', () => {
  for (const row of rows) {
    assert.deepEqual([row.invoke.files.package_files.package, row.invoke.internet, row.maker], ['evaluate-progress', false, 'maker:evaluate-progress']);
    assert.ok(Array.isArray(row.input_schema.required) && row.job.length > 20, row.id);
  }
});

test('a request that is not JSON, an unknown function and a request missing its parts are refused with a sentence', async () => {
  assert.match((await run(argvOf('workOutMeasures'), 'not json')).last.error, /JSON/);
  assert.match((await run(argvOf('nothingLikeThis'), {})).last.error, /Unknown request/);
  assert.match((await run(argvOf('workOutMeasures'), { facts: [] })).last.error, /exactly one of measures/);
  assert.match((await run(argvOf('workOutMeasures'), { facts: [], measures: [{ id: 'a', op: 'count' }], measure_id: 'b' })).last.error, /not one of the definitions/);
  assert.match((await run(argvOf('pickFiredRules'), { signals: [], rules: [{ id: 'x' }] })).last.error, /every rule needs/);
  assert.match((await run(argvOf('checkCorroboration'), { checks: [], need: 1.5 })).last.error, /whole number/);
  assert.match((await run(argvOf('holdBackOnRisk'), { assessment: { evaluated: true, risk: 0 } })).last.error, /threshold must be a number/);
  assert.match((await run(argvOf('scoreResponses'), { instrument: { id: 'q', validated: false, responseFactKind: 'quiz.answer', responseScale: { min: 1, max: 5 }, subscales: [] }, responses: [] })).last.error, /not validated/);
  assert.match((await run(argvOf('stitchFacts'), { facts: [], config: { keyPaths: 'member' } })).last.error, /keyPaths/);
});

test('measures: one definition picked by id, a params override, and a pipeline all answer through the row', async () => {
  const facts = [{ id: 'a', kind: 'order', qty: 3 }, { id: 'b', kind: 'order', qty: 9 }];
  const measures = [{ id: 'biggest', op: 'quantile', inputs: [{ field: ['qty'] }], params: { q: 1 } }, { id: 'n', op: 'count', inputs: [{}] }];
  assert.deepEqual((await run(argvOf('workOutMeasures'), { facts, measures, measure_id: 'biggest' })).last.result.measures.map(item => item.value), [9]);
  assert.deepEqual((await run(argvOf('workOutMeasures'), { facts, measures, measure_id: 'biggest', params_override: { q: 0 } })).last.result.measures.map(item => item.value), [3]);
  const pipeline = { stages: [{ id: 'n', def: { id: 'n', op: 'count', inputs: [{}] } }] };
  assert.equal((await run(argvOf('workOutMeasures'), { facts, pipeline })).last.result.result.value, 2);
  assert.equal((await run(argvOf('workOutMeasures'), { facts, measure: { id: 'x', op: 'magic' } })).last.result.measures[0].ok, false);
});

test('a pipeline with measure_id or params_override, a string stageRules and a questionnaire without a fact kind are refused in words', async () => {
  const pipeline = { stages: [{ id: 'n', def: { id: 'n', op: 'count', inputs: [{}] } }] };
  assert.match((await run(argvOf('workOutMeasures'), { facts: [], pipeline, measure_id: 'n' })).last.error, /only with measures/);
  assert.match((await run(argvOf('workOutMeasures'), { facts: [], pipeline, params_override: { q: 1 } })).last.error, /only with measures/);
  const config = { keyPaths: [['member']], sourcePath: ['source'], timePath: ['at'], confidence: { identified: 'known', anonymous: 'unknown' } };
  for (const bad of [{ stageRules: 'bought' }, { stageRules: [{ stage: 'x' }] }, { strongKeyPaths: 'member' }, { valuePath: 'spend' }, { baseStage: 'none' }]) {
    const { last } = await run(argvOf('stitchFacts'), { facts: [], config: { ...config, ...bad } });
    assert.match(last.error, /config\.(stageRules|strongKeyPaths|valuePath|baseStage) must be/, JSON.stringify(bad));
  }
  const instrument = { id: 'q', validated: true, responseScale: { min: 1, max: 5 }, subscales: [] };
  assert.match((await run(argvOf('scoreResponses'), { instrument, responses: [] })).last.error, /responseFactKind/);
  assert.match((await run(argvOf('decideNudge'), { context: { rate_limit_ok: true }, risk_threshold: 1, allowed_tones: 'warm' })).last.error, /list of the tones/);
  const nudge = (tone, allowed_tones) => run(argvOf('decideNudge'), { context: { risk: 1, rate_limit_ok: true }, risk_threshold: 0.5, tone, allowed_tones });
  assert.equal((await nudge('warm', ['warm'])).last.result.nudge, true);
  assert.equal((await nudge('sharp', ['warm'])).last.result.nudge, false);
});
