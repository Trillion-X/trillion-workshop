import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const packageRoot = new URL('..', import.meta.url);
const repoRoot = new URL('../../..', import.meta.url);
const boundaryPath = new URL('things-to-store-and-run.json', packageRoot);
const requestSource = new URL('do-work/record-audio-requests.ts', packageRoot);
const artifactSource = new URL('do-work/recorded-file-artifact.ts', packageRoot);

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

const tempDir = await mkdtemp(join(tmpdir(), 'record-audio-backend-proof-'));
const requestModule = await bundleModule(requestSource, join(tempDir, 'requests.mjs'));
const artifactModule = await bundleModule(artifactSource, join(tempDir, 'artifact.mjs'));
const boundary = JSON.parse(await readFile(boundaryPath, 'utf8'));
const boundaryText = JSON.stringify(boundary);
const thingByAddress = (address) => boundary.things.find((thing) => thing.address === address);

const sourceRef = {
  role: 'stored-screen-capture',
  media_type: 'video/webm',
  display_name: 'Evidence',
  artifact_ref: {
    multihash: '1f:test',
    cas_address: '1f:test',
    media_type: 'video/webm',
    byte_length: 12,
    stored_bytes_address_label: 'package::record-audio::source-bytes::media-record:test',
  },
};
const localPlaybackRef = {
  kind: 'local-playback.indexeddb-chunks',
  database: 'record-audio',
  store: 'recorded-chunks',
  recording_id: 'recording:test',
  recorded_file_id: 'media-record:test',
  recorded_at: '2026-06-22T00:00:00.000Z',
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
  meetingEventContext: { source: 'google', sourceId: 'account:a/calendar:main', eventId: 'event:a', title: 'Planning', startsAt: '2026-06-22T10:00:00.000Z', endsAt: null, url: 'https://meet.example/a' },
});

assert.equal(request.target, 'slot::workflow');
assert.equal(request.payload.definition_id, 'action:record-audio:save-recorded-file');
assert.equal(request.payload.input.backend_descriptor_id, requestModule.RECORD_AUDIO_BACKEND_DESCRIPTOR.id);
assert.equal(request.payload.input.action_descriptor_id, 'save-captured-media');
assert.equal(request.payload.input.record_id, 'media-record:test');
assert.equal(request.payload.input.capture_kind, 'screen');
assert.deepEqual(request.payload.input.source_ref, sourceRef);
assert.deepEqual(request.payload.input.artifact_ref, sourceRef.artifact_ref);
assert.equal(request.payload.input.completion_reason_ref, 'capture-completion:test');
assert.equal(request.payload.input.artifact_disposition, 'saved');
assert.deepEqual(request.payload.input.meeting_event_context, { source: 'google', sourceId: 'account:a/calendar:main', eventId: 'event:a', title: 'Planning', startsAt: '2026-06-22T10:00:00.000Z', endsAt: null, url: 'https://meet.example/a' });
for (const action of ['set-recording-meeting-context', 'clear-recording-meeting-context']) {
  assert.equal(boundary.things.some(thing => thing.address === `package::record-audio::workflow-action::${action}`), false,
    'meeting association changes use the current conditional recording owner, never an unconditional retired-runtime field writer');
}
const meetingContext = { source: 'google', sourceId: 'calendar:one', eventId: 'event:one', title: 'Planning', startsAt: '2026-06-22T10:00:00.000Z', endsAt: null, url: null };
const setMeeting = requestModule.buildSetRecordingMeetingContextRequest({
  recordedFileId: 'media-record:one', meetingEventContext: meetingContext, expectedMeetingContext: null,
});
const clearMeeting = requestModule.buildClearRecordingMeetingContextRequest({
  recordedFileId: 'media-record:one', expectedMeetingContext: meetingContext,
});
for (const change of [setMeeting, clearMeeting]) {
  assert.equal(change.payload.input.record_id, 'media-record:one');
  assert.equal(change.payload.input.recorded_file_id, 'media-record:one');
  assert.ok(Object.hasOwn(change.payload.input, 'expected_meeting_context'));
}
assert.throws(() => requestModule.buildSetRecordingMeetingContextRequest({
  recordedFileId: '', meetingEventContext: meetingContext, expectedMeetingContext: null,
}), /recording identity/i);

const futureState = requestModule.buildSaveRecordingStateRequest({
  recordingId: 'recording:future',
  mode: 'sensor-depth-map',
  state: 'capturing',
  observedAt: '2026-06-22T00:00:00.000Z',
});
assert.equal(futureState.payload.input.capture_kind, 'sensor-depth-map');

