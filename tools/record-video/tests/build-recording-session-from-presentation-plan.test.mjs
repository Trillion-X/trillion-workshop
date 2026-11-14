import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDirectory = new URL('..', import.meta.url).pathname;
const builder = join(packageDirectory, 'do-work', 'build-recording-session-from-presentation-plan.mjs');
const manifestPath = join(packageDirectory, 'things-to-store-and-run.json');

function presentationPlan() {
  return {
    id: 'PLAN-test-method',
    title: 'A generic explanation',
    material_id: 'material-test',
    material_revision: 3,
    format_id: 'GENERIC-DIRECT',
    format_revision: 4,
    revision: 5,
    medium: 'video',
    acquisitions: [],
    beats: [
      { id: 'opening', delivery: 'speak', text: 'Here is the opening.' },
      { id: 'close', delivery: 'speak', text: 'Here is the close.' },
    ],
    execution: {
      adapter: 'capture.video',
      countdown_seconds: 2,
      auto_stop_seconds: 0,
      silence_stop_seconds: 3,
      silence_threshold_rms: 0.015,
      minimum_speech_ms: 900,
      stop_on_final_word: true,
      completion_grace_ms: 250,
    },
  };
}

function readyResult(plan) {
  return {
    plan_id: plan.id,
    state: 'ready_to_authorize',
    problems: [],
    requirements: [{ id: 'camera_live', satisfied: true }],
  };
}

function run(directory, plan, options = {}) {
  const planPath = join(directory, 'plan.json');
  const outPath = join(directory, 'session.json');
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const argv = [
    process.execPath,
    builder,
    '--plan', planPath,
    '--out', outPath,
    '--now-ms', String(options.nowMs ?? 1_000_000),
  ];
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    const path = join(directory, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    argv.push(`--${name}`, path);
  }
  execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

test('a compiled plan stages without pretending it is authorized', () => {
  const session = run(mkdtempSync(join(tmpdir(), 'record-video-stage-')), presentationPlan());
  assert.equal(session.kind, 'record-video.recording-session');
  assert.equal(session.auto_start, false);
  assert.equal(session.readiness_state, 'awaiting_setup');
  assert.equal(session.authorization_state, 'not_authorized');
  assert.deepEqual(session.sentences, ['Here is the opening.', 'Here is the close.']);
  assert.equal(session.stop_on_final_word, true);
  assert.equal(session.auto_stop_seconds, 0);
  assert.equal(session.silence_stop_seconds, 3);
  assert.equal(session.silence_threshold_rms, 0.015);
  assert.equal(session.minimum_speech_ms, 900);
});

test('fresh readiness plus a matching unexpired grant is required for auto-start', () => {
  const directory = mkdtempSync(join(tmpdir(), 'record-video-authorize-'));
  const plan = presentationPlan();
  const session = run(directory, plan, {
    nowMs: 1_000_000,
    inputs: {
      readiness: readyResult(plan),
      authorization: {
        plan_id: plan.id,
        authorized: true,
        authorized_at_ms: 999_999,
        grant_until_ms: 1_000_100,
      },
    },
  });
  assert.equal(session.auto_start, true);
  assert.equal(session.readiness_state, 'ready_to_authorize');
  assert.equal(session.authorization_state, 'authorized');
});

test('an explicit denied grant and the workflow null fallback both stage without authorization', () => {
  const directory = mkdtempSync(join(tmpdir(), 'record-video-no-grant-'));
  const plan = presentationPlan();
  for (const authorization of [{ authorized: false }, {}]) {
    const session = run(directory, plan, {
      nowMs: 1_000_000,
      inputs: {
        readiness: { state: 'awaiting_setup' },
        authorization,
      },
    });
    assert.equal(session.auto_start, false);
    assert.equal(session.readiness_state, 'awaiting_setup');
    assert.equal(session.authorization_state, 'not_authorized');
  }
});

test('expired authorization cannot authorize a session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'record-video-expired-'));
  const plan = presentationPlan();
  assert.throws(
    () => run(directory, plan, {
      nowMs: 1_000_101,
      inputs: {
        readiness: readyResult(plan),
        authorization: {
          plan_id: plan.id,
          authorized: true,
          authorized_at_ms: 999_999,
          grant_until_ms: 1_000_100,
        },
      },
    }),
    /invalid|authorization/,
  );
});

test('a format that gathers answers cannot be flattened into a teleprompter script', () => {
  const plan = presentationPlan();
  plan.acquisitions = [{ id: 'answer', prompt: 'Ask somebody' }];
  assert.throws(
    () => run(mkdtempSync(join(tmpdir(), 'record-video-acquisition-')), plan),
    /open acquisitions/,
  );
});

test('the workflow DATA is package-owned, leaf-contained, and free of creator-specific seed copy', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestText = JSON.stringify(manifest);
  const action = manifest.things.find(
    (thing) => thing.address === 'package::record-video::workflow-action::stage-recording-session-from-presentation-plan',
  );
  assert.ok(action, 'missing stage action');
  assert.equal(action.payload.steps[1].config.input.containment.kind, 'leaf');
  assert.equal(action.payload.steps[2].config.items[0].address, 'record-video-recording-session');
  const inlineInputs = action.payload.steps[1].config.input.inputs;
  const readinessFallback = inlineInputs.find((input) => input.mount_path === 'readiness.json')
    .source.bytes.transform.find((transform) => transform.op === 'op:core.if_null').args.fallback;
  const authorizationFallback = inlineInputs.find((input) => input.mount_path === 'authorization.json')
    .source.bytes.transform.find((transform) => transform.op === 'op:core.if_null').args.fallback;
  assert.deepEqual(readinessFallback, { state: 'awaiting_setup' });
  assert.deepEqual(authorizationFallback, { authorized: false });
  assert.equal(manifest.things.some((thing) => thing.address === 'record-video-recording-session'), false);
  for (const forbidden of ['Morgan Lake', 'Hollis, Nebraska', 'Harbor Launchpad']) {
    assert.equal(manifestText.includes(forbidden), false, `${forbidden} leaked into reusable package DATA`);
  }
});
