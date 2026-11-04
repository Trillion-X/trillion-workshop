// test/sealed-log.test.mjs
//
// The sealed local log (computer/sealed-log.mjs): only the holder of the reader's private key can read what a Mac wrote;
// every flushed batch is its own chunk; a changed header or a wrong key fails to open; a torn tail is cut off on the
// next open; deflate is used when it helps; the file is private. Real files, real X25519/HKDF/AES-GCM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSealedLog, generateReaderKeys, openAll, scanChunks, sealChunk, sealedSettings } from '../sealed-log.mjs';

const settings = sealedSettings();
const readers = generateReaderKeys();
const keyId = Buffer.from('reader01');
const file = () => join(mkdtempSync(join(tmpdir(), 'sealed-')), 'logs', 'a.sealed');

test('a log opens with the reader key into exactly what was written, one chunk per flush, and the file holds no plaintext', () => {
  const path = file();
  const log = createSealedLog({ file: path, publicKey: readers.publicKey, keyId });
  log.append('first line: secret-token-ABC');
  log.flush();
  log.append('second line');
  log.append('third line');
  log.close();
  const bytes = readFileSync(path);
  assert.equal(bytes.includes(Buffer.from('secret-token-ABC')), false);
  const opened = openAll({ privateKey: readers.privateKey, bytes });
  assert.deepEqual(opened.batches.map(String), ['first line: secret-token-ABC\n', 'second line\nthird line\n']);
  assert.equal(opened.torn, 0);
  assert.equal(scanChunks(bytes).chunks.length, 2);
  assert.equal(scanChunks(bytes).chunks[0].key_id, keyId.toString('hex'));
  assert.equal((statSync(path).mode & 0o777).toString(8), '600');
});

test('another key, or a changed header, cannot open a chunk', () => {
  const chunk = sealChunk({ publicKey: readers.publicKey, keyId, plaintext: 'private' });
  assert.throws(() => openAll({ privateKey: generateReaderKeys().privateKey, bytes: chunk }), error => error.status === 403 && /does not open/.test(error.message));
  const edited = Buffer.from(chunk);
  edited[settings.magic.length + 1] ^= 1;
  assert.throws(() => openAll({ privateKey: readers.privateKey, bytes: edited }), error => error.status === 403);
});

test('the same text sealed twice gives different bytes (a fresh key and nonce each time), and long text is deflated', () => {
  const text = 'abc '.repeat(5000);
  const one = sealChunk({ publicKey: readers.publicKey, keyId, plaintext: text }), two = sealChunk({ publicKey: readers.publicKey, keyId, plaintext: text });
  assert.notDeepEqual(one, two);
  assert.ok(one.length < text.length / 4, 'deflated');
  assert.equal(openAll({ privateKey: readers.privateKey, bytes: one }).batches[0].toString(), text);
});

test('a torn last chunk is reported by a scan and cut off when the log is opened again, and appending continues in whole chunks', () => {
  const path = file();
  const first = createSealedLog({ file: path, publicKey: readers.publicKey, keyId });
  first.append('kept'); first.close();
  const whole = readFileSync(path).length;
  appendFileSync(path, sealChunk({ publicKey: readers.publicKey, keyId, plaintext: 'half written' }).subarray(0, 40));
  assert.equal(scanChunks(readFileSync(path)).torn, 40);
  const second = createSealedLog({ file: path, publicKey: readers.publicKey, keyId });
  assert.equal(readFileSync(path).length, whole, 'the torn tail was cut');
  second.append('after'); second.close();
  const opened = openAll({ privateKey: readers.privateKey, bytes: readFileSync(path) });
  assert.deepEqual(opened.batches.map(String), ['kept\n', 'after\n']);
  assert.equal(opened.torn, 0);
});

test('a batch over the limit, a bad public key and a file that is not a sealed log are refused in words', () => {
  assert.throws(() => sealChunk({ publicKey: readers.publicKey, keyId, plaintext: Buffer.alloc(settings.max_plaintext_bytes + 1) }), /larger than/);
  assert.throws(() => sealChunk({ publicKey: Buffer.alloc(5), keyId, plaintext: 'x' }), /32-byte public key/);
  const path = file();
  createSealedLog({ file: path, publicKey: readers.publicKey, keyId }).close();
  writeFileSync(path, Buffer.from('plain text log that is long enough to look like a header'));
  assert.throws(() => createSealedLog({ file: path, publicKey: readers.publicKey, keyId }), /not a sealed chunk/);
});
