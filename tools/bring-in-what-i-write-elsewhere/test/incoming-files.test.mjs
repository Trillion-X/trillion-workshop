import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { incomingFileIdentities, verifyIncomingFiles, storedFileLookup, checkIncomingFiles } from '../read-data/incoming-files.mjs';
const bytes = Buffer.from('RIFF sample wave bytes');
const identity = makeHashCodeHexFromBytes(bytes);
const files = { '/Kept/true.wav': { base64: bytes.toString('base64') } };

test('handed-in Files are checked once by content identity and carrier names and types are discarded', () => {
  const calls = [];
  const lookup = storedFileLookup(files);
  const locate = id => { calls.push(id); return lookup(id); };
  const items = [{ attachments: [{ identity, name: 'Forged', media_type: 'text/plain' }, identity] }, { files: [{ id: identity, name: 'Forged' }] }];
  assert.deepEqual(incomingFileIdentities(items), [identity]);
  verifyIncomingFiles(items, locate);
  assert.deepEqual(calls, [identity]);
  assert.deepEqual(items[0].attachments, [{ identity, name: '/Kept/true.wav', media_type: 'audio/wav' }]);
  assert.deepEqual(items[1].files, [{ id: identity, name: '/Kept/true.wav', media_type: 'audio/wav' }]);
});

test('a file given with the same bytes under two names is one file, named by the first name in order', () => {
  const lookup = storedFileLookup({ '/b/copy.wav': { text: 'same' }, '/a/first.txt': { text: 'same' } });
  assert.deepEqual(lookup(makeHashCodeHexFromBytes(Buffer.from('same'))), { name: '/a/first.txt', media_type: 'text/plain' });
});

test('missing, null, malformed and unhanded files abort before acceptance', () => {
  const items = [{ files: [{ id: identity }] }];
  assert.throws(() => verifyIncomingFiles(items, storedFileLookup({})), error => error.status === 400 && error.not_sent === true);
  assert.throws(() => verifyIncomingFiles(items, storedFileLookup({ '/Kept/true.wav': null })), error => error.status === 400 && error.not_sent === true);
  assert.deepEqual(items, [{ files: [{ id: identity }] }]);
  assert.throws(() => verifyIncomingFiles([{ attachments: ['bad'] }], () => assert.fail('must not locate')), error => error.status === 400 && error.not_sent === true);
});

test('checkIncomingFiles answers the canonical batch from the files it was handed, and refuses when none were handed', () => {
  const checked = checkIncomingFiles({ items: [{ text: 'A note' }, { attachments: [identity] }], stored: { files } });
  assert.deepEqual(checked.items[1].attachments, [{ identity, name: '/Kept/true.wav', media_type: 'audio/wav' }]);
  assert.throws(() => checkIncomingFiles({ items: [{ attachments: [identity] }] }), error => error.status === 400 && error.not_sent === true);
  assert.throws(() => checkIncomingFiles({ stored: { files } }), error => error.status === 400 && error.not_sent === true);
});
