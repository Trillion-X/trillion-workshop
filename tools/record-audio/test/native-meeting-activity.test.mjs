import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { importSource } from 'trillion-workshop/test-helpers/import-source-for-tests.mjs';

const root = new URL('../', import.meta.url).pathname;

async function loadModule(entry) {
  const result = await build({
    stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: root, sourcefile: 'test-entry.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  });
  return importSource(result.outputFiles[0].text);
}

// Both exports must share the same bundled invocation registry, just as the
// real workspace does. Independent bundles would invent two runtime sessions.
const module = await build({ stdin: { contents: `export * from 'trillion-workshop/tools/record-audio/do-work/native-meeting-activity.ts';
  export * from 'trillion-workshop/tools/record-audio/do-work/meeting-application-recording.ts';`, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const activity = await importSource(module.outputFiles[0].text);
const invocationOwner = activity;

function fixture() {
  const commands = [], changes = [], started = [];
  const owner = activity.createNativeMeetingActivityOwner({
    post: command => commands.push(command), onChange: state => changes.push(state),
    onInputStarted: value => started.push(value),
  });
  const ready = (documentId = 'doc-A') => owner.receive({ event: 'ready', document_id: documentId });
  const command = () => commands.at(-1);
  const snapshot = (processes, { reason = 'process-list', status = 'observing', doc = command().document_id,
    session = command().session_id } = {}) => owner.receive({ event: 'snapshot', document_id: doc,
    session_id: session, status, reason, processes });
  return { owner, commands, changes, started, ready, command, snapshot };
}

const process = (overrides = {}) => ({ process_id: 71, bundle_id: 'com.example.meet', name: 'Meet',
  is_running_input: true, episode_id: 'episode-1', ...overrides });

test('native episode identity starts once and a new episode invalidates the previous request', () => {
  const f = fixture(); f.ready(); f.owner.configure(true);
  assert.equal(f.command().command, 'subscribe');
  f.snapshot([process()], { reason: 'input-transition' });
  assert.equal(f.started.length, 1);
  const first = f.started[0];
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(first), true);

  f.snapshot([process()], { reason: 'process-list' });
  assert.equal(f.started.length, 1, 'repeated observation of the same episode is not a new start');
  f.snapshot([process({ episode_id: 'episode-2' })], { reason: 'input-transition' });
  assert.equal(f.started.length, 2, 'a new episode for the same PID and bundle is a distinct start');
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(first), false);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(f.started[1]), true);
});

test('initial snapshots establish a baseline without replaying an already active process', () => {
  const f = fixture(); f.ready(); f.owner.configure(true);
  f.snapshot([process()], { reason: 'snapshot' });
  assert.equal(f.started.length, 0);
  f.snapshot([process()], { reason: 'process-list' });
  assert.equal(f.started.length, 0);
  f.snapshot([], { reason: 'process-list' });
  f.snapshot([process()], { reason: 'process-list' });
  assert.equal(f.started.length, 1, 'a later transition after the baseline can start a recording');
});

test('observer recovery establishes a silent active-input baseline, then accepts a later start', () => {
  const f = fixture(); f.ready(); f.owner.configure(true);
  f.snapshot([process()], { reason: 'input-transition' });
  const beforeRecovery = f.started[0];

  f.snapshot([], { reason: 'unavailable', status: 'unavailable' });
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(beforeRecovery), false);
  f.snapshot([process({ episode_id: 'episode-after-recovery' })], { reason: 'recovered' });
  assert.equal(f.owner.getState().apps[0].active, true, 'the recovered input remains visible as active');
  assert.equal(f.started.length, 1, 'a still-running input is a baseline, not a replayed start');

  f.snapshot([], { reason: 'input-transition' });
  f.snapshot([process({ episode_id: 'episode-after-real-restart' })], { reason: 'input-transition' });
  assert.equal(f.started.length, 2, 'a real stop/start after recovery remains eligible');

  // Tie the protocol regression to the native producer: any refresh that began
  // unavailable must label every coalesced pass as a recovery baseline.
});

test('document and session identities fence snapshots and invocations', () => {
  const f = fixture(); f.ready('doc-A'); f.owner.configure(true);
  const firstCommand = f.command();
  f.snapshot([process()], { reason: 'input-transition', doc: 'doc-other' });
  f.snapshot([process()], { reason: 'input-transition', session: 'stale-session' });
  assert.equal(f.started.length, 0);
  f.snapshot([process()], { reason: 'input-transition' });
  const oldInvocation = f.started[0];
  f.ready('doc-B');
  assert.notEqual(f.command().document_id, firstCommand.document_id);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(oldInvocation), false);
  const newSession = f.command().session_id;
  f.snapshot([process({ episode_id: 'episode-3' })], { reason: 'input-transition', session: newSession });
  assert.equal(f.started.length, 2);
});

