import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appJob, runAppJob } from '../app-job.mjs';
import { nativeResultOutbox } from '../native-result-outbox.mjs';
import { settingsOf, toolFor } from '../mac-tools.mjs';

const identity = `1f:${'a'.repeat(64)}`;

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'app-job-test-'));
  const appPath = join(home, 'Editor.app');
  mkdirSync(appPath);
  const apps = { apps: [{ id: 'editor', label: 'Editor' }] };
  const sources = { sources: [{ id: 'editor', label: 'Editor', look: { paths: [appPath] } }] };
  const calls = [];
  const client = { file: async () => ({ identity }), readUrl: async () => 'https://files.test/input' };
  const common = {
    apps, sources, home, client,
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
    useApp: async request => { calls.push(request); return { app: 'editor', label: 'Editor', operation: request.operation, ok: true, answer: {}, said: `Editor did ${request.operation}.` }; },
    fileSource: async path => ({ path, size: readFileSync(path).length, close: async () => {} }),
    sendFile: async ({ source, name }) => ({ identity: `1f:${String(source.path.length).padStart(64, '0').slice(0, 64)}`, name }),
    loadChunking: async () => ({}),
  };
  return { home, appPath, calls, client, common };
}

test('checks installed app eligibility before contacting its server', async () => {
  const { common, calls } = setup();
  common.installedHere = () => false;
  const result = await runAppJob({ app: 'editor', operation: 'inspect' }, {}, common);
  assert.equal(result.ok, false);
  assert.match(result.said, /not installed/);
  assert.equal(calls.length, 0);
});

test('checks the chosen open project before any editing step', async () => {
  const { common, calls } = setup();
  common.useApp = async request => {
    calls.push(request);
    return { app: 'editor', label: 'Editor', operation: request.operation, ok: true, answer: { name: 'Other project' }, said: 'Editor read the open project.' };
  };
  const result = await runAppJob({ app: 'editor', steps: [
    { operation: 'project_manager', arguments: { action: 'get_current' }, expect: { path: 'answer.name', is: 'Chosen project' } },
    { operation: 'render', arguments: { action: 'start' } },
  ] }, {}, common);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.match(result.said, /did not match the requested answer.name/);
});

test('downloads declared inputs, resolves file placeholders across steps, and uploads requested outputs', async () => {
  const { common, calls } = setup();
  let downloadedBytes;
  common.useApp = async request => {
    calls.push(request);
    if (request.operation === 'import') downloadedBytes = readFileSync(request.args.path).toString('hex');
    if (request.operation === 'render') writeFileSync(request.args.destination, 'rendered video');
    return { app: 'editor', label: 'Editor', operation: request.operation, ok: true, answer: { success: true }, said: `Editor did ${request.operation}.` };
  };
  const result = await runAppJob({
    app: 'editor',
    files: { inputs: [{ key: 'source', identity, name: 'source.mp4', access: 'copy' }], outputs: [{ key: 'render', name: 'render.mp4', media_type: 'video/mp4' }] },
    steps: [
      { operation: 'import', arguments: { path: { input_file: 'source' } } },
      { operation: 'render', arguments: { directory: { output_dir: 'render' }, destination: { output_file: 'render' } } },
    ],
  }, {}, common);
  assert.equal(calls.length, 2);
  assert.equal(downloadedBytes, '010203');
  assert.equal(calls[1].args.directory, dirname(calls[1].args.destination));
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map(step => step.operation), ['import', 'render']);
  assert.deepEqual(result.inputs, [{ key: 'source', identity, name: 'source.mp4', access: 'copy' }]);
  assert.equal(result.files[0].identity.startsWith('1f:'), true);
  assert.equal(result.files[0].name, 'render.mp4');
  assert.equal(result.files[0].bytes, Buffer.byteLength('rendered video'));
});

