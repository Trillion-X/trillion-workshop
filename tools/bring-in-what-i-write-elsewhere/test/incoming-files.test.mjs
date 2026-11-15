import assert from 'node:assert/strict';
import test from 'node:test';
import { incomingFileIdentities, verifyIncomingFiles, nativeFileLookup } from '../read-data/incoming-files.mjs';
const identity = `1f:${'a'.repeat(64)}`;

test('Files door checks each identity once and discards carrier names and types', async () => {
  const calls = [];
  const door = { async files(method, input) { calls.push({ method, input }); return { names: ['/Kept/true.wav'], media_type: 'audio/wav' }; } };
  const items = [{ attachments: [{ identity, name: 'Forged', media_type: 'text/plain' }, identity] }, { files: [{ id: identity, name: 'Forged' }] }];
  assert.deepEqual(incomingFileIdentities(items), [identity]);
  await verifyIncomingFiles(items, nativeFileLookup(door));
  assert.deepEqual(calls, [{ method: 'find_file', input: { name_or_identity: identity } }]);
  assert.deepEqual(items[0].attachments, [{ identity, name: '/Kept/true.wav', media_type: 'audio/wav' }]);
  assert.deepEqual(items[1].files, [{ id: identity, name: '/Kept/true.wav', media_type: 'audio/wav' }]);
});

test('missing, malformed, busy and authority-refused files abort before acceptance', async () => {
  const items = [{ files: [{ id: identity }] }];
  await assert.rejects(verifyIncomingFiles(items, nativeFileLookup({ files: async () => { throw { code: 'namespace_not_found' }; } })), error => error.status === 400 && error.not_sent === true);
  assert.deepEqual(items, [{ files: [{ id: identity }] }]);
  await assert.rejects(verifyIncomingFiles([{ attachments: ['bad'] }], async () => assert.fail('must not locate')), error => error.status === 400 && error.not_sent === true);
  for (const code of ['no_files', 'current_workspace_rights_refused', 'selected_owner_unavailable']) {
    await assert.rejects(verifyIncomingFiles(items, nativeFileLookup({ files: async () => { throw { code }; } })), error => error.code === code && error.not_sent === true);
  }
});
