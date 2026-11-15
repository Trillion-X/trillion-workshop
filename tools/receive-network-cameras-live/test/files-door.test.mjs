import assert from 'node:assert/strict';
import test from 'node:test';
import { accountFiles } from '../read-data/camera-live.mjs';

test('camera upload uses bounded current Files pieces and finishes only at the last byte', async () => {
  const calls = [];
  const files = accountFiles({ door: { async files(method, input) { calls.push({ method, input }); return method === 'write_file_finish' ? { identity: `1f:${'a'.repeat(64)}` } : {}; } } });
  const upload = await files.startUpload({ name: '/recording.mp4', byte_length: 100000, media_type: 'video/mp4' });
  assert.equal(await files.putPart(upload, 0, new Uint8Array(50000)), 'growing');
  assert.equal(calls.some(call => call.method === 'write_file_finish'), false);
  assert.equal(await files.putPart(upload, 50000, new Uint8Array(50000)), 'stored');
  assert.deepEqual(calls.filter(call => call.method === 'write_file_piece').map(call => call.input.offset), [0, 40960, 50000, 90960]);
  assert.ok(calls.filter(call => call.method === 'write_file_piece').every(call => call.input.content_base64.length < 55000));
  assert.equal(calls.at(-1).method, 'write_file_finish');
});

test('camera does not acknowledge an unconfirmed upload or hide unavailable Files as absent', async () => {
  const files = accountFiles({ door: { async files() { return {}; } } });
  const upload = await files.startUpload({ name: '/recording.mp4', byte_length: 1 });
  await assert.rejects(files.putPart(upload, 0, Uint8Array.of(7)), error => error.code === 'not-confirmed');
  const busy = accountFiles({ door: { async files() { throw { code: 'selected_owner_unavailable' }; } } });
  await assert.rejects(busy.readText('/Camera/live-sources.json'), error => error.code === 'selected_owner_unavailable');
});