test('fails fast when the app reports an unsuccessful answer and does not upload outputs', async () => {
  const { common, calls } = setup();
  common.useApp = async request => { calls.push(request); return { app: 'editor', label: 'Editor', operation: request.operation, ok: true, answer: { success: false }, said: 'Editor could not finish.' }; };
  common.sendFile = async () => assert.fail('must not upload');
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'first' }, { operation: 'second' }], files: { outputs: [{ key: 'result', name: 'result.mov' }] } }, {}, common);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(result.steps.length, 1);
  assert.equal((await appJob.run({ app: 'editor', operation: 'first' }, {}, common)).error, 'Editor could not finish.');
});

test('reports a missing requested output instead of claiming the job succeeded', async () => {
  const { common } = setup();
  const result = await runAppJob({ app: 'editor', operation: 'render', files: { outputs: [{ key: 'render', name: 'render.mp4' }] } }, {}, common);
  assert.equal(result.ok, false);
  assert.match(result.said, /did not create the requested file/);
});

test('waits for an asynchronous app render and its output before saving the file', async () => {
  const { common, calls } = setup();
  let checks = 0;
  let targetDir;
  common.useApp = async request => {
    calls.push(request);
    if (request.operation === 'save') {
      writeFileSync(request.args.path, 'project checkpoint');
      return { app: 'editor', label: 'Editor', operation: 'save', ok: true, answer: { success: true }, said: 'Editor saved the project.' };
    }
    if (request.operation === 'render' && request.args.action === 'safe_quick_export') {
      targetDir = request.args.params.target_dir;
      return { app: 'editor', label: 'Editor', operation: 'render', ok: true, answer: { success: false, status: { JobStatus: 'Rendering' }, params: { TargetDir: targetDir } }, said: 'Editor started rendering.' };
    }
    checks += 1;
    if (checks === 2) writeFileSync(join(targetDir, 'movie.mov'), 'completed render');
    return { app: 'editor', label: 'Editor', operation: 'render', ok: true, answer: { rendering: checks < 2 }, said: 'Editor checked rendering.' };
  };
  const result = await runAppJob({
    app: 'editor',
    files: { outputs: [{ key: 'movie', name: 'movie.mov' }, { key: 'checkpoint', name: 'checkpoint.drp' }] },
    steps: [{
      operation: 'render',
      arguments: { action: 'safe_quick_export', params: { target_dir: { output_dir: 'movie' } } },
      wait_for: {
        when: { path: 'answer.status.JobStatus', is: 'Rendering' },
        poll: { operation: 'render', arguments: { action: 'is_rendering' }, until: { path: 'answer.rendering', is: false } },
        output_keys: ['movie'],
        timeout_seconds: 5,
      },
    }, { operation: 'save', arguments: { path: { output_file: 'checkpoint' } } }],
  }, {}, common);
  assert.deepEqual(calls.map(call => call.args.action ?? call.operation), ['safe_quick_export', 'is_rendering', 'is_rendering', 'save']);
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].answer.success, true);
  assert.equal(result.files[0].name, 'movie.mov');
  assert.equal(result.files[1].name, 'checkpoint.drp');
  assert.equal(result.steps[0].answer.initial.params.TargetDir, '[private job folder]/outputs/movie');
});

test('does not save an asynchronous render when its completion read fails', async () => {
  const { common, calls } = setup();
  common.useApp = async request => {
    calls.push(request);
    return request.args.action === 'start'
      ? { app: 'editor', label: 'Editor', operation: 'render', ok: true, answer: { state: 'working' }, said: 'Started.' }
      : { app: 'editor', label: 'Editor', operation: 'render', ok: false, answer: { error: 'Render failed.' }, said: 'Render failed.' };
  };
  common.sendFile = async () => assert.fail('must not save an unfinished render');
  const result = await runAppJob({
    app: 'editor', files: { outputs: [{ key: 'movie', name: 'movie.mov' }] },
    steps: [{ operation: 'render', arguments: { action: 'start' }, wait_for: {
      when: { path: 'answer.state', is: 'working' },
      poll: { operation: 'render', arguments: { action: 'status' }, until: { path: 'answer.state', is: 'complete' } },
      timeout_seconds: 5,
    } }],
  }, {}, common);
  assert.equal(result.ok, false);
  assert.match(result.said, /Render failed/);
  assert.equal(calls.length, 2);
});

