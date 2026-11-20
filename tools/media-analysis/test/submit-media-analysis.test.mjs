// The media analysis request builder (packages/media-analysis/do-work/submit-media-analysis.mjs): its input, its command
// descriptor and the refusal to send without a sender. Synthetic data only; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaAnalysisInput, submitMediaAnalysisRequest } from '../packages/media-analysis/do-work/submit-media-analysis.mjs';

const SOURCE = { artifact_ref: { multihash: 'mh-synthetic', cas_address: 'cas-synthetic', byte_length: 10 }, media_type: 'video/mp4' };

test('the request names the local process, its script input, and the media as a blob reference', () => {
  const input = buildMediaAnalysisInput({ source: SOURCE, requestId: 'media-analysis:test-1', requestedAt: '2026-11-20T00:00:00.000Z' });
  assert.equal(input.request_id, 'media-analysis:test-1');
  assert.equal(input.requested_at, '2026-11-20T00:00:00.000Z');
  const descriptor = input.options.analysis_command.process_descriptor;
  assert.deepEqual(descriptor.argv, ['python3', 'packages/media-analysis/do-work/analyze-media.py', 'media/source', 'media-analysis:test-1', 'command-output.json']);
  const [script, media] = descriptor.inputs;
  assert.equal(script.executable, true);
  assert.equal(script.source.kind, 'inline_text');
  assert.match(script.source.text, /def claim\(/);
  assert.deepEqual(media, { mount_path: 'media/source', content_type: 'video/mp4', source: { kind: 'blob_ref', hash: 'cas-synthetic' } });
});

test('a source without a CAS address names its multihash, and the default lanes are on', () => {
  const input = buildMediaAnalysisInput({ source: { ...SOURCE, artifact_ref: { multihash: 'mh-only' } }, requestId: 'media-analysis:test-2' });
  assert.equal(input.options.analysis_command.process_descriptor.inputs[1].source.hash, 'mh-only');
  assert.deepEqual(input.lanes, { metadata: true, chapters: true, thumbnails: true, embeddings: true });
});

test('a caller lane choice is kept as given', () => {
  const input = buildMediaAnalysisInput({ source: SOURCE, requestId: 'media-analysis:test-3', lanes: { metadata: true } });
  assert.deepEqual(input.lanes, { metadata: true });
  assert.deepEqual(input.options.analysis_command.process_profile.lanes, { metadata: true });
});

test('a request is refused without a sender, so nothing is sent by default', async () => {
  await assert.rejects(submitMediaAnalysisRequest({ source: SOURCE }), { code: 'no_sender' });
  await assert.rejects(submitMediaAnalysisRequest({ source: SOURCE }, {}), { code: 'no_sender' });
});

test('with a sender, the request is sent once to the analysis action and the input is answered', async () => {
  const sent = [];
  const input = await submitMediaAnalysisRequest({ source: SOURCE, requestId: 'media-analysis:test-4' }, { send: async message => { sent.push(message); } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].definition_id, 'action:submit-media-analysis-request');
  assert.equal(sent[0].input.request_id, 'media-analysis:test-4');
  assert.deepEqual(input, sent[0].input);
});