test('malformed identities fail closed and unavailable clears active rows and outstanding requests', () => {
  const f = fixture(); f.ready(); f.owner.configure(true);
  f.snapshot([process()], { reason: 'input-transition' });
  const outstanding = f.started[0];
  f.snapshot([process({ episode_id: '   ' })]);
  assert.equal(f.owner.getState().status, 'unavailable');
  assert.equal(f.owner.getState().apps[0].active, false);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(outstanding), false);
  f.snapshot([process({ process_id: Number.MAX_SAFE_INTEGER + 1 })]);
  assert.equal(f.owner.getState().status, 'unavailable');
  f.snapshot([process({ episode_id: 'episode-recovered' })], { reason: 'input-transition' });
  const recovered = f.started.at(-1);
  f.owner.receive({ event: 'error', document_id: f.command().document_id, session_id: f.command().session_id });
  assert.equal(f.owner.getState().status, 'unavailable');
  assert.equal(f.owner.getState().apps[0].active, false);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(recovered), false);
});

test('inspect, manual emissions, and pause cannot start or retain recordings', () => {
  const f = fixture(); f.ready(); f.owner.configure(true);
  const session = f.command().session_id;
  f.owner.inspect();
  assert.equal(f.command().command, 'inspect');
  f.snapshot([process()], { reason: 'inspect', status: 'inspected', session });
  assert.equal(f.started.length, 0);
  f.snapshot([process({ episode_id: 'episode-fresh' })], { reason: 'input-transition', session });
  const request = f.started[0];
  f.owner.pause();
  assert.equal(f.command().command, 'unsubscribe');
  assert.equal(f.owner.getState().apps[0].active, false);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(request), false);
  f.snapshot([process({ episode_id: 'episode-after-pause' })], { reason: 'input-transition', session });
  assert.equal(f.started.length, 1);
});

test('the same native episode has one durable claim identity across window-specific invocations', () => {
  const base = { appId: 'com.example.meet', appName: 'Meet', processId: 71,
    nativeDocumentId: 'doc-A', nativeSessionId: 'session-A', nativeEpisodeId: 'global-episode' };
  const first = invocationOwner.createMeetingApplicationRecordingInvocation(base, () => true);
  const sibling = invocationOwner.createMeetingApplicationRecordingInvocation({ ...base,
    nativeDocumentId: 'doc-B', nativeSessionId: 'session-B' }, () => true);
  assert.equal(first.invocationId, sibling.invocationId);
  assert.notEqual(first.nativeDocumentId, sibling.nativeDocumentId);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(first), false,
    'one registry cannot accept an older issuance with changed source coordinates');
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(sibling), true);
});

test('invocation registry accepts only unchanged, current fields and refuses expiry or tampering', () => {
  let current = true;
  const base = { appId: 'com.example.meet', appName: 'Meet', processId: 71,
    nativeDocumentId: 'doc', nativeSessionId: 'session', nativeEpisodeId: 'episode' };
  const now = Date.parse('2026-10-14T12:00:00.000Z');
  const value = invocationOwner.createMeetingApplicationRecordingInvocation(base, () => current, now);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(value, now + 1), true);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(value, now + 120_000), false);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation({ ...value, appName: 'Other' }, now + 1), false);
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation({ ...value, extra: true }, now + 1), false);
  current = false;
  assert.equal(invocationOwner.isCurrentMeetingApplicationRecordingInvocation(value, now + 1), false);
  assert.throws(() => invocationOwner.createMeetingApplicationRecordingInvocation({ ...base, nativeEpisodeId: '' }, () => true, now), TypeError);
});