test('does not turn a refused app operation into a pending success', async () => {
  const { common, calls } = setup();
  common.useApp = async request => {
    calls.push(request);
    return { app: 'editor', label: 'Editor', operation: 'render', ok: false, answer: { status: { JobStatus: 'Rendering' } }, said: 'Editor refused the render.' };
  };
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'render', wait_for: {
    when: { path: 'answer.status.JobStatus', is: 'Rendering' },
    poll: { operation: 'render', arguments: { action: 'is_rendering' }, until: { path: 'answer.rendering', is: false } },
  } }] }, {}, common);
  assert.equal(result.ok, false);
  assert.equal(result.said, 'Editor refused the render.');
  assert.equal(calls.length, 1);
});

// The rows of tool:run-an-app-job and tool:use-an-app-on-this-computer were in media-composition's records.json when
// this test was written in Trillion-X/trillion; the Workshop's records.json holds neither, so only this Mac's own row is
// checked here.
test('routes the separate job tool to this Mac', async () => {
  const settings = settingsOf();
  assert.deepEqual(settings.tools['tool:run-an-app-job'], { module: './app-job.mjs', export: 'appJob', name: 'run' });
  assert.equal(typeof await toolFor(settings, 'tool:run-an-app-job'), 'function');
});

test('a step can use a value an earlier step answered, and naming one that is not there stops the job before the app is asked', async () => {
  const { common, calls } = setup();
  common.useApp = async request => {
    calls.push(request);
    const answer = request.operation === 'import' ? { clips: [{ id: 'clip-7', name: 'take.mov' }] } : { success: true };
    return { app: 'editor', label: 'Editor', operation: request.operation, ok: true, answer, said: `Editor did ${request.operation}.` };
  };
  const result = await runAppJob({ app: 'editor', steps: [
    { operation: 'import', arguments: { paths: ['/x'] } },
    { operation: 'cut', arguments: { clips: [{ clip_id: { from_step: 0, path: 'answer.clips.0.id' }, start_frame: 0, end_frame: 48 }] } },
  ] }, {}, common);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1].args, { clips: [{ clip_id: 'clip-7', start_frame: 0, end_frame: 48 }] });

  calls.length = 0;
  const missing = await runAppJob({ app: 'editor', steps: [
    { operation: 'import', arguments: {} },
    { operation: 'cut', arguments: { clip_id: { from_step: 0, path: 'answer.clips.3.id' } } },
  ] }, {}, common);
  assert.equal(missing.ok, false);
  assert.equal(calls.length, 1, 'the cut was never sent to the app');
  assert.match(missing.said, /answered nothing at answer\.clips\.3\.id/);
  const later = await runAppJob({ app: 'editor', steps: [{ operation: 'cut', arguments: { clip_id: { from_step: 0, path: 'answer' } } }] }, {}, common);
  assert.match(later.said, /does not name an earlier step/);
});

test('a job for an app that must be open, while it is closed, opens it quietly first and then fetches and runs', async () => {
  const { common, calls } = setup();
  common.apps = { apps: [{ id: 'editor', label: 'Editor', needs_open: { processes: ['/MacOS/Editor'] }, opens: { app: 'The Editor' } }] };
  let fetched = 0;
  common.fetchImpl = async () => { fetched += 1; return new Response(new Uint8Array([1])); };
  let ps = ['/usr/sbin/cfprefsd'];
  const launched = [];
  common.running = () => ps;
  common.openDeps = { open: async app => { launched.push(app); ps = ['/Applications/Editor.app/Contents/MacOS/Editor']; return { code: 0, out: '' }; }, sleep: async () => {} };
  const job = { app: 'editor', files: { inputs: [{ key: 'clip', identity, name: 'clip.mov', access: 'copy' }] }, steps: [{ operation: 'import', arguments: { path: { input_file: 'clip' } } }] };
  const first = await runAppJob(job, {}, common);
  assert.deepEqual(launched, ['The Editor']);
  assert.equal(first.ok, true);
  assert.equal(first.needs_open, undefined);
  assert.equal(fetched, 1);
  assert.equal(calls.length, 1);
  const again = await runAppJob(job, {}, common);
  assert.equal(again.ok, true);
  assert.deepEqual(launched, ['The Editor'], 'already open: not launched again');
});

