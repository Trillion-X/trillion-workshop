import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const packageRoot = new URL('..', import.meta.url);
const repoRoot = new URL('../../..', import.meta.url);
const boundaryPath = new URL('things-to-store-and-run.json', packageRoot);
const requestSource = new URL('do-work/record-video-requests.ts', packageRoot);
const artifactSource = new URL('do-work/recorded-file-artifact.ts', packageRoot);
const sessionSource = new URL('read-data/recording-session.ts', packageRoot);

async function bundleModule(entryUrl, outfile) {
  await build({
    entryPoints: [entryUrl.pathname],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    alias: { '@': repoRoot.pathname.replace(/\/$/, '') },
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile));
}

const tempDir = await mkdtemp(join(tmpdir(), 'record-video-backend-proof-'));
const requestModule = await bundleModule(requestSource, join(tempDir, 'requests.mjs'));
const artifactModule = await bundleModule(artifactSource, join(tempDir, 'artifact.mjs'));
const sessionModule = await bundleModule(sessionSource, join(tempDir, 'session.mjs'));
const boundary = JSON.parse(await readFile(boundaryPath, 'utf8'));
const boundaryText = JSON.stringify(boundary);
const thingByAddress = (address) => boundary.things.find((thing) => thing.address === address);

async function declaredSourceTests(directoryUrl, prefix = '') {
  const found = [];
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    if (entry.name === 'built-stored-bytes' || entry.name === '.bitfield-entry-scope') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await declaredSourceTests(new URL(`${entry.name}/`, directoryUrl), relative));
    else if (/\.test\.(?:ts|tsx|mjs|js)$/.test(entry.name)) found.push(relative);
  }
  return found.sort();
}

const checkDescriptor = thingByAddress('package::record-video::checks');
assert.deepEqual(
  [...checkDescriptor.payload.checks].sort(),
  await declaredSourceTests(packageRoot),
  'every package-owned source test must be in the declared check set',
);

const sourceRef = {
  role: 'stored-screen-capture',
  media_type: 'video/webm',
  display_name: 'Evidence',
  artifact_ref: {
    multihash: '1f:test',
    cas_address: '1f:test',
    media_type: 'video/webm',
    byte_length: 12,
    stored_bytes_address_label: 'package::record-video::source-bytes::media-record:test',
  },
};
const localPlaybackRef = {
  kind: 'local-playback.indexeddb-chunks',
  database: 'record-video',
  store: 'recorded-chunks',
  recording_id: 'recording:test',
  chunk_refs: [{ key: 'recording:test:chunk:0', byte_length: 12 }],
  media_type: 'video/webm',
  byte_length: 12,
};

const request = requestModule.buildSaveRecordedFileRequest({
  recordingId: 'recording:test',
  recordedFileId: 'media-record:test',
  label: 'Desk capture',
  mode: 'screen',
  mediaType: 'video/webm',
  byteLength: 12,
  durationMs: 34,
  recordedAt: '2026-06-22T00:00:00.000Z',
  storedFileRef: localPlaybackRef,
  sourceRef,
  completionReasonRef: 'capture-completion:test',
  completionObservedAt: '2026-06-22T00:00:34.000Z',
  artifactDisposition: 'saved',
});

assert.equal(request.target, 'slot::workflow');
assert.equal(request.payload.definition_id, 'action:record-video:save-recorded-file');
assert.equal(request.payload.input.backend_descriptor_id, requestModule.RECORD_VIDEO_BACKEND_DESCRIPTOR.id);
assert.equal(request.payload.input.action_descriptor_id, 'save-captured-media');
assert.equal(request.payload.input.record_id, 'media-record:test');
assert.equal(request.payload.input.capture_kind, 'screen');
assert.deepEqual(request.payload.input.source_ref, sourceRef);
assert.equal(request.payload.input.completion_reason_ref, 'capture-completion:test');
assert.equal(request.payload.input.completion_observed_at, '2026-06-22T00:00:34.000Z');
assert.equal(request.payload.input.artifact_disposition, 'saved');
assert.deepEqual(request.payload.input.artifact_ref, sourceRef.artifact_ref);

const futureState = requestModule.buildSaveRecordingStateRequest({
  recordingId: 'recording:future',
  mode: 'sensor-depth-map',
  state: 'stopped',
  observedAt: '2026-06-22T00:00:00.000Z',
  completionReason: 'silence-after-speech',
});
assert.equal(futureState.payload.input.capture_kind, 'sensor-depth-map');
assert.equal(futureState.payload.input.completion_reason, 'silence-after-speech');

for (const address of [
  'package::record-video::descriptor::media-capture-record-action-projection',
  'package::record-video::projection-descriptor::recordings',
  'package::record-video::process-descriptor::native-capture',
  'package::record-video::input::recording-session',
  'package::record-video::input::completion-reason-refs',
  'package::record-video::workflow-action::stage-recording-session-from-presentation-plan',
]) {
  assert.ok(boundary.things.some((thing) => thing.address === address), `missing ${address}`);
}

for (const forbidden of [
  'prop:recorded_file',
  'record-video.recorded-file',
  'record-video.recording-state',
  'record-video.recording-error',
  'prop:captured_source',
  'captured-media-source',
  'action:record-video:publish-recordings-feed',
  'record-action-projection.materialized-feed',
  'record-action-projection.record-patch',
  'record-action-projection.record-retraction',
]) {
  assert.equal(boundaryText.includes(forbidden), false, `forbidden active marker remained: ${forbidden}`);
}