for (const address of [
  'package::record-audio::descriptor::media-capture-record-action-projection',
  'package::record-audio::projection-descriptor::recordings',
  'package::record-audio::process-descriptor::native-capture',
]) {
  assert.ok(boundary.things.some((thing) => thing.address === address), `missing ${address}`);
}

for (const forbidden of [
  'prop:recorded_file',
  'record-audio.recorded-file',
  'record-audio.recording-state',
  'record-audio.recording-error',
  'prop:captured_source',
  'captured-media-source',
  'action:record-audio:publish-recordings-feed',
  'record-action-projection.materialized-feed',
  'record-action-projection.record-patch',
  'record-action-projection.record-retraction',
]) {
  assert.equal(boundaryText.includes(forbidden), false, `forbidden active marker remained: ${forbidden}`);
}

const recordingsProjection = thingByAddress('record-audio-recordings-v2');
assert.equal(recordingsProjection.type, 'record_from_matching_records');
assert.deepEqual(recordingsProjection.matching_record_paths, [
  ['record-audio', 'media-record-segment'],
]);
assert.equal(
  recordingsProjection.matching_record_paths.some((path) => (
    path[0] === 'current-item' && path[1] === 'published-record'
  )),
  false,
  'the recording aggregate must not admit every published record; unrelated rows invalidate the grouped feed',
);
assert.equal(recordingsProjection.payload_bytes.value_to_bytes, 'cell_table');
assert.deepEqual(recordingsProjection.payload_bytes.group_by.path, ['payload', 'record_id']);
assert.deepEqual(
  recordingsProjection.payload_bytes.columns.map((column) => column.column),
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
);

const recordingsInput = thingByAddress('package::record-audio::input::recordings');
assert.equal(recordingsInput.payload.value_address_label, 'record-audio-recordings-v2');
assert.equal(recordingsInput.payload.value.projection.fields[10].key, 'sourceRef');
assert.equal(recordingsInput.payload.value.projection.fields[11].key, 'state');
assert.equal(recordingsInput.payload.value.projection.fields[12].key, 'error');
assert.equal(recordingsInput.payload.value.projection.fields[13].key, 'completionReasonRef');
assert.equal(recordingsInput.payload.value.projection.fields[14].key, 'completionObservedAt');
assert.equal(recordingsInput.payload.value.projection.fields[15].key, 'artifactDisposition');

const recordingPageLayout = thingByAddress('record-audio-page-layout-state');
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

const actionById = (id) => boundary.things.find((thing) => thing.payload?.id === id)?.payload;
const saveItems = actionById('action:record-audio:save-recorded-file').steps[0].config.items;
assert.equal(saveItems[0].payload.kind, 'record-audio.media-record-core');
assert.equal(saveItems[1].payload.field, 'label');
assert.deepEqual(saveItems[0].path, ['record-audio', 'media-record-segment']);
assert.equal(saveItems[0].payload.completion_reason_ref.select.path, 'completion_reason_ref');
assert.equal(saveItems[0].payload.artifact_disposition.select.path, 'artifact_disposition');

const declaredChecks = thingByAddress('package::record-audio::checks').payload.checks;
for (const requiredCheck of [
  'do-work/recorded-file-store.test.ts',
  'show/live-recording.test.ts',
  'show/recording-lifecycle.test.ts',
  'tests/record-audio-backend-proof.mjs',
]) {
  assert.ok(declaredChecks.includes(requiredCheck), `missing declared check ${requiredCheck}`);
}

for (const [id, field] of [
  ['action:record-audio:set-recording-name', 'label'],
  ['action:record-audio:set-recording-notes', 'notes'],
  ['action:record-audio:set-recording-subtitle', 'subtitle'],
]) {
  const items = actionById(id).steps[0].config.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].payload.kind, 'record-audio.media-record-field');
  assert.equal(items[0].payload.field, field);
}

const removeItems = actionById('action:record-audio:remove-recording').steps[0].config.items;
assert.equal(removeItems.length, 4);
assert.ok(removeItems.every((item) => !Object.hasOwn(item, 'payload')));

assert.equal(
  artifactModule.recordedFileBytesAddressLabel('media-record:test'),
  'package::record-audio::source-bytes::media-record:test',
);
assert.match(requestModule.createRecordAudioId('custom'), /^custom:/);

await writeFile(join(tempDir, 'proof.json'), JSON.stringify({ ok: true }, null, 2));
console.log('[record-audio] backend descriptor proof passed');