test('a job for an app that never starts answers plainly, fetches nothing and never contacts the app', async () => {
  const { common, calls } = setup();
  common.apps = { apps: [{ id: 'editor', label: 'Editor', needs_open: { processes: ['/MacOS/Editor'] } }] };
  let fetched = 0;
  common.fetchImpl = async () => { fetched += 1; return new Response(new Uint8Array([1])); };
  common.running = () => ['/usr/sbin/cfprefsd'];
  let at = 0;
  common.openDeps = { open: async () => ({ code: 0, out: '' }), sleep: async ms => { at += ms; }, now: () => at, seconds: 90 };
  const failed = await runAppJob({ app: 'editor', files: { inputs: [{ key: 'clip', identity, name: 'clip.mov', access: 'copy' }] }, steps: [{ operation: 'import', arguments: { path: { input_file: 'clip' } } }] }, {}, common);
  assert.deepEqual(failed, { app: 'editor', label: 'Editor', ok: false, said: 'Editor did not start within 90 s.' });
  assert.equal(fetched, 0);
  assert.equal(calls.length, 0);
});


test('a real app job shares one editor session across import and edit', async () => {
  const { common } = setup();
  delete common.useApp;
  let sessions = 0, closed = 0;
  const imported = new Set();
  common.withAppSession = async (options, work) => {
    sessions += 1;
    assert.equal(options.app, 'editor');
    try { return await work({ async use({ operation, args }) {
      if (operation === 'import') imported.add('clip-7');
      if (operation === 'cut') assert.ok(imported.has(args.clip), 'the clip still belongs to the active editor process');
      return { app: 'editor', label: 'Editor', operation, ok: true, answer: { clip: 'clip-7' }, said: 'Editor finished.' };
    } }); } finally { closed += 1; }
  };
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'import' }, { operation: 'cut', arguments: { clip: { from_step: 0, path: 'answer.clip' } } }] }, {}, common);
  assert.equal(result.ok, true);
  assert.deepEqual({ sessions, closed }, { sessions: 1, closed: 1 });
  assert.equal(result.steps.length, 2);
});

test('app job keeps fixed step evidence with one shared fence for all operations', async () => {
  const { common, calls } = setup();
  const events = [];
  const context = {
    recordProgress: async value => events.push({ progress: value }),
    recordEffect: async value => { events.push({ effect: value }); return { proceed: true }; },
  };
  common.useApp = async request => { calls.push(request); events.push({ dispatch: request.operation }); return { ok: true, answer: {} }; };
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'import', arguments: { token: 'private-input' } }, { operation: 'edit' }] }, context, common);
  assert.equal(result.ok, true);
  assert.deepEqual(events.map(event => event.progress?.stage ?? event.effect?.state ?? event.dispatch), [
    'app-step-starting', 'starting', 'import', 'app-step-returned',
    'app-step-starting', 'edit', 'app-step-returned', 'done',
  ]);
  assert.deepEqual(events.filter(event => event.effect?.state === 'done').map(event => event.effect.receipt), [
    { returned_steps: 2, ok: true },
  ]);
  assert.deepEqual(events.filter(event => event.effect?.state === 'starting').map(event => event.effect.effect_id), ['app-job-operations']);
  assert.equal(JSON.stringify(events.filter(event => !event.dispatch)).includes('private-input'), false);
});