const recordingsProjection = thingByAddress('record-video-recordings-v2');
assert.equal(recordingsProjection.type, 'record_from_matching_records');
assert.deepEqual(recordingsProjection.matching_record_paths, [['record-video', 'media-record-segment']]);
assert.equal(recordingsProjection.payload_bytes.value_to_bytes, 'cell_table');
assert.deepEqual(recordingsProjection.payload_bytes.group_by.path, ['payload', 'record_id']);
assert.deepEqual(
  recordingsProjection.payload_bytes.columns.map((column) => column.column),
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
);

const recordingsInput = thingByAddress('package::record-video::input::recordings');
assert.equal(recordingsInput.payload.value_address_label, 'record-video-recordings-v2');
assert.equal(recordingsInput.payload.value.projection.fields[10].key, 'sourceRef');
assert.equal(recordingsInput.payload.value.projection.fields[11].key, 'completionReasonRef');
assert.equal(recordingsInput.payload.value.projection.fields[12].key, 'completionObservedAt');
assert.equal(recordingsInput.payload.value.projection.fields[13].key, 'artifactDisposition');

const surfaceFactflow = thingByAddress('package::record-video::factflow::record-video-surface');
assert.ok(
  surfaceFactflow.payload.fact_sources.some(
    (source) => source.address === 'package::record-video::input::recording-session',
  ),
  'record-video surface factflow must source the teleprompter session input',
);
assert.ok(surfaceFactflow.payload.fact_sources.some(
  (source) => source.address === 'package::record-video::input::completion-reason-refs',
));

const recordingPageLayout = thingByAddress('record-video-page-layout-state');
assert.equal(recordingPageLayout.address_mode, 'label_hash');
assert.equal(
  recordingPageLayout.payload.tabGroups['recording-page-main-group'].activeTabId,
  'recording-page-documents-tab',
);
assert.deepEqual(
  recordingPageLayout.payload.tabs['recording-page-documents-tab'].packageEntry,
  { packageName: 'documents', entryName: 'documents' },
);
assert.equal(
  recordingPageLayout.payload.tabs['recording-page-documents-tab'].materialTarget,
  'component:documents',
);
assert.equal(Object.hasOwn(recordingPageLayout.payload.tabs, 'recording-page-notes-tab'), false);

const recordingSessionInput = thingByAddress('package::record-video::input::recording-session');
assert.equal(recordingSessionInput.payload.input_name, 'recording-session');
assert.equal(recordingSessionInput.payload.value_address_label, sessionModule.RECORDING_SESSION_VALUE_ADDRESS_LABEL);

const stageSessionAction = thingByAddress(
  'package::record-video::workflow-action::stage-recording-session-from-presentation-plan',
);
assert.deepEqual(stageSessionAction.payload.input_schema.required, ['plan']);
assert.equal(stageSessionAction.payload.steps[1].config.input.containment.kind, 'leaf');
assert.equal(stageSessionAction.payload.steps[2].config.items[0].address, 'record-video-recording-session');
assert.equal(boundary.things.some((thing) => thing.address === 'record-video-recording-session'), false);

const decodedSession = sessionModule.decodeRecordingSession({
  session_id: 'presentation-plan:test',
  sentences: ['One sentence with several words.', 'Final sentence.'],
  capture_mode: 'video',
  auto_start: false,
  countdown_seconds: 3,
  auto_stop_seconds: 0,
  stop_on_final_word: true,
  completion_grace_ms: 250,
});
assert.equal(decodedSession.captureMode, 'video');
assert.equal(decodedSession.autoStart, false);
assert.equal(decodedSession.countdownSeconds, 3);
assert.equal(decodedSession.autoStopSeconds, 0);
assert.equal(decodedSession.stopOnFinalWord, true);
assert.equal(decodedSession.words.length > decodedSession.sentences.length, true);
assert.equal(sessionModule.reachedScriptCompletion(decodedSession, decodedSession.words.length - 1), false);
assert.equal(sessionModule.reachedScriptCompletion(decodedSession, decodedSession.words.length), true);
assert.equal(
  sessionModule.activeSentenceIndexForCursor(decodedSession, 0),
  0,
);
assert.equal(
  sessionModule.alignRecognizedWords(decodedSession, 0, 0, ['One', 'sentence', 'with']),
  3,
);

const actionById = (id) => boundary.things.find((thing) => thing.payload?.id === id)?.payload;
const saveItems = actionById('action:record-video:save-recorded-file').steps[0].config.items;
assert.equal(saveItems[0].payload.kind, 'record-video.media-record-core');
assert.equal(saveItems[1].payload.field, 'label');
assert.deepEqual(saveItems[0].path, ['record-video', 'media-record-segment']);

for (const [id, field] of [
  ['action:record-video:set-recording-name', 'label'],
  ['action:record-video:set-recording-notes', 'notes'],
  ['action:record-video:set-recording-subtitle', 'subtitle'],
]) {
  const items = actionById(id).steps[0].config.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.kind, 'record-video.media-record-field');
  assert.equal(items[0].payload.field, field);
}

const removeItems = actionById('action:record-video:remove-recording').steps[0].config.items;
assert.equal(removeItems.length, 4);
assert.ok(removeItems.every((item) => !Object.hasOwn(item, 'payload')));

assert.equal(
  artifactModule.recordedFileBytesAddressLabel('media-record:test'),
  'package::record-video::source-bytes::media-record:test',
);
assert.match(requestModule.createRecordVideoId('custom'), /^custom:/);

await writeFile(join(tempDir, 'proof.json'), JSON.stringify({ ok: true }, null, 2));
console.log('[record-video] backend descriptor proof passed');
