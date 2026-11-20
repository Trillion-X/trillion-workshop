import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePresentationPlan } from '../do-work/compile-presentation-plan.mjs';
import { evaluatePresentationReadiness } from '../do-work/evaluate-presentation-readiness.mjs';

const owner = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(owner, '../..');
const rows = JSON.parse(readFileSync(join(owner, 'tool-rows.json'))).records.map(row => row.payload);
const material = { id: 'source:sample', title: 'Observed example', revision: 2,
  claims: [{ id: 'claim:one', text: 'The sample was observed.', evidence_refs: ['span:one'] }],
  fields: { spoken: 'The sample was observed.' }, source_refs: ['source:one'] };
const format = { id: 'format:sample', title: 'A short video', revision: 3, medium: 'video',
  beats: [{ id: 'opening', delivery: 'speak', template: '{spoken}', claim_refs: ['claim:one'] }],
  requirements: [{ id: 'camera', methods: ['sensor'], instruction: 'Check the camera.', max_age_seconds: 5 }],
  execution: { adapter: 'capture.video', countdown_seconds: 3 } };
const compile = () => compilePresentationPlan(material, format.id, { formats: [format] });
const now = 1_000_000;
const observation = { value: true, method: 'sensor', observed_at_ms: now };

function runRow(row, input, root = repository) {
  const argv = row.invoke.argv.slice(1).map(arg => arg.startsWith('/opt/') ? join(root, arg.slice(5)) : arg);
  const cwd = row.invoke.workdir.startsWith('/opt/') ? join(root, row.invoke.workdir.slice(5)) : root;
  return spawnSync(process.execPath, argv, { cwd, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
}

function packaged(row, run) {
  const root = tempFolder(join(tmpdir(), 'content-rows-'));
  try {
    for (const spec of row.invoke.files.package_files) {
      const from = spec.package ? join(repository, 'tools', spec.package) : join(repository, 'node_modules', spec.module);
      const destination = join(root, spec.at.slice(5));
      for (const path of spec.paths) {
        mkdirSync(dirname(join(destination, path)), { recursive: true });
        cpSync(join(from, path), join(destination, path), { recursive: true });
      }
    }
    return run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('each row runs its actual packed command and returns the declared result', () => {
  for (const row of rows) packaged(row, root => {
    const result = runRow(row, row.verify[0].input, root);
    assert.equal(result.status, 0, result.stderr);
    const answer = JSON.parse(result.stdout).result;
    for (const field of row.output_schema.required) assert.ok(Object.hasOwn(answer, field), `${row.id}: ${field}`);
    assert.equal(row.result_selector, '$.result');
  });
});

test('compiled plan and readiness reach the existing teleprompter consumer without granting capture', () => {
  const plan = compile();
  assert.match(plan.id, /^PLAN-1f:[0-9a-f]{64}$/);
  const observations = { [plan.requirements[0].key]: observation };
  const ready = evaluatePresentationReadiness(plan, ['capture.video'], observations, now);
  const consumer = JSON.parse(readFileSync(join(repository, 'tools/record-video-with-teleprompter/tool-rows.json'))).records[0].payload;
  packaged(consumer, root => {
    const outcome = runRow(consumer, { plan, readiness: ready, nowMs: now }, root);
    assert.equal(outcome.status, 0, outcome.stderr);
    const session = JSON.parse(outcome.stdout).result;
    assert.equal(session.source_plan.id, plan.id);
    assert.equal(session.auto_start, false);
    assert.deepEqual(session.sentences, [material.fields.spoken]);
    assert.equal(session.authorization_state, 'not_authorized');
  });
});

test('operator evidence accepted by a mixed-method requirement never claims independent sensor proof', () => {
  const plan = compile(); plan.requirements[0].methods = ['operator', 'sensor'];
  const result = evaluatePresentationReadiness(plan, ['capture.video'], {
    [plan.requirements[0].key]: { ...observation, method: 'operator' },
  }, now);
  assert.equal(result.state, 'ready_to_authorize');
  assert.equal(result.physical_setup_independently_verified, false);
});

test('malformed freshness and evidence contracts fail closed', () => {
  for (const invalid of [undefined, null, '5', -1, NaN, Infinity]) {
    const plan = compile(); plan.requirements[0].max_age_seconds = invalid;
    assert.throws(() => evaluatePresentationReadiness(plan, ['capture.video'], {}, now), /max_age_seconds/);
  }
  for (const methods of [undefined, [], [''], ['sensor', 1]]) {
    const plan = compile(); plan.requirements[0].methods = methods;
    assert.throws(() => evaluatePresentationReadiness(plan, ['capture.video'], {}, now), /accepted evidence methods/);
  }
  const plan = compile(); plan.requirements.push(plan.requirements[0]);
  assert.throws(() => evaluatePresentationReadiness(plan, [], {}, now), /duplicate requirement key/);
});

test('timestamps are real numbers, never future, and respect the exact freshness boundary', () => {
  const plan = compile(), key = plan.requirements[0].key;
  for (const invalid of [null, '', String(now)]) {
    const result = evaluatePresentationReadiness(plan, ['capture.video'], { [key]: { ...observation, observed_at_ms: invalid } }, now);
    assert.equal(result.problems[0].kind, 'invalid_observation_time');
  }
  for (const observed_at_ms of [now + 1, now - 5001]) {
    const result = evaluatePresentationReadiness(plan, ['capture.video'], { [key]: { ...observation, observed_at_ms } }, now);
    assert.equal(result.problems[0].kind, 'stale_observation');
  }
  assert.equal(evaluatePresentationReadiness(plan, ['capture.video'], { [key]: { ...observation, observed_at_ms: now - 5000 } }, now).state, 'ready_to_authorize');
});

test('deterministic container selection never executes caller-supplied AI argv', () => {
  const row = rows.find(row => row.id === 'tool:choose-a-content-style');
  packaged(row, root => {
    const outcome = runRow(row, { shape: {}, mode: 'ai', rules: {
      execution: { default_mode: 'ai', timeout_ms: 1000 },
      ai_mode: { argv: [process.execPath, '-e', 'throw Error("must not run")'], prompt_template: '{shape} {definitions}' },
    } }, root);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /local_ai_required/);
    assert.equal(outcome.stdout, '');
  });
});

test('rows require caller DATA and never recover an absent document from old presets', () => {
  const compiler = rows.find(row => row.id === 'tool:compile-a-presentation-plan');
  const classifier = rows.find(row => row.id === 'tool:choose-a-content-style');
  for (const [row, input, message] of [[compiler, { material, format_id: format.id }, /formats must contain/],
    [classifier, { shape: {} }, /rules must be an object/]]) {
    packaged(row, root => {
      const result = runRow(row, input, root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(result.stdout, '');
    });
  }
});

test('the authorized local classifier accepts one complete definition and rejects ambiguous text', () => {
  const root = tempFolder(join(tmpdir(), 'content-local-ai-'));
  try {
    const rules = join(root, 'rules.json');
    const command = join(owner, 'do-work/media-classify.mjs');
    for (const [reply, accepted] of [['action:a-long', true], ['action:a and action:a-long', false]]) {
      writeFileSync(rules, JSON.stringify({ execution: { default_mode: 'ai', timeout_ms: 1000 },
        ai_mode: { argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(reply)})`], prompt_template: '{shape} {definitions}' } }));
      const outcome = spawnSync(process.execPath, [command, '--shape', '{}', '--rules', rules, '--definitions', 'action:a,action:a-long'], { encoding: 'utf8' });
      assert.equal(outcome.status, accepted ? 0 : 1, outcome.stderr);
      if (accepted) assert.equal(JSON.parse(outcome.stdout.trim().split('\n').at(-1)).definition, 'action:a-long');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compilation and readiness are repeatable and leave source objects unchanged', () => {
  const before = JSON.stringify({ material, format });
  const plan = compile(); const planBefore = JSON.stringify(plan);
  const observations = { [plan.requirements[0].key]: observation };
  const first = evaluatePresentationReadiness(plan, ['capture.video'], observations, now);
  assert.deepEqual(evaluatePresentationReadiness(plan, ['capture.video'], observations, now), first);
  assert.equal(compile().id, plan.id);
  assert.equal(JSON.stringify(plan), planBefore);
  assert.equal(JSON.stringify({ material, format }), before);
});