for (const refusal of [{ proceed: true, repeated: true }, { proceed: false, effect: { state: 'unknown' } }, { proceed: false, effect: { state: 'done' } }]) {
  test('app job refuses an already attempted step without sending an operation: ' + JSON.stringify(refusal), async () => {
    const { common, calls } = setup();
    const progress = [];
    const result = await runAppJob({ app: 'editor', operation: 'edit' }, {
      recordEffect: async () => refusal, recordProgress: value => progress.push(value),
    }, common);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(calls.length, 0);
    assert.equal(progress.at(-1).stage, 'app-step-uncertain');
  });
}

test('lost app reply preserves the earlier confirmed step and never settles the unanswered edit', async () => {
  const { common, calls } = setup();
  const progress = [], effects = [];
  common.useApp = async request => {
    calls.push(request);
    if (request.operation === 'edit') throw new Error('lost reply with private-input');
    return { ok: true, answer: { private: 'private-app-response' } };
  };
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'import' }, { operation: 'edit' }, { operation: 'save' }] }, {
    recordProgress: value => progress.push(value),
    recordEffect: async value => { effects.push(value); return { proceed: true }; },
  }, common);
  assert.equal(result.uncertain, true);
  assert.deepEqual(calls.map(call => call.operation), ['import', 'edit']);
  assert.ok(progress.some(value => value.stage === 'app-step-returned' && value.step === 0 && value.returned_steps === 1));
  assert.equal(progress.at(-1).stage, 'app-step-uncertain');
  assert.equal(progress.at(-1).step, 1);
  assert.equal(effects.filter(value => value.state === 'done').length, 0);
  assert.equal(effects.at(-1).state, 'starting');
  assert.equal(JSON.stringify([...progress, ...effects]).includes('private-app-response'), false);
  assert.equal(result.said.includes('private-input'), false);
});

test('lost admission reply does not dispatch an app operation', async () => {
  const { common, calls } = setup();
  const result = await runAppJob({ app: 'editor', operation: 'edit' }, {
    recordEffect: async () => { throw new Error('admission reply lost'); },
  }, common);
  assert.equal(result.uncertain, true);
  assert.equal(calls.length, 0);
});

test('listing app operations needs no mutation fence', async () => {
  const { common, calls } = setup();
  const result = await runAppJob({ app: 'editor' }, {
    recordEffect: async () => assert.fail('discovery is not an editing session'),
  }, common);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, null);
});

test('a confirmed failed operation settles the session without dispatching later operations', async () => {
  const { common, calls } = setup();
  const effects = [];
  common.useApp = async request => { calls.push(request); return { ok: false, answer: { success: false } }; };
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'edit' }, { operation: 'save' }] }, {
    recordEffect: async value => { effects.push(value); return { proceed: true }; },
  }, common);
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(effects.map(value => value.state), ['starting', 'done']);
  assert.deepEqual(effects.at(-1).receipt, { returned_steps: 1, ok: false });
});

test('a saved output identity is reported before a later upload fails and the private folder is retired', async () => {
  const { common } = setup();
  const progress = [];
  let outputPath, saves = 0;
  common.useApp = async request => {
    outputPath = request.args.first;
    writeFileSync(request.args.first, 'first-output');
    writeFileSync(request.args.second, 'second-output');
    return { ok: true, answer: {} };
  };
  common.sendFile = async () => { if (++saves === 2) throw new Error('second save reply lost'); return { identity }; };
  await assert.rejects(runAppJob({ app: 'editor', operation: 'export', arguments: {
    first: { output_file: 'first' }, second: { output_file: 'second' },
  }, files: { outputs: [{ key: 'first' }, { key: 'second' }] } }, {
    recordProgress: value => progress.push(value),
  }, common), /second save reply lost/);
  assert.deepEqual(progress.at(-1), { total_steps: 1, returned_steps: 1, stage: 'app-output-saved', saved_outputs: 1, file: { identity, bytes: 12 } });
  assert.equal(existsSync(outputPath), false);
  assert.equal(JSON.stringify(progress).includes(outputPath), false);
});

test('lost asynchronous completion reply stays uncertain and never saves or settles a render', async () => {
  const { common, calls } = setup();
  const effects = [];
  common.useApp = async request => {
    calls.push(request);
    if (request.args.action === 'status') throw new Error('completion reply lost');
    return { ok: true, answer: { state: 'working' } };
  };
  common.sendFile = async () => assert.fail('no completed output was confirmed');
  const result = await runAppJob({ app: 'editor', steps: [{ operation: 'render', arguments: { action: 'start' }, wait_for: {
    when: { path: 'answer.state', is: 'working' },
    poll: { operation: 'render', arguments: { action: 'status' }, until: { path: 'answer.state', is: 'complete' } },
    timeout_seconds: 1,
  } }] }, { recordEffect: async value => { effects.push(value); return { proceed: true }; } }, common);
  assert.equal(result.uncertain, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(effects.map(value => value.state), ['starting']);
});


test('native app outputs are retained and checkpointed before any upload; outbox delivery does not repeat editing', async t => {
  const { common, calls, home } = setup();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const outbox = nativeResultOutbox({ file: join(home, 'native-results'), accountId: 'synthetic-account', origin: 'https://example.test' });
  const handoffId = 'h_retained';
  outbox.put({ handoff_id: handoffId, generation: 1, execution: { state: 'started' }, finish: { handoff_id: handoffId, agent_id: 'computer', generation: 1 } });
  const progress = [];
  const context = { handoff_id: handoffId, generation: 1, recordProgress: value => progress.push(value),
    outputDelivery: { createWorkspace: () => outbox.createOutputWorkspace(handoffId, 1), stage: value => outbox.stageOutputs(handoffId, 1, value) } };
  let outputPath;
  common.useApp = async request => { calls.push(request); outputPath = request.args.path; writeFileSync(outputPath, 'original completed edit'); return { ok: true, answer: {} }; };
  common.sendFile = async () => assert.fail('app operations never upload managed outputs');
  const result = await runAppJob({ app: 'editor', operation: 'export', arguments: { path: { output_file: 'video' }, private_argument: 'never-persist-this-argument' },
    files: { outputs: [{ key: 'video', name: 'saved.mp4', media_type: 'video/mp4' }] } }, context, common);
  assert.deepEqual(result, { output_delivery_pending: true });
  assert.equal(calls.length, 1);
  assert.equal(existsSync(outputPath), true);
  assert.equal(outbox.get(handoffId).execution.state, 'outputs');
  assert.equal(JSON.stringify(outbox.list()).includes('never-persist-this-argument'), false);
  assert.equal(JSON.stringify(outbox.list()).includes(outputPath), false, 'only a bounded owner workspace name is persisted');
  const final = await outbox.deliverOutputs(handoffId, async ({ source, output }) => {
    assert.equal(new TextDecoder().decode(await source.readAt(0, source.size)), 'original completed edit');
    return { identity: output.identity, bytes: source.size };
  });
  assert.equal(final.finish.result.files[0].name, 'saved.mp4');
  assert.equal(calls.length, 1, 'saving files repeats no app operation');
  outbox.put({ ...final, delivery_ack: { generation: final.generation } });
  outbox.delete(handoffId);
  assert.equal(existsSync(outputPath), false);
});

test('an authenticated native output job without its outbox refuses before opening or editing an app', async () => {
  const { common, calls } = setup();
  common.openApp = async () => assert.fail('no app launch without durable output ownership');
  await assert.rejects(runAppJob({ app: 'editor', operation: 'export', files: { outputs: [{ key: 'video' }] } }, { handoff_id: 'h_unowned' }, common), /authenticated native result outbox/);
  assert.equal(calls.length, 0);
});

test('uncertain native editing retains its private artifact but cannot enter output-only delivery', async t => {
  const { common, home } = setup();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const outbox = nativeResultOutbox({ file: join(home, 'results'), accountId: 'synthetic-account', origin: 'https://example.test' });
  const handoffId = 'h_uncertain_output';
  outbox.put({ handoff_id: handoffId, generation: 1, execution: { state: 'started' }, finish: { handoff_id: handoffId, agent_id: 'computer', generation: 1 } });
  let outputPath, staged = false;
  common.useApp = async request => { outputPath = request.args.path; writeFileSync(outputPath, 'uncertain produced artifact'); throw new Error('reply lost'); };
  const result = await runAppJob({ app: 'editor', operation: 'export', arguments: { path: { output_file: 'video' } }, files: { outputs: [{ key: 'video' }] } }, {
    handoff_id: handoffId, outputDelivery: { createWorkspace: () => outbox.createOutputWorkspace(handoffId, 1), stage: () => { staged = true; } },
  }, common);
  assert.equal(result.uncertain, true);
  assert.equal(staged, false);
  assert.equal(existsSync(outputPath), true);
  assert.equal(outbox.get(handoffId).execution.state, 'started');
  await assert.rejects(outbox.deliverOutputs(handoffId, async () => assert.fail('never claim an uncertain artifact')), /authenticated private workspace/);
});


test('a confirmed later app failure keeps the already-produced project and reports failure after output saving', async t => {
  const { common, calls, home } = setup();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const outbox = nativeResultOutbox({ file: join(home, 'results'), accountId: 'synthetic-account', origin: 'https://example.test' });
  const handoffId = 'h_partial_failed';
  outbox.put({ handoff_id: handoffId, generation: 1, execution: { state: 'started' }, finish: { handoff_id: handoffId, agent_id: 'computer', generation: 1 } });
  common.useApp = async request => {
    calls.push(request);
    if (request.operation === 'save') { writeFileSync(request.args.path, 'valuable saved project'); return { ok: true, answer: {} }; }
    return { ok: false, said: 'The video render failed.', answer: { success: false } };
  };
  const result = await runAppJob({ app: 'editor', steps: [
    { operation: 'save', arguments: { path: { output_file: 'project' } } }, { operation: 'render', arguments: { path: { output_file: 'video' } } },
  ], files: { outputs: [{ key: 'project', name: 'kept.fcproj' }, { key: 'video', name: 'missing.mp4' }] } }, {
    handoff_id: handoffId, outputDelivery: { createWorkspace: () => outbox.createOutputWorkspace(handoffId, 1), stage: value => outbox.stageOutputs(handoffId, 1, value) },
  }, common);
  assert.deepEqual(result, { output_delivery_pending: true });
  assert.equal(outbox.get(handoffId).output_delivery.files.length, 1);
  const delivered = await outbox.deliverOutputs(handoffId, async ({ source, output }) => ({ identity: output.identity, bytes: source.size }));
  assert.equal(delivered.finish.result.ok, false);
  assert.equal(delivered.finish.result.error, 'The video render failed.');
  assert.deepEqual(delivered.finish.result.files.map(file => file.name), ['kept.fcproj']);
  assert.equal(calls.length, 2);
});

test('a confirmed failed app with no produced output needs no upload and preserves the real error', async t => {
  const { common, home } = setup();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const outbox = nativeResultOutbox({ file: join(home, 'results'), accountId: 'synthetic-account', origin: 'https://example.test' });
  const handoffId = 'h_empty_failed';
  outbox.put({ handoff_id: handoffId, generation: 1, execution: { state: 'started' }, finish: { handoff_id: handoffId, agent_id: 'computer', generation: 1 } });
  common.useApp = async () => ({ ok: false, said: 'The app refused.', answer: {} });
  await runAppJob({ app: 'editor', operation: 'render', files: { outputs: [{ key: 'video' }] } }, { handoff_id: handoffId,
    outputDelivery: { createWorkspace: () => outbox.createOutputWorkspace(handoffId, 1), stage: value => outbox.stageOutputs(handoffId, 1, value) },
  }, common);
  const row = outbox.get(handoffId);
  assert.equal(row.execution.state, 'returned');
  assert.equal(row.output_delivery.state, 'saved');
  assert.deepEqual(row.output_delivery.files, []);
  assert.equal(row.finish.result.error, 'The app refused.');
});
